import { BridgeHost } from "./bridge/BridgeHost.js";
import { installLifecycleHandlers } from "./lifecycle.js";

/**
 * `easyeda-pro-mcp daemon`: run only the bridge + hub HTTP API (no MCP stdio),
 * until SIGINT/SIGTERM or an authenticated POST /v1/shutdown.
 */
export async function runDaemon(): Promise<void> {
  let shutdown: (() => Promise<void>) | undefined;
  const host = new BridgeHost({
    role: "daemon",
    onShutdownRequest: () => {
      void shutdown?.();
    }
  });
  await host.start();
  if (host.currentMode === "proxy") {
    console.error(`[easyeda-mcp] Another hub already owns the bridge (${host.hubUrl}); nothing to do.`);
    await host.stop();
    process.exit(0);
  }
  ({ shutdown } = installLifecycleHandlers({ bridge: host }));
  console.error(`[easyeda-mcp] Daemon running (pid ${process.pid}, mode ${host.currentMode}). Stop with SIGTERM or \`easyeda stop\`.`);
}
