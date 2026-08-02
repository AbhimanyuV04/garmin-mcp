import { googleAuthUrl, googleConfigured } from '../src/google';
import { putLoginState } from '../src/oauth';
import { Req, Res, esc, html, issuerOf, page } from './_http';

/**
 * GET /connect — the entry point a person is given.
 *
 * Sign in with Google, link Garmin, then add the connector URL to Claude. Each
 * person's Garmin tokens are stored against their own Google account, so two
 * people sharing this deployment never see each other's data.
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

  const state = await putLoginState({ intent: 'connect' });

  return html(
    res,
    200,
    page(
      'Connect Garmin to Claude',
      'Link your Garmin account so Claude can read your sleep, runs and training data.',
      `<ol>
         <li>Sign in with Google — this identifies you, nothing is posted to your account.</li>
         <li>Enter your Garmin login once, so this server can fetch your data.</li>
         <li>Add the connector URL to Claude.</li>
       </ol>
       <a class="btn" href="${esc(googleAuthUrl(issuer, state))}">Continue with Google</a>
       <p class="fine">Your data stays tied to the Google account you choose, and is only
       visible to you. Unaffiliated with Garmin.</p>`
    )
  );
}
