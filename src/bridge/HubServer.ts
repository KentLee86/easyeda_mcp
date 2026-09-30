import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { errorToWire, type WireError } from "./errors.js";
import type { BridgeClient } from "./types.js";
import { HUB_HOST } from "./config.js";

export const MAX_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_CALL_TIMEOUT_MS = 600_000;
export const DEFAULT_CALL_TIMEOUT_MS = 10_000;

export type HubRole = "mcp" | "daemon";

export type HubServerOptions = {
  /** The local bridge that owns the WebSocket connection to the extension. */
  bridge: BridgeClient;
  token: string;
  role: HubRole;
  port: number;
  host?: string;
  /** Extra fields for GET /v1/hub (pid, wsPort, ...). */
  info?: () => Record<string, unknown>;
  /** Called by POST /v1/shutdown. Only daemons accept it. */
  onShutdown?: () => void;
  logger?: Pick<Console, "error" | "warn" | "info">;
};

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/**
 * JSON-over-HTTP front door to the bridge owner. Used by the CLI, the Python
 * client, and other MCP server processes (proxy mode).
 *
 * Security: binds 127.0.0.1 only, requires `Authorization: Bearer <token>`,
 * rejects any request carrying an Origin header (browser pages, CSRF) or a
 * Host header that is not a loopback name (DNS rebinding), and only accepts
 * `application/json` bodies.
 */
export class HubServer {
  private server?: Server;
  private readonly host: string;
  private readonly tokenBuffer: Buffer;

  constructor(private readonly options: HubServerOptions) {
    this.host = options.host ?? HUB_HOST;
    this.tokenBuffer = Buffer.from(options.token, "utf8");
  }

  get port(): number {
    const address = this.server?.address() as AddressInfo | null | undefined;
    return address?.port ?? this.options.port;
  }

  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    const server = createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        this.send(response, 500, { ok: false, error: { code: "unexpected_error", message: String(error) } });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (error) => this.options.logger?.error(`[easyeda-mcp] Hub HTTP error: ${String(error)}`));
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      this.checkRequest(request);
      const url = new URL(request.url ?? "/", "http://hub");
      const route = `${request.method} ${url.pathname}`;
      switch (route) {
        case "GET /v1/status":
          this.send(response, 200, await this.options.bridge.getStatus());
          return;
        case "GET /v1/hub":
          this.send(response, 200, { ok: true, role: this.options.role, httpPort: this.port, ...this.options.info?.() });
          return;
        case "POST /v1/call":
          await this.handleCall(request, response);
          return;
        case "POST /v1/shutdown":
          await readJsonBody(request);
          if (this.options.role !== "daemon" || !this.options.onShutdown) {
            throw new HttpError(409, "not_daemon", "This hub belongs to an MCP stdio server; stop that MCP client instead.");
          }
          this.send(response, 200, { ok: true, shuttingDown: true });
          setImmediate(() => this.options.onShutdown?.());
          return;
        default:
          if (["/v1/status", "/v1/hub", "/v1/call", "/v1/shutdown"].includes(url.pathname)) {
            throw new HttpError(405, "method_not_allowed", `${request.method} is not allowed on ${url.pathname}.`);
          }
          throw new HttpError(404, "not_found", `Unknown endpoint ${url.pathname}.`);
      }
    } catch (error) {
      if (error instanceof HttpError) {
        this.send(response, error.status, { ok: false, error: { code: error.code, message: error.message } satisfies WireError });
        return;
      }
      throw error;
    }
  }

  private checkRequest(request: IncomingMessage): void {
    if (request.headers.origin !== undefined) {
      throw new HttpError(403, "origin_rejected", "Requests with an Origin header are rejected (browser pages may not use the hub).");
    }
    const host = (request.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
      throw new HttpError(403, "host_rejected", "The Host header must be 127.0.0.1 or localhost.");
    }
    const header = request.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const given = Buffer.from(match?.[1] ?? "", "utf8");
    if (given.length !== this.tokenBuffer.length || !timingSafeEqual(given, this.tokenBuffer)) {
      throw new HttpError(401, "unauthorized", "Missing or wrong bearer token (see the token file in the easyeda-mcp config dir).");
    }
    if (request.method === "POST") {
      const type = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") {
        throw new HttpError(415, "unsupported_media_type", "POST bodies must be Content-Type: application/json.");
      }
    }
  }

  private async handleCall(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new HttpError(400, "bad_request", "Body must be a JSON object {method, params?, timeoutMs?}.");
    }
    const { method, params, timeoutMs } = body as { method?: unknown; params?: unknown; timeoutMs?: unknown };
    if (typeof method !== "string" || method.length === 0) {
      throw new HttpError(400, "bad_request", "\"method\" must be a non-empty string.");
    }
    if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new HttpError(400, "bad_request", "\"timeoutMs\" must be a positive number.");
    }
    const timeout = Math.min(timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, MAX_CALL_TIMEOUT_MS);
    try {
      const result = await this.options.bridge.call(method, params, timeout);
      this.send(response, 200, { ok: true, result });
    } catch (error) {
      const wire = errorToWire(error);
      this.send(response, wire.status, { ok: false, error: wire.error });
    }
  }

  private send(response: ServerResponse, status: number, payload: unknown): void {
    if (response.headersSent) {
      return;
    }
    const body = JSON.stringify(payload ?? null);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-easyeda-hub-role": this.options.role
    });
    response.end(body);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "payload_too_large", `Body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json", "Body is not valid JSON.");
  }
}
