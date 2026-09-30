#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeHost } from "./bridge/BridgeHost.js";
import { runDaemon } from "./daemon.js";
import { installLifecycleHandlers } from "./lifecycle.js";
import { createMcpServer } from "./mcp/server.js";

async function main(): Promise<void> {
  if (process.argv[2] === "daemon") {
    await runDaemon();
    return;
  }

  // Owns the bridge port (and serves the hub HTTP API), or proxies to the
  // process that does.
  const bridge = new BridgeHost({ role: "mcp" });
  await bridge.start();

  const server = createMcpServer(bridge);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  installLifecycleHandlers({ bridge, server, transport });
}

main().catch((error) => {
  console.error(`[easyeda-mcp] Fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
