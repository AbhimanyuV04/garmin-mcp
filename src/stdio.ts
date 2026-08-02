#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GarminSession } from './garmin';
import { createServer } from './create-server';

async function main() {
  // Local stdio serves exactly one user, so one session for the process life is
  // correct here — unlike the hosted transport, which builds one per request.
  const session = await GarminSession.create();
  await createServer(session).connect(new StdioServerTransport());
}

main().catch((err) => {
  // stdout is the MCP transport — diagnostics must go to stderr.
  console.error(`garmin-mcp failed to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
