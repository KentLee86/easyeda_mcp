import { watch, type FSWatcher } from "node:fs";
import { createDisconnectedStatus, type EditorStatus } from "../protocol/messages.js";
import { SERVER_VERSION } from "../version.js";
import { EasyEdaBridge } from "./EasyEdaBridge.js";
import { BridgeUnavailableError } from "./errors.js";
import { HubServer, type HubRole } from "./HubServer.js";
import { HubUnreachableError, RemoteBridge } from "./RemoteBridge.js";
import type { BridgeClient, BridgeMode } from "./types.js";
import {
  configDir as defaultConfigDir,
  DEFAULT_HTTP_PORT,
  ensureConfigDir,
  ensureToken,
  envHttpPort,
  envWsPort,
  readHubInfo,
  readToken,
  removeHubInfo,
  writeHubInfo
} from "./config.js";

type Logger = Pick<Console, "error" | "warn" | "info">;

export type BridgeHostOptions = {
  role: HubRole;
  wsHost?: string;
  wsPort?: number;
  /** Hub HTTP port when this process becomes the owner (default $EASYEDA_MCP_HTTP_PORT or 8766). */
  httpPort?: number;
  configDir?: string;
  /** Whether to forward calls to another process's hub when the port is taken (default true). */
  allowProxy?: boolean;
  /** How often a non-owner re-checks the port / hub (default 2000 ms). */
  retryMs?: number;
  logger?: Logger;
  /** Called by POST /v1/shutdown on a daemon hub. */
  onShutdownRequest?: () => void;
};

/**
 * Owns the bridge for one process and decides how it reaches the extension:
 *
 * - owner:   bound the WebSocket port; also serves the hub HTTP API and writes hub.json.
 * - proxy:   the port belongs to another hub (verified with the token); calls go over HTTP.
 * - waiting: the port belongs to something that is not a hub; keep retrying to bind it.
 *
 * Every `retryMs` a non-owner tries to bind the port again, so when the owner
 * exits (and sends the extension a bye) one of the remaining processes takes over.
 */
export class BridgeHost implements BridgeClient {
  private readonly options: Required<Omit<BridgeHostOptions, "onShutdownRequest" | "httpPort" | "wsHost">> & Pick<BridgeHostOptions, "onShutdownRequest">;
  private readonly wsHost: string;
  private readonly httpPort: number;
  private readonly local: EasyEdaBridge;
  private hub?: HubServer;
  private remote?: RemoteBridge;
  private mode: BridgeMode = "stopped";
  private waitingMessage?: string;
  private timer?: NodeJS.Timeout;
  private watcher?: FSWatcher;
  private ticking?: Promise<void>;
  private readonly startedAt = new Date().toISOString();

  constructor(options: BridgeHostOptions) {
    this.wsHost = options.wsHost ?? process.env.EASYEDA_MCP_WS_HOST ?? "127.0.0.1";
    this.httpPort = options.httpPort ?? envHttpPort() ?? DEFAULT_HTTP_PORT;
    this.options = {
      role: options.role,
      wsPort: options.wsPort ?? envWsPort(),
      configDir: options.configDir ?? defaultConfigDir(),
      allowProxy: options.allowProxy ?? true,
      retryMs: options.retryMs ?? 2_000,
      logger: options.logger ?? console,
      onShutdownRequest: options.onShutdownRequest
    };
    this.local = new EasyEdaBridge({ host: this.wsHost, port: this.options.wsPort, logger: this.options.logger });
  }

  get currentMode(): BridgeMode {
    return this.mode;
  }

  get hubUrl(): string | undefined {
    return this.hub?.url ?? this.remote?.baseUrl;
  }

  get endpoint(): string {
    return this.local.endpoint;
  }

  get wsPort(): number {
    return this.local.boundPort ?? this.options.wsPort;
  }

  describe(): Record<string, unknown> {
    return {
      mode: this.mode,
      role: this.options.role,
      wsEndpoint: this.local.endpoint,
      ...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
      configDir: this.options.configDir
    };
  }

  async start(): Promise<void> {
    if (this.mode !== "stopped") {
      return;
    }
    this.mode = "waiting";
    await this.tick();
    this.watchHubFile();
    // Fallback for file systems without change events.
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.retryMs);
    this.timer.unref?.();
  }

  /**
   * The owner removes hub.json right before it releases the port, so a
   * non-owner that sees hub.json disappear re-checks at once instead of
   * waiting for the next interval tick.
   */
  private watchHubFile(): void {
    ensureConfigDir(this.options.configDir).then(() => {
      if (this.mode === "stopped" || this.watcher) {
        return;
      }
      try {
        this.watcher = watch(this.options.configDir, { persistent: false }, (_event, fileName) => {
          if (this.mode === "owner" || this.mode === "stopped") {
            return;
          }
          if (fileName === null || String(fileName) === "hub.json") {
            this.burst();
          }
        });
        this.watcher.on("error", () => this.unwatch());
      } catch {
        // No fs.watch here; the interval still covers takeover.
      }
    }, () => undefined);
  }

  /**
   * hub.json goes away just before the owner releases the port, so retry a few
   * times over the next second rather than once.
   */
  private burst(): void {
    if (this.burstTimers.length > 0) {
      return;
    }
    for (const delay of [0, 20, 50, 100, 200, 400, 700, 1_000]) {
      const timer = setTimeout(() => {
        this.burstTimers = this.burstTimers.filter((item) => item !== timer);
        if (this.mode === "waiting" || this.mode === "proxy") {
          void this.tick();
        }
      }, delay);
      timer.unref?.();
      this.burstTimers.push(timer);
    }
  }

  private burstTimers: NodeJS.Timeout[] = [];

  private unwatch(): void {
    for (const timer of this.burstTimers) {
      clearTimeout(timer);
    }
    this.burstTimers = [];
    this.watcher?.close();
    this.watcher = undefined;
  }

  async waitForConnected(timeoutMs: number): Promise<boolean> {
    if (this.mode === "proxy" && this.remote) {
      return this.remote.waitForConnected(timeoutMs).catch(() => false);
    }
    return this.local.waitForConnected(timeoutMs);
  }

  async stop(): Promise<void> {
    this.unwatch();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.ticking;
    const wasOwner = this.mode === "owner";
    this.mode = "stopped";
    this.remote = undefined;
    // Remove hub.json before releasing the port so we never delete the file
    // a successor has just written.
    if (wasOwner) {
      await removeHubInfo(process.pid, this.options.configDir).catch(() => undefined);
    }
    await this.hub?.stop();
    this.hub = undefined;
    // Sends {kind:"bye"} to the extension before closing.
    await this.local.stop();
  }

  getStatus(): EditorStatus | Promise<EditorStatus> {
    if (this.mode === "owner") {
      return this.local.getStatus();
    }
    if (this.mode === "proxy" && this.remote) {
      return this.remote.getStatus().catch((error) => {
        this.kick();
        return createDisconnectedStatus(error instanceof Error ? error.message : String(error));
      });
    }
    return createDisconnectedStatus(this.waitingMessage);
  }

  async call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.mode === "owner") {
      return this.local.call(method, params, timeoutMs);
    }
    if (this.mode === "proxy" && this.remote) {
      try {
        return await this.remote.call(method, params, timeoutMs);
      } catch (error) {
        if (error instanceof HubUnreachableError) {
          // The owner went away; try to take over the port right now.
          this.kick();
          throw new BridgeUnavailableError(`${error.message} This process will take over the bridge port; the extension reconnects within a few seconds. Retry.`);
        }
        throw error;
      }
    }
    throw new BridgeUnavailableError(this.waitingMessage);
  }

  /** Run a re-check soon (used when a proxied request finds the owner gone). */
  private kick(): void {
    void this.tick();
  }

  private tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = this.runTick().finally(() => {
        this.ticking = undefined;
      });
    }
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    if (this.mode === "owner" || this.mode === "stopped") {
      return;
    }
    if (await this.local.tryListen()) {
      await this.becomeOwner();
      return;
    }
    if (this.options.allowProxy) {
      const remote = await this.findHub();
      if (remote) {
        if (this.mode !== "proxy") {
          this.options.logger.error(`[easyeda-mcp] Bridge port ${this.wsHost}:${this.options.wsPort} is owned by the hub at ${remote.baseUrl}; forwarding calls to it.`);
        }
        this.remote = remote;
        this.mode = "proxy";
        return;
      }
    }
    const previous = this.mode;
    this.remote = undefined;
    this.mode = "waiting";
    this.waitingMessage = `Bridge port ${this.wsHost}:${this.options.wsPort} is used by another process that is not an EasyEDA MCP hub${this.options.allowProxy ? "" : " (or proxying is disabled)"}. ` +
      `Retrying every ${this.options.retryMs / 1000}s; stop the other process or set EASYEDA_MCP_WS_PORT for both server and extension.`;
    if (previous !== "waiting" || !this.loggedWaiting) {
      this.loggedWaiting = true;
      this.options.logger.error(`[easyeda-mcp] ${this.waitingMessage}`);
    }
  }

  private loggedWaiting = false;

  /** Find a hub that owns our WS port and accepts our token. */
  async findHub(): Promise<RemoteBridge | undefined> {
    const token = await readToken(this.options.configDir).catch(() => undefined);
    if (!token) {
      return undefined;
    }
    const info = await readHubInfo(this.options.configDir);
    const httpPort = envHttpPort() ?? info?.httpPort ?? this.httpPort;
    const remote = new RemoteBridge({ token, httpPort });
    try {
      const hub = await remote.hubInfo(1_500);
      if (typeof hub.wsPort === "number" && hub.wsPort !== this.options.wsPort) {
        return undefined;
      }
      await remote.getStatus();
      return remote;
    } catch {
      return undefined;
    }
  }

  private async becomeOwner(): Promise<void> {
    this.remote = undefined;
    this.mode = "owner";
    this.waitingMessage = undefined;
    try {
      const token = await ensureToken(this.options.configDir);
      const hub = new HubServer({
        bridge: this.local,
        token,
        role: this.options.role,
        port: this.httpPort,
        logger: this.options.logger,
        onShutdown: this.options.onShutdownRequest,
        info: () => ({ pid: process.pid, wsPort: this.wsPort, startedAt: this.startedAt, version: SERVER_VERSION })
      });
      await hub.start();
      this.hub = hub;
      await writeHubInfo({
        pid: process.pid,
        role: this.options.role,
        wsPort: this.wsPort,
        httpPort: hub.port,
        startedAt: this.startedAt,
        version: SERVER_VERSION
      }, this.options.configDir);
      this.options.logger.error(`[easyeda-mcp] Hub HTTP API listening at ${hub.url} (${this.options.role})`);
    } catch (error) {
      // The bridge still works for this process; only CLI/proxy access is lost.
      this.options.logger.error(`[easyeda-mcp] Hub HTTP API not started: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
