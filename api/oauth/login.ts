import { loadTokens } from '../../src/db';
import {
  OWNER_USER_ID,
  clearAttempts,
  getRequest,
  issueCode,
  requireSecret,
  safeEqual,
  tooManyAttempts
} from '../../src/oauth';
import { Req, Res, esc, formField, header, html } from '../_http';

/**
 * POST /api/oauth/login
 *
 * Verifies the owner, then mints the authorization code. The request_id links
 * this submission to a validated /authorize request, so the redirect target
 * comes from server-side state rather than from this form — a field here cannot
 * redirect the code somewhere new.
 */
export default async function handler(req: Req, res: Res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return html(res, 405, page('Method not allowed', 'Use POST.'));
  }

  let adminPassword: string;
  try {
    adminPassword = requireSecret('ADMIN_PASSWORD');
  } catch (err) {
    return html(
      res,
      503,
      page('Not configured', err instanceof Error ? err.message : 'Server misconfigured.')
    );
  }

  const requestId = formField(req, 'request_id') ?? '';
  const password = formField(req, 'password') ?? '';

  const pending = requestId ? await getRequest(requestId) : null;
  if (!pending) {
    return html(res, 400, page('Expired', 'This login request expired. Start again from your client.'));
  }

  // Throttle per client IP. Not perfect behind shared NATs, but it turns an
  // offline-speed guessing loop into a slow one.
  const who = header(req, 'x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (await tooManyAttempts(who)) {
    return html(res, 429, page('Too many attempts', 'Wait 15 minutes and try again.'));
  }

  if (!safeEqual(password, adminPassword)) {
    return html(res, 401, retryPage(requestId, 'Incorrect password.'));
  }
  await clearAttempts(who);

  // Bind the identity to a Garmin session now, so a client does not connect
  // successfully and then find every tool failing.
  const garmin = await loadTokens(OWNER_USER_ID);
  if (!garmin) {
    return html(
      res,
      409,
      page(
        'Garmin not connected',
        'Sign-in succeeded, but no Garmin tokens are stored for this account yet. Deposit them first, then reconnect.'
      )
    );
  }

  const code = await issueCode({ ...pending, sub: OWNER_USER_ID });

  const url = new URL(pending.redirect_uri);
  url.searchParams.set('code', code);
  if (pending.state) url.searchParams.set('state', pending.state);
  res.setHeader('Location', url.toString());
  return res.status(302).end();
}

const shell = (title: string, inner: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>
:root{--bg:#fff;--fg:#16181d;--muted:#5c6270;--line:#d8dbe2;--accent:#1f6feb;--err:#c0392b}
@media(prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e8eaed;--muted:#9aa1ad;--line:#2c3037;--accent:#5a9bff;--err:#ff8b7a}}
*{box-sizing:border-box}
body{margin:0;padding:3rem 1rem;background:var(--bg);color:var(--fg);
font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:24rem;margin:0 auto}
h1{font-size:1.15rem;margin:0 0 .3rem}
p{color:var(--muted);margin:0 0 1.5rem}
.err{color:var(--err)}
label{display:block;font-weight:600;font-size:.875rem;margin-bottom:.3rem}
input{width:100%;padding:.6rem .7rem;font:inherit;background:var(--bg);color:var(--fg);
border:1px solid var(--line);border-radius:6px;margin-bottom:1rem}
button{width:100%;font:inherit;font-weight:600;padding:.6rem 1rem;border:0;
border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}
</style></head><body><main>${inner}</main></body></html>`;

const page = (title: string, message: string) =>
  shell(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);

const retryPage = (requestId: string, error: string) =>
  shell(
    'Authorize access',
    `<h1>Authorize access</h1><p class="err">${esc(error)}</p>
     <form method="POST" action="/login" autocomplete="off">
       <input type="hidden" name="request_id" value="${esc(requestId)}">
       <label for="password">Admin password</label>
       <input id="password" name="password" type="password" required autocomplete="current-password">
       <button type="submit">Approve</button>
     </form>`
  );
