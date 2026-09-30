import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeHost } from "./BridgeHost.js";
import { BridgeUnavailableError } from "./errors.js";
import { readHubInfo } from "./config.js";
import { connectFakeExtension, silentLogger, waitFor } from "./fakeExtension.testutil.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function tempConfigDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "easyeda-host-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function startHost(configDir: string, wsPort: number, role: "mcp" | "daemon" = "mcp"): Promise<BridgeHost> {
  const host = new BridgeHost({ role, wsPort, httpPort: 0, configDir, retryMs: 50, logger: silentLogger });
  await host.start();
  cleanups.push(() => host.stop());
  return host;
}

describe("BridgeHost", () => {
  it("becomes the owner, serves the hub, and writes/removes hub.json", async () => {
    const dir = await tempConfigDir();
    const owner = await startHost(dir, 0);
    expect(owner.currentMode).toBe("owner");
    const info = await readHubInfo(dir);
    expect(info).toMatchObject({ pid: process.pid, role: "mcp", wsPort: owner.wsPort });
    expect(owner.hubUrl).toBe(`http://127.0.0.1:${info?.httpPort}`);

    await owner.stop();
    expect(await readHubInfo(dir)).toBeUndefined();
  });

  it("proxies call() and getStatus() to the owner's extension when the port is taken by a hub", async () => {
    const dir = await tempConfigDir();
    const owner = await startHost(dir, 0);
    const seen: string[] = [];
    const fake = await connectFakeExtension(owner.endpoint, (method, params) => {
      seen.push(method);
      return { answeredBy: "owner-extension", params };
    });
    cleanups.push(() => fake.close());

    const second = await startHost(dir, owner.wsPort);
    expect(second.currentMode).toBe("proxy");
    await expect(second.call("apiCall", { path: "pcb_PrimitiveComponent.getAll" })).resolves.toEqual({
      answeredBy: "owner-extension",
      params: { path: "pcb_PrimitiveComponent.getAll" }
    });
    expect(seen).toEqual(["apiCall"]);
    expect(await second.getStatus()).toMatchObject({ connected: true, documentName: "fake pcb" });
  });

  it("takes over the port when the owner goes away", async () => {
    const dir = await tempConfigDir();
    const owner = await startHost(dir, 0);
    const port = owner.wsPort;
    const second = await startHost(dir, port);
    expect(second.currentMode).toBe("proxy");

    await owner.stop();
    await waitFor(() => second.currentMode === "owner");
    // hub.json is written right after the port is bound.
    await waitFor(async () => (await readHubInfo(dir))?.wsPort === port);
    expect(second.hubUrl).toBe(`http://127.0.0.1:${(await readHubInfo(dir))?.httpPort}`);

    const fake = await connectFakeExtension(`ws://127.0.0.1:${port}`, () => "new-owner");
    cleanups.push(() => fake.close());
    await expect(second.call("getContext")).resolves.toBe("new-owner");
  });

  it("waits (no proxy) when the port is held by something that is not a hub", async () => {
    const dir = await tempConfigDir();
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as { port: number }).port;
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));

    const host = await startHost(dir, port);
    expect(host.currentMode).toBe("waiting");
    expect((await host.getStatus()).message).toContain("not an EasyEDA MCP hub");
    await expect(host.call("getContext")).rejects.toBeInstanceOf(BridgeUnavailableError);

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await waitFor(() => host.currentMode === "owner");
  });
});
