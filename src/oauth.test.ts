import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  isUsableRedirectUri,
  redirectUriAllowed,
  safeEqual,
  signJwt,
  verifyJwt,
  verifyPkce
} from './oauth';

const SECRET = 'x'.repeat(32);
const OTHER = 'y'.repeat(32);
const ctx = { iss: 'https://mcp.example', aud: 'https://mcp.example/api/mcp' };
const now = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------ safeEqual
assert.equal(safeEqual('abc', 'abc'), true);
assert.equal(safeEqual('abc', 'abd'), false);
assert.equal(safeEqual('abc', 'abcd'), false, 'length mismatch returns, never throws');
assert.equal(safeEqual('', ''), true);

// ----------------------------------------------------------------------- JWT
const good = signJwt({ sub: 'owner', ...ctx, exp: now() + 60 }, SECRET);
assert.equal(verifyJwt(good, SECRET, ctx)?.sub, 'owner', 'round-trips');

assert.equal(verifyJwt(good, OTHER, ctx), null, 'wrong signing key rejected');
assert.equal(verifyJwt(good + 'x', SECRET, ctx), null, 'tampered signature rejected');
assert.equal(verifyJwt('a.b', SECRET, ctx), null, 'malformed token rejected');
assert.equal(verifyJwt('', SECRET, ctx), null);

const expired = signJwt({ sub: 'owner', ...ctx, exp: now() - 1 }, SECRET);
assert.equal(verifyJwt(expired, SECRET, ctx), null, 'expired token rejected');

// A token minted for a different service on the same secret must not pass here.
const wrongAud = signJwt({ sub: 'owner', iss: ctx.iss, aud: 'https://elsewhere', exp: now() + 60 }, SECRET);
assert.equal(verifyJwt(wrongAud, SECRET, ctx), null, 'audience is enforced');

const wrongIss = signJwt({ sub: 'owner', iss: 'https://evil', aud: ctx.aud, exp: now() + 60 }, SECRET);
assert.equal(verifyJwt(wrongIss, SECRET, ctx), null, 'issuer is enforced');

// alg:none is the classic JWT bypass — the header must never select the algorithm.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const algNone = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'owner', ...ctx, exp: now() + 60 })}.`;
assert.equal(verifyJwt(algNone, SECRET, ctx), null, 'alg:none rejected');

// Re-signing the payload under a different declared alg must still fail.
const [, payload, sig] = good.split('.');
const swapped = `${b64({ alg: 'HS512', typ: 'JWT' })}.${payload}.${sig}`;
assert.equal(verifyJwt(swapped, SECRET, ctx), null, 'header swap invalidates signature');

// Escalating the subject invalidates the signature.
const tampered = `${good.split('.')[0]}.${b64({ sub: 'admin', ...ctx, exp: now() + 60 })}.${sig}`;
assert.equal(verifyJwt(tampered, SECRET, ctx), null, 'payload tampering rejected');

// ---------------------------------------------------------------------- PKCE
const verifier = randomBytes(32).toString('base64url'); // 43 chars
const challenge = createHash('sha256').update(verifier).digest('base64url');

assert.equal(verifyPkce(verifier, challenge, 'S256'), true);
assert.equal(verifyPkce('wrong'.padEnd(43, 'a'), challenge, 'S256'), false, 'wrong verifier fails');
assert.equal(verifyPkce(verifier, challenge, 'plain'), false, 'plain method refused');
assert.equal(verifyPkce(verifier, challenge, ''), false);
// Downgrade attempt: presenting the challenge as its own verifier.
assert.equal(verifyPkce(challenge, challenge, 'S256'), false);
assert.equal(verifyPkce('short', challenge, 'S256'), false, 'below 43 chars refused');
assert.equal(verifyPkce('a'.repeat(129), challenge, 'S256'), false, 'above 128 chars refused');
assert.equal(verifyPkce('a'.repeat(43) + '!', challenge, 'S256'), false, 'invalid charset refused');

// -------------------------------------------------------------- redirect_uri
const registered = ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:5173/cb'];
assert.equal(redirectUriAllowed('https://claude.ai/api/mcp/auth_callback', registered), true);
assert.equal(redirectUriAllowed('http://localhost:5173/cb', registered), true);

// Every one of these is a real open-redirect shape that prefix matching allows.
for (const evil of [
  'https://claude.ai/api/mcp/auth_callback.evil.com',
  'https://claude.ai/api/mcp/auth_callback/../../steal',
  'https://claude.ai/api/mcp/auth_callback?next=https://evil',
  'https://claude.ai.evil.com/api/mcp/auth_callback',
  'https://claude.ai/api/mcp/auth_callbac',
  'HTTPS://CLAUDE.AI/api/mcp/auth_callback'
]) {
  assert.equal(redirectUriAllowed(evil, registered), false, `must reject ${evil}`);
}

assert.equal(isUsableRedirectUri('https://example.com/cb'), true);
assert.equal(isUsableRedirectUri('http://localhost:3000/cb'), true, 'loopback http allowed');
assert.equal(isUsableRedirectUri('http://127.0.0.1/cb'), true);
assert.equal(isUsableRedirectUri('http://example.com/cb'), false, 'plaintext non-loopback refused');
assert.equal(isUsableRedirectUri('javascript:alert(1)'), false);
assert.equal(isUsableRedirectUri('https://example.com/cb#frag'), false, 'fragments refused');
assert.equal(isUsableRedirectUri('not a url'), false);

console.log('✓ oauth primitives ok');
