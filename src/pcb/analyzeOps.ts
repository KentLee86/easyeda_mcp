// Live side of `pcb analyze`: switch to the PCB, read one snapshot plus one
// apiBatch (component boxes, copper layer count, outline polylines when the
// snapshot has no board outline), restore the original document, analyze.
import { errorToWire, type WireError } from "../bridge/errors.js";
import type { BridgeClient } from "../bridge/types.js";
import { DocumentSession } from "../mcp/exportOps.js";
import { analyzePcb, type AnalyzeOptions, type BBox, type PcbAnalysis, type PcbSnapshotLike } from "./analyze.js";

export const PCB_ANALYZE_SECTIONS = ["components", "pads", "tracks", "arcs", "vias", "pours", "fills", "regions", "nets", "layers", "outline"];

export type PcbAnalyzeRequest = Pick<AnalyzeOptions, "top" | "grid" | "tolerance"> & {
  /** Ask EasyEDA for per-component boxes (getPrimitivesBBox). Default true; false = pad extents. */
  bboxes?: boolean;
  timeoutMs?: number;
};

export type PcbAnalyzeResult = PcbAnalysis & {
  ok: boolean;
  document?: { uuid?: string; name?: string };
  sources: { bboxes: number; bboxErrors: number; outlinePolylines?: number; notes: WireError[] };
  documents: { switches: Array<{ kind: string; uuid?: string; name?: string }>; restored: boolean; restoreError?: WireError };
};

type BatchResult = { results?: Array<{ ok: boolean; value?: unknown; error?: WireError }> };

function isBox(value: unknown): value is BBox {
  const box = value as Partial<BBox> | undefined;
  return !!box && [box.minX, box.minY, box.maxX, box.maxY].every((n) => typeof n === "number" && Number.isFinite(n));
}

function hasOutline(snapshot: PcbSnapshotLike): boolean {
  const outline = snapshot.outline;
  return !!outline && (!Array.isArray(outline) || outline.length > 0) && !snapshot.errors?.outline;
}

export async function runPcbAnalyze(bridge: BridgeClient, request: PcbAnalyzeRequest = {}): Promise<PcbAnalyzeResult> {
  const timeoutMs = request.timeoutMs ?? 60_000;
  const session = new DocumentSession(bridge);
  const notes: WireError[] = [];
  let snapshot: PcbSnapshotLike;
  let document: { uuid?: string; name?: string } | undefined;
  const bboxes: Record<string, BBox> = {};
  let bboxErrors = 0;
  let copperLayers: number | undefined;
  let outlinePrimitives: unknown[] | undefined;
  let restored = false;
  let restoreError: WireError | undefined;
  try {
    const current = await session.use("pcb");
    document = { uuid: current?.uuid, ...(current?.name ? { name: current.name } : {}) };
    snapshot = await bridge.call("pcbSnapshot", { include: PCB_ANALYZE_SECTIONS }, timeoutMs) as PcbSnapshotLike;
    if (snapshot.errors) {
      for (const [part, message] of Object.entries(snapshot.errors)) notes.push({ code: "snapshot_part_failed", message: `${part}: ${message}` });
    }
    const ids = (Array.isArray(snapshot.components) ? snapshot.components : [])
      .map((item) => (item as { primitiveId?: unknown }).primitiveId)
      .filter((id): id is string => typeof id === "string");
    const wantOutline = !hasOutline(snapshot);
    const calls: Array<{ path: string; args: unknown[] }> = [{ path: "pcb_Layer.getTheNumberOfCopperLayers", args: [] }];
    if (wantOutline) calls.push({ path: "pcb_PrimitivePolyline.getAll", args: [] });
    const bboxStart = calls.length;
    if (request.bboxes !== false) for (const id of ids) calls.push({ path: "pcb_Primitive.getPrimitivesBBox", args: [[id]] });
    try {
      const batch = await bridge.call("apiBatch", { calls, stopOnError: false }, timeoutMs) as BatchResult;
      const results = Array.isArray(batch?.results) ? batch.results : [];
      const layerCount = results[0];
      if (layerCount?.ok && typeof layerCount.value === "number" && layerCount.value > 0) copperLayers = layerCount.value;
      if (wantOutline) {
        const polylines = results[1];
        if (polylines?.ok && Array.isArray(polylines.value)) outlinePrimitives = polylines.value;
        else if (polylines?.error) notes.push({ code: "outline_unavailable", message: polylines.error.message });
      }
      ids.forEach((id, index) => {
        if (request.bboxes === false) return;
        const result = results[bboxStart + index];
        if (result?.ok && isBox(result.value)) bboxes[id] = result.value;
        else bboxErrors++;
      });
    } catch (error) {
      // Older extensions without apiBatch: fall back to pad extents.
      notes.push({ code: "batch_failed", message: errorToWire(error).error.message });
      if (request.bboxes !== false) bboxErrors = ids.length;
    }
  } finally {
    const restore = await session.restore();
    restored = restore.restored;
    restoreError = restore.error;
  }

  const report = analyzePcb(snapshot, {
    top: request.top,
    grid: request.grid,
    tolerance: request.tolerance,
    bboxes,
    ...(outlinePrimitives ? { outlinePrimitives } : {}),
    ...(copperLayers ? { copperLayers } : {})
  });
  return {
    ok: report.summary.errors === 0 && report.summary.warnings === 0,
    ...(document ? { document } : {}),
    ...report,
    sources: {
      bboxes: Object.keys(bboxes).length,
      bboxErrors,
      ...(outlinePrimitives ? { outlinePolylines: outlinePrimitives.length } : {}),
      notes
    },
    documents: { switches: session.switches, restored, ...(restoreError ? { restoreError } : {}) }
  };
}
