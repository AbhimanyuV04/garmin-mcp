import { getClient, putRequest, redirectUriAllowed } from '../../src/oauth';
import { Req, Res, esc, html, param } from '../_http';

/**
 * GET /api/oauth/authorize
 *
 * Validation order is a security property, not a style choice. Until client_id
 * and redirect_uri are both known good, errors are rendered here rather than
 * redirected — redirecting an unverified redirect_uri is exactly the open
 * redirect that leaks authorization codes.
 */
export default async function handler(req: Req, res: Res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return html(res, 405, page('Method not allowed', 'Use GET.'));
  }

  const clientId = param(req, 'client_id');
  const redirectUri = param(req, 'redirect_uri');

  if (!clientId || !redirectUri) {
    return html(res, 400, page('Invalid request', 'client_id and redirect_uri are required.'));
  }

  const client = await getClient(clientId);
  if (!client) {
    return html(res, 400, page('Unknown client', 'This client_id is not registered.'));
  }
  if (!redirectUriAllowed(redirectUri, client.redirect_uris)) {
    return html(
      res,
      400,
      page('Redirect mismatch', 'That redirect_uri is not registered for this client.')
    );
  }

  // Past this point the redirect target is trusted, so failures go back to it.
  const state = param(req, 'state');
  const bounce = (error: string, description: string) => {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    url.searchParams.set('error_description', description);
    if (state) url.searchParams.set('state', state);
    res.setHeader('Location', url.toString());
    return res.status(302).end();
  };

  if (param(req, 'response_type') !== 'code') {
    return bounce('unsupported_response_type', 'Only response_type=code is supported.');
  }

  const codeChallenge = param(req, 'code_challenge');
  const method = param(req, 'code_challenge_method') ?? 'plain';
  if (!codeChallenge) {
    return bounce('invalid_request', 'PKCE is required: send code_challenge.');
  }
  if (method !== 'S256') {
    // Refusing `plain` is deliberate; it protects nothing if the code leaks.
    return bounce('invalid_request', 'code_challenge_method must be S256.');
  }

  const requestId = await putRequest({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: method,
    scope: param(req, 'scope')
  });

  return html(res, 200, loginPage(requestId, client.client_name ?? clientId));
}

const shell = (title: string, inner: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>
:root{--bg:#fff;--fg:#16181d;--muted:#5c6270;--line:#d8dbe2;--accent:#1f6feb}
@media(prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e8eaed;--muted:#9aa1ad;--line:#2c3037;--accent:#5a9bff}}
*{box-sizing:border-box}
body{margin:0;padding:3rem 1rem;background:var(--bg);color:var(--fg);
font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:24rem;margin:0 auto}
h1{font-size:1.15rem;margin:0 0 .3rem}
p{color:var(--muted);margin:0 0 1.5rem}
label{display:block;font-weight:600;font-size:.875rem;margin-bottom:.3rem}
input{width:100%;padding:.6rem .7rem;font:inherit;background:var(--bg);color:var(--fg);
border:1px solid var(--line);border-radius:6px;margin-bottom:1rem}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{width:100%;font:inherit;font-weight:600;padding:.6rem 1rem;border:0;
border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}
</style></head><body><main>${inner}</main></body></html>`;

const page = (title: string, message: string) =>
  shell(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);

const loginPage = (requestId: string, clientName: string) =>
  shell(
    'Authorize access',
    `<h1>Authorize access</h1>
     <p><strong>${esc(clientName)}</strong> is requesting access to your Garmin data
     through this server. Sign in to approve.</p>
     <form method="POST" action="/api/oauth/login" autocomplete="off">
       <input type="hidden" name="request_id" value="${esc(requestId)}">
       <label for="password">Admin password</label>
       <input id="password" name="password" type="password" required autocomplete="current-password">
       <button type="submit">Approve</button>
     </form>`
  );
