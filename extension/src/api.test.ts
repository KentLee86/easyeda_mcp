import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiBatch, apiCall, apiDescribe, exportFile, pcbDrc, pcbSnapshot, renderImage, toPlain, useDocument } from "./api.js";

class Primitive {
  readonly #state: { id: string; x: number };
  constructor(state: { id: string; x: number }) { this.#state = state; }
  get primitiveId() { return this.#state.id; }
  get x() { return this.#state.x; }
  setX() { return this; }
}

function makeEda(documentType = 3) {
  const components = [new Primitive({ id: "e1", x: 10 }), new Primitive({ id: "e2", x: 20 })];
  class ComponentApi {
    async getAll() { return components; }
    async modify(id: string, patch: { x?: number }) { return new Primitive({ id, x: patch.x ?? 0 }); }
    async fail() { throw new Error("boom"); }
  }
  class DrcApi {
    check = vi.fn(async () => [
      { name: "Clearance Error", list: [{ name: "Pad to Pad", list: [{ errorType: "Clearance Error" }, { errorType: "Clearance Error" }] }] },
      { name: "Netlist Error", list: [{ errorType: "Netlist Error" }] }
    ]);
  }
  const listApi = (items: unknown[]) => ({ getAll: async () => items });
  return {
    pcb_PrimitiveComponent: new ComponentApi(),
    pcb_PrimitivePad: listApi([]),
    pcb_PrimitiveLine: listApi([{ net: "GND" }]),
    pcb_PrimitiveArc: listApi([]),
    pcb_PrimitiveVia: listApi([]),
    pcb_PrimitivePour: listApi([]),
    pcb_PrimitiveFill: listApi([]),
    pcb_PrimitiveRegion: listApi([]),
    pcb_PrimitiveString: listApi([]),
    pcb_Net: { getAllNets: async () => [] },
    pcb_Layer: { getAllLayers: async () => [] },
    pcb_Primitive: { getPrimitiveBoardLine: async () => { throw new Error("no outline"); } },
    pcb_Drc: new DrcApi(),
    sys_FileSystem: { saveFileToFileSystem: vi.fn() },
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType, uuid: "doc" }) }
  };
}

let eda: ReturnType<typeof makeEda>;

beforeEach(() => {
  eda = makeEda();
  vi.stubGlobal("eda", eda);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toPlain", () => {
  it("flattens prototype getters, drops functions and cycles", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(toPlain(new Primitive({ id: "e1", x: 5 }))).toEqual({ primitiveId: "e1", x: 5 });
    expect(toPlain(cyclic)).toEqual({ a: 1 });
    expect(toPlain({ n: Number.NaN, f: () => 1 })).toEqual({ n: null });
  });
});

describe("apiCall", () => {
  it("calls an allowed method with JSON args and returns plain data", async () => {
    await expect(apiCall({ path: "pcb_PrimitiveComponent.getAll" })).resolves.toEqual([{ primitiveId: "e1", x: 10 }, { primitiveId: "e2", x: 20 }]);
    await expect(apiCall({ path: "pcb_PrimitiveComponent.modify", args: ["e1", { x: 99 }] })).resolves.toEqual({ primitiveId: "e1", x: 99 });
  });

  it("keeps sys_* closed and rejects malformed or unknown paths", async () => {
    await expect(apiCall({ path: "sys_FileSystem.saveFileToFileSystem", args: ["/tmp/x"] })).rejects.toMatchObject({ code: "api_forbidden" });
    expect(eda.sys_FileSystem.saveFileToFileSystem).not.toHaveBeenCalled();
    await expect(apiCall({ path: "pcb_PrimitiveComponent" })).rejects.toMatchObject({ code: "invalid_path" });
    await expect(apiCall({ path: "pcb_Nope.get" })).rejects.toMatchObject({ code: "api_unavailable" });
  });
});

describe("apiBatch", () => {
  it("stops at the first error by default and can continue", async () => {
    const calls = [{ path: "pcb_PrimitiveComponent.fail" }, { path: "pcb_PrimitiveComponent.getAll" }];
    expect((await apiBatch({ calls })).results).toHaveLength(1);
    const all = (await apiBatch({ calls, stopOnError: false })).results as Array<{ ok: boolean }>;
    expect(all.map((result) => result.ok)).toEqual([false, true]);
  });
});

describe("apiDescribe", () => {
  it("lists methods of allowed namespaces only", () => {
    const { namespaces } = apiDescribe({}) as { namespaces: Record<string, string[]> };
    expect(namespaces.pcb_PrimitiveComponent).toEqual(["getAll", "modify", "fail"]);
    expect(namespaces.sys_FileSystem).toBeUndefined();
  });
});

describe("pcbSnapshot", () => {
  it("reads the requested parts with counts and reports failing parts", async () => {
    const snapshot = await pcbSnapshot({ include: ["components", "tracks", "outline"] });
    expect(snapshot.counts).toEqual({ components: 2, tracks: 1 });
    expect(snapshot.errors).toEqual({ outline: "no outline" });
    expect(snapshot.units).toBe("mil");
  });

  it("refuses when the active document is not a PCB", async () => {
    vi.stubGlobal("eda", makeEda(1));
    await expect(pcbSnapshot({})).rejects.toMatchObject({ code: "unsupported_document" });
  });
});

describe("pcbDrc", () => {
  it("always asks for the error tree and counts leaf errors per category", async () => {
    const result = await pcbDrc({ verbose: false });
    expect(eda.pcb_Drc.check).toHaveBeenCalledWith(true, false, true);
    expect(result).toEqual({ ok: false, errorCount: 3, categories: [{ name: "Clearance Error", count: 2 }, { name: "Netlist Error", count: 1 }] });
  });

  it("maps a boolean-only answer to ok", async () => {
    eda.pcb_Drc.check.mockResolvedValueOnce(true as never);
    await expect(pcbDrc({})).resolves.toMatchObject({ ok: true, errorCount: 0 });
  });
});

describe("renderImage", () => {
  it("fits the primitives' box using the scale-1 probe and returns the PNG as base64", async () => {
    vi.useFakeTimers();
    const zoomTo = vi.fn(async (x: number, _y: number, scale: number) => ({
      // canvas = document / 10; 700x400 canvas units visible at scale 1
      left: x / 10 - 350 / scale, right: x / 10 + 350 / scale, top: 0, bottom: -400 / scale
    }));
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    vi.stubGlobal("eda", {
      ...eda,
      pcb_Primitive: { getPrimitivesBBox: async () => ({ minX: 1000, maxX: 1200, minY: -500, maxY: -400 }) },
      dmt_EditorControl: { zoomTo, getCurrentRenderedAreaImage: async () => png }
    });

    const pending = renderImage({ primitiveIds: ["e1"], margin: 0 });
    await vi.runAllTimersAsync();
    const result = await pending;

    // box 200x100 doc plus 1 unit each side = 20.2x10.2 canvas; width limits: 700/20.2
    const [x, y, scale] = zoomTo.mock.calls.at(-1)!;
    expect([x, y]).toEqual([1100, -450]);
    expect(scale).toBeCloseTo(700 / 20.2, 6);
    expect(result).toMatchObject({ mimeType: "image/png", size: 4, base64: "iVBORw==" });
    vi.useRealTimers();
  });
});

describe("exportFile", () => {
  const withManufacture = (documentType: number, file: unknown) => {
    const pcbGet = vi.fn(async () => file);
    vi.stubGlobal("eda", {
      ...makeEda(documentType),
      pcb_ManufactureData: { get3DFile: pcbGet },
      sch_ManufactureData: { getExportDocumentFile: vi.fn(async () => file) }
    });
    return pcbGet;
  };

  it("returns the file of a *_ManufactureData.get* call as base64", async () => {
    const get3DFile = withManufacture(3, new File(["STEP"], "board.step", { type: "text/plain" }));
    await expect(exportFile({ path: "pcb_ManufactureData.get3DFile", args: ["board", "step"] }))
      .resolves.toEqual({ fileName: "board.step", mimeType: "text/plain", size: 4, base64: "U1RFUA==" });
    expect(get3DFile).toHaveBeenCalledWith("board", "step");
  });

  it("refuses a PCB export on a schematic tab (it would hang behind a dialog)", async () => {
    const get3DFile = withManufacture(1, new File(["x"], "x"));
    await expect(exportFile({ path: "pcb_ManufactureData.get3DFile" })).rejects.toMatchObject({ code: "unsupported_document" });
    expect(get3DFile).not.toHaveBeenCalled();
  });

  it("reports an empty export and only allows manufacture getters", async () => {
    withManufacture(3, undefined);
    await expect(exportFile({ path: "pcb_ManufactureData.get3DFile" })).rejects.toMatchObject({ code: "export_empty" });
    await expect(exportFile({ path: "pcb_PrimitiveComponent.getAll" })).rejects.toMatchObject({ code: "api_forbidden" });
  });
});

describe("useDocument", () => {
  it("opens the board's PCB or first schematic page and reports the previous document", async () => {
    let current = { uuid: "page-1", documentType: 1 };
    const openDocument = vi.fn(async (uuid: string) => { current = { uuid, documentType: uuid === "pcb-1" ? 3 : 1 }; });
    vi.stubGlobal("eda", {
      dmt_SelectControl: { getCurrentDocumentInfo: async () => current },
      dmt_EditorControl: { openDocument },
      dmt_Project: { getCurrentProjectInfo: async () => ({ data: [{ name: "B", pcb: { uuid: "pcb-1", name: "PCB" }, schematic: { page: [{ uuid: "page-1", name: "P1" }, { uuid: "page-2", name: "P2" }] } }] }) }
    });

    await expect(useDocument({ kind: "pcb" })).resolves.toEqual({
      previous: { uuid: "page-1", documentType: 1 },
      current: { uuid: "pcb-1", documentType: 3, name: "PCB" }
    });
    await expect(useDocument({ kind: "schematic", page: "P2" })).resolves.toMatchObject({ current: { uuid: "page-2" } });
    await useDocument({ uuid: "page-2" });
    expect(openDocument).toHaveBeenCalledTimes(2);
  });
});
