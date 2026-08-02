import { GarminConnect } from 'garmin-connect';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Node's built-in .env loader (20.12+). MCP clients normally pass config via
// their own `env` block, so a missing file is the common case, not an error.
try {
  process.loadEnvFile();
} catch {
  /* no .env present */
}

export type IGarminTokens = ReturnType<GarminConnect['exportToken']>;

export const TOKEN_PATH =
  process.env.GARMIN_TOKEN_PATH ?? join(homedir(), '.garmin-mcp', 'tokens.json');

export function encodeTokens(tokens: IGarminTokens): string {
  return Buffer.from(JSON.stringify(tokens)).toString('base64');
}

export function decodeTokens(b64: string): IGarminTokens {
  const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  if (!parsed?.oauth1?.oauth_token || !parsed?.oauth2?.access_token) {
    throw new Error('Malformed Garmin tokens: missing oauth1/oauth2 fields');
  }
  return parsed as IGarminTokens;
}

export function saveTokens(tokens: IGarminTokens, path = TOKEN_PATH): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  // Tokens are ~1yr bearer credentials to the whole Garmin account.
  chmodSync(path, 0o600);
}

// Env var wins so Vercel/KV deploys need no filesystem.
function loadTokens(path = TOKEN_PATH): IGarminTokens | null {
  const fromEnv = process.env.GARMIN_TOKENS_BASE64;
  if (fromEnv) return decodeTokens(fromEnv);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as IGarminTokens;
}

async function loginWithCredentials(): Promise<GarminConnect> {
  const username = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;
  if (!username || !password) {
    throw new Error(
      `No cached tokens at ${TOKEN_PATH} and GARMIN_EMAIL/GARMIN_PASSWORD are unset.\n` +
        `Run \`npm run auth\` once to log in and cache tokens.`
    );
  }
  const client = new GarminConnect({ username, password });
  await client.login();
  saveTokens(client.exportToken());
  return client;
}

let cached: Promise<GarminConnect> | undefined;

/** Authenticated Garmin client. Uses cached tokens, falls back to a fresh login. */
export function getGarminClient(): Promise<GarminConnect> {
  cached ??= (async () => {
    const tokens = loadTokens();
    if (!tokens) return loginWithCredentials();

    const client = new GarminConnect({ username: '', password: '' });
    client.loadToken(tokens.oauth1, tokens.oauth2);
    try {
      await client.getUserProfile();
      return client;
    } catch {
      // oauth1 is good for ~1yr; if it is dead too, only credentials can recover.
      return loginWithCredentials();
    }
  })();
  return cached;
}

const GC_API = 'https://connectapi.garmin.com';

/**
 * GET a Garmin Connect API path. The library wraps only sleep/HR/steps/weight,
 * so everything else goes through here — it still rides the library's auth
 * headers and oauth2 refresh interceptor.
 */
// ponytail: all tools use this one path rather than the library's typed getters
// for the two it covers, so there is a single error surface to handle.
export async function api<T>(path: string, params?: Record<string, string>): Promise<T> {
  const client = await getGarminClient();
  return client.client.get<T>(`${GC_API}${path}`, params ? { params } : undefined);
}

let displayName: Promise<string> | undefined;

/** Several wellness endpoints are keyed by display name rather than user id. */
export function getDisplayName(): Promise<string> {
  displayName ??= getGarminClient()
    .then((c) => c.getUserProfile())
    .then((p) => p.displayName);
  return displayName;
}

// ponytail: the library's axios interceptor refreshes oauth2 in-memory on expiry,
// so a refreshed access_token is not written back — it just re-refreshes next start.
// Persist on refresh only if startup latency becomes a problem.
