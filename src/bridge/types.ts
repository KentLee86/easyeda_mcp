import type { EditorStatus } from "../protocol/messages.js";

/** How this process currently reaches the EasyEDA Pro extension. */
export type BridgeMode =
  /** This process owns the WebSocket port (and the hub HTTP endpoint). */
  | "owner"
  /** Another process owns the port; calls are forwarded to its hub over HTTP. */
  | "proxy"
  /** The port is held by something that is not a hub; retrying to bind it. */
  | "waiting"
  | "stopped";

/**
 * What the MCP tools and the CLI need from a bridge. Implemented by the local
 * WebSocket bridge (EasyEdaBridge), the HTTP client for a hub (RemoteBridge),
 * and BridgeHost, which switches between the two.
 */
export interface BridgeClient {
  readonly endpoint: string;
  getStatus(): EditorStatus | Promise<EditorStatus>;
  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  /** Optional diagnostics about how the bridge is wired (owner/proxy/...). */
  describe?(): Record<string, unknown>;
}
