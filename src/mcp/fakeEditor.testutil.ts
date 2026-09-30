// Test helper (not used at runtime): a fake EasyEDA editor behind the bridge
// methods useDocument / exportFile / pcbDrc / pcbSnapshot / schematicSnapshot.
import { BridgeRpcError } from "../bridge/errors.js";

export const DOCS = { sch: { uuid: "sch1", documentType: 1, name: "Main" }, pcb: { uuid: "pcb1", documentType: 3, name: "Board" } };

/** Fake extension: tracks the active document and refuses exports for the wrong one. */
export function fakeEditor(options: {
  failPaths?: string[];
  drcErrors?: number;
  enet?: unknown;
  schematic?: unknown;
  /** Full pcbSnapshot result (default: counts only). */
  pcb?: unknown;
  /** getPrimitivesBBox answers by primitive id, for apiBatch. */
  bboxes?: Record<string, unknown>;
} = {}) {
  let current: { uuid: string; documentType: number; name: string } = DOCS.sch;
  const log: string[] = [];
  const call = async (method: string, params?: unknown): Promise<unknown> => {
    const p = (params ?? {}) as Record<string, any>;
    if (method === "useDocument") {
      const previous = { uuid: current.uuid, documentType: current.documentType };
      current = p.uuid ? (p.uuid === "pcb1" ? DOCS.pcb : DOCS.sch) : p.kind === "pcb" ? DOCS.pcb : DOCS.sch;
      log.push(`use:${p.uuid ?? p.kind}`);
      return { previous, current };
    }
    if (method === "exportFile") {
      const needs = String(p.path).startsWith("pcb_") ? "pcb1" : "sch1";
      log.push(`export:${p.path}`);
      if (current.uuid !== needs) throw new BridgeRpcError(`wrong document for ${p.path}`, "unsupported_document");
      if (options.failPaths?.includes(p.path)) throw new BridgeRpcError(`no file from ${p.path}`, "export_empty");
      if (p.path === "pcb_ManufactureData.getNetlistFile") {
        return { fileName: "n.enet", base64: Buffer.from(JSON.stringify(options.enet ?? { components: {} })).toString("base64") };
      }
      if (p.path === "pcb_ManufactureData.getBomFile") {
        const tsv = "﻿Designator\tValue\nR1\t10k\n";
        return { fileName: `${p.fileName}.csv`, base64: Buffer.from(tsv, "utf16le").toString("base64") };
      }
      if (p.path === "pcb_ManufactureData.getGerberFile" || p.path === "pcb_ManufactureData.getAltiumDesignerFile") {
        return { fileName: String(p.fileName), base64: Buffer.from("PK\u0003\u0004fakezip").toString("base64") };
      }
      if (p.path === "pcb_ManufactureData.get3DFile") {
        return { fileName: "board", mimeType: "text/plain", base64: Buffer.from("ISO-10303-21;\nHEADER;").toString("base64") };
      }
      return { fileName: String(p.fileName), base64: Buffer.from(`%PDF-1.4 ${p.path} ${JSON.stringify(p.args)}`).toString("base64") };
    }
    if (method === "pcbDrc") {
      log.push("drc");
      if (current.uuid !== "pcb1") throw new BridgeRpcError("drc needs pcb", "unsupported_document");
      return { ok: (options.drcErrors ?? 0) === 0, errorCount: options.drcErrors ?? 0, categories: [] };
    }
    if (method === "pcbSnapshot") {
      if (options.pcb === undefined) return { counts: { components: 2, nets: 1 } };
      log.push("pcbSnapshot");
      if (current.uuid !== "pcb1") throw new BridgeRpcError("needs pcb", "unsupported_document");
      return options.pcb;
    }
    if (method === "apiBatch") {
      log.push("apiBatch");
      const calls = (p.calls ?? []) as Array<{ path: string; args?: unknown[] }>;
      return {
        results: calls.map((c) => {
          if (c.path === "pcb_Layer.getTheNumberOfCopperLayers") return { ok: true, value: 2 };
          if (c.path === "pcb_Primitive.getPrimitivesBBox") {
            const id = String((c.args?.[0] as unknown[] | undefined)?.[0]);
            return options.bboxes?.[id] ? { ok: true, value: options.bboxes[id] } : { ok: false, error: { code: "easyeda_api_error", message: `no bbox for ${id}` } };
          }
          return { ok: false, error: { code: "api_unavailable", message: `${c.path} not faked` } };
        })
      };
    }
    if (method === "schematicSnapshot") {
      if (current.uuid !== "sch1") throw new BridgeRpcError("needs schematic", "unsupported_document");
      return options.schematic ?? { components: [], pins: [], counts: { components: 0 } };
    }
    throw new Error(`unexpected ${method}`);
  };
  return {
    bridge: { endpoint: "fake", getStatus: () => ({ connected: true, projectName: "My Board/v2", extensionVersion: "1.2.0", updatedAt: "" }), call },
    log,
    get current() {
      return current;
    }
  };
}

