import { spawn } from "node:child_process";
import { closeSync, openSync, watch, type FSWatcher } from "node:fs";
import { fileURLToPath } from "node:url";
import { BridgeRpcError, BridgeUnavailableError } from "../bridge/errors.js";
import { RemoteBridge } from "../bridge/RemoteBridge.js";
import { configDir, daemonLogPath, DEFAULT_HTTP_PORT, ensureConfigDir, envHttpPort, readHubInfo, readToken } from "../bridge/config.js";

export const EXTENSION_WAIT_MS = 20_000;

export type HubConnection = {
  bridge: RemoteBridge;
  info: Record<string, unknown>;
  /** True when this invocation started the daemon. */
  started: boolean;
};

/** Try to reach the hub described by the config dir; undefined when none answers. */
export async function findHub(dir = configDir()): Promise<HubConnection | undefined> {
  const token = await readToken(dir);
  if (!token) {
    return undefined;
  }
  const hubInfo = await readHubInfo(dir);
  const bridge = new RemoteBridge({ token, httpPort: envHttpPort() ?? hubInfo?.httpPort ?? DEFAULT_HTTP_PORT });
  try {
    const info = await bridge.hubInfo(1_500);
    return { bridge, info, started: false };
  } catch (error) {
    if (error instanceof BridgeRpcError && error.code === "unauthorized") {
      throw new BridgeRpcError(`The hub at ${bridge.baseUrl} rejected the token in ${dir}. Is EASYEDA_MCP_CONFIG_DIR the same for the hub and this CLI?`, "unauthorized");
    }
    return undefined;
  }
}

/** Start `easyeda-pro-mcp daemon` detached, logging to <config dir>/daemon.log. */
export async function spawnDaemon(dir = configDir()): Promise<number | undefined> {
  await ensureConfigDir(dir);
  const entry = fileURLToPath(new URL("../index.js", import.meta.url));
  const log = openSync(daemonLogPath(dir), "a", 0o600);
  try {
    const child = spawn(process.execPath, [entry, "daemon"], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, EASYEDA_MCP_CONFIG_DIR: dir }
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(log);
  }
}

/**
 * Connect to the hub, starting a daemon when allowed. With requireExtension,
 * wait until the extension is connected — but only while the hub is young
 * (< EXTENSION_WAIT_MS since it started), so a stale disconnected hub fails fast.
 */
export async function connectHub(options: { start: boolean; requireExtension: boolean; dir?: string; waitMs?: number }): Promise<HubConnection> {
  const dir = options.dir ?? configDir();
  const waitMs = options.waitMs ?? EXTENSION_WAIT_MS;
  let connection = await findHub(dir);
  if (!connection) {
    if (!options.start) {
      throw new BridgeRpcError(`No easyeda-mcp hub is running (config dir ${dir}). Start one with \`easyeda daemon\`, run an MCP client, or drop --no-start.`, "hub_not_running");
    }
    const pid = await spawnDaemon(dir);
    connection = await waitForHub(dir, Date.now() + waitMs);
    if (!connection) {
      throw new BridgeRpcError(`Started a daemon (pid ${pid}) but its hub did not answer within ${waitMs / 1000}s. See ${daemonLogPath(dir)}.`, "hub_start_failed");
    }
    connection.started = true;
  }
  if (!options.requireExtension) {
    return connection;
  }
  const startedAt = Date.parse(String(connection.info.startedAt ?? ""));
  const deadline = connection.started ? Date.now() + waitMs : (Number.isFinite(startedAt) ? startedAt + waitMs : Date.now());
  // Long-poll: the hub answers as soon as the extension says hello.
  for (;;) {
    const remaining = deadline - Date.now();
    const status = remaining > 0 ? await connection.bridge.waitForStatus(remaining) : await connection.bridge.getStatus();
    if (status.connected && status.connectionState !== "connecting") {
      return connection;
    }
    if (Date.now() >= deadline - 10) {
      throw new BridgeUnavailableError(`${status.message ?? "EasyEDA Pro extension is not connected."} (hub ${connection.bridge.baseUrl})`);
    }
  }
}

/**
 * Wait for a freshly spawned daemon: react to hub.json appearing in the
 * config dir (fs.watch), with a slow poll as fallback.
 */
async function waitForHub(dir: string, deadline: number): Promise<HubConnection | undefined> {
  let watcher: FSWatcher | undefined;
  let wake: (() => void) | undefined;
  try {
    watcher = watch(dir, { persistent: false }, () => wake?.());
    watcher.on("error", () => undefined);
  } catch {
    watcher = undefined;
  }
  try {
    for (;;) {
      const connection = await findHub(dir);
      if (connection || Date.now() >= deadline) {
        return connection;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(watcher ? 500 : 100, Math.max(0, deadline - Date.now())));
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  } finally {
    watcher?.close();
  }
}
