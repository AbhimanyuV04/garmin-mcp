#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerHealthTools } from './tools/health';

const server = new McpServer({ name: 'garmin-mcp', version: '0.1.0' });

registerHealthTools(server);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  // stdout is the MCP transport — diagnostics must go to stderr.
  console.error(`garmin-mcp failed to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
