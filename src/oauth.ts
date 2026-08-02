import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { requireRedis } from './db';

/**
 * A minimal OAuth 2.1 authorization server for MCP remote connectors.
 *
 * Public clients only (Claude Web cannot keep a secret), so PKCE is mandatory
 * rather than optional and `plain` is refused outright.
 */

export const ACCESS_TTL = 60 * 60; // 1 hour
export const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 days, matching Garmin tokens
const CODE_TTL = 60; // authorization codes are redeemed immediately
const REQUEST_TTL = 10 * 60; // time allowed to complete the login form

/** The single account this server serves. See README for multi-user notes. */
export const OWNER_USER_ID = 'owner';

// ---------------------------------------------------------------- primitives

const b64url = (buf: Buffer) => buf.toString('base64url');
const token = () => b64url(randomBytes(32));

/** Compares without leaking length or content through timing. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, and the throw itself is a leak.
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------- JWT

export type AccessClaims = {
  sub: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  scope?: string;
};

/**
 * HS256 only. The algorithm is fixed at both ends and never read from the
 * token header for dispatch, which removes the `alg: none` and RS/HS confusion
 * attacks by construction rather than by validation.
 */
export function signJwt(claims: Omit<AccessClaims, 'iat'>, secret: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(
    Buffer.from(JSON.stringify({ ...claims, iat: Math.floor(Date.now() / 1000) }))
  );
  const body = `${header}.${payload}`;
  return `${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`;
}

export function verifyJwt(
  jwt: string,
  secret: string,
  expected: { iss: string; aud: string }
): AccessClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  const expectedSig = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  if (!safeEqual(signature, expectedSig)) return null;

  try {
    const head = JSON.parse(Buffer.from(header, 'base64url').toString());
    // Checked for spec compliance, never used to choose the algorithm.
    if (head.alg !== 'HS256' || head.typ !== 'JWT') return null;

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as AccessClaims;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
    // Without an audience check, a token minted for another service on the same
    // secret would be accepted here.
    if (claims.iss !== expected.iss || claims.aud !== expected.aud) return null;
    if (typeof claims.sub !== 'string' || !claims.sub) return null;
    return claims;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------- PKCE

/** RFC 7636: S256 only. `plain` offers no protection against code interception. */
export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== 'S256') return false;
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;
  return safeEqual(b64url(createHash('sha256').update(verifier).digest()), challenge);
}

// ---------------------------------------------------------- redirect_uri

/**
 * Exact string match against what the client registered. Prefix or origin
 * matching is the classic open-redirect hole: a registered
 * `https://app.example/cb` would otherwise accept `https://app.example/cb.evil`
 * and hand the authorization code to the attacker.
 */
export function redirectUriAllowed(candidate: string, registered: string[]): boolean {
  return registered.some((uri) => uri === candidate);
}

/** Rejects redirect targets that cannot protect a code in transit. */
export function isUsableRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash) return false; // fragments cannot be matched reliably
  if (parsed.protocol === 'https:') return true;
  // Loopback over http is allowed for native clients (RFC 8252).
  return (
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1')
  );
}

// -------------------------------------------------------------------- store

export type Client = { client_id: string; redirect_uris: string[]; client_name?: string };

export type PendingRequest = {
  client_id: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string;
};

export type CodeRecord = PendingRequest & { sub: string };

const k = {
  client: (id: string) => `oauth:client:${id}`,
  request: (id: string) => `oauth:req:${id}`,
  code: (c: string) => `oauth:code:${c}`,
  refresh: (t: string) => `oauth:refresh:${t}`,
  attempts: (who: string) => `oauth:attempts:${who}`
};

/** Upstash may return parsed objects or raw strings depending on how it was set. */
function parse<T>(raw: unknown): T | null {
  if (!raw) return null;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;
}

export async function registerClient(
  redirect_uris: string[],
  client_name?: string
): Promise<Client> {
  const client: Client = { client_id: `mcp_${token()}`, redirect_uris, client_name };
  // Registrations outlive refresh tokens or the client is orphaned mid-session.
  await requireRedis().set(k.client(client.client_id), JSON.stringify(client), {
    ex: REFRESH_TTL * 2
  });
  return client;
}

export const getClient = async (id: string): Promise<Client | null> =>
  parse<Client>(await requireRedis().get(k.client(id)));

export async function putRequest(req: PendingRequest): Promise<string> {
  const id = token();
  await requireRedis().set(k.request(id), JSON.stringify(req), { ex: REQUEST_TTL });
  return id;
}

export const getRequest = async (id: string): Promise<PendingRequest | null> =>
  parse<PendingRequest>(await requireRedis().get(k.request(id)));

export async function issueCode(record: CodeRecord): Promise<string> {
  const code = token();
  await requireRedis().set(k.code(code), JSON.stringify(record), { ex: CODE_TTL });
  return code;
}

/**
 * Atomically read-and-delete. Authorization codes are single use; a plain
 * get-then-delete would let two concurrent redemptions both succeed.
 */
export async function takeCode(code: string): Promise<CodeRecord | null> {
  return parse<CodeRecord>(await requireRedis().getdel(k.code(code)));
}

export async function issueRefresh(sub: string, client_id: string): Promise<string> {
  const t = token();
  await requireRedis().set(k.refresh(t), JSON.stringify({ sub, client_id }), { ex: REFRESH_TTL });
  return t;
}

/** Rotates on use: the old token dies as the new one is issued. */
export async function takeRefresh(t: string): Promise<{ sub: string; client_id: string } | null> {
  return parse<{ sub: string; client_id: string }>(await requireRedis().getdel(k.refresh(t)));
}

// ------------------------------------------------------------ login attempts

/**
 * The admin secret is the only thing between the internet and the owner's
 * health data, so throttle guesses. Redis-backed because serverless instances
 * share no memory and a per-instance counter would reset constantly.
 */
export async function tooManyAttempts(who: string, limit = 8, windowSec = 900): Promise<boolean> {
  const store = requireRedis();
  const key = k.attempts(who);
  const n = await store.incr(key);
  if (n === 1) await store.expire(key, windowSec);
  return n > limit;
}

export const clearAttempts = (who: string) => requireRedis().del(k.attempts(who));

// ------------------------------------------------------------------- config

export function requireSecret(name: 'JWT_SECRET' | 'ADMIN_PASSWORD'): string {
  const value = process.env[name];
  if (!value || value.length < 16) {
    // Fail closed: a weak or missing secret must disable the server, not
    // silently downgrade it.
    throw new Error(`${name} must be set to at least 16 characters.`);
  }
  return value;
}

/** Issuer must match what clients discovered, or audience checks are theatre. */
export function issuerFrom(host: string | undefined, proto = 'https'): string {
  if (!host) throw new Error('Missing Host header');
  const scheme = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : proto;
  return `${scheme}://${host}`;
}
