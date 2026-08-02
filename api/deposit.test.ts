import assert from 'node:assert/strict';
import handler from './deposit';

type Captured = { code: number; body: any };

function invoke(opts: {
  method?: string;
  gate?: string;
  body?: unknown;
  secret?: string;
}): Promise<Captured> {
  if (opts.secret === undefined) delete process.env.AUTH_GATE_SECRET;
  else process.env.AUTH_GATE_SECRET = opts.secret;

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
    headers: opts.gate === undefined ? {} : { 'x-auth-gate': opts.gate },
    body: opts.body
  };
  return handler(req as any, res as any).then(() => captured);
}

const GOOD = 'a'.repeat(24);
const creds = { email: 'someone@example.com', password: 'pw' };

(async () => {
  // The load-bearing property: with no secret configured the endpoint is inert,
  // so an unconfigured deploy cannot harvest anyone's credentials.
  let r = await invoke({ body: creds });
  assert.equal(r.code, 401, 'unconfigured deployment must refuse');
  assert.match(r.body.error, /no AUTH_GATE_SECRET/);

  // A short secret is brute-forceable, so treat it as unconfigured.
  r = await invoke({ secret: 'short', gate: 'short', body: creds });
  assert.equal(r.code, 401);
  assert.match(r.body.error, /too short/);

  r = await invoke({ secret: GOOD, gate: 'b'.repeat(24), body: creds });
  assert.equal(r.code, 401, 'wrong key rejected');
  assert.match(r.body.error, /Incorrect access key/);

  r = await invoke({ secret: GOOD, gate: 'a'.repeat(23), body: creds });
  assert.equal(r.code, 401, 'length mismatch rejected, not thrown');

  r = await invoke({ secret: GOOD, body: creds });
  assert.equal(r.code, 401, 'missing key rejected');

  // Gate is checked before the body, so probing does not reveal validation rules.
  r = await invoke({ secret: GOOD, gate: 'b'.repeat(24), body: {} });
  assert.match(r.body.error, /Incorrect access key/, 'gate precedes body validation');

  r = await invoke({ method: 'GET', secret: GOOD, gate: GOOD });
  assert.equal(r.code, 405, 'GET refused');

  // With a valid key, missing fields fail before any network call to Garmin.
  r = await invoke({ secret: GOOD, gate: GOOD, body: { email: '', password: '' } });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /required/);

  // Body may arrive as a raw string; malformed JSON must not throw.
  r = await invoke({ secret: GOOD, gate: GOOD, body: '{"bad json' });
  assert.equal(r.code, 400, 'malformed body rejected cleanly');

  console.log('✓ token endpoint gate ok');
  process.exit(0);
})();
