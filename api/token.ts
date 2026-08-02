import { timingSafeEqual } from 'node:crypto';
import { GarminConnect } from 'garmin-connect';
import { encodeTokens } from '../src/garmin';

// Structural types instead of @vercel/node: that package is types-only for this
// handler but drags in a dev tree with known advisories. Vercel supplies the
// real runtime objects, and this shape also fits other Node serverless hosts.
type VercelRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type VercelResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): { json(body: unknown): unknown };
};

/**
 * Exchanges Garmin credentials for OAuth tokens and hands them straight back to
 * the caller. Nothing is stored: no database, no disk write, no credential
 * logging. The tokens exist only in this function's memory and the response.
 *
 * This endpoint takes a password over the wire, so it is deliberately useless
 * until an access gate is configured — see `assertGate`.
 */

function assertGate(req: VercelRequest): string | null {
  const expected = process.env.AUTH_GATE_SECRET;
  // Fail closed. An unconfigured deployment is a credential-harvesting page
  // wearing a login form, so refuse to serve rather than default to open.
  if (!expected) {
    return 'This deployment has no AUTH_GATE_SECRET configured and is disabled.';
  }
  if (expected.length < 16) {
    return 'AUTH_GATE_SECRET is too short to be meaningful. Use 16+ random characters.';
  }

  const provided = String(req.headers['x-auth-gate'] ?? '');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Compare in constant time, and only when lengths match — timingSafeEqual
  // throws on a length mismatch, which would itself leak the length.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return 'Incorrect access key.';
  }
  return null;
}

/** Garmin's own errors can echo the submitted form back; never forward them raw. */
function safeMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : '';
  if (/ticket not found|mfa/i.test(raw)) {
    return 'Garmin did not accept those credentials. If your account has two-factor authentication enabled, this tool cannot complete the login — use the local `npm run auth` command instead.';
  }
  if (/429|too many/i.test(raw)) {
    return 'Garmin is rate limiting these attempts. Wait several minutes before retrying.';
  }
  if (/locked/i.test(raw)) {
    return 'Garmin reports this account as locked. Sign in at connect.garmin.com to clear it.';
  }
  return 'Login failed. Check the email and password and try again.';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Tokens are account credentials; keep them out of every cache in the chain.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST.' });
  }

  const gateError = assertGate(req);
  if (gateError) return res.status(401).json({ error: gateError });

  const parsed = (typeof req.body === 'string' ? safeParse(req.body) : req.body) ?? {};
  const body = parsed as Record<string, unknown>;
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Both email and password are required.' });
  }

  try {
    const client = new GarminConnect({ username: email, password });
    await client.login();
    const tokens = client.exportToken();

    return res.status(200).json({
      tokensBase64: encodeTokens(tokens),
      tokens,
      // displayName is a Garmin-internal uuid, so this is not a second identifier.
      expiresAt: tokens.oauth2?.refresh_token_expires_at
    });
  } catch (err) {
    // Deliberately not logging the error object: Garmin's axios errors carry
    // request config, and the login body contains the password.
    console.error('garmin login failed');
    return res.status(401).json({ error: safeMessage(err) });
  }
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
