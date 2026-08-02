import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

/**
 * End-to-end OAuth flow against an in-memory Redis stub: register -> authorize
 * -> login -> token. Unit tests cover the primitives; this proves the handlers
 * actually compose, and that replay and PKCE failures are caught in situ.
 */

const store = new Map<string, string>();

class FakeRedis {
  constructor(_opts: unknown) {}
  async get(key: string) {
    return store.get(key) ?? null;
  }
  async set(key: string, value: string) {
    store.set(key, value);
    return 'OK';
  }
  async getdel(key: string) {
    const v = store.get(key) ?? null;
    store.delete(key);
    return v;
  }
  async del(key: string) {
    return store.delete(key) ? 1 : 0;
  }
  async incr(key: string) {
    const n = Number(store.get(key) ?? '0') + 1;
    store.set(key, String(n));
    return n;
  }
  async expire() {
    return 1;
  }
}

// Seed the stub before anything lazily requires the real client.
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
process.env.ADMIN_PASSWORD = 'p'.repeat(20);

const registerHandler = require('./register').default;
const authorizeHandler = require('./authorize').default;
const loginHandler = require('./login').default;
const tokenHandler = require('./token').default;
const { verifyJwt, OWNER_USER_ID } = require('../../src/oauth') as typeof import('../../src/oauth');

type Captured = { code: number; body: any; text: string; headers: Record<string, string> };

function mockRes(): { res: any; out: Captured } {
  const out: Captured = { code: 0, body: null, text: '', headers: {} };
  const res: any = {
    setHeader: (k: string, v: string) => {
      out.headers[k.toLowerCase()] = v;
    },
    status(code: number) {
      out.code = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return body;
    },
    send(text: string) {
      out.text = text;
      return text;
    },
    end() {
      return undefined;
    }
  };
  return { res, out };
}

const call = async (handler: any, req: any): Promise<Captured> => {
  const { res, out } = mockRes();
  await handler({ headers: { host: 'mcp.example' }, ...req }, res);
  return out;
};

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

(async () => {
  // 1. Dynamic client registration.
  const reg = await call(registerHandler, {
    method: 'POST',
    body: { redirect_uris: [REDIRECT], client_name: 'Claude' }
  });
  assert.equal(reg.code, 201, 'client registered');
  const clientId = reg.body.client_id as string;
  assert.ok(clientId, 'client_id issued');

  // A redirect_uri that cannot protect a code must be refused at registration.
  const badReg = await call(registerHandler, {
    method: 'POST',
    body: { redirect_uris: ['http://evil.example/cb'] }
  });
  assert.equal(badReg.code, 400, 'plaintext non-loopback redirect refused');

  // 2. Authorize, with PKCE.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authQuery = {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    state: 'st-123',
    code_challenge: challenge,
    code_challenge_method: 'S256'
  };

  const auth = await call(authorizeHandler, { method: 'GET', query: authQuery });
  assert.equal(auth.code, 200, 'login form rendered');
  const requestId = /name="request_id" value="([^"]+)"/.exec(auth.text)?.[1];
  assert.ok(requestId, 'request_id embedded in form');

  // An unregistered redirect_uri must render an error, never redirect.
  const mismatch = await call(authorizeHandler, {
    method: 'GET',
    query: { ...authQuery, redirect_uri: 'https://evil.example/cb' }
  });
  assert.equal(mismatch.code, 400, 'redirect mismatch refused');
  assert.equal(mismatch.headers.location, undefined, 'must NOT redirect an unverified uri');

  // Missing PKCE bounces back to the (now trusted) redirect_uri.
  const noPkce = await call(authorizeHandler, {
    method: 'GET',
    query: { ...authQuery, code_challenge: undefined }
  });
  assert.equal(noPkce.code, 302);
  assert.match(noPkce.headers.location, /error=invalid_request/, 'PKCE required');

  // 3. Login. Without Garmin tokens stored, connecting must fail loudly.
  const noGarmin = await call(loginHandler, {
    method: 'POST',
    body: { request_id: requestId, password: 'p'.repeat(20) }
  });
  assert.equal(noGarmin.code, 409, 'refuses to bind a session with no Garmin tokens');

  store.set(
    `garmin:tokens:${OWNER_USER_ID}`,
    JSON.stringify({ oauth1: { oauth_token: 'o' }, oauth2: { access_token: 'a' } })
  );

  const wrongPw = await call(loginHandler, {
    method: 'POST',
    body: { request_id: requestId, password: 'wrong-password-here' }
  });
  assert.equal(wrongPw.code, 401, 'wrong password rejected');
  assert.equal(wrongPw.headers.location, undefined, 'no code issued on failed login');

  const login = await call(loginHandler, {
    method: 'POST',
    body: { request_id: requestId, password: 'p'.repeat(20) }
  });
  assert.equal(login.code, 302, 'redirects back to the client');
  const location = new URL(login.headers.location);
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get('state'), 'st-123', 'state round-trips');
  const code = location.searchParams.get('code')!;
  assert.ok(code, 'authorization code issued');

  // 4. Token exchange, wrong verifier first.
  const badPkce = await call(tokenHandler, {
    method: 'POST',
    body: {
      grant_type: 'authorization_code',
      code,
      code_verifier: randomBytes(32).toString('base64url'),
      client_id: clientId
    }
  });
  assert.equal(badPkce.code, 400, 'wrong code_verifier rejected');
  assert.equal(badPkce.body.error, 'invalid_grant');

  // The failed attempt consumed the code, so even the right verifier now fails.
  const afterBurn = await call(tokenHandler, {
    method: 'POST',
    body: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId }
  });
  assert.equal(afterBurn.code, 400, 'codes are single use even after a failed redemption');

  // Fresh round for the happy path.
  const auth2 = await call(authorizeHandler, { method: 'GET', query: authQuery });
  const rid2 = /name="request_id" value="([^"]+)"/.exec(auth2.text)![1];
  const login2 = await call(loginHandler, {
    method: 'POST',
    body: { request_id: rid2, password: 'p'.repeat(20) }
  });
  const code2 = new URL(login2.headers.location).searchParams.get('code')!;

  const wrongClient = await call(tokenHandler, {
    method: 'POST',
    body: {
      grant_type: 'authorization_code',
      code: code2,
      code_verifier: verifier,
      client_id: 'mcp_someoneelse'
    }
  });
  assert.equal(wrongClient.code, 400, 'code bound to the issuing client');

  const auth3 = await call(authorizeHandler, { method: 'GET', query: authQuery });
  const rid3 = /name="request_id" value="([^"]+)"/.exec(auth3.text)![1];
  const login3 = await call(loginHandler, {
    method: 'POST',
    body: { request_id: rid3, password: 'p'.repeat(20) }
  });
  const code3 = new URL(login3.headers.location).searchParams.get('code')!;

  const tok = await call(tokenHandler, {
    method: 'POST',
    body: {
      grant_type: 'authorization_code',
      code: code3,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT
    }
  });
  assert.equal(tok.code, 200, 'token issued');
  assert.equal(tok.body.token_type, 'Bearer');
  assert.equal(tok.headers['cache-control'], 'no-store, max-age=0', 'tokens are uncacheable');

  const claims = verifyJwt(tok.body.access_token, process.env.JWT_SECRET!, {
    iss: 'https://mcp.example',
    aud: 'https://mcp.example/mcp'
  });
  assert.equal(claims?.sub, OWNER_USER_ID, 'access token identifies the owner');

  // 5. Refresh rotation.
  const refreshed = await call(tokenHandler, {
    method: 'POST',
    body: {
      grant_type: 'refresh_token',
      refresh_token: tok.body.refresh_token,
      client_id: clientId
    }
  });
  assert.equal(refreshed.code, 200, 'refresh grant works');
  assert.notEqual(refreshed.body.refresh_token, tok.body.refresh_token, 'refresh token rotates');

  const replayed = await call(tokenHandler, {
    method: 'POST',
    body: {
      grant_type: 'refresh_token',
      refresh_token: tok.body.refresh_token,
      client_id: clientId
    }
  });
  assert.equal(replayed.code, 400, 'rotated refresh token cannot be replayed');

  console.log('✓ oauth flow ok');
})();
