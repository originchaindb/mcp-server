#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readConfig } from "./config.js";
import { createDatabaseServer } from "./database-server.js";

const config = (() => {
  try { return readConfig(process.env); }
  catch (error) {
    process.stderr.write(`[originchain-mcp] FATAL: ${error instanceof Error ? error.message : 'invalid configuration'}\n`);
    process.exit(1);
  }
})();
// Configuration warnings go to stderr once at startup; stdout is reserved for MCP.
for (const warning of config.warnings) process.stderr.write(`[originchain-mcp] WARNING: ${warning}\n`);
const server = createDatabaseServer(config);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[originchain-mcp] ready; request timeout=${config.timeoutMs}ms\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `[originchain-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
