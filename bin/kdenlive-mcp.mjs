#!/usr/bin/env node
import { runMcpServer } from "../src/mcp-server.mjs";

runMcpServer().catch((error) => {
  process.stderr.write(`kdenlive-mcp: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
