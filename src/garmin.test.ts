import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeTokens, decodeTokens, saveTokens } from './garmin';

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

const path = join(mkdtempSync(join(tmpdir(), 'garmin-')), 'nested', 'tokens.json');
saveTokens(tokens, path);
assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), tokens, 'saves through missing dirs');

console.log('✓ token store ok');
