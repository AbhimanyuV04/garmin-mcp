import { GarminConnect } from 'garmin-connect';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type GarminTokens = ReturnType<GarminConnect['exportToken']>;

/** The single user of a local stdio server, which has no notion of accounts. */
export const LOCAL_USER = 'local';

export const TOKEN_PATH =
  process.env.GARMIN_TOKEN_PATH ?? join(homedir(), '.garmin-mcp', 'tokens.json');

export function encodeTokens(tokens: GarminTokens): string {
  return Buffer.from(JSON.stringify(tokens)).toString('base64');
}

export function decodeTokens(b64: string): GarminTokens {
  const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  if (!parsed?.oauth1?.oauth_token || !parsed?.oauth2?.access_token) {
    throw new Error('Malformed Garmin tokens: missing oauth1/oauth2 fields');
  }
  return parsed as GarminTokens;
}

/**
 * User ids become Redis keys, so constrain them rather than trusting whatever
 * an upstream identity provider hands over. Rejects separators and wildcards
 * that would let one user's id address another user's key.
 */
const USER_ID = /^[A-Za-z0-9_.@-]{1,128}$/;

export function assertUserId(userId: string): string {
  if (!USER_ID.test(userId)) {
    throw new Error('Invalid user id: expected 1-128 chars of [A-Za-z0-9_.@-]');
  }
  return userId;
}

const key = (userId: string) => `garmin:tokens:${assertUserId(userId)}`;

/** Redis is used when configured; otherwise everything falls back to the file. */
function redis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  // Required lazily so local stdio never pays for the client or its env checks.
  const { Redis } = require('@upstash/redis') as typeof import('@upstash/redis');
  return new Redis({ url, token });
}

export const isHosted = () => redis() !== null;

/**
 * Seconds until the refresh token dies. Garmin tokens are useless past that
 * point, so let Redis expire them rather than keeping dead credentials around.
 */
function ttlSeconds(tokens: GarminTokens): number | undefined {
  const expiresAt = (tokens.oauth2 as { refresh_token_expires_at?: number })
    ?.refresh_token_expires_at;
  if (typeof expiresAt !== 'number') return undefined;
  const remaining = Math.floor(expiresAt - Date.now() / 1000);
  return remaining > 0 ? remaining : undefined;
}

export async function loadTokens(userId: string): Promise<GarminTokens | null> {
  const store = redis();
  if (store) {
    // Upstash parses JSON responses, so this may already be an object.
    const raw = await store.get<GarminTokens | string>(key(userId));
    if (!raw) return null;
    return typeof raw === 'string' ? (JSON.parse(raw) as GarminTokens) : raw;
  }

  // Local: the env var wins so a machine can run without a token file at all.
  const fromEnv = process.env.GARMIN_TOKENS_BASE64;
  if (fromEnv) return decodeTokens(fromEnv);
  if (!existsSync(TOKEN_PATH)) return null;
  return JSON.parse(readFileSync(TOKEN_PATH, 'utf8')) as GarminTokens;
}

export async function saveTokens(userId: string, tokens: GarminTokens): Promise<void> {
  const store = redis();
  if (store) {
    const ttl = ttlSeconds(tokens);
    await store.set(key(userId), JSON.stringify(tokens), ttl ? { ex: ttl } : undefined);
    return;
  }
  mkdirSync(dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  // Tokens are ~30-day bearer credentials to the whole Garmin account.
  chmodSync(TOKEN_PATH, 0o600);
}

export async function deleteTokens(userId: string): Promise<void> {
  const store = redis();
  if (store) {
    await store.del(key(userId));
    return;
  }
  if (existsSync(TOKEN_PATH)) rmSync(TOKEN_PATH);
}
