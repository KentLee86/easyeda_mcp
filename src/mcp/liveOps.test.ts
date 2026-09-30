import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEasyEdaTools } from "./registerTools.js";
import {
  buildMoveProperties,
  buildRenderParams,
  findComponentByDesignator,
  isReadOnlyApiPath,
  movePcbComponent,
  mutationsAllowedByEnv,
  parseLayer,
  parseRegion
} from "./liveOps.js";

const clients: Client[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const COMPONENTS = [
  { primitiveId: "e12", designator: "U1", x: 100, y: 200, rotation: 0, layer: 1, locked: false },
  { primitiveId: "e13", designator: "R1", x: 10, y: 20, rotation: 90, layer: 2, locked: false }
];

/** Fake bridge that behaves like the extension for pcbSnapshot / apiCall modify+get. */
function fakeBridge(activeDocumentType: "pcb" | "schematic" = "pcb") {
  const state = new Map(COMPONENTS.map((component) => [component.primitiveId, { ...component }]));
  const call = vi.fn(async (method: string, params?: unknown) => {
    const p = params as { path?: string; args?: unknown[] } | undefined;
    if (method === "pcbSnapshot") return { units: "mil", components: [...state.values()] };
    if (method === "schematicSnapshot") return { components: [{ primitiveId: "s1", designator: "U1" }] };
    if (method === "renderImage") return { mimeType: "image/png", size: 3, base64: "iVBO", region: { left: 0, right: 1, top: 0, bottom: 1 } };
    if (method === "apiCall" && p?.path === "pcb_PrimitiveComponent.modify") {
      const [id, props] = p.args as [string, Record<string, number>];
      const next = { ...state.get(id)!, ...props };
      state.set(id, next);
      return { ...next, extra: "big object" };
    }
    if (method === "apiCall" && p?.path === "pcb_PrimitiveComponent.get") return state.get((p.args as string[])[0]!);
    if (method === "apiCall") return { called: p?.path, args: p?.args };
    throw new Error(`unexpected ${method}`);
  });
  return {
    endpoint: "ws://test",
    getStatus: () => ({ connected: true, activeDocumentType, updatedAt: "" }),
    call
  };
}

async function makeClient(bridge: ReturnType<typeof fakeBridge>): Promise<Client> {
  const server = new McpServer({ name: "t", version: "0" });
  registerEasyEdaTools(server, bridge as never);
  const client = new Client({ name: "c", version: "0" });
  clients.push(client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

describe("API path classification", () => {
  it("treats get/is/has/check/calculate/convert/discretize/describe methods as read-only", () => {
    for (const path of ["pcb_PrimitiveComponent.getAll", "pcb_PrimitiveComponent.get", "dmt_Board.getCurrentBoardInfo", "pcb_Net.isNetExist", "sch_Foo.hasBar", "pcb_Drc.check", "pcb_Math.calculateLength", "lib_Unit.convertMilToMm", "pcb_Shape.discretize"]) {
      expect(isReadOnlyApiPath(path), path).toBe(true);
    }
  });

  it("treats everything else, including look-alike prefixes, as mutating", () => {
    for (const path of ["pcb_PrimitiveComponent.modify", "pcb_PrimitiveComponent.create", "pcb_PrimitiveComponent.delete", "dmt_Board.save", "pcb_Foo.isolate", "pcb_Foo.getter", "pcb_Foo.issue", "pcb_Foo.checkout", "pcb_Foo.setGetAll"]) {
      expect(isReadOnlyApiPath(path), path).toBe(false);
    }
  });

  it("only opts in to mutations with EASYEDA_MCP_ALLOW_MUTATIONS=1", () => {
    expect(mutationsAllowedByEnv({ EASYEDA_MCP_ALLOW_MUTATIONS: "1" })).toBe(true);
    for (const value of [undefined, "0", "true", "yes", ""]) {
      expect(mutationsAllowedByEnv({ EASYEDA_MCP_ALLOW_MUTATIONS: value })).toBe(false);
    }
  });
});

describe("move resolution", () => {
  it("finds a designator case-insensitively and rejects missing/ambiguous ones", () => {
    expect(findComponentByDesignator(COMPONENTS, "u1").primitiveId).toBe("e12");
    expect(() => findComponentByDesignator(COMPONENTS, "U9")).toThrow(/No component/);
    expect(() => findComponentByDesignator([...COMPONENTS, { primitiveId: "e99", designator: "U1" }], "U1")).toThrow(/matches 2/);
  });

  it("builds absolute, relative, rotation and layer properties", () => {
    const u1 = COMPONENTS[0]!;
    expect(buildMoveProperties(u1, { designator: "U1", x: 5, dy: -50 })).toEqual({ x: 5, y: 150 });
    expect(buildMoveProperties(u1, { designator: "U1", rotation: 90, layer: "bottom" })).toEqual({ rotation: 90, layer: 2 });
    expect(() => buildMoveProperties(u1, { designator: "U1", x: 1, dx: 1 })).toThrow(/either x or dx/);
    expect(() => buildMoveProperties(u1, { designator: "U1" })).toThrow(/Nothing to change/);
  });

  it("maps layers", () => {
    expect(parseLayer("top")).toBe(1);
    expect(parseLayer("BOTTOM")).toBe(2);
    expect(parseLayer("12")).toBe(12);
    expect(() => parseLayer("middle")).toThrow(/Invalid layer/);
  });

  it("moves via pcbSnapshot + modify and reads back before/after", async () => {
    const bridge = fakeBridge();
    const moved = await movePcbComponent(bridge, { designator: "U1", dx: 10 });
    expect(moved).toMatchObject({
      primitiveId: "e12",
      requested: { x: 110 },
      before: { x: 100, y: 200 },
      after: { x: 110, y: 200 }
    });
    expect(bridge.call).toHaveBeenCalledWith("apiCall", { path: "pcb_PrimitiveComponent.modify", args: ["e12", { x: 110 }] }, 30_000);
    expect(moved.modifyResult).not.toHaveProperty("extra");
  });
});

describe("render params", () => {
  it("parses regions and resolves designators on PCB or schematic", async () => {
    expect(parseRegion("0, 100, 0, 50")).toEqual({ left: 0, right: 100, top: 0, bottom: 50 });
    expect(() => parseRegion("1,2,3")).toThrow(/left,right,top,bottom/);
    expect(await buildRenderParams(fakeBridge("pcb"), { designator: "R1", margin: 1 })).toEqual({ margin: 1, primitiveIds: ["e13"] });
    expect(await buildRenderParams(fakeBridge("schematic"), { designator: "U1" })).toEqual({ primitiveIds: ["s1"] });
  });
});

describe("MCP gate for easyeda_api_call / easyeda_pcb_move_component", () => {
  it("runs read-only API paths without confirmation", async () => {
    const bridge = fakeBridge();
    const client = await makeClient(bridge);
    const result = await client.callTool({ name: "easyeda_api_call", arguments: { path: "pcb_PrimitiveComponent.getAll" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ readOnly: true, result: { called: "pcb_PrimitiveComponent.getAll" } });
  });

  it("blocks mutating API paths without the exact phrase", async () => {
    const bridge = fakeBridge();
    const client = await makeClient(bridge);
    for (const confirmation of [undefined, "yes", "CONFIRM api pcb_PrimitiveComponent.delete", "CONFIRM move U1"]) {
      const result = await client.callTool({ name: "easyeda_api_call", arguments: { path: "pcb_PrimitiveComponent.modify", args: ["e12", { x: 1 }], ...(confirmation ? { confirmation } : {}) } });
      expect(result.isError, String(confirmation)).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: "confirmation_required", expectedConfirmation: "CONFIRM api pcb_PrimitiveComponent.modify" });
    }
    expect(bridge.call).not.toHaveBeenCalled();

    const allowed = await client.callTool({ name: "easyeda_api_call", arguments: { path: "pcb_PrimitiveComponent.modify", args: ["e12", { x: 1 }], confirmation: "CONFIRM api pcb_PrimitiveComponent.modify" } });
    expect(allowed.isError).toBeFalsy();
    expect(bridge.call).toHaveBeenCalledTimes(1);
  });

  it("lets EASYEDA_MCP_ALLOW_MUTATIONS=1 skip the phrase", async () => {
    vi.stubEnv("EASYEDA_MCP_ALLOW_MUTATIONS", "1");
    const bridge = fakeBridge();
    const client = await makeClient(bridge);
    const result = await client.callTool({ name: "easyeda_api_call", arguments: { path: "dmt_Board.save" } });
    expect(result.isError).toBeFalsy();
    const moved = await client.callTool({ name: "easyeda_pcb_move_component", arguments: { designator: "U1", x: 0 } });
    expect(moved.isError).toBeFalsy();
  });

  it("gates easyeda_pcb_move_component with CONFIRM move <designator>", async () => {
    const bridge = fakeBridge();
    const client = await makeClient(bridge);
    const blocked = await client.callTool({ name: "easyeda_pcb_move_component", arguments: { designator: "U1", dx: 5, confirmation: "CONFIRM move R1" } });
    expect(blocked.structuredContent).toMatchObject({ error: "confirmation_required", expectedConfirmation: "CONFIRM move U1" });
    expect(bridge.call).not.toHaveBeenCalled();

    const moved = await client.callTool({ name: "easyeda_pcb_move_component", arguments: { designator: "U1", dx: 5, confirmation: "CONFIRM move U1" } });
    expect(moved.structuredContent).toMatchObject({ before: { x: 100 }, after: { x: 105 } });
  });

  it("returns image content from easyeda_render_view and marks tool annotations correctly", async () => {
    const client = await makeClient(fakeBridge());
    const result = await client.callTool({ name: "easyeda_render_view", arguments: { designator: "U1" } });
    const content = result.content as Array<{ type: string; data?: string; mimeType?: string }>;
    expect(content.find((item) => item.type === "image")).toEqual({ type: "image", data: "iVBO", mimeType: "image/png" });

    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    for (const name of ["easyeda_pcb_snapshot", "easyeda_pcb_drc", "easyeda_api_describe", "easyeda_render_view"]) {
      expect(byName[name]?.annotations?.readOnlyHint, name).toBe(true);
    }
    for (const name of ["easyeda_api_call", "easyeda_pcb_move_component"]) {
      expect(byName[name]?.annotations?.readOnlyHint, name).toBe(false);
      expect(byName[name]?.description, name).toContain("EASYEDA_MCP_ALLOW_MUTATIONS=1");
    }
    expect(byName.easyeda_render_view?.description).toContain("changes the editor view");
  });
});

describe("catalog-driven MCP tools", () => {
  it("easyeda_export writes the file, switches back, and inlines text", async () => {
    const { fakeEditor } = await import("./fakeEditor.testutil.js");
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const dir = await mkdtemp(nodePath.join(os.tmpdir(), "easyeda-mcp-export-"));
    try {
      const editor = fakeEditor();
      const client = await makeClient(editor.bridge as never);
      const result = await client.callTool({ name: "easyeda_export", arguments: { kind: "pnp", outputPath: `${dir}/` } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ result: { kind: "pnp", restoredDocument: true, path: nodePath.join(dir, "My_Board_v2-pnp.csv") } });
      expect(await readFile(nodePath.join(dir, "My_Board_v2-pnp.csv"), "utf8")).toContain("getPickAndPlaceFile");
      const broken = await client.callTool({ name: "easyeda_export", arguments: { kind: "ipc2581" } });
      expect(broken.structuredContent).toMatchObject({ error: "export_unsupported" });

      const pkg = await client.callTool({ name: "easyeda_package", arguments: { kinds: ["gerber", "sch-pdf"], outDir: nodePath.join(dir, "pkg") } });
      expect(pkg.structuredContent).toMatchObject({ manifest: { files: [{ kind: "gerber" }, { kind: "sch-pdf" }] } });

      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
      for (const name of ["easyeda_export", "easyeda_package", "easyeda_design_check"]) {
        expect(byName[name]?.annotations?.readOnlyHint, name).toBe(false);
        expect(byName[name]?.annotations?.destructiveHint, name).toBe(false);
      }
      expect(byName.easyeda_export?.description).toContain("ipc2581");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
