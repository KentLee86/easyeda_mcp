import { describe, expect, it } from "vitest";
import { fakeEditor } from "../mcp/fakeEditor.testutil.js";
import { runPcbAnalyze } from "./analyzeOps.js";
import { SAMPLE_PCB } from "./fixtures.testutil.js";

describe("runPcbAnalyze", () => {
  it("switches to the PCB, reads snapshot + one batch, restores, and analyzes", async () => {
    const editor = fakeEditor({ pcb: SAMPLE_PCB, bboxes: { c1: { minX: 150, minY: -250, maxX: 250, maxY: -150 } } });
    const result = await runPcbAnalyze(editor.bridge, { top: 3 });
    expect(editor.log).toEqual(["use:pcb", "pcbSnapshot", "apiBatch", "use:sch1"]);
    expect(editor.current.uuid).toBe("sch1");
    expect(result.documents).toMatchObject({ restored: true, switches: [{ kind: "pcb", uuid: "pcb1" }] });
    expect(result.sources).toMatchObject({ bboxes: 1, bboxErrors: 1 });
    expect(result.placement.components.map((c) => c.bboxSource)).toEqual(["api", "pads"]);
    expect(result.board).toMatchObject({ outlineSource: "outline", width: 1000, copperLayers: 2 });
    expect(result.routing.possiblyUnrouted).toEqual(["N1"]);
    expect(result.ok).toBe(false);
  });

  it("skips the bbox calls when asked and is ok for a clean board", async () => {
    const routed = { ...SAMPLE_PCB, tracks: [{ net: "N1", layer: 1, startX: 200, startY: -200, endX: 600, endY: -200, lineWidth: 10 }] };
    const editor = fakeEditor({ pcb: routed });
    const result = await runPcbAnalyze(editor.bridge, { bboxes: false });
    expect(result.ok).toBe(true);
    expect(result.sources).toMatchObject({ bboxes: 0, bboxErrors: 0 });
    expect(result.routing.nets.find((n) => n.net === "N1")).toMatchObject({ status: "routed", trackLength: 400 });
  });

  it("restores the document when the snapshot fails", async () => {
    const editor = fakeEditor({ pcb: SAMPLE_PCB });
    const failing = { ...editor.bridge, call: async (method: string, params?: unknown) => {
      if (method === "pcbSnapshot") throw new Error("boom");
      return editor.bridge.call(method, params);
    } };
    await expect(runPcbAnalyze(failing)).rejects.toThrow("boom");
    expect(editor.current.uuid).toBe("sch1");
  });
});
