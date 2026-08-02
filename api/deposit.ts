import { GarminConnect } from 'garmin-connect';
import { deleteTokens, isHosted, saveTokens } from '../src/db';
import { depositAudience, requireSecret, verifyJwt } from '../src/oauth';

/**
 * Exchanges Garmin credentials for OAuth tokens and stores them against the
 * signed-in user. The password is used once to reach Garmin and is never
 * written to disk, stored, or logged.
 *
 * Callers must present a deposit token issued after Google sign-in, so tokens
 * can only ever be written under an authenticated identity — never one named
 * in the request body.
 */

// Structural types instead of @vercel/node: that package is types-only for this
// handler but drags in a dev tree with known advisories. Vercel supplies the
// real runtime objects, and this shape also fits other Node serverless hosts.
type VercelRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type VercelResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): { json(body: unknown): unknown };
};

type Caller = { ok: true; userId: string } | { ok: false; error: string };

function authenticate(req: VercelRequest): Caller {
  const header = String(req.headers['authorization'] ?? '');
  const bearer = /^Bearer (.+)$/.exec(header);
  if (!bearer) {
    return { ok: false, error: 'Sign in first — open /connect to link your Garmin account.' };
  }

  let secret: string;
  try {
    secret = requireSecret('JWT_SECRET');
  } catch {
    return { ok: false, error: 'This deployment is not configured (JWT_SECRET missing).' };
  }

  const host = req.headers['host'];
  const hostname = Array.isArray(host) ? host[0] : host;
  if (!hostname) return { ok: false, error: 'Missing Host header.' };
  const issuer =
    hostname.startsWith('localhost') || hostname.startsWith('127.0.0.1')
      ? `http://${hostname}`
      : `https://${hostname}`;

  // Audience is the deposit endpoint specifically, so an MCP access token
  // cannot be reused to overwrite someone's stored Garmin credentials.
  const claims = verifyJwt(bearer[1], secret, { iss: issuer, aud: depositAudience(issuer) });
  if (!claims) {
    return { ok: false, error: 'Your sign-in expired. Reload /connect and try again.' };
  }
  return { ok: true, userId: claims.sub };
}

/** Garmin's own errors can echo the submitted form back; never forward them raw. */
function safeMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : '';
  if (/ticket not found|mfa/i.test(raw)) {
    return 'Garmin did not accept those credentials. Accounts with two-factor authentication cannot be linked.';
  }
  if (/429|too many/i.test(raw)) {
    return 'Garmin is rate limiting these attempts. Wait several minutes before retrying.';
  }
  if (/locked/i.test(raw)) {
    return 'Garmin reports this account as locked. Sign in at connect.garmin.com to clear it.';
  }
  return 'Login failed. Check the email and password and try again.';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Tokens are account credentials; keep them out of every cache in the chain.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'POST' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ error: 'Use POST to link, DELETE to unlink.' });
  }

  const caller = authenticate(req);
  if (!caller.ok) return res.status(401).json({ error: caller.error });

  // Anyone storing someone else's health data needs a way to remove it.
  if (req.method === 'DELETE') {
    await deleteTokens(caller.userId);
    return res.status(200).json({ deleted: true });
  }

  if (!isHosted()) {
    return res.status(503).json({
      error: 'No storage configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.'
    });
  }

  const parsed = (typeof req.body === 'string' ? safeParse(req.body) : req.body) ?? {};
  const body = parsed as Record<string, unknown>;
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Both email and password are required.' });
  }

  try {
    const client = new GarminConnect({ username: email, password });
    await client.login();
    await saveTokens(caller.userId, client.exportToken());
    return res.status(200).json({ linked: true });
  } catch (err) {
    // Deliberately not logging the error object: Garmin's axios errors carry
    // request config, and the login body contains the password.
    console.error('garmin login failed');
    return res.status(401).json({ error: safeMessage(err) });
  }
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
