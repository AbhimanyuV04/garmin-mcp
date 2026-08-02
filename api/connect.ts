import { accessCount, maxUsers } from '../src/db';
import { googleAuthUrl, googleConfigured } from '../src/google';
import { putLoginState } from '../src/oauth';
import { Req, Res, esc, html, issuerOf, page, param } from './_http';

/**
 * GET /connect — the entry point a person is given.
 *
 * Sign in with Google, link Garmin, then add the connector URL to Claude. Each
 * person's Garmin tokens are stored against their own Google account, so people
 * sharing this deployment never see each other's data.
 *
 * An invite code may arrive as ?invite=... so a whole group can be sent one
 * link. It is kept in server-side login state rather than re-read on the way
 * back, so the callback cannot be handed a code this server never issued.
 */
export default async function handler(req: Req, res: Res) {
  const issuer = issuerOf(req);

  if (!googleConfigured()) {
    return html(
      res,
      503,
      page(
        'Not configured',
        'This deployment has no Google sign-in configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.'
      )
    );
  }

  const invite = param(req, 'invite')?.trim();
  const state = await putLoginState({ intent: 'connect', invite });

  const cap = maxUsers();
  const full = (await accessCount()) >= cap;

  return html(
    res,
    200,
    page(
      'Connect Garmin to Claude',
      'Link your Garmin account so Claude can read your sleep, runs and training data.',
      `${
        full
          ? `<div class="card"><strong>This server is full.</strong> It is capped at
               ${cap} people. You can still run your own copy — it is open source.</div>`
          : ''
      }
       <ol>
         <li>Sign in with Google — this identifies you, nothing is posted to your account.</li>
         <li>Enter your Garmin login once, so this server can fetch your data.</li>
         <li>Add the connector URL to Claude.</li>
       </ol>
       ${
         invite
           ? `<div class="card">Using the invite code from your link.</div>`
           : `<form method="GET" action="/connect">
                <label for="invite">Invite code <span class="fine">(if you were given one)</span></label>
                <input id="invite" name="invite" type="text" autocomplete="off"
                       placeholder="Leave blank if the owner added your email">
                <button class="btn secondary" type="submit">Use code</button>
              </form>`
       }
       <a class="btn" href="${esc(googleAuthUrl(issuer, state))}">Continue with Google</a>
       <p class="fine">Whoever runs this server can see that you signed up, and stores a
       Garmin access token for you until you unlink. Your Garmin password is never stored.
       Unaffiliated with Garmin.</p>`
    )
  );
}
