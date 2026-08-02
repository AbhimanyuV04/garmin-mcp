import { loadTokens } from '../../src/db';
import { depositAudience, getRequest, issueCode, requireSecret, verifyJwt } from '../../src/oauth';
import { Req, Res, formField, issuerOf, noStore } from '../_http';

/**
 * POST /auth/resume
 *
 * Finishes an MCP authorization that stalled because the person had no Garmin
 * account linked yet. They link it on the callback page, and this hands back
 * the redirect that returns them to the waiting client.
 *
 * Without it, the only way out of that state was to abandon the attempt and
 * start again from the client, which reads as "stuck forever".
 */
export default async function handler(req: Req, res: Res) {
  noStore(res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST.' });
  }

  let secret: string;
  try {
    secret = requireSecret('JWT_SECRET');
  } catch {
    return res.status(503).json({ error: 'Server is not configured.' });
  }

  const issuer = issuerOf(req);
  const bearer = /^Bearer (.+)$/.exec(String(req.headers['authorization'] ?? ''));
  if (!bearer) return res.status(401).json({ error: 'Sign in again.' });

  // The same short-lived token that authorises the deposit proves who this is,
  // so the code can only ever be issued for the signed-in person.
  const claims = verifyJwt(bearer[1], secret, { iss: issuer, aud: depositAudience(issuer) });
  if (!claims) return res.status(401).json({ error: 'Your sign-in expired. Start again.' });

  const requestId = formField(req, 'request_id');
  if (!requestId) return res.status(400).json({ error: 'Missing request_id.' });

  const pending = await getRequest(requestId);
  if (!pending) {
    return res.status(400).json({ error: 'That connection attempt expired. Retry from Claude.' });
  }

  if (!(await loadTokens(claims.sub))) {
    return res.status(409).json({ error: 'Link a Garmin account first.' });
  }

  const code = await issueCode({ ...pending, sub: claims.sub });
  const url = new URL(pending.redirect_uri);
  url.searchParams.set('code', code);
  if (pending.state) url.searchParams.set('state', pending.state);

  // Returned rather than sent as a 302: the caller is fetch(), which would
  // follow a redirect itself instead of navigating the window.
  return res.status(200).json({ redirect: url.toString() });
}
