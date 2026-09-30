import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeHost } from "../bridge/BridgeHost.js";
import { connectFakeExtension, silentLogger, waitFor } from "../bridge/fakeExtension.testutil.js";
import { CliUsageError, joinNegativeNumbers, parseCli, parseJsonArg } from "./args.js";
import { runCli, runEditorCommand } from "./main.js";
import { fakeEditor } from "../mcp/fakeEditor.testutil.js";
import { SAMPLE_PCB } from "../pcb/fixtures.testutil.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("CLI argument parsing", () => {
  it("parses call args as JSON with a string fallback", () => {
    expect(parseJsonArg("\"e12\"")).toBe("e12");
    expect(parseJsonArg("{\"x\":100}")).toEqual({ x: 100 });
    expect(parseJsonArg("12")).toBe(12);
    expect(parseJsonArg("e12")).toBe("e12");
    expect(parseCli(["call", "pcb_PrimitiveComponent.modify", "\"e12\"", "{\"x\":100}"]).command).toEqual({
      name: "call",
      path: "pcb_PrimitiveComponent.modify",
      args: ["e12", { x: 100 }]
    });
  });

  it("parses pcb move with negative numbers and layer names", () => {
    expect(joinNegativeNumbers(["pcb", "move", "U1", "--dx", "-50", "--", "-3"])).toEqual(["pcb", "move", "U1", "--dx=-50", "--", "-3"]);
    const invocation = parseCli(["pcb", "move", "U1", "--dx", "-50", "--y", "20.5", "--layer", "bottom", "--rotation", "90"]);
    expect(invocation.command).toEqual({ name: "pcb-move", request: { designator: "U1", dx: -50, y: 20.5, rotation: 90, layer: "bottom" } });
    expect(invocation.start).toBe(true);
  });

  it("rejects bad or inapplicable options with a usage error", () => {
    const bad = [
      ["pcb", "move", "U1"],
      ["pcb", "move", "U1", "--x", "1", "--dx", "2"],
      ["pcb", "move", "U1", "--x", "abc"],
      ["pcb", "move", "U1", "--layer", "middle"],
      ["pcb", "snapshot", "--include", "components,bogus"],
      ["pcb", "drc", "--out", "x"],
      ["export", "gerber", "--format", "csv"],
      ["export", "zip"],
      ["export", "ipc2581"],
      ["export", "step", "--format", "csv"],
      ["export", "gerber", "--scope", "schematic"],
      ["package", "--preset", "nope"],
      ["package", "--kinds", "gerber", "--preset", "fab"],
      ["package", "--kinds", "sch-dxf"],
      ["check", "--out", "x"],
      ["render"],
      ["render", "--out", "a.png", "--region", "1,2"],
      ["status", "--start", "--no-start"],
      ["frobnicate"]
    ];
    for (const argv of bad) {
      expect(() => parseCli(argv), argv.join(" ")).toThrow(CliUsageError);
    }
  });

  it("defaults --start on only for commands that talk to EasyEDA", () => {
    expect(parseCli(["status"]).start).toBe(false);
    expect(parseCli(["stop"]).start).toBe(false);
    expect(parseCli(["pcb", "drc"]).start).toBe(true);
    expect(parseCli(["pcb", "drc", "--no-start"]).start).toBe(false);
    expect(parseCli(["status", "--start"]).start).toBe(true);
  });

  it("parses snapshot, export and render options", () => {
    expect(parseCli(["pcb", "snapshot", "--include", "components,tracks", "--out", "s.json", "--pretty"])).toMatchObject({
      command: { name: "pcb-snapshot", include: ["components", "tracks"], out: "s.json" },
      pretty: true
    });
    expect(parseCli(["export", "bom"]).command).toEqual({ name: "export", kind: "bom", overwrite: false });
    expect(parseCli(["export", "step", "--out", "x/"]).command).toEqual({ name: "export", kind: "step", out: "x/", overwrite: false });
    expect(parseCli(["export", "--list"])).toMatchObject({ command: { name: "export-list" }, start: false });
    expect(parseCli(["package", "--preset", "assembly", "--zip", "--drc-gate"]).command).toEqual({ name: "package", preset: "assembly", zip: true, drcGate: true });
    expect(parseCli(["package", "--kinds", "gerber, pnp"]).command).toMatchObject({ kinds: ["gerber", "pnp"] });
    expect(parseCli(["check", "--json"]).command).toEqual({ name: "check", json: true, strict: false });
    expect(parseCli(["render", "--designator", "U1", "--margin", "1", "-o", "v.png"]).command).toEqual({ name: "render", designator: "U1", margin: 1, out: "v.png" });
  });
});

describe("CLI against an in-process hub", () => {
  async function setup() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "easyeda-cli-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    vi.stubEnv("EASYEDA_MCP_CONFIG_DIR", dir);
    vi.stubEnv("EASYEDA_MCP_HTTP_PORT", "");
    let stopRequested = false;
    const host = new BridgeHost({ role: "daemon", wsPort: 0, httpPort: 0, configDir: dir, logger: silentLogger, onShutdownRequest: () => {
      stopRequested = true;
      void host.stop();
    } });
    await host.start();
    cleanups.push(() => host.stop());
    const components = new Map([["e12", { primitiveId: "e12", designator: "U1", x: 100, y: 200, rotation: 0, layer: 1 }]]);
    const calls: Array<{ method: string; params: unknown }> = [];
    const fake = await connectFakeExtension(host.endpoint, (method, params) => {
      calls.push({ method, params });
      const p = params as { path?: string; args?: unknown[] };
      if (method === "pcbSnapshot") return { components: [...components.values()], counts: { components: components.size } };
      if (p?.path === "pcb_PrimitiveComponent.modify") {
        const [id, props] = p.args as [string, object];
        Object.assign(components.get(id)!, props);
        return components.get(id);
      }
      if (p?.path === "pcb_PrimitiveComponent.get") return components.get(String(p.args?.[0]));
      if (method === "apiBatch") return { results: [{ ok: true, value: 1 }, { ok: false, error: { code: "x", message: "boom" } }] };
      return { method, params };
    });
    cleanups.push(() => fake.close());
    return { dir, host, calls, isStopRequested: () => stopRequested };
  }

  async function run(argv: string[], stdin = "") {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, readStdin: async () => stdin });
    return { code, stdout, stderr, json: stdout ? JSON.parse(stdout) : undefined };
  }

  it("runs status, call, pcb move, snapshot --out, batch and stop", async () => {
    const { dir, calls, isStopRequested } = await setup();

    const status = await run(["status"]);
    expect(status.code).toBe(0);
    expect(status.json).toMatchObject({ hub: { role: "daemon" }, status: { connected: true } });

    const call = await run(["call", "pcb_PrimitiveComponent.getAll", "--no-start"]);
    expect(call.json).toEqual({ method: "apiCall", params: { path: "pcb_PrimitiveComponent.getAll", args: [] } });

    const move = await run(["pcb", "move", "u1", "--dy", "-25", "--no-start"]);
    expect(move.code).toBe(0);
    expect(move.json).toMatchObject({ primitiveId: "e12", before: { y: 200 }, after: { y: 175 } });
    expect(calls).toContainEqual({ method: "apiCall", params: { path: "pcb_PrimitiveComponent.modify", args: ["e12", { y: 175 }] } });

    const out = path.join(dir, "snap.json");
    const snapshot = await run(["pcb", "snapshot", "--include", "components", "--out", out]);
    expect(snapshot.json).toMatchObject({ path: out, counts: { components: 1 } });
    expect(JSON.parse(await readFile(out, "utf8")).components[0].designator).toBe("U1");

    const batchFile = path.join(dir, "batch.json");
    await writeFile(batchFile, JSON.stringify([{ path: "pcb_A.getAll" }, { path: "pcb_B.getAll" }]));
    const batch = await run(["batch", batchFile]);
    expect(batch.code).toBe(1);
    expect(calls.at(-1)).toEqual({ method: "apiBatch", params: { calls: [{ path: "pcb_A.getAll" }, { path: "pcb_B.getAll" }], stopOnError: true } });
    await run(["batch", "-", "--continue-on-error"], "[{\"path\":\"pcb_A.getAll\"}]");
    expect(calls.at(-1)?.params).toMatchObject({ stopOnError: false });

    const missing = await run(["pcb", "move", "R7", "--x", "0"]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stderr)).toMatchObject({ ok: false, error: { code: "component_not_found" } });

    const stop = await run(["stop"]);
    expect(stop.json).toMatchObject({ stopped: true, pid: process.pid });
    await waitFor(() => isStopRequested());
  });

  it("reports a missing hub without starting one when --no-start is given", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "easyeda-cli-empty-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    vi.stubEnv("EASYEDA_MCP_CONFIG_DIR", dir);
    const status = await run(["status"]);
    expect(status.code).toBe(1);
    expect(status.json).toMatchObject({ hub: null });
    const call = await run(["call", "pcb_X.getAll", "--no-start"]);
    expect(call.code).toBe(1);
    expect(JSON.parse(call.stderr)).toMatchObject({ error: { code: "hub_not_running" } });
  });
});

describe("CLI export / package / check (fake editor)", () => {
  async function tempDir() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "easyeda-cli-ops-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }
  const noStdin = { readStdin: async () => "" };

  it("exports a catalog kind into a directory and refuses to overwrite", async () => {
    const dir = await tempDir();
    const editor = fakeEditor();
    const command = parseCli(["export", "step", "--out", `${dir}/`]).command as Parameters<typeof runEditorCommand>[0];
    const first = await runEditorCommand(command, editor.bridge as never, undefined, noStdin);
    expect(first.output).toMatchObject({ kind: "step", path: path.join(dir, "My_Board_v2-step.step"), restoredDocument: true });
    await expect(runEditorCommand(command, editor.bridge as never, undefined, noStdin)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("package exits 1 with --drc-gate when DRC has errors, 0 without the gate", async () => {
    const dir = await tempDir();
    const gated = parseCli(["package", "--kinds", "gerber,pnp", "--out", path.join(dir, "a"), "--drc-gate"]).command as Parameters<typeof runEditorCommand>[0];
    const failing = await runEditorCommand(gated, fakeEditor({ drcErrors: 3 }).bridge as never, undefined, noStdin);
    expect(failing.exitCode).toBe(1);
    expect(JSON.parse(await readFile(path.join(dir, "a", "manifest.json"), "utf8")).drc.errorCount).toBe(3);

    const ungated = parseCli(["package", "--kinds", "gerber,pnp", "--out", path.join(dir, "b")]).command as Parameters<typeof runEditorCommand>[0];
    expect((await runEditorCommand(ungated, fakeEditor({ drcErrors: 3 }).bridge as never, undefined, noStdin)).exitCode).toBe(0);
    const clean = parseCli(["package", "--kinds", "gerber", "--out", path.join(dir, "c"), "--drc-gate"]).command as Parameters<typeof runEditorCommand>[0];
    expect((await runEditorCommand(clean, fakeEditor().bridge as never, undefined, noStdin)).exitCode).toBe(0);
    const withFailure = parseCli(["package", "--kinds", "gerber,dxf", "--out", path.join(dir, "d")]).command as Parameters<typeof runEditorCommand>[0];
    const failed = await runEditorCommand(withFailure, fakeEditor({ failPaths: ["pcb_ManufactureData.getDxfFile"] }).bridge as never, undefined, noStdin);
    expect(failed.exitCode).toBe(1);
    expect(failed.output).toMatchObject({ failures: [{ kind: "dxf" }] });
  });

  it("check prints text by default and JSON with --json; exit 0 clean / 1 findings", async () => {
    const empty = { components: {} };
    const clean = await runEditorCommand(parseCli(["check"]).command as never, fakeEditor({ enet: empty }).bridge as never, undefined, noStdin);
    expect(clean.exitCode).toBe(0);
    expect(clean.text).toMatch(/^OK: 0 finding/);
    const dirty = await runEditorCommand(parseCli(["check", "--json"]).command as never, fakeEditor({ enet: empty, drcErrors: 1 }).bridge as never, undefined, noStdin);
    expect(dirty.exitCode).toBe(1);
    expect(dirty.text).toBeUndefined();
    expect(dirty.output).toMatchObject({ ok: false, drc: { errorCount: 1 } });
  });

  it("export --list works without a hub and check errors exit 2", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "easyeda-cli-nohub-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    vi.stubEnv("EASYEDA_MCP_CONFIG_DIR", dir);
    let out = "";
    let err = "";
    const io = { stdout: (text: string) => { out += text; }, stderr: (text: string) => { err += text; }, readStdin: async () => "" };
    expect(await runCli(["export", "--list"], io)).toBe(0);
    expect(JSON.parse(out).unsupported.map((item: { kind: string }) => item.kind)).toContain("ipc2581");
    expect(await runCli(["check", "--no-start"], io)).toBe(2);
    expect(JSON.parse(err).error.code).toBe("hub_not_running");
    expect(await runCli(["pcb", "analyze", "--no-start"], io)).toBe(2);
  });

  it("parses pcb analyze options", () => {
    expect(parseCli(["pcb", "analyze"]).command).toEqual({ name: "pcb-analyze", json: false, padBBox: false });
    expect(parseCli(["pcb", "analyze", "--json", "--top", "5", "--out", "r.json", "--grid", "5", "--pad-bbox"]).command).toEqual({ name: "pcb-analyze", json: true, padBBox: true, top: 5, out: "r.json", grid: 5 });
    expect(() => parseCli(["pcb", "analyze", "--top", "0"])).toThrow(CliUsageError);
    expect(() => parseCli(["pcb", "analyze", "--strict"])).toThrow(CliUsageError);
  });

  it("pcb analyze prints a summary, writes --out, and exits 1 on warnings / 0 when clean", async () => {
    const dir = await tempDir();
    const out = path.join(dir, "report.json");
    const dirty = await runEditorCommand(parseCli(["pcb", "analyze", "--out", out, "--pad-bbox"]).command as never, fakeEditor({ pcb: SAMPLE_PCB }).bridge as never, undefined, noStdin);
    expect(dirty.exitCode).toBe(1);
    expect(dirty.text).toMatch(/^WARNINGS: 0 error\(s\), 1 warning/);
    expect(dirty.text).toContain(`Report: ${out}`);
    expect(JSON.parse(await readFile(out, "utf8")).routing.possiblyUnrouted).toEqual(["N1"]);
    const routed = { ...SAMPLE_PCB, tracks: [{ net: "N1", layer: 1, startX: 200, startY: -200, endX: 600, endY: -200, lineWidth: 10 }] };
    const clean = await runEditorCommand(parseCli(["pcb", "analyze", "--json"]).command as never, fakeEditor({ pcb: routed }).bridge as never, undefined, noStdin);
    expect(clean.exitCode).toBe(0);
    expect(clean.text).toBeUndefined();
    expect(clean.output).toMatchObject({ ok: true, documents: { restored: true } });
  });
});
