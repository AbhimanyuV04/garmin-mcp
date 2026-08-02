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
const resumeHandler = require('../auth/resume').default;
const connectHandler = require('../connect').default;
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
  // Refused, but still answered: a client left waiting on a rendered page has
  // no way to learn the flow ended, which reads as a permanent hang.
  let auth = await call(authorizeHandler, { method: 'GET', query: authQuery });
  assert.equal(auth.code, 200);
  nextGoogleUser = { sub: '999', email: 'stranger@example.com', verified: true };
  let cb = await call(callbackHandler, {
    method: 'GET',
    query: { code: 'g-code', state: stateFrom(auth.text) }
  });
  assert.equal(cb.code, 302, 'the waiting client is told the flow failed');
  const denied = new URL(cb.headers.location);
  assert.equal(denied.searchParams.get('error'), 'access_denied');
  assert.equal(denied.searchParams.get('code'), null, 'no authorization code for a stranger');
  assert.equal(denied.searchParams.get('state'), 'st-123', 'state still round-trips');

  // --- an unverified Google email is refused --------------------------------
  // The allowlist is keyed on email, so an address the account has not proven
  // it owns must not be honoured.
  auth = await call(authorizeHandler, { method: 'GET', query: authQuery });
  nextGoogleUser = { sub: '111', email: 'you@example.com', verified: false };
  cb = await call(callbackHandler, {
    method: 'GET',
    query: { code: 'g-code', state: stateFrom(auth.text) }
  });
  assert.equal(cb.code, 302, 'unverified email refused, and the client is told');
  assert.equal(
    new URL(cb.headers.location).searchParams.get('error'),
    'access_denied',
    'no code issued for an unverified address'
  );

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
  // This is the state that stranded a real user: the flow cannot complete, so
  // it must offer a way to finish here rather than rendering a dead end.
  auth = await call(authorizeHandler, { method: 'GET', query: authQuery });
  const strandedState = stateFrom(auth.text);
  cb = await call(callbackHandler, {
    method: 'GET',
    query: { code: 'g-code', state: strandedState }
  });
  assert.equal(cb.code, 200, 'offers the Garmin form instead of dead-ending');
  assert.match(cb.text, /Claude is waiting for this/, 'explains why they are here');
  assert.match(cb.text, /var REQUEST_ID = "/, 'carries the pending request so it can resume');
  assert.equal(cb.headers.location, undefined, 'no code issued without Garmin linked');

  // Resuming without a linked Garmin account must still refuse.
  const strandedToken = /var TOKEN = "([^"]+)"/.exec(cb.text)![1];
  const pendingId = /var REQUEST_ID = "([^"]+)"/.exec(cb.text)![1];
  let resumed = await call(resumeHandler, {
    method: 'POST',
    headers: { host: HOST, authorization: `Bearer ${strandedToken}` },
    body: { request_id: pendingId }
  });
  assert.equal(resumed.code, 409, 'cannot resume before Garmin is linked');

  // --- link Garmin for both people, under their own ids ---------------------
  store.set('garmin:tokens:google_111', JSON.stringify({ oauth1: { oauth_token: 'yours' } }));
  store.set('garmin:tokens:google_222', JSON.stringify({ oauth1: { oauth_token: 'dads' } }));

  // Now that Garmin exists, the stranded attempt finishes without starting over.
  resumed = await call(resumeHandler, {
    method: 'POST',
    headers: { host: HOST, authorization: `Bearer ${strandedToken}` },
    body: { request_id: pendingId }
  });
  assert.equal(resumed.code, 200, 'resume completes the waiting authorization');
  const resumeUrl = new URL(resumed.body.redirect);
  assert.equal(resumeUrl.origin + resumeUrl.pathname, REDIRECT, 'returns to the client');
  assert.ok(resumeUrl.searchParams.get('code'), 'carries an authorization code');
  assert.equal(resumeUrl.searchParams.get('state'), 'st-123');

  // Resume needs a real sign-in, not just a request id.
  const noAuth = await call(resumeHandler, {
    method: 'POST',
    headers: { host: HOST },
    body: { request_id: pendingId }
  });
  assert.equal(noAuth.code, 401, 'anonymous resume refused');

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

  // --- invite codes: a group joins without being named one at a time --------
  process.env.INVITE_CODES = 'run-club-2026-abc, second-code-xyz';
  process.env.MAX_USERS = '2';

  const joinWith = async (invite: string | undefined, user: { sub: string; email: string }) => {
    const c = await call(connectHandler, { method: 'GET', query: invite ? { invite } : {} });
    const s = stateFrom(c.text);
    nextGoogleUser = { ...user, verified: true };
    return call(callbackHandler, { method: 'GET', query: { code: 'g-code', state: s } });
  };

  // No code and not on the allowlist: refused.
  let joined = await joinWith(undefined, { sub: '333', email: 'runner1@example.com' });
  assert.equal(joined.code, 403, 'no invite, not on the list');
  assert.match(joined.text, /Not on the list/);

  // A wrong code is worth nothing.
  joined = await joinWith('not-the-code', { sub: '333', email: 'runner1@example.com' });
  assert.equal(joined.code, 403, 'a wrong invite code admits nobody');

  // A valid code admits them, and records it so the code isn't needed again.
  joined = await joinWith('run-club-2026-abc', { sub: '333', email: 'runner1@example.com' });
  assert.equal(joined.code, 200, 'valid invite admits a new person');
  assert.match(joined.text, /Connect your Garmin/);
  assert.ok(store.get('access:granted:runner1@example.com'), 'the grant is persisted');

  joined = await joinWith(undefined, { sub: '333', email: 'runner1@example.com' });
  assert.equal(joined.code, 200, 'returning without the code still works');

  // The second listed code works too.
  joined = await joinWith('second-code-xyz', { sub: '444', email: 'runner2@example.com' });
  assert.equal(joined.code, 200, 'any configured code is accepted');

  // Cap reached: a valid code no longer admits anyone, and says why.
  joined = await joinWith('run-club-2026-abc', { sub: '555', email: 'runner3@example.com' });
  assert.equal(joined.code, 403, 'the cap stops a leaked code enrolling the world');
  assert.match(joined.text, /Server is full/);
  assert.equal(store.get('access:granted:runner3@example.com'), undefined, 'no grant past the cap');

  // Allowlisted people are unaffected by the cap.
  joined = await joinWith(undefined, { sub: '111', email: 'you@example.com' });
  assert.equal(joined.code, 200, 'ALLOWED_EMAILS still bypasses invites and the cap');

  // With no codes configured, invites admit nobody.
  delete process.env.INVITE_CODES;
  joined = await joinWith('run-club-2026-abc', { sub: '666', email: 'runner4@example.com' });
  assert.equal(joined.code, 403, 'unset INVITE_CODES means no invite works');

  // --- open sign-up ---------------------------------------------------------
  // Off by default, so a deployment is never open by accident.
  assert.equal(
    (await joinWith(undefined, { sub: '777', email: 'anyone@example.com' })).code,
    403,
    'open sign-up is off unless turned on'
  );

  process.env.OPEN_SIGNUP = 'true';
  process.env.MAX_USERS = 'unlimited';

  joined = await joinWith(undefined, { sub: '777', email: 'anyone@example.com' });
  assert.equal(joined.code, 200, 'anyone may sign up when open');
  assert.ok(store.get('access:granted:anyone@example.com'), 'open sign-ups are still recorded');

  joined = await joinWith(undefined, { sub: '888', email: 'someone.else@example.com' });
  assert.equal(joined.code, 200, 'and the next person too');

  // Unverified addresses stay refused: identity still has to be real.
  const c = await call(connectHandler, { method: 'GET', query: {} });
  nextGoogleUser = { sub: '999', email: 'spoofed@example.com', verified: false };
  joined = await call(callbackHandler, {
    method: 'GET',
    query: { code: 'g-code', state: stateFrom(c.text) }
  });
  assert.equal(joined.code, 401, 'open does not mean unverified emails are accepted');

  // The cap still binds when it is set, even in open mode.
  process.env.MAX_USERS = '1';
  joined = await joinWith(undefined, { sub: '1010', email: 'latecomer@example.com' });
  assert.equal(joined.code, 403, 'MAX_USERS still caps an open server');
  assert.match(joined.text, /Server is full/);

  // Anyone already admitted keeps working once the cap is hit.
  joined = await joinWith(undefined, { sub: '777', email: 'anyone@example.com' });
  assert.equal(joined.code, 200, 'existing users are not locked out by the cap');

  delete process.env.OPEN_SIGNUP;
  delete process.env.MAX_USERS;

  console.log('✓ oauth flow ok (multi-user + invites + open)');
})();
