import { issuerFrom } from '../../src/oauth';
import { Req, Res, header, noStore } from '../_http';

/**
 * Authorization Server Metadata (RFC 8414), served at
 * /.well-known/oauth-authorization-server via a rewrite.
 *
 * This is how an MCP client discovers the endpoints, so the issuer must match
 * the host the client actually reached — a hardcoded issuer breaks preview
 * deployments and silently invalidates audience checks.
 */
export default async function handler(req: Req, res: Res) {
  const issuer = issuerFrom(header(req, 'host'));
  noStore(res);
  return res.status(200).json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // S256 only: `plain` is advertised nowhere because it is refused everywhere.
    code_challenge_methods_supported: ['S256'],
    // Public clients cannot hold a secret; PKCE carries the security instead.
    token_endpoint_auth_methods_supported: ['none']
  });
}
