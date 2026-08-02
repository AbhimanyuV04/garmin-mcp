import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'j'.repeat(32);

import { resolveUser } from './mcp';
import { signJwt } from '../src/oauth';

const SECRET = process.env.JWT_SECRET!;
const ISSUER = 'https://mcp.example';
const AUD = `${ISSUER}/api/mcp`;
const now = () => Math.floor(Date.now() / 1000);
const bearer = (claims: Parameters<typeof signJwt>[0]) => `Bearer ${signJwt(claims, SECRET)}`;

// Happy path.
const good = resolveUser(bearer({ sub: 'owner', iss: ISSUER, aud: AUD, exp: now() + 60 }), ISSUER);
assert.deepEqual(good, { ok: true, sub: 'owner' });

// Every rejection must be a 401 so the client knows to re-authenticate rather
// than treating it as a server fault and retrying blindly.
const rejects: [string, string | undefined][] = [
  ['no header', undefined],
  ['empty', ''],
  ['wrong scheme', 'Basic abc123'],
  ['bearer with no token', 'Bearer '],
  ['garbage token', 'Bearer not-a-jwt'],
  ['signed by another key', `Bearer ${signJwt({ sub: 'o', iss: ISSUER, aud: AUD, exp: now() + 60 }, 'k'.repeat(32))}`],
  ['expired', bearer({ sub: 'owner', iss: ISSUER, aud: AUD, exp: now() - 1 })],
  // A token for a different resource on the same secret must not open this one.
  ['wrong audience', bearer({ sub: 'owner', iss: ISSUER, aud: `${ISSUER}/api/other`, exp: now() + 60 })],
  ['wrong issuer', bearer({ sub: 'owner', iss: 'https://evil.example', aud: AUD, exp: now() + 60 })]
];

for (const [label, header] of rejects) {
  const result = resolveUser(header, ISSUER);
  assert.equal(result.ok, false, `${label} must be rejected`);
  assert.equal(result.ok === false && result.status, 401, `${label} must be 401`);
}

// A token issued for a different host must not work here, which is what stops
// a preview deployment's token from opening production.
const otherHost = resolveUser(
  bearer({ sub: 'owner', iss: ISSUER, aud: AUD, exp: now() + 60 }),
  'https://other.example'
);
assert.equal(otherHost.ok, false, 'issuer is bound to the host that was reached');

// Misconfiguration is a server fault, not an auth failure: a 401 would send the
// client into a login loop it can never satisfy.
const saved = process.env.JWT_SECRET;
delete process.env.JWT_SECRET;
const unconfigured = resolveUser('Bearer whatever', ISSUER);
assert.equal(unconfigured.ok === false && unconfigured.status, 503, 'missing secret is a 503');
process.env.JWT_SECRET = saved;

console.log('✓ mcp transport auth ok');
