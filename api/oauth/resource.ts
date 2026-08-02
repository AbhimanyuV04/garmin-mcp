import { issuerFrom, resourceUrl } from '../../src/oauth';
import { Req, Res, header, noStore } from '../_http';

/**
 * Protected Resource Metadata (RFC 9728), served at
 * /.well-known/oauth-protected-resource via a rewrite.
 *
 * Points the MCP client at the authorization server that guards this resource.
 * Without it a client receiving a 401 has no way to discover where to log in.
 */
export default async function handler(req: Req, res: Res) {
  const issuer = issuerFrom(header(req, 'host'));
  noStore(res);
  return res.status(200).json({
    resource: resourceUrl(issuer),
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: ['garmin:read', 'garmin:write']
  });
}
