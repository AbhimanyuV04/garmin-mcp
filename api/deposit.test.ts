import assert from 'node:assert/strict';

const store = new Map<string, string>();

class FakeRedis {
  constructor(_opts: unknown) {}
  async get(k: string) {
    return store.get(k) ?? null;
  }
  async set(k: string, v: string) {
    store.set(k, v);
    return 'OK';
  }
  async getdel(k: string) {
    const v = store.get(k) ?? null;
    store.delete(k);
    return v;
  }
  async del(k: string) {
    return store.delete(k) ? 1 : 0;
  }
  async incr() {
    return 1;
  }
  async expire() {
    return 1;
  }
}

const resolved = require.resolve('@upstash/redis');
require.cache[resolved] = {
  id: resolved,
  filename: resolved,
  loaded: true,
  exports: { Redis: FakeRedis }
} as NodeJS.Module;

process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
process.env.JWT_SECRET = 'j'.repeat(32);

import handler from './deposit';
import { depositAudience, resourceUrl, signJwt } from '../src/oauth';

const HOST = 'mcp.example';
const ISSUER = `https://${HOST}`;
const SECRET = process.env.JWT_SECRET!;
const now = () => Math.floor(Date.now() / 1000);

type Captured = { code: number; body: any };

function invoke(opts: { method?: string; auth?: string; body?: unknown }): Promise<Captured> {
  const captured: Captured = { code: 0, body: null };
  const res = {
    setHeader() {},
    status(code: number) {
      captured.code = code;
      return {
        json(body: unknown) {
          captured.body = body;
          return body;
        }
      };
    }
  };
  const req = {
    method: opts.method ?? 'POST',
    headers: {
      host: HOST,
      ...(opts.auth === undefined ? {} : { authorization: opts.auth })
    },
    body: opts.body
  };
  return handler(req as any, res as any).then(() => captured);
}

const depositToken = (sub: string, aud = depositAudience(ISSUER), exp = now() + 300) =>
  `Bearer ${signJwt({ sub, iss: ISSUER, aud, exp }, SECRET)}`;

const creds = { email: 'someone@example.com', password: 'pw' };

(async () => {
  let r = await invoke({ body: creds });
  assert.equal(r.code, 401, 'anonymous deposit refused');
  assert.match(r.body.error, /Sign in first/);

  r = await invoke({ auth: 'Basic abc', body: creds });
  assert.equal(r.code, 401, 'wrong scheme refused');

  r = await invoke({ auth: 'Bearer not-a-jwt', body: creds });
  assert.equal(r.code, 401, 'garbage token refused');

  r = await invoke({
    auth: depositToken('google_1', depositAudience(ISSUER), now() - 1),
    body: creds
  });
  assert.equal(r.code, 401, 'expired token refused');

  // The separation that matters: a token good for reading Garmin data must not
  // also be able to overwrite the stored credentials.
  r = await invoke({ auth: depositToken('google_1', resourceUrl(ISSUER)), body: creds });
  assert.equal(r.code, 401, 'MCP access token cannot be reused to deposit');

  r = await invoke({
    auth: `Bearer ${signJwt(
      { sub: 'google_1', iss: ISSUER, aud: depositAudience(ISSUER), exp: now() + 300 },
      'k'.repeat(32)
    )}`,
    body: creds
  });
  assert.equal(r.code, 401, 'token signed by another key refused');

  // Authenticated, so body validation is reached — no Garmin call is made.
  r = await invoke({ auth: depositToken('google_1'), body: { email: '', password: '' } });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /required/);

  r = await invoke({ auth: depositToken('google_1'), body: '{"bad json' });
  assert.equal(r.code, 400, 'malformed body rejected cleanly');

  r = await invoke({ method: 'GET', auth: depositToken('google_1') });
  assert.equal(r.code, 405, 'GET refused');

  // Deleting only ever touches the caller's own key.
  store.set('garmin:tokens:google_1', '{"oauth1":{}}');
  store.set('garmin:tokens:google_2', '{"oauth1":{}}');
  r = await invoke({ method: 'DELETE', auth: depositToken('google_1') });
  assert.equal(r.code, 200);
  assert.equal(store.has('garmin:tokens:google_1'), false, 'own tokens deleted');
  assert.equal(store.has('garmin:tokens:google_2'), true, 'other user untouched');

  r = await invoke({ method: 'DELETE' });
  assert.equal(r.code, 401, 'anonymous delete refused');

  console.log('✓ deposit endpoint ok');
  process.exit(0);
})();
