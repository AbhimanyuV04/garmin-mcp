import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

/**
 * End-to-end OAuth flow with Google as the identity provider, against an
 * in-memory Redis and a stubbed Google token endpoint.
 *
 * The load-bearing assertion is the last one: two different Google accounts
 * must resolve to two different Garmin sessions. That is the whole reason this
 * server is no longer single-user.
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
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.ALLOWED_EMAILS = 'you@example.com, dad@example.com';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Stands in for Google's token endpoint. */
let nextGoogleUser = { sub: '111', email: 'you@example.com', verified: true };
(globalThis as { fetch: unknown }).fetch = async (url: string) => {
  assert.equal(url, 'https://oauth2.googleapis.com/token', 'only Google is called');
  const claims = {
    iss: 'https://accounts.google.com',
    aud: process.env.GOOGLE_CLIENT_ID,
    sub: nextGoogleUser.sub,
    email: nextGoogleUser.email,
    email_verified: nextGoogleUser.verified,
    exp: Math.floor(Date.now() / 1000) + 600
  };
  return {
    ok: true,
    json: async () => ({ id_token: `${b64({ alg: 'RS256' })}.${b64(claims)}.sig` })
  };
};

const registerHandler = require('./register').default;
const authorizeHandler = require('./authorize').default;
const callbackHandler = require('../auth/callback').default;
const tokenHandler = require('./token').default;
const { verifyJwt, resourceUrl } = require('../../src/oauth') as typeof import('../../src/oauth');

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

const HOST = 'mcp.example';
const ISSUER = `https://${HOST}`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const call = async (handler: any, req: any): Promise<Captured> => {
  const { res, out } = mockRes();
  await handler({ headers: { host: HOST }, ...req }, res);
  return out;
};

/** Pulls the state parameter out of a rendered "Continue with Google" link. */
const stateFrom = (html: string) => {
  const href = /href="([^"]*accounts\.google\.com[^"]*)"/.exec(html)?.[1] ?? '';
  return new URL(href.replace(/&amp;/g, '&')).searchParams.get('state')!;
};

(async () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const reg = await call(registerHandler, {
    method: 'POST',
    body: { redirect_uris: [REDIRECT], client_name: 'Claude' }
  });
  const clientId = reg.body.client_id as string;

  const authQuery = {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    state: 'st-123',
    code_challenge: challenge,
    code_challenge_method: 'S256'
  };

  // --- an unregistered redirect_uri is still refused without redirecting ----
  const mismatch = await call(authorizeHandler, {
    method: 'GET',
    query: { ...authQuery, redirect_uri: 'https://evil.example/cb' }
  });
  assert.equal(mismatch.code, 400);
  assert.equal(mismatch.headers.location, undefined, 'must NOT redirect an unverified uri');

  // --- sign-in is refused for anyone not on the allowlist -------------------
  let auth = await call(authorizeHandler, { method: 'GET', query: authQuery });
  assert.equal(auth.code, 200);
  nextGoogleUser = { sub: '999', email: 'stranger@example.com', verified: true };
  let cb = await call(callbackHandler, {
    method: 'GET',
    query: { code: 'g-code', state: stateFrom(auth.text) }
  });
  assert.equal(cb.code, 403, 'allowlist keeps strangers out');
  assert.equal(cb.headers.location, undefined, 'no authorization code for a stranger');

  // --- an unverified Google email is refused --------------------------------
  auth = await call(authorizeHandler, { method: 'GET', query: authQuery });
  nextGoogleUser = { sub: '111', email: 'you@example.com', verified: false };
  cb = await call(callbackHandler, {
    method: 'GET',
    query: { code: 'g-code', state: stateFrom(auth.text) }
  });
  assert.equal(cb.code, 401, 'unverified email refused');

  // --- a replayed state is refused ------------------------------------------
  auth = await call(authorizeHandler, { method: 'GET', query: authQuery });
  const usedState = stateFrom(auth.text);
  nextGoogleUser = { sub: '111', email: 'you@example.com', verified: true };
  await call(callbackHandler, { method: 'GET', query: { code: 'g-code', state: usedState } });
  const replay = await call(callbackHandler, {
    method: 'GET',
    query: { code: 'g-code', state: usedState }
  });
  assert.equal(replay.code, 400, 'state is single use');

  // --- signed in, but no Garmin linked yet ----------------------------------
  auth = await call(authorizeHandler, { method: 'GET', query: authQuery });
  cb = await call(callbackHandler, {
    method: 'GET',
    query: { code: 'g-code', state: stateFrom(auth.text) }
  });
  assert.equal(cb.code, 409, 'refuses to finish before Garmin is linked');
  assert.match(cb.text, /Connect Garmin/);

  // --- link Garmin for both people, under their own ids ---------------------
  store.set('garmin:tokens:google_111', JSON.stringify({ oauth1: { oauth_token: 'yours' } }));
  store.set('garmin:tokens:google_222', JSON.stringify({ oauth1: { oauth_token: 'dads' } }));

  async function fullFlow(user: { sub: string; email: string }) {
    nextGoogleUser = { ...user, verified: true };
    const a = await call(authorizeHandler, { method: 'GET', query: authQuery });
    const c = await call(callbackHandler, {
      method: 'GET',
      query: { code: 'g-code', state: stateFrom(a.text) }
    });
    assert.equal(c.code, 302, `${user.email} completes sign-in`);
    const authCode = new URL(c.headers.location).searchParams.get('code')!;
    const t = await call(tokenHandler, {
      method: 'POST',
      body: {
        grant_type: 'authorization_code',
        code: authCode,
        code_verifier: verifier,
        client_id: clientId
      }
    });
    assert.equal(t.code, 200, `${user.email} exchanges the code`);
    return verifyJwt(t.body.access_token, process.env.JWT_SECRET!, {
      iss: ISSUER,
      aud: resourceUrl(ISSUER)
    })!;
  }

  const yours = await fullFlow({ sub: '111', email: 'you@example.com' });
  const dads = await fullFlow({ sub: '222', email: 'dad@example.com' });

  assert.equal(yours.sub, 'google_111');
  assert.equal(dads.sub, 'google_222');
  // The point of the whole phase: two people, two identities, two data sets.
  assert.notEqual(yours.sub, dads.sub, 'separate Google accounts get separate sessions');

  console.log('✓ oauth flow ok (multi-user)');
})();
