import {
  ACCESS_TTL,
  REFRESH_TTL,
  issueRefresh,
  issuerFrom,
  requireSecret,
  safeEqual,
  signJwt,
  takeCode,
  takeRefresh,
  verifyPkce
} from '../../src/oauth';
import { Req, Res, formField, header, noStore, oauthError } from '../_http';

/**
 * POST /api/oauth/token
 *
 * Public clients only, so there is no client_secret to check: PKCE is what
 * proves the caller is the same party that started the flow. Codes and refresh
 * tokens are both consumed atomically, so a replay finds nothing.
 */
export default async function handler(req: Req, res: Res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return oauthError(res, 405, 'invalid_request', 'Use POST.');
  }

  let jwtSecret: string;
  try {
    jwtSecret = requireSecret('JWT_SECRET');
  } catch (err) {
    return oauthError(res, 503, 'server_error', err instanceof Error ? err.message : undefined);
  }

  const issuer = issuerFrom(header(req, 'host'));
  const grant = formField(req, 'grant_type');

  if (grant === 'authorization_code') {
    const code = formField(req, 'code');
    const verifier = formField(req, 'code_verifier');
    const clientId = formField(req, 'client_id');
    const redirectUri = formField(req, 'redirect_uri');

    if (!code || !verifier || !clientId) {
      return oauthError(
        res,
        400,
        'invalid_request',
        'code, code_verifier and client_id are required.'
      );
    }

    // Single-use: consumed here whether or not the rest validates, so a leaked
    // code cannot be retried against a different verifier.
    const record = await takeCode(code);
    if (!record) {
      return oauthError(res, 400, 'invalid_grant', 'Authorization code is invalid or expired.');
    }
    // The code was issued to one client for one redirect_uri; both must match
    // or a different client could redeem an intercepted code.
    if (!safeEqual(record.client_id, clientId)) {
      return oauthError(res, 400, 'invalid_grant', 'Code was issued to a different client.');
    }
    if (redirectUri && !safeEqual(record.redirect_uri, redirectUri)) {
      return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the request.');
    }
    if (!verifyPkce(verifier, record.code_challenge, record.code_challenge_method)) {
      return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed.');
    }

    return issue(res, record.sub, clientId, issuer, jwtSecret, record.scope);
  }

  if (grant === 'refresh_token') {
    const presented = formField(req, 'refresh_token');
    const clientId = formField(req, 'client_id');
    if (!presented || !clientId) {
      return oauthError(res, 400, 'invalid_request', 'refresh_token and client_id are required.');
    }

    // Rotation: the presented token is destroyed as it is read.
    const record = await takeRefresh(presented);
    if (!record) {
      return oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired.');
    }
    if (!safeEqual(record.client_id, clientId)) {
      return oauthError(res, 400, 'invalid_grant', 'Refresh token belongs to a different client.');
    }

    return issue(res, record.sub, clientId, issuer, jwtSecret);
  }

  return oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

async function issue(
  res: Res,
  sub: string,
  clientId: string,
  issuer: string,
  secret: string,
  scope?: string
) {
  const now = Math.floor(Date.now() / 1000);
  const access = signJwt(
    { sub, iss: issuer, aud: `${issuer}/api/mcp`, exp: now + ACCESS_TTL, scope },
    secret
  );
  const refresh = await issueRefresh(sub, clientId);

  noStore(res);
  return res.status(200).json({
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: refresh,
    refresh_expires_in: REFRESH_TTL,
    scope
  });
}
