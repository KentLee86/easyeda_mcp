export type ExtensionBridgeConfig = {
  host: string;
  port: number;
  openTimeoutMs: number;
  heartbeatIntervalMs: number;
  /** Reconnect when the server has been silent this long (it acks every heartbeat). */
  livenessTimeoutMs: number;
  /** Backoff for the first attempts; afterwards the last delay repeats forever. */
  reconnectDelayMs: number[];
  /** Suffix of the global that holds connection state (dev hot-load uses its own). */
  stateKey: string;
};

type BridgeConfigOverride = Partial<ExtensionBridgeConfig>;

const defaultBridgeConfig: ExtensionBridgeConfig = {
  host: "127.0.0.1",
  port: 8765,
  // Localhost opens take milliseconds, and sys_WebSocket reports no failure
  // event, so a short open timeout and a ~1 s retry cadence are the fastest way
  // to find a server that starts later (about two cheap attempts per second).
  openTimeoutMs: 1_000,
  heartbeatIntervalMs: 3_000,
  livenessTimeoutMs: 10_000,
  reconnectDelayMs: [0, 250, 500, 1_000],
  stateKey: ""
};

function resolveOverrides(): BridgeConfigOverride {
  const globalOverride = (globalThis as { __EASYEDA_MCP_BRIDGE_CONFIG__?: BridgeConfigOverride }).__EASYEDA_MCP_BRIDGE_CONFIG__;
  return globalOverride ?? {};
}

export function getBridgeConfig(): ExtensionBridgeConfig {
  const override = resolveOverrides();
  return {
    ...defaultBridgeConfig,
    ...override,
    reconnectDelayMs: Array.isArray(override.reconnectDelayMs) && override.reconnectDelayMs.length > 0
      ? override.reconnectDelayMs.filter((delay) => Number.isFinite(delay) && delay >= 0)
      : defaultBridgeConfig.reconnectDelayMs
  };
}

export function getBridgeUri(config = getBridgeConfig()): string {
  return `ws://${config.host}:${config.port}`;
}
