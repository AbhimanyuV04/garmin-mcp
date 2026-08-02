import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// TOKEN_PATH is resolved at module load, so point it somewhere disposable
// before importing. Redis stays unconfigured, so this exercises the file path.
const dir = mkdtempSync(join(tmpdir(), 'garmin-'));
process.env.GARMIN_TOKEN_PATH = join(dir, 'nested', 'tokens.json');
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.GARMIN_TOKENS_BASE64;

const {
  encodeTokens,
  decodeTokens,
  saveTokens,
  loadTokens,
  deleteTokens,
  assertUserId,
  isHosted,
  LOCAL_USER,
  TOKEN_PATH
} = require('./db') as typeof import('./db');

const tokens = {
  oauth1: { oauth_token: 'o1', oauth_token_secret: 's1' },
  oauth2: {
    scope: 'x', jti: 'j', access_token: 'a', token_type: 'Bearer',
    refresh_token: 'r', expires_in: 3600, refresh_token_expires_in: 7200,
    expires_at: 1, refresh_token_expires_at: 2
  }
} as Parameters<typeof encodeTokens>[0];

assert.deepEqual(decodeTokens(encodeTokens(tokens)), tokens, 'base64 roundtrip');
assert.throws(() => decodeTokens(Buffer.from('{"oauth1":{}}').toString('base64')), /Malformed/);
assert.throws(() => decodeTokens('not-base64-json'));

// User ids become Redis key suffixes. Anything that could address a different
// user's key, or collide with the namespace separator, must be rejected.
assert.equal(assertUserId('user_123'), 'user_123');
assert.equal(assertUserId('a.b@example.com'), 'a.b@example.com');
for (const bad of ['', 'a:b', 'a b', 'a*', 'a/b', 'a\nb', '{}', 'x'.repeat(129)]) {
  assert.throws(() => assertUserId(bad), /Invalid user id/, `must reject ${JSON.stringify(bad)}`);
}

assert.equal(isHosted(), false, 'no Upstash env means file-backed');

(async () => {
  assert.equal(await loadTokens(LOCAL_USER), null, 'absent file reads as null');

  await saveTokens(LOCAL_USER, tokens);
  assert.deepEqual(
    JSON.parse(readFileSync(TOKEN_PATH, 'utf8')),
    tokens,
    'saves through missing directories'
  );
  assert.deepEqual(await loadTokens(LOCAL_USER), tokens, 'round-trips through the store');

  await deleteTokens(LOCAL_USER);
  assert.equal(await loadTokens(LOCAL_USER), null, 'delete clears the token');

  console.log('✓ token store ok');
})();
