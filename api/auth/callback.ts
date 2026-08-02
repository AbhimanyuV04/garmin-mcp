import { loadTokens } from '../../src/db';
import { exchangeCode, isAllowed, userIdFor } from '../../src/google';
import {
  DEPOSIT_TTL,
  depositAudience,
  getRequest,
  issueCode,
  requireSecret,
  signJwt,
  takeLoginState
} from '../../src/oauth';
import { Req, Res, esc, html, issuerOf, page, param } from '../_http';

/**
 * GET /auth/callback — where Google returns after sign-in.
 *
 * Handles both entry points: an MCP client waiting on an authorization code,
 * and a person onboarding through /connect. Which one is recorded server-side
 * against the state parameter, so the callback URL itself cannot redirect the
 * result somewhere new.
 *
 * A waiting MCP client must always be given an answer. Rendering a page and
 * stopping leaves it spinning with no way to know the flow ended, so every
 * terminal outcome here either redirects back to the client or offers a way to
 * finish in place.
 */
export default async function handler(req: Req, res: Res) {
  const issuer = issuerOf(req);

  const error = param(req, 'error');
  if (error) {
    return html(res, 400, page('Sign-in cancelled', `Google reported: ${esc(error)}`));
  }

  const code = param(req, 'code');
  // State is single use and must exist in Redis, so a callback that did not
  // originate here is refused rather than processed.
  const state = await takeLoginState(param(req, 'state') ?? '');
  if (!code || !state) {
    return html(
      res,
      400,
      page('Sign-in expired', 'That link is no longer valid. Start again from the beginning.')
    );
  }

  // Fetched up front so failures can be reported back to the waiting client.
  const pending = state.intent === 'mcp' ? await getRequest(state.requestId) : null;

  // Returns false when nobody is waiting, so the caller renders a page instead.
  // Not written as `bounce(...) ?? html(...)`: res.end() yields undefined, so
  // that form would fire the redirect and then overwrite it with the page.
  const bounce = (err: string, description: string): boolean => {
    if (!pending) return false;
    const url = new URL(pending.redirect_uri);
    url.searchParams.set('error', err);
    url.searchParams.set('error_description', description);
    if (pending.state) url.searchParams.set('state', pending.state);
    res.setHeader('Location', url.toString());
    res.status(302).end();
    return true;
  };

  let identity;
  try {
    identity = await exchangeCode(issuer, code);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sign-in failed.';
    if (bounce('access_denied', message)) return;
    return html(res, 401, page('Sign-in failed', esc(message)));
  }

  // The allowlist is what keeps this from being an open service that stores
  // strangers' health data.
  if (!isAllowed(identity.email)) {
    if (bounce('access_denied', `${identity.email} is not permitted to use this server.`)) return;
    return html(
      res,
      403,
      page(
        'Not on the list',
        `<strong>${esc(identity.email)}</strong> isn't allowed to use this server.
         Ask the owner to add it to <code>ALLOWED_EMAILS</code>.`
      )
    );
  }

  const userId = userIdFor(identity);
  const hasGarmin = Boolean(await loadTokens(userId));

  let secret: string;
  try {
    secret = requireSecret('JWT_SECRET');
  } catch {
    return html(res, 503, page('Not configured', 'JWT_SECRET is not set.'));
  }
  const now = Math.floor(Date.now() / 1000);
  // Scoped to linking only: this token cannot read Garmin data.
  const depositToken = signJwt(
    { sub: userId, iss: issuer, aud: depositAudience(issuer), exp: now + DEPOSIT_TTL },
    secret
  );

  if (state.intent === 'connect') {
    return html(res, 200, linkPage(identity.email, depositToken, hasGarmin, issuer, null));
  }

  if (!pending) {
    return html(
      res,
      400,
      page('Request expired', 'The connection attempt timed out. Try connecting again from Claude.')
    );
  }

  // Signed in, but nothing to read yet. Rather than dead-ending, let them link
  // Garmin here and continue straight back to the client that is waiting.
  if (!hasGarmin) {
    return html(res, 200, linkPage(identity.email, depositToken, false, issuer, state.requestId));
  }

  const authCode = await issueCode({ ...pending, sub: userId });
  const url = new URL(pending.redirect_uri);
  url.searchParams.set('code', authCode);
  if (pending.state) url.searchParams.set('state', pending.state);
  res.setHeader('Location', url.toString());
  return res.status(302).end();
}

/**
 * @param requestId when present, an MCP client is waiting: linking Garmin
 *   should hand the browser straight back to it instead of stopping here.
 */
const linkPage = (
  email: string,
  depositToken: string,
  hasGarmin: boolean,
  issuer: string,
  requestId: string | null
) =>
  page(
    'Connect your Garmin',
    `Signed in as <strong>${esc(email)}</strong>.`,
    `${
      requestId
        ? `<div class="card">Claude is waiting for this. Link your Garmin account and
             you'll be sent straight back.</div>`
        : ''
    }
     ${
       hasGarmin
         ? `<div class="card"><span class="ok">✓</span> Garmin is already linked to this
              account. Submitting again replaces the stored login.</div>`
         : ''
     }
     <div class="card">
       Your Garmin password is used once to obtain an access token, then discarded.
       It is never stored or logged. Accounts with two-factor authentication are
       not supported.
     </div>
     <form id="f" autocomplete="off">
       <label for="email">Garmin email</label>
       <input id="email" type="email" required autocomplete="off">
       <label for="password">Garmin password</label>
       <input id="password" type="password" required autocomplete="off">
       <button id="go" type="submit">Link Garmin</button>
     </form>
     <p class="err" id="err" hidden></p>
     <div id="done" hidden>
       <div class="card"><span class="ok">✓</span> Garmin linked. Add this as a custom
         connector in Claude:<br><br><code>${esc(issuer)}/mcp</code></div>
       <button class="btn secondary" id="unlink" type="button">Unlink my Garmin data</button>
     </div>
     <script>
       var TOKEN = ${JSON.stringify(depositToken)};
       var REQUEST_ID = ${JSON.stringify(requestId)};
       var $ = function (id) { return document.getElementById(id); };
       function fail(msg) { $('err').textContent = msg; $('err').hidden = false; }
       $('f').addEventListener('submit', async function (e) {
         e.preventDefault();
         $('err').hidden = true;
         $('go').disabled = true;
         $('go').textContent = 'Contacting Garmin...';
         try {
           var r = await fetch('/api/deposit', {
             method: 'POST',
             headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
             body: JSON.stringify({ email: $('email').value, password: $('password').value })
           });
           var data = await r.json();
           if (!r.ok) throw new Error(data.error || 'Request failed.');
           $('password').value = '';
           if (REQUEST_ID) {
             $('go').textContent = 'Returning to Claude...';
             var rs = await fetch('/auth/resume', {
               method: 'POST',
               headers: {
                 'content-type': 'application/x-www-form-urlencoded',
                 authorization: 'Bearer ' + TOKEN
               },
               body: new URLSearchParams({ request_id: REQUEST_ID })
             });
             var out = await rs.json();
             if (rs.ok && out.redirect) { window.location.href = out.redirect; return; }
             throw new Error(out.error || 'Could not return to Claude. Retry from Claude.');
           }
           $('f').hidden = true;
           $('done').hidden = false;
         } catch (err) {
           fail(err.message);
         } finally {
           $('go').disabled = false;
           $('go').textContent = 'Link Garmin';
         }
       });
       var unlink = $('unlink');
       if (unlink) unlink.addEventListener('click', async function () {
         if (!confirm('Delete your stored Garmin tokens from this server?')) return;
         var r = await fetch('/api/deposit', {
           method: 'DELETE',
           headers: { authorization: 'Bearer ' + TOKEN }
         });
         alert(r.ok ? 'Deleted.' : 'Could not delete. Try again.');
       });
     </script>`
  );
