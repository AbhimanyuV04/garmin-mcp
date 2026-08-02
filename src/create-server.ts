import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GarminSession } from './garmin';
import { registerActivityTools } from './tools/activities';
import { registerHealthTools } from './tools/health';
import { registerTrainingTools } from './tools/training';

/**
 * Builds an MCP server whose tools are bound to exactly one Garmin session.
 *
 * Every tool closes over `session`, so there is no ambient "current user" that
 * a second concurrent request could observe. A hosted deployment builds one of
 * these per request; the local stdio server builds one for its single user.
 */
export function createServer(session: GarminSession): McpServer {
  const server = new McpServer({ name: 'garmin-mcp', version: '0.2.0' });
  registerHealthTools(server, session);
  registerTrainingTools(server, session);
  registerActivityTools(server, session);
  return server;
}
