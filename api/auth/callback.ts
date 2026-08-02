import { loadTokens } from '../../src/db';
import { exchangeCode, isAllowed, userIdFor } from '../../src/google';
import {
  ACCESS_TTL,
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

  let identity;
  try {
    identity = await exchangeCode(issuer, code);
  } catch (err) {
    return html(
      res,
      401,
      page('Sign-in failed', esc(err instanceof Error ? err.message : 'Please try again.'))
    );
  }

  // The allowlist is what keeps this from being an open service that stores
  // strangers' health data.
  if (!isAllowed(identity.email)) {
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

  if (state.intent === 'connect') {
    let secret: string;
    try {
      secret = requireSecret('JWT_SECRET');
    } catch {
      return html(res, 503, page('Not configured', 'JWT_SECRET is not set.'));
    }
    const now = Math.floor(Date.now() / 1000);
    // Scoped to the deposit endpoint only: this token cannot read Garmin data.
    const depositToken = signJwt(
      { sub: userId, iss: issuer, aud: depositAudience(issuer), exp: now + DEPOSIT_TTL },
      secret
    );
    const existing = await loadTokens(userId);
    return html(res, 200, connectPage(identity.email, depositToken, Boolean(existing), issuer));
  }

  // intent === 'mcp': finish the authorization the MCP client started.
  const pending = await getRequest(state.requestId);
  if (!pending) {
    return html(
      res,
      400,
      page('Request expired', 'The connection attempt timed out. Try connecting again.')
    );
  }

  const garmin = await loadTokens(userId);
  if (!garmin) {
    return html(
      res,
      409,
      page(
        'Garmin not connected yet',
        `You're signed in as <strong>${esc(identity.email)}</strong>, but this account
         has no Garmin data linked yet.`,
        `<a class="btn" href="${esc(issuer)}/connect">Connect Garmin</a>
         <p class="fine">Once that's done, try connecting from Claude again.</p>`
      )
    );
  }

  const authCode = await issueCode({ ...pending, sub: userId });
  const url = new URL(pending.redirect_uri);
  url.searchParams.set('code', authCode);
  if (pending.state) url.searchParams.set('state', pending.state);
  res.setHeader('Location', url.toString());
  return res.status(302).end();
}

const connectPage = (email: string, depositToken: string, hasGarmin: boolean, issuer: string) =>
  page(
    'Connect your Garmin',
    `Signed in as <strong>${esc(email)}</strong>.`,
    `${
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
       var $ = function (id) { return document.getElementById(id); };
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
           $('f').hidden = true;
           $('done').hidden = false;
         } catch (err) {
           $('err').textContent = err.message;
           $('err').hidden = false;
         } finally {
           $('go').disabled = false;
           $('go').textContent = 'Link Garmin';
         }
       });
       $('unlink').addEventListener('click', async function () {
         if (!confirm('Delete your stored Garmin tokens from this server?')) return;
         var r = await fetch('/api/deposit', {
           method: 'DELETE',
           headers: { authorization: 'Bearer ' + TOKEN }
         });
         alert(r.ok ? 'Deleted.' : 'Could not delete. Try again.');
       });
     </script>`
  );
