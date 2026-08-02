import { getClient, putLoginState, putRequest, redirectUriAllowed } from '../../src/oauth';
import { googleAuthUrl, googleConfigured } from '../../src/google';
import { Req, Res, esc, html, issuerOf, param, page } from '../_http';

/**
 * GET /authorize
 *
 * Validation order is a security property, not a style choice. Until client_id
 * and redirect_uri are both known good, errors are rendered here rather than
 * redirected — redirecting an unverified redirect_uri is exactly the open
 * redirect that leaks authorization codes.
 *
 * Once validated, the user is handed to Google. This server never sees a
 * password, so there is nothing here to guess or leak.
 */
export default async function handler(req: Req, res: Res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return html(res, 405, page('Method not allowed', 'Use GET.'));
  }

  if (!googleConfigured()) {
    return html(
      res,
      503,
      page('Not configured', 'This deployment has no Google sign-in configured.')
    );
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

  const issuer = issuerOf(req);
  const loginState = await putLoginState({ intent: 'mcp', requestId });

  return html(res, 200, consentPage(client.client_name ?? clientId, googleAuthUrl(issuer, loginState)));
}

const consentPage = (clientName: string, googleUrl: string) =>
  page(
    'Authorize access',
    `<strong>${esc(clientName)}</strong> is asking to read your Garmin data through
     this server. Sign in to confirm it's you.`,
    `<a class="btn" href="${esc(googleUrl)}">Continue with Google</a>
     <p class="fine">You'll be signed in as whichever Google account you choose.
     Your Garmin data stays tied to that account.</p>`
  );
