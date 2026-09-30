import process from "node:process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

type ProcessLike = {
  exit(code?: number): never;
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  stdin: {
    once(event: string, listener: () => void): unknown;
    off(event: string, listener: () => void): unknown;
  };
};

type LifecycleOptions = {
  /** Stopping the bridge sends {kind:"bye"} to the extension and releases the port. */
  bridge: { stop(): Promise<void> };
  /** MCP stdio server; omitted for the daemon, which then ignores stdin. */
  server?: Pick<McpServer, "close">;
  transport?: Pick<StdioServerTransport, "close">;
  processRef?: ProcessLike;
  exitOnShutdown?: boolean;
};

export function installLifecycleHandlers(options: LifecycleOptions): { shutdown: () => Promise<void> } {
  const {
    bridge,
    server,
    transport,
    processRef = process,
    exitOnShutdown = true
  } = options;

  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      detach();
      shutdownPromise = (async () => {
        // bridge.stop() awaits the bye message before closing the socket.
        await Promise.allSettled([
          server?.close(),
          transport?.close(),
          bridge.stop()
        ]);
      })().finally(() => {
        if (exitOnShutdown) {
          processRef.exit(0);
        }
      });
    }

    return shutdownPromise;
  };

  const onSignal = () => {
    void shutdown();
  };

  const onStdinClosed = () => {
    void shutdown();
  };

  const detach = (): void => {
    processRef.off("SIGINT", onSignal);
    processRef.off("SIGTERM", onSignal);
    processRef.stdin.off("end", onStdinClosed);
    processRef.stdin.off("close", onStdinClosed);
  };

  processRef.once("SIGINT", onSignal);
  processRef.once("SIGTERM", onSignal);
  if (transport) {
    processRef.stdin.once("end", onStdinClosed);
    processRef.stdin.once("close", onStdinClosed);
  }

  return { shutdown };
}
