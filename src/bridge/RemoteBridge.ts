import { createDisconnectedStatus, type EditorStatus } from "../protocol/messages.js";
import { BridgeUnavailableError, errorFromWire, type WireError } from "./errors.js";
import { DEFAULT_CALL_TIMEOUT_MS } from "./HubServer.js";
import type { BridgeClient } from "./types.js";
import { HUB_HOST } from "./config.js";

export type RemoteBridgeOptions = {
  token: string;
  httpPort: number;
  host?: string;
  /** Extra slack on top of the call timeout for the HTTP request itself. */
  httpSlackMs?: number;
};

/** Thrown when the hub itself cannot be reached (nothing listening, reset, ...). */
export class HubUnreachableError extends BridgeUnavailableError {
  constructor(url: string, cause: unknown) {
    super(`EasyEDA MCP hub at ${url} is not reachable: ${cause instanceof Error ? (cause.cause as Error | undefined)?.message ?? cause.message : String(cause)}`);
    this.name = "HubUnreachableError";
  }
}

/** HTTP client for a hub; same call()/getStatus() contract as the local bridge. */
export class RemoteBridge implements BridgeClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly httpSlackMs: number;
  private lastStatus: EditorStatus = createDisconnectedStatus();

  constructor(options: RemoteBridgeOptions) {
    this.baseUrl = `http://${options.host ?? HUB_HOST}:${options.httpPort}`;
    this.token = options.token;
    this.httpSlackMs = options.httpSlackMs ?? 5_000;
  }

  get endpoint(): string {
    return this.baseUrl;
  }

  describe(): Record<string, unknown> {
    return { mode: "proxy", hubUrl: this.baseUrl };
  }

  async getStatus(): Promise<EditorStatus> {
    this.lastStatus = await this.request<EditorStatus>("GET", "/v1/status", undefined, 5_000);
    return this.lastStatus;
  }

  /**
   * Long-poll the hub until the extension has said hello (or timeoutMs, capped
   * by the hub at 60 s). Resolves with the status either way.
   */
  async waitForStatus(timeoutMs: number): Promise<EditorStatus> {
    const wait = Math.max(0, Math.round(timeoutMs));
    this.lastStatus = await this.request<EditorStatus>("GET", `/v1/status?waitFor=connected&timeoutMs=${wait}`, undefined, wait + this.httpSlackMs);
    return this.lastStatus;
  }

  async waitForConnected(timeoutMs: number): Promise<boolean> {
    const status = await this.waitForStatus(timeoutMs);
    return status.connected && status.connectionState !== "connecting";
  }

  /** Last status fetched by getStatus(), without a round trip. */
  get cachedStatus(): EditorStatus {
    return this.lastStatus;
  }

  async hubInfo(timeoutMs = 2_000): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/v1/hub", undefined, timeoutMs);
  }

  async call(method: string, params?: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    const body = await this.request<{ ok: true; result: unknown }>("POST", "/v1/call", { method, params, timeoutMs }, timeoutMs + this.httpSlackMs);
    return body.result;
  }

  async shutdown(): Promise<unknown> {
    return this.request("POST", "/v1/shutdown", {}, 5_000);
  }

  private async request<T>(verb: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: verb,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(verb === "POST" ? { "content-type": "application/json" } : {})
        },
        body: verb === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new HubUnreachableError(this.baseUrl, error);
    }
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new HubUnreachableError(this.baseUrl, new Error(`non-JSON response (HTTP ${response.status})`));
    }
    if (!response.ok || (typeof payload === "object" && payload !== null && (payload as { ok?: unknown }).ok === false)) {
      const error = (payload as { error?: WireError }).error ?? { code: `http_${response.status}`, message: `Hub answered HTTP ${response.status}.` };
      throw errorFromWire(error);
    }
    return payload as T;
  }
}
