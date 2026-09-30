import { describe, expect, it } from "vitest";
import { analyzePcb, formatPcbAnalysis, type PcbSnapshotLike } from "./analyze.js";

// Synthetic boards in the shape of pcbSnapshot output (mil, y negative downward).

type PadSpec = { n: string; x: number; y: number; net?: string; w?: number; h?: number; layer?: number; shape?: string };

function part(id: string, designator: string, layer: number, x: number, y: number, pads: PadSpec[], rotation = 0) {
  return {
    component: {
      primitiveType: "Component",
      primitiveId: id,
      designator,
      layer,
      x,
      y,
      rotation,
      footprint: { name: `FP_${designator}` },
      pads: pads.map((p, i) => ({ primitiveId: `p${i}`, net: p.net ?? "", padNumber: p.n }))
    },
    pads: pads.map((p, i) => ({
      primitiveType: "Pad",
      primitiveId: `${id}p${i}`,
      padNumber: p.n,
      layer: p.layer ?? layer,
      x: p.x,
      y: p.y,
      rotation: 0,
      pad: [p.shape ?? "RECT", p.w ?? 20, p.h ?? 20, 0],
      net: p.net ?? ""
    }))
  };
}

function board(parts: Array<ReturnType<typeof part>>, extra: Partial<PcbSnapshotLike> = {}): PcbSnapshotLike {
  return {
    units: "mil",
    outline: { layer: 11, polygon: { polygon: [0, 0, "L", 1000, 0, 1000, -1000, 0, -1000, 0, 0] } },
    components: parts.map((p) => p.component),
    pads: parts.flatMap((p) => p.pads),
    tracks: [],
    arcs: [],
    vias: [],
    pours: [],
    layers: [
      { id: 1, name: "Top Layer", type: "SIGNAL", layerStatus: 1 },
      { id: 2, name: "Bottom Layer", type: "SIGNAL", layerStatus: 1 },
      { id: 15, name: "In1.Cu", type: "SIGNAL", layerStatus: 0 }
    ],
    ...extra
  };
}

function track(net: string, layer: number, sx: number, sy: number, ex: number, ey: number, lineWidth = 10) {
  return { primitiveType: "Line", net, layer, startX: sx, startY: sy, endX: ex, endY: ey, lineWidth };
}

// Two-pad resistor footprint around (x, y), pads 60 mil apart.
function resistor(id: string, designator: string, layer: number, x: number, y: number, nets: [string?, string?] = []) {
  return part(id, designator, layer, x, y, [
    { n: "1", x: x - 30, y, net: nets[0] },
    { n: "2", x: x + 30, y, net: nets[1] }
  ]);
}

describe("analyzePcb board and placement", () => {
  it("reads the board outline, size, area and copper layer count", () => {
    const report = analyzePcb(board([resistor("c1", "R1", 1, 500, -500)]));
    expect(report.board.outlineSource).toBe("outline");
    expect(report.board).toMatchObject({ width: 1000, height: 1000, area: 1_000_000, copperLayers: 2, widthMm: 25.4 });
    const r1 = report.placement.components[0]!;
    expect(r1).toMatchObject({ designator: "R1", side: "top", bboxSource: "pads", width: 80, height: 20, pads: 2 });
  });

  it("takes the outline from board-outline polylines, else estimates it", () => {
    const base = board([resistor("c1", "R1", 1, 500, -500)]);
    delete base.outline;
    const fromPolyline = analyzePcb(base, { outlinePrimitives: [{ layer: 11, polygon: { polygon: [0, 0, "L", 2000, 0, 2000, -1000, 0, -1000] } }, { layer: 3, polygon: { polygon: [0, 0, "L", 9000, 0, 9000, -9000] } }] });
    expect(fromPolyline.board).toMatchObject({ outlineSource: "board-outline-layer", width: 2000, height: 1000 });
    const estimated = analyzePcb(base);
    expect(estimated.board.outlineSource).toBe("estimated");
    expect(estimated.findings.map((f) => f.code)).toContain("outline-missing");
  });

  it("flags components outside the board", () => {
    const report = analyzePcb(board([
      resistor("c1", "R1", 1, 990, -500),
      resistor("c2", "R2", 1, 500, -500),
      resistor("c3", "R3", 1, 200, -200)
    ]), { bboxes: { c2: { minX: 450, minY: -520, maxX: 1100, maxY: -480 } } });
    const outside = report.findings.filter((f) => f.code === "pads-outside-board" || f.code === "outside-board");
    expect(outside).toEqual([
      expect.objectContaining({ severity: "error", code: "pads-outside-board", designators: ["R1"] }),
      expect.objectContaining({ severity: "warning", code: "outside-board", designators: ["R2"] })
    ]);
    expect(report.placement.components.find((c) => c.designator === "R2")!.bboxSource).toBe("api");
  });

  it("reports overlaps on the same side only, mechanical parts as info", () => {
    const report = analyzePcb(board([
      resistor("c1", "R1", 1, 500, -500, ["A", "B"]),
      resistor("c2", "R2", 1, 540, -505, ["C", "D"]),
      // Same place on the bottom: no overlap with the top parts.
      resistor("c3", "R3", 2, 500, -500, ["E", "F"]),
      // Mounting hole (no nets) over R1.
      part("c4", "H1", 1, 470, -500, [{ n: "1", x: 470, y: -500, w: 40, h: 40, layer: 12 }])
    ]));
    const overlaps = report.findings.filter((f) => f.code === "overlap");
    expect(overlaps.map((f) => [f.severity, f.designators])).toEqual([
      ["warning", ["R1", "R2"]],
      ["info", ["R1", "H1"]]
    ]);
    expect(overlaps[0]!.data).toMatchObject({ side: "top", overlapArea: 600, padOverlap: true });
    expect(report.placement.top.components).toBe(3);
    expect(report.placement.bottom).toMatchObject({ components: 1, bboxArea: 1600, density: 0.0016 });
  });

  it("measures edge-to-edge spacing and lists the closest pairs", () => {
    const report = analyzePcb(board([
      resistor("c1", "R1", 1, 200, -500),
      resistor("c2", "R2", 1, 300, -500), // gap 100 - 80 = 20
      resistor("c3", "R3", 1, 700, -500),
      resistor("c4", "R4", 2, 250, -500) // bottom: ignored for top spacing
    ]), { top: 2 });
    expect(report.placement.closestPairs).toEqual([
      { side: "top", a: "R1", b: "R2", gap: 20 },
      { side: "top", a: "R2", b: "R3", gap: 320 }
    ]);
    expect(report.placement.components.find((c) => c.designator === "R1")!.nearest).toEqual({ designator: "R2", gap: 20 });
    expect(report.placement.components.find((c) => c.designator === "R4")!.nearest).toBeUndefined();
  });

  it("reports non-90-degree rotations and off-grid parts as info", () => {
    const tilted = resistor("c1", "R1", 1, 503, -500);
    tilted.component.rotation = 45;
    const report = analyzePcb(board([tilted, resistor("c2", "R2", 1, 200, -200)]), { grid: 5 });
    const info = report.findings.filter((f) => f.severity === "info").map((f) => `${f.code}:${f.designators?.join()}`);
    expect(info).toEqual(["rotation-not-90:R1", "off-grid:R1"]);
  });
});

describe("analyzePcb routing", () => {
  it("sums straight and arc track length, widths, layers and vias per net", () => {
    const report = analyzePcb(board([], {
      tracks: [track("SIG", 1, 0, 0, 300, -400, 8), track("SIG", 2, 300, -400, 300, -500, 12), track("", 1, 0, 0, 10, 0)],
      arcs: [{ primitiveType: "Arc", net: "SIG", layer: 1, startX: 0, startY: 0, endX: 200, endY: 0, arcAngle: 180, lineWidth: 10 }],
      vias: [{ net: "SIG", x: 300, y: -400, diameter: 24, holeDiameter: 12 }, { net: "OTHER", x: 10, y: -10, diameter: 24 }],
      nets: [{ net: "SIG", length: 700 }]
    }));
    const sig = report.routing.nets.find((n) => n.net === "SIG")!;
    expect(sig.trackLength).toBeCloseTo(500 + 100 + 100 * Math.PI, 1);
    expect(sig).toMatchObject({ segments: 2, arcs: 1, vias: 1, minWidth: 8, maxWidth: 12, layers: ["Top Layer", "Bottom Layer"], easyedaLength: 700, status: "no-pads" });
    expect(report.routing.vias).toBe(2);
    expect(report.routing.longestNets[0]!.net).toBe("SIG");
  });

  it("finds two pads of a net with no track as possibly unrouted", () => {
    const report = analyzePcb(board([
      part("c1", "U1", 1, 200, -200, [{ n: "1", x: 200, y: -200, net: "N1" }]),
      part("c2", "U2", 1, 600, -200, [{ n: "1", x: 600, y: -200, net: "N1" }])
    ]));
    expect(report.routing.possiblyUnrouted).toEqual(["N1"]);
    const net = report.routing.nets.find((n) => n.net === "N1")!;
    expect(net.padGroups).toEqual([["U1.1"], ["U2.1"]]);
    expect(report.findings).toContainEqual(expect.objectContaining({ severity: "warning", code: "possibly-unrouted", net: "N1" }));
  });

  it("follows a route from a top pad through a via to a bottom pad", () => {
    const parts = [
      part("c1", "U1", 1, 100, -100, [{ n: "1", x: 100, y: -100, net: "N1" }]),
      part("c2", "U2", 2, 500, -100, [{ n: "1", x: 500, y: -100, net: "N1" }])
    ];
    const routed = { tracks: [track("N1", 1, 100, -100, 300, -100), track("N1", 2, 300, -100, 500, -100)], vias: [{ net: "N1", x: 300, y: -100, diameter: 24 }] };
    const report = analyzePcb(board(parts, routed));
    expect(report.routing.nets.find((n) => n.net === "N1")!.status).toBe("routed");
    expect(report.findings.filter((f) => f.code === "possibly-unrouted")).toEqual([]);
    // Without the via the two layers do not meet.
    expect(analyzePcb(board(parts, { ...routed, vias: [] })).routing.possiblyUnrouted).toEqual(["N1"]);
    // A bottom track does not reach a top-only SMD pad.
    expect(analyzePcb(board(parts, { ...routed, tracks: [track("N1", 2, 100, -100, 500, -100)], vias: [] })).routing.possiblyUnrouted).toEqual(["N1"]);
  });

  it("connects pads through a pour of the same net on the pad's layer", () => {
    const parts = [
      part("c1", "C1", 1, 200, -200, [{ n: "2", x: 200, y: -200, net: "GND" }]),
      part("c2", "C2", 1, 400, -200, [{ n: "2", x: 400, y: -200, net: "GND" }]),
      part("c3", "J1", 1, 800, -800, [{ n: "1", x: 800, y: -800, net: "GND", layer: 12, shape: "ELLIPSE" }])
    ];
    const pour = (layer: number, poly: unknown[]) => ({ primitiveType: "Pour", net: "GND", layer, complexPolygon: { polygon: poly }, lineWidth: 0.2 });
    const topPour = pour(1, [100, -100, "L", 500, -100, 500, -300, 100, -300, 100, -100]);
    // Bottom pour reaching the through-hole J1 and a via next to C2.
    const bottomPour = pour(2, [350, -150, "L", 900, -150, 900, -900, 350, -900]);
    const via = { net: "GND", x: 420, y: -250, diameter: 24 };
    const report = analyzePcb(board(parts, { pours: [topPour, bottomPour], vias: [via] }));
    expect(report.routing.nets.find((n) => n.net === "GND")).toMatchObject({ status: "routed", pours: 2 });
    expect(report.routing.pourConnectivity).toBe("outline");
    // A pour of another net does not connect GND.
    const otherNet = { ...topPour, net: "VCC" };
    expect(analyzePcb(board(parts, { pours: [otherNet, bottomPour], vias: [via] })).routing.nets.find((n) => n.net === "GND")!.padGroups).toEqual([["C1.2"], ["C2.2"], ["J1.1"]]);
    // A pour without geometry leaves connectivity unknown: info instead of warning.
    const unknown = analyzePcb(board(parts, { pours: [{ ...topPour, complexPolygon: undefined }] }));
    expect(unknown.routing.pourConnectivity).toBe("unknown");
    expect(unknown.findings.find((f) => f.code === "possibly-unrouted")!.severity).toBe("info");
  });

  it("formats a short human summary", () => {
    const report = analyzePcb(board([
      part("c1", "U1", 1, 200, -200, [{ n: "1", x: 200, y: -200, net: "N1" }]),
      part("c2", "U2", 1, 600, -200, [{ n: "1", x: 600, y: -200, net: "N1" }])
    ]));
    const text = formatPcbAnalysis(report);
    expect(text).toMatch(/^WARNINGS: 0 error\(s\), 1 warning\(s\)/);
    expect(text).toContain("Board: 1000 x 1000 mil (25.4 x 25.4 mm)");
    expect(text).toContain("Possibly unrouted: N1");
  });
});
