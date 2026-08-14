#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error("helsinki-transit MCP running on stdio");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
