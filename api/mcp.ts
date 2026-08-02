import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { GarminSession } from '../src/garmin';
import { createServer } from '../src/server';
import { issuerFrom, requireSecret, verifyJwt } from '../src/oauth';

type Req = IncomingMessage & { body?: unknown };

/**
 * POST /api/mcp — the remote MCP endpoint.
 *
 * Stateless: a fresh transport, server and Garmin session are built per
 * request and discarded after. Vercel gives no instance affinity, so anything
 * held between requests would either be missing on the next invocation or,
 * worse, shared with a different user.
 */

export type AuthResult =
  | { ok: true; sub: string }
  | { ok: false; status: number; error: string; description: string };

/**
 * Resolves the bearer token to a user. Exported so the failure paths can be
 * tested without standing up a transport.
 */
export function resolveUser(authorization: string | undefined, issuer: string): AuthResult {
  let secret: string;
  try {
    secret = requireSecret('JWT_SECRET');
  } catch {
    return {
      ok: false,
      status: 503,
      error: 'server_error',
      description: 'JWT_SECRET is not configured.'
    };
  }

  const match = /^Bearer (.+)$/.exec(authorization ?? '');
  if (!match) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_request',
      description: 'Missing bearer token.'
    };
  }

  // Audience is scoped to this endpoint, so a token minted for another
  // resource on the same secret cannot be replayed here.
  const claims = verifyJwt(match[1], secret, { iss: issuer, aud: `${issuer}/api/mcp` });
  if (!claims) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_token',
      description: 'Token is invalid, expired, or issued for another resource.'
    };
  }

  return { ok: true, sub: claims.sub };
}

function cors(res: ServerResponse) {
  // No cookies are involved, so a wildcard origin cannot be abused to ride an
  // ambient session — the bearer token must be attached deliberately.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req: Req, res: ServerResponse) {
  cors(res);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const host = req.headers.host;
  const issuer = issuerFrom(Array.isArray(host) ? host[0] : host);
  const auth = resolveUser(req.headers.authorization, issuer);

  if (!auth.ok) {
    // RFC 9728: this header is how an MCP client discovers where to log in.
    // Without it Claude Web sees a bare 401 and cannot start the OAuth flow.
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="garmin-mcp", error="${auth.error}", ` +
        `resource_metadata="${issuer}/.well-known/oauth-protected-resource"`
    );
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = auth.status;
    return res.end(JSON.stringify({ error: auth.error, error_description: auth.description }));
  }

  // Lazy: a missing-token failure surfaces as a readable tool error rather than
  // breaking the handshake before the client can display anything.
  const session = GarminSession.forUser(auth.sub);
  const server = createServer(session);
  const transport = new StreamableHTTPServerTransport({
    // Stateless. A session id would promise resumability this deployment
    // cannot honour, since the next request lands on a different instance.
    sessionIdGenerator: undefined,
    // Plain JSON rather than an SSE stream: serverless functions are billed and
    // capped by wall-clock time, and a held-open stream burns both.
    enableJsonResponse: true
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    // Never echo the error: it can carry Garmin request config, including tokens.
    console.error('mcp request failed:', err instanceof Error ? err.message : 'unknown');
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        })
      );
    }
  } finally {
    // Release per-request state explicitly; the instance may be reused.
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
