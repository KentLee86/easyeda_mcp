import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Behavior added in ba328a4 / c170b6e / 587a927 (bridge liveness + retry,
// deactivate, toast, document types, save/autoroute, exports, findComponent,
// multi-page snapshot). index.ts reads the bridge config at module load, so
// every test sets __EASYEDA_MCP_BRIDGE_CONFIG__ and imports a fresh module.

const WS_ID = "easyeda-mcp-bridge";

type Registration = {
  onMessage?: (event: MessageEvent<string>) => Promise<void>;
  onOpen?: () => Promise<void>;
};

type Harness = {
  eda: Record<string, any>;
  registration: Registration;
  registerCount: () => number;
  registerTimes: number[];
  sent: Array<Record<string, any>>;
  document: { info: Record<string, unknown> };
};

function makeEda(overrides: Record<string, any> = {}): Harness {
  const harness = {
    registration: {} as Registration,
    registerTimes: [] as number[],
    sent: [] as Array<Record<string, any>>,
    document: { info: { uuid: "doc-1", documentType: 1, name: "Page 1" } as Record<string, unknown> }
  } as Harness;
  const register = vi.fn((_id: string, _uri: string, onMessage: Registration["onMessage"], onOpen: Registration["onOpen"]) => {
    harness.registerTimes.push(Date.now());
    harness.registration.onMessage = onMessage;
    harness.registration.onOpen = onOpen;
  });
  harness.registerCount = () => register.mock.calls.length;
  harness.eda = {
    sys_WebSocket: {
      register,
      close: vi.fn(),
      send: vi.fn((_id: string, message: string) => {
        harness.sent.push(JSON.parse(message));
      })
    },
    sys_Dialog: { showInformationMessage: vi.fn() },
    sys_ToastMessage: { showMessage: vi.fn() },
    sys_Log: { warn: vi.fn(), error: vi.fn() },
    dmt_SelectControl: { getCurrentDocumentInfo: vi.fn(async () => harness.document.info) },
    dmt_EditorControl: { getSplitScreenTree: vi.fn(async () => []) },
    ...overrides
  };
  vi.stubGlobal("eda", harness.eda);
  return harness;
}

async function loadExtension(config: Record<string, unknown> = {}) {
  (globalThis as Record<string, unknown>).__EASYEDA_MCP_BRIDGE_CONFIG__ = {
    openTimeoutMs: 60_000,
    heartbeatIntervalMs: 1_000,
    livenessTimeoutMs: 3_000,
    reconnectDelayMs: [0],
    ...config
  };
  return import("./index.js");
}

async function call(harness: Harness, method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> {
  await harness.registration.onMessage?.({
    data: JSON.stringify({ kind: "call", requestId: `${method}-1`, method, params })
  } as MessageEvent<string>);
  return harness.sent.at(-1) ?? {};
}

async function connected(config: Record<string, unknown> = {}, overrides: Record<string, any> = {}) {
  const harness = makeEda(overrides);
  const extension = await loadExtension(config);
  extension.connect();
  return { harness, extension };
}

function resetBridgeRuntime(): void {
  // Connection state lives on a global shared by re-evaluations of the script.
  for (const key of Object.keys(globalThis)) {
    if (key.startsWith("easyedaMcpBridgeRuntime")) {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  resetBridgeRuntime();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).__EASYEDA_MCP_BRIDGE_CONFIG__;
});

describe("re-evaluated script (EasyEDA runs the entry again for every event)", () => {
  it("shares connection state between evaluations, so a menu command sees the live connection", async () => {
    const harness = makeEda();
    const first = await loadExtension();
    first.activate("onStartupFinished");
    await harness.registration.onOpen?.();

    vi.resetModules();
    const second = await loadExtension();
    await second.showStatus();

    const status = String(harness.eda.sys_Dialog.showInformationMessage.mock.calls.at(-1)?.[0] ?? "");
    expect(status).toContain("Connection phase: connected");
    expect(harness.registerCount()).toBe(1);
  });

  it("deactivates when external interaction is switched off", async () => {
    const harness = makeEda();
    const extension = await loadExtension();
    extension.activate("onStartupFinished");
    await harness.registration.onOpen?.();

    extension.activate("onChangeAllowExternalInteractions", "off");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.eda.sys_WebSocket.close).toHaveBeenLastCalledWith(WS_ID);
    expect(harness.registerCount()).toBe(1);
  });
});

describe("bridge liveness watchdog", () => {
  it("closes the socket and re-registers when the server stays silent past livenessTimeoutMs", async () => {
    const harness = makeEda();
    const extension = await loadExtension();
    extension.activate("onStartupFinished");
    await harness.registration.onOpen?.();
    const closesAfterOpen = harness.eda.sys_WebSocket.close.mock.calls.length;

    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.registerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(harness.eda.sys_WebSocket.close.mock.calls.length).toBeGreaterThan(closesAfterOpen);
    expect(harness.eda.sys_WebSocket.close).toHaveBeenLastCalledWith(WS_ID);
    expect(harness.registerCount()).toBe(2);
  });

  it("does not reconnect while server messages (acks) keep arriving", async () => {
    const harness = makeEda();
    const extension = await loadExtension();
    extension.activate("onStartupFinished");
    await harness.registration.onOpen?.();

    for (let second = 0; second < 10; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await harness.registration.onMessage?.({ data: JSON.stringify({ kind: "ack" }) } as MessageEvent<string>);
    }

    expect(harness.registerCount()).toBe(1);
    expect(harness.sent.filter((message) => message.kind === "status").length).toBeGreaterThanOrEqual(9);
  });
});

describe("reconnect retries", () => {
  it("keeps retrying with the last delay after the backoff list is exhausted", async () => {
    // Nothing ever opens: each attempt ends with the 50 ms open timeout.
    const harness = makeEda();
    const extension = await loadExtension({ openTimeoutMs: 50, reconnectDelayMs: [0, 100, 200] });
    extension.activate("onStartupFinished");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(harness.registerCount()).toBeGreaterThan(10);
    const gaps = harness.registerTimes.slice(1).map((time, index) => time - harness.registerTimes[index]);
    expect(gaps.slice(0, 2)).toEqual([150, 250]);
    expect(new Set(gaps.slice(2))).toEqual(new Set([250]));
  });

  it("keeps retrying silently while blocked, notifying once per blocked episode", async () => {
    let blocked = true;
    const harness = makeEda();
    const register = harness.eda.sys_WebSocket.register;
    register.mockImplementation((...args: any[]) => {
      harness.registerTimes.push(Date.now());
      if (blocked) {
        throw new Error("External interaction permission is not granted for this extension.");
      }
      harness.registration.onMessage = args[2];
      harness.registration.onOpen = args[3];
    });
    const dialog = harness.eda.sys_Dialog.showInformationMessage;
    const extension = await loadExtension({ reconnectDelayMs: [0, 500] });
    extension.activate("onStartupFinished");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.registerCount()).toBeGreaterThan(5);
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(dialog.mock.calls[0][0]).toContain("permission");

    // Permission granted: the next retry opens; a later block is a new episode.
    blocked = false;
    await vi.advanceTimersByTimeAsync(500);
    await harness.registration.onOpen?.();
    expect(harness.eda.sys_ToastMessage.showMessage).toHaveBeenCalledWith(expect.stringContaining("connected"), "success");
    blocked = true;
    // The server goes silent -> watchdog reconnects -> permission blocked again.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dialog).toHaveBeenCalledTimes(2);
  });

  it("always shows the message for manual connect failures", async () => {
    const harness = makeEda();
    harness.eda.sys_WebSocket.register.mockImplementation(() => {
      throw new Error("External interaction permission is not granted for this extension.");
    });
    const dialog = harness.eda.sys_Dialog.showInformationMessage;
    const extension = await loadExtension({ reconnectDelayMs: [0, 500] });
    extension.activate("onStartupFinished");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dialog).toHaveBeenCalledTimes(1);

    extension.connect();
    extension.reconnect();
    expect(dialog).toHaveBeenCalledTimes(3);
  });
});

describe("deactivate", () => {
  it("stops timers and retries, closes the socket, and activate() works again", async () => {
    const harness = makeEda();
    const extension = await loadExtension();
    extension.activate("onStartupFinished");
    await harness.registration.onOpen?.();
    const sentBefore = harness.sent.length;
    harness.eda.sys_WebSocket.close.mockClear();

    extension.deactivate();
    expect(harness.eda.sys_WebSocket.close).toHaveBeenCalledWith(WS_ID);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sent.length).toBe(sentBefore);
    expect(harness.registerCount()).toBe(1);

    extension.activate("onStartupFinished");
    expect(harness.registerCount()).toBe(2);
    await harness.registration.onOpen?.();
    expect(harness.sent.at(-1)?.kind).toBe("hello");
  });
});

describe("connected notification", () => {
  it("uses a toast (not a modal dialog) for automatic connects", async () => {
    const harness = makeEda();
    const extension = await loadExtension();
    extension.activate("onStartupFinished");
    await harness.registration.onOpen?.();

    expect(harness.eda.sys_ToastMessage.showMessage).toHaveBeenCalledWith(expect.stringContaining("connected"), "success");
    expect(harness.eda.sys_Dialog.showInformationMessage).not.toHaveBeenCalled();
  });
});

describe("document type inference", () => {
  it.each([
    [3, "pcb"],
    [1, "schematic"],
    [4, "footprint"],
    [2, "symbol"],
    [-1, "home"]
  ])("documentType %i -> %s in status/getContext", async (documentType, expected) => {
    const { harness } = await connected();
    harness.document.info = { uuid: "doc-1", documentType };

    const message = await call(harness, "getContext");

    expect(message.kind).toBe("result");
    expect(message.result.status.activeDocumentType).toBe(expected);
  });
});

describe("confirmedAction", () => {
  const documentApis = () => ({
    sch_Document: { save: vi.fn(async () => true) },
    pcb_Document: {
      save: vi.fn(async () => true),
      importAutoRouteJsonFile: vi.fn(async () => true),
      importAutoLayoutJsonFile: vi.fn(async () => true)
    }
  });

  it("saves the schematic through sch_Document when a schematic page is active", async () => {
    const apis = documentApis();
    const { harness } = await connected({}, apis);

    const message = await call(harness, "confirmedAction", { action: "save" });

    expect(message.result).toMatchObject({ saved: true, documentType: "schematic", documentUuid: "doc-1" });
    expect(apis.sch_Document.save).toHaveBeenCalledWith("doc-1");
    expect(apis.pcb_Document.save).not.toHaveBeenCalled();
  });

  it("saves the board through pcb_Document when a PCB is active", async () => {
    const apis = documentApis();
    const { harness } = await connected({}, apis);
    harness.document.info = { uuid: "pcb-1", documentType: 3 };

    const message = await call(harness, "confirmedAction", { action: "save" });

    expect(message.result).toMatchObject({ saved: true, documentType: "pcb" });
    expect(apis.pcb_Document.save).toHaveBeenCalledWith("pcb-1");
    expect(apis.sch_Document.save).not.toHaveBeenCalled();
  });

  it("rejects save on the home tab with unsupported_document", async () => {
    const apis = documentApis();
    const { harness } = await connected({}, apis);
    harness.document.info = { uuid: "home", documentType: -1 };

    const message = await call(harness, "confirmedAction", { action: "save" });

    expect(message.kind).toBe("error");
    expect(message.error.code).toBe("unsupported_document");
    expect(apis.sch_Document.save).not.toHaveBeenCalled();
    expect(apis.pcb_Document.save).not.toHaveBeenCalled();
  });

  it("imports autoroute JSON text as a File", async () => {
    const apis = documentApis();
    const { harness } = await connected({}, apis);
    const json = JSON.stringify({ tracks: [{ net: "GND" }] });

    const message = await call(harness, "confirmedAction", { action: "autoroute", params: { json } });

    expect(message.result).toMatchObject({ action: "autoroute", imported: true });
    const file = (apis.pcb_Document.importAutoRouteJsonFile.mock.calls as unknown as File[][])[0][0];
    expect(file).toBeInstanceOf(File);
    expect(await file.text()).toBe(json);
  });

  it("rejects autoroute without JSON with missing_json", async () => {
    const apis = documentApis();
    const { harness } = await connected({}, apis);

    const message = await call(harness, "confirmedAction", { action: "autoroute", params: {} });

    expect(message.error.code).toBe("missing_json");
    expect(apis.pcb_Document.importAutoRouteJsonFile).not.toHaveBeenCalled();
  });
});

describe("exports", () => {
  const manufactureApis = () => {
    const pcb = {
      getBomFile: vi.fn(),
      getNetlistFile: vi.fn(),
      getPdfFile: vi.fn()
    };
    const sch = {
      getBomFile: vi.fn(async () => new Blob([new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x0a])])),
      getNetlistFile: vi.fn(async () => undefined),
      getExportDocumentFile: vi.fn(async () => new Blob(["%PDF-1.4"]))
    };
    return { pcb_ManufactureData: pcb, sch_ManufactureData: sch };
  };

  it("returns BOM bytes as base64 and follows the active schematic for scope auto", async () => {
    const apis = manufactureApis();
    const { harness } = await connected({}, apis);

    const message = await call(harness, "exportBom", { fileName: "bom", scope: "auto" });

    expect(message.result).toEqual({
      fileName: "bom.csv",
      size: 5,
      base64: Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x0a]).toString("base64")
    });
    expect(apis.sch_ManufactureData.getBomFile).toHaveBeenCalledWith("bom", "csv");
    for (const method of Object.values(apis.pcb_ManufactureData)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("exports a schematic PDF through getExportDocumentFile(name, \"PDF\")", async () => {
    const apis = manufactureApis();
    const { harness } = await connected({}, apis);

    const message = await call(harness, "exportPdf", { fileName: "sheet" });

    expect(message.result).toMatchObject({ fileName: "sheet.pdf", size: 8 });
    expect(apis.sch_ManufactureData.getExportDocumentFile).toHaveBeenCalledWith("sheet", "PDF");
    expect(apis.pcb_ManufactureData.getPdfFile).not.toHaveBeenCalled();
  });

  it("reports export_unavailable when the schematic netlist comes back empty", async () => {
    const apis = manufactureApis();
    const { harness } = await connected({}, apis);

    const message = await call(harness, "exportNetlist", { fileName: "net" });

    expect(message.kind).toBe("error");
    expect(message.error.code).toBe("export_unavailable");
    expect(apis.pcb_ManufactureData.getNetlistFile).not.toHaveBeenCalled();
  });
});

describe("findComponent", () => {
  const components = () => ({
    sch_PrimitiveComponent: {
      getAll: vi.fn(async () => [
        { primitiveId: "$r1", designator: "R1", value: "10k" },
        { primitiveId: "$r10", designator: "R10", value: "1k" }
      ])
    }
  });

  it("prefers an exact designator (R1 does not match R10)", async () => {
    const { harness } = await connected({}, components());

    const message = await call(harness, "findComponent", { query: "R1" });

    expect(message.result.matches.map((match: any) => match.component.designator)).toEqual(["R1"]);
  });

  it("falls back to substring matches", async () => {
    const { harness } = await connected({}, components());

    const message = await call(harness, "findComponent", { query: "R" });

    expect(message.result.matches.map((match: any) => match.component.designator)).toEqual(["R1", "R10"]);
  });
});

describe("multi-page schematic snapshot", () => {
  it("visits every page of the board, builds a per-page snapshot and reopens the original document", async () => {
    const pages: Record<string, { components: unknown[]; pins: Record<string, unknown[]>; wires: unknown[] }> = {
      "page-a": {
        components: [{ primitiveId: "e1", componentType: "part", designator: "U1", x: 0, y: 0 }],
        pins: { e1: [{ primitiveId: "e1p1", pinNumber: "1", x: 0, y: 0 }] },
        wires: [{ primitiveId: "w1", net: "VBUS", line: [0, 0, 20, 0] }]
      },
      "page-b": {
        components: [{ primitiveId: "e1", componentType: "part", designator: "R1", x: 0, y: 0 }],
        pins: { e1: [{ primitiveId: "e1p1", pinNumber: "1", x: 0, y: 0 }] },
        wires: [{ primitiveId: "w1", net: "SENSE", line: [0, 0, 20, 0] }]
      }
    };
    let open = "pcb-1";
    const openDocument = vi.fn(async (uuid: string) => {
      open = uuid;
    });
    const { harness } = await connected({}, {
      dmt_Project: {
        getCurrentProjectInfo: vi.fn(async () => ({
          data: [{
            pcb: { uuid: "pcb-1" },
            schematic: { page: [{ uuid: "page-a", name: "Power" }, { uuid: "page-b", name: "IO" }] }
          }]
        }))
      },
      dmt_EditorControl: { getSplitScreenTree: vi.fn(async () => []), openDocument },
      sch_PrimitiveComponent: {
        getAll: vi.fn(async () => pages[open]?.components ?? []),
        getAllPinsByPrimitiveId: vi.fn(async (id: string) => {
          if (!pages[open]) throw new Error("component is not on the open page");
          return pages[open].pins[id] ?? [];
        })
      },
      sch_PrimitiveWire: { getAll: vi.fn(async () => pages[open]?.wires ?? []) },
      sch_PrimitiveText: { getAll: vi.fn(async () => []) }
    });
    harness.eda.dmt_SelectControl.getCurrentDocumentInfo.mockImplementation(async () =>
      open === "pcb-1" ? { uuid: "pcb-1", documentType: 3 } : { uuid: open, documentType: 1 });

    const message = await call(harness, "schematicSnapshot", { includeRaw: false });

    expect(message.kind).toBe("result");
    expect(message.result.counts).toMatchObject({ pages: 2, components: 2 });
    expect(message.result.pins.map((pin: any) => [pin.componentDesignator, pin.page?.name, pin.net]))
      .toEqual([["U1", "Power", "VBUS"], ["R1", "IO", "SENSE"]]);
    expect(openDocument.mock.calls.map(([uuid]) => uuid)).toEqual(["page-a", "page-b", "pcb-1"]);
    expect(open).toBe("pcb-1");
  });
});

describe("regressions for fixed bridge bugs", () => {
  function trackUnhandledRejections(): { reasons: unknown[]; stop: () => void } {
    const reasons: unknown[] = [];
    const listener = (reason: unknown) => reasons.push(reason);
    process.on("unhandledRejection", listener);
    return { reasons, stop: () => process.off("unhandledRejection", listener) };
  }

  it("ignores an open that arrives after deactivate(): no hello, heartbeat or toast, socket closed", async () => {
    const harness = makeEda();
    const extension = await loadExtension();
    extension.activate("onStartupFinished");
    extension.deactivate();
    harness.eda.sys_WebSocket.close.mockClear();

    await harness.registration.onOpen?.();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.sent).toEqual([]);
    expect(harness.eda.sys_ToastMessage.showMessage).not.toHaveBeenCalled();
    expect(harness.eda.sys_WebSocket.close).toHaveBeenCalledWith(WS_ID);
    expect(harness.registerCount()).toBe(1);
  });

  it("handles a missing sys_WebSocket.register without an unhandled rejection and keeps retrying", async () => {
    const tracker = trackUnhandledRejections();
    try {
      const harness = makeEda();
      const register = harness.eda.sys_WebSocket.register;
      delete harness.eda.sys_WebSocket.register;
      const extension = await loadExtension({ reconnectDelayMs: [0, 500] });

      extension.activate("onStartupFinished");
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise((resolve) => process.nextTick(resolve));
      expect(tracker.reasons).toEqual([]);
      expect(harness.eda.sys_Dialog.showInformationMessage).toHaveBeenCalledTimes(1);

      // The retry is scheduled: once the API shows up (permission enabled) it connects.
      harness.eda.sys_WebSocket.register = register;
      await vi.advanceTimersByTimeAsync(500);
      expect(harness.registerCount()).toBe(1);
    } finally {
      tracker.stop();
    }
  });

  it("does not reject when a handler fails and sending the error fails too", async () => {
    const harness = makeEda();
    const extension = await loadExtension();
    extension.connect();
    await harness.registration.onOpen?.();
    harness.eda.sys_WebSocket.send.mockImplementation(() => {
      throw new Error("socket closed");
    });

    await expect(harness.registration.onMessage?.({
      data: JSON.stringify({ kind: "call", requestId: "x-1", method: "noSuchMethod", params: {} })
    } as MessageEvent<string>)).resolves.toBeUndefined();

    // send() reported the failure, so a reconnect is scheduled.
    await vi.advanceTimersByTimeAsync(10);
    expect(harness.registerCount()).toBe(2);
  });

  it("does not classify a document as pcb because its name contains PCB", async () => {
    const { harness } = await connected();
    harness.document.info = { uuid: "doc-1", name: "MyPCB schematic" };

    const message = await call(harness, "getContext");

    expect(message.result.status.activeDocumentType).not.toBe("pcb");
    harness.document.info = { uuid: "doc-1", type: "schematic", name: "MyPCB" };
    expect((await call(harness, "getContext")).result.status.activeDocumentType).toBe("schematic");
  });

  describe("exportPdf scope", () => {
    const pdfApis = () => ({
      pcb_ManufactureData: { getPdfFile: vi.fn(async () => new Blob(["%PDF-pcb"])) },
      sch_ManufactureData: { getExportDocumentFile: vi.fn(async () => new Blob(["%PDF-sch"])) }
    });

    it("rejects auto scope on the home tab without touching the PCB API", async () => {
      const apis = pdfApis();
      const { harness } = await connected({}, apis);
      harness.document.info = { uuid: "home", documentType: -1 };

      const message = await call(harness, "exportPdf", { fileName: "out", scope: "auto" });

      expect(message.error?.code).toBe("unsupported_document");
      expect(apis.pcb_ManufactureData.getPdfFile).not.toHaveBeenCalled();
      expect(apis.sch_ManufactureData.getExportDocumentFile).not.toHaveBeenCalled();
    });

    it("uses pcb getPdfFile for scope pcb with a PCB active", async () => {
      const apis = pdfApis();
      const { harness } = await connected({}, apis);
      harness.document.info = { uuid: "pcb-1", documentType: 3 };

      const message = await call(harness, "exportPdf", { fileName: "out", scope: "pcb" });

      expect(message.result).toMatchObject({ fileName: "out.pdf", size: 8 });
      expect(apis.pcb_ManufactureData.getPdfFile).toHaveBeenCalledWith("out");
      expect(apis.sch_ManufactureData.getExportDocumentFile).not.toHaveBeenCalled();
    });

    it("uses sch getExportDocumentFile(name, \"PDF\") for scope schematic", async () => {
      const apis = pdfApis();
      const { harness } = await connected({}, apis);
      harness.document.info = { uuid: "pcb-1", documentType: 3 };

      const message = await call(harness, "exportPdf", { fileName: "out", scope: "schematic" });

      expect(message.result).toMatchObject({ fileName: "out.pdf" });
      expect(apis.sch_ManufactureData.getExportDocumentFile).toHaveBeenCalledWith("out", "PDF");
      expect(apis.pcb_ManufactureData.getPdfFile).not.toHaveBeenCalled();
    });
  });
});
