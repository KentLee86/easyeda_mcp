import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EasyEdaBridge } from "./EasyEdaBridge.js";
import { HubServer } from "./HubServer.js";
import { RemoteBridge } from "./RemoteBridge.js";
import { BridgeRpcError, BridgeUnavailableError } from "./errors.js";
import { configDir, ensureToken, readToken, tokenPath } from "./config.js";
import { connectFakeExtension, silentLogger, waitFor, type FakeExtension } from "./fakeExtension.testutil.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const TOKEN = "t0ken-for-tests";

async function startHub(role: "mcp" | "daemon" = "mcp", onShutdown?: () => void) {
  const bridge = new EasyEdaBridge({ port: 0, logger: silentLogger });
  await bridge.start();
  cleanups.push(() => bridge.stop());
  const hub = new HubServer({ bridge, token: TOKEN, role, port: 0, onShutdown, info: () => ({ pid: process.pid, wsPort: bridge.boundPort }) });
  await hub.start();
  cleanups.push(() => hub.stop());
  return { bridge, hub };
}

async function extension(bridge: EasyEdaBridge, handler?: Parameters<typeof connectFakeExtension>[1]): Promise<FakeExtension> {
  const fake = await connectFakeExtension(bridge.endpoint, handler);
  cleanups.push(() => fake.close());
  return fake;
}

describe("HubServer auth", () => {
  it("rejects a missing or wrong token with 401", async () => {
    const { hub } = await startHub();
    const none = await fetch(`${hub.url}/v1/status`);
    expect(none.status).toBe(401);
    const wrong = await fetch(`${hub.url}/v1/status`, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("rejects any request with an Origin header with 403, even with the right token", async () => {
    const { hub } = await startHub();
    const response = await fetch(`${hub.url}/v1/status`, { headers: { authorization: `Bearer ${TOKEN}`, origin: "http://evil.example" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "origin_rejected" } });
  });

  it("rejects a non-loopback Host header (DNS rebinding)", async () => {
    const { hub } = await startHub();
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${hub.url}/v1/status`, { headers: { authorization: `Bearer ${TOKEN}`, host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("rejects POST bodies that are not application/json with 415", async () => {
    const { hub } = await startHub();
    const response = await fetch(`${hub.url}/v1/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
      body: JSON.stringify({ method: "getContext" })
    });
    expect(response.status).toBe(415);
  });

  it("serves status with the right token", async () => {
    const { hub } = await startHub();
    const response = await fetch(`${hub.url}/v1/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connected: false });
  });
});

describe("HubServer /v1/call", () => {
  it("round-trips a call through the fake extension", async () => {
    const { bridge, hub } = await startHub();
    await extension(bridge, (method, params) => ({ echoed: method, params }));
    const response = await fetch(`${hub.url}/v1/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ method: "apiCall", params: { path: "pcb_PrimitiveComponent.getAll", args: [] } })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: { echoed: "apiCall", params: { path: "pcb_PrimitiveComponent.getAll", args: [] } } });
  });

  it("maps a disconnected extension to 503 bridge_unavailable and rpc errors to 502", async () => {
    const { bridge, hub } = await startHub();
    const remote = new RemoteBridge({ token: TOKEN, httpPort: hub.port });
    await expect(remote.call("getContext")).rejects.toBeInstanceOf(BridgeUnavailableError);

    await extension(bridge, () => {
      throw Object.assign(new Error("namespace not allowed"), { code: "api_forbidden" });
    });
    const response = await fetch(`${hub.url}/v1/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ method: "apiCall", params: { path: "sys_Foo.bar" } })
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "api_forbidden", message: "namespace not allowed" } });
    await expect(remote.call("apiCall", { path: "sys_Foo.bar" })).rejects.toMatchObject({ code: "api_forbidden" });
    await expect(remote.call("apiCall")).rejects.toBeInstanceOf(BridgeRpcError);
  });

  it("rejects a malformed call body with 400", async () => {
    const { hub } = await startHub();
    const response = await fetch(`${hub.url}/v1/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{\"params\":{}}"
    });
    expect(response.status).toBe(400);
  });

  it("only lets a daemon hub accept /v1/shutdown", async () => {
    const mcp = await startHub("mcp");
    const remoteMcp = new RemoteBridge({ token: TOKEN, httpPort: mcp.hub.port });
    await expect(remoteMcp.shutdown()).rejects.toMatchObject({ code: "not_daemon" });

    let stopped = false;
    const daemon = await startHub("daemon", () => {
      stopped = true;
    });
    await new RemoteBridge({ token: TOKEN, httpPort: daemon.hub.port }).shutdown();
    await waitFor(() => stopped);
  });
});

describe("EasyEdaBridge bye", () => {
  it("sends {kind:\"bye\"} to the extension before closing on stop()", async () => {
    const bridge = new EasyEdaBridge({ port: 0, logger: silentLogger });
    await bridge.start();
    const fake = await connectFakeExtension(bridge.endpoint);
    const closed = new Promise<void>((resolve) => fake.socket.once("close", () => resolve()));
    await bridge.stop();
    await closed;
    expect(fake.received.map((message) => message.kind)).toContain("bye");
    expect(fake.received.at(-1)).toMatchObject({ kind: "bye" });
  });
});

describe("token file", () => {
  it("creates the token with 0600 in a 0700 dir and reuses it", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "easyeda-cfg-"));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const dir = path.join(base, "nested", "easyeda-mcp");
    const first = await ensureToken(dir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(tokenPath(dir))).mode & 0o777).toBe(0o600);
    expect(await ensureToken(dir)).toBe(first);
    expect(await readToken(dir)).toBe(first);
  });

  it("resolves the config dir from env overrides", () => {
    expect(configDir({ EASYEDA_MCP_CONFIG_DIR: "/x/y" })).toBe("/x/y");
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/easyeda-mcp");
    expect(configDir({ HOME: "/tmp" })).toBe("/tmp/.config/easyeda-mcp");
  });
});
