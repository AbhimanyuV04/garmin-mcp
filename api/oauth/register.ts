import { registerClient, isUsableRedirectUri } from '../../src/oauth';
import { Req, Res, oauthError, noStore } from '../_http';

/**
 * Dynamic Client Registration (RFC 7591).
 *
 * MCP clients such as Claude Web have no pre-issued client_id, so this endpoint
 * is what makes "paste a URL and connect" work at all. It is deliberately open,
 * as the spec intends: registering yields only an identifier. Nothing is
 * authorized until the owner passes the login step.
 */
export default async function handler(req: Req, res: Res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return oauthError(res, 405, 'invalid_request', 'Use POST.');
  }

  const body = (typeof req.body === 'string' ? safeParse(req.body) : req.body) as
    | Record<string, unknown>
    | null;

  const uris = body?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === 'string')) {
    return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be a non-empty array.');
  }
  if (uris.length > 10) {
    return oauthError(res, 400, 'invalid_redirect_uri', 'Too many redirect_uris.');
  }

  const bad = (uris as string[]).find((u) => !isUsableRedirectUri(u));
  if (bad) {
    return oauthError(
      res,
      400,
      'invalid_redirect_uri',
      `Redirect URIs must be https, or http on loopback: ${bad}`
    );
  }

  const name = typeof body?.client_name === 'string' ? body.client_name.slice(0, 120) : undefined;
  const client = await registerClient(uris as string[], name);

  noStore(res);
  return res.status(201).json({
    client_id: client.client_id,
    redirect_uris: client.redirect_uris,
    client_name: client.client_name,
    // Public client: it cannot hold a secret, so PKCE carries the security.
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code']
  });
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
