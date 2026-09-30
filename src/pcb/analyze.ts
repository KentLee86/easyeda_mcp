// Offline placement / routing analysis of an EasyEDA Pro PCB snapshot
// (bridge method pcbSnapshot, units mil). Pure: no bridge, no I/O.
//
// Assumptions (see docs/cli.md, "pcb analyze"):
// - Layer 1 = top copper, 2 = bottom, 15..46 = inner copper, 11 = board
//   outline, 12 = multi-layer (through-hole pads). Vias connect all layers.
// - Component rotation is in degrees; pad rotation is in radians (what
//   pcb_PrimitivePad reports). A pad rotation above 2*pi is read as degrees.
// - Pads are rectangles (RECT/OVAL, OVAL as its bounding rectangle) or
//   16-gon ellipses; other shapes fall back to their width/height rectangle.
// - Pours connect whatever of their net touches the pour *outline* on that
//   layer. The poured copper is smaller (clearances, removed islands), so
//   this can over-connect but not under-connect.

import {
  arcLength,
  arcPolyline,
  bboxArea,
  bboxCorners,
  bboxGap,
  bboxHeight,
  bboxInside,
  bboxOfPoints,
  bboxOverlapArea,
  bboxWidth,
  ellipsePolygon,
  inflateBBox,
  parsePolygonSource,
  pointInPolygon,
  polygonArea,
  rotatedRect,
  shapeBBox,
  shapesTouch,
  unionBBox,
  type BBox,
  type Point,
  type Shape
} from "./geometry.js";

export type { BBox } from "./geometry.js";

type Rec = Record<string, unknown>;

export type PcbSnapshotLike = {
  document?: unknown;
  units?: unknown;
  components?: unknown[];
  pads?: unknown[];
  tracks?: unknown[];
  arcs?: unknown[];
  vias?: unknown[];
  pours?: unknown[];
  fills?: unknown[];
  regions?: unknown[];
  nets?: unknown[];
  layers?: unknown[];
  outline?: unknown;
  errors?: Record<string, string>;
};

export type AnalyzeOptions = {
  /** How many entries to keep in top-N lists (closest pairs, longest nets). Default 10. */
  top?: number;
  /** Component bounding boxes by component primitiveId (from pcb_Primitive.getPrimitivesBBox). */
  bboxes?: Record<string, BBox>;
  /** Extra primitives that may carry the board outline (e.g. pcb_PrimitivePolyline.getAll()). */
  outlinePrimitives?: unknown[];
  /** Copper layer count if known (pcb_Layer.getTheNumberOfCopperLayers). */
  copperLayers?: number;
  /** Connection tolerance in mil. Default 0.5. */
  tolerance?: number;
  /** Report components whose origin is off this grid (mil), as info. */
  grid?: number;
};

export type Severity = "error" | "warning" | "info";

export type Finding = {
  severity: Severity;
  code: string;
  message: string;
  designators?: string[];
  net?: string;
  data?: Record<string, unknown>;
};

export type ComponentInfo = {
  designator: string;
  primitiveId: string;
  side: "top" | "bottom";
  layer: number;
  x: number;
  y: number;
  rotation: number;
  footprint?: string;
  bbox?: BBox;
  bboxSource: "api" | "pads" | "none";
  width: number;
  height: number;
  padBBox?: BBox;
  pads: number;
  connectedPads: number;
  nearest?: { designator: string; gap: number };
};

export type NetRouting = {
  net: string;
  pads: number;
  trackLength: number;
  segments: number;
  arcs: number;
  vias: number;
  pours: number;
  layers: string[];
  minWidth?: number;
  maxWidth?: number;
  /** Length EasyEDA reports for the net (pcb_Net), when present. */
  easyedaLength?: number;
  /** Connected groups of pads (only listed when more than one). */
  padGroups?: string[][];
  status: "routed" | "possibly-unrouted" | "single-pad" | "no-pads";
};

export type PcbAnalysis = {
  units: "mil";
  board: {
    outlineSource: "outline" | "board-outline-layer" | "estimated";
    bbox?: BBox;
    width?: number;
    height?: number;
    widthMm?: number;
    heightMm?: number;
    area?: number;
    areaMm2?: number;
    copperLayers: number;
    counts: Record<string, number>;
  };
  placement: {
    top: { components: number; bboxArea: number; density?: number };
    bottom: { components: number; bboxArea: number; density?: number };
    components: ComponentInfo[];
    closestPairs: Array<{ side: "top" | "bottom"; a: string; b: string; gap: number }>;
  };
  routing: {
    nets: NetRouting[];
    totalTrackLength: number;
    vias: number;
    longestNets: Array<{ net: string; trackLength: number }>;
    possiblyUnrouted: string[];
    pourConnectivity: "outline" | "none" | "unknown";
  };
  findings: Finding[];
  summary: { errors: number; warnings: number; infos: number };
  assumptions: string[];
};

const TOP = 1;
const BOTTOM = 2;
const OUTLINE_LAYER = 11;
const MULTI = 12;
const MM_PER_MIL = 0.0254;

const ASSUMPTIONS = [
  "Units are mil. Layer 1 = top, 2 = bottom, 15-46 = inner copper, 11 = board outline, 12 = multi-layer (through-hole).",
  "Vias and multi-layer pads connect every copper layer; blind/buried via spans are ignored.",
  "Pours connect items of their net that touch the pour outline on the pour's layer; the actual poured copper is smaller, so connectivity can be over-estimated, never under-estimated.",
  "Pad rotation is read as radians (pcb_PrimitivePad), component rotation as degrees.",
  "Component boxes come from pcb_Primitive.getPrimitivesBBox when available (may include silkscreen), otherwise from the pad extents.",
  "Copper items of one net connect when their copper overlaps within the tolerance (default 0.5 mil)."
];

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function records(list: unknown): Rec[] {
  return Array.isArray(list) ? list.filter((item): item is Rec => !!item && typeof item === "object") : [];
}

function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function roundBox(box: BBox): BBox {
  return { minX: round(box.minX), minY: round(box.minY), maxX: round(box.maxX), maxY: round(box.maxY) };
}

function isCopper(layer: number): boolean {
  return layer === TOP || layer === BOTTOM || (layer >= 15 && layer <= 46);
}

function polygonSource(item: Rec): unknown {
  for (const key of ["complexPolygon", "polygon"]) {
    const value = item[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && Array.isArray((value as Rec).polygon)) return (value as Rec).polygon;
  }
  return undefined;
}

// ---- board outline ---------------------------------------------------------

type Outline = { source: PcbAnalysis["board"]["outlineSource"]; rings: Point[][]; bbox?: BBox };

/** Rings from whatever getPrimitiveBoardLine / polylines / lines returned. */
function ringsFrom(value: unknown, requireOutlineLayer: boolean): Point[][] {
  const items = Array.isArray(value) && value.every((item) => item && typeof item === "object" && !Array.isArray(item)) ? (value as Rec[]) : value && typeof value === "object" && !Array.isArray(value) ? [value as Rec] : [];
  const rings: Point[][] = [];
  for (const item of items) {
    const layer = num(item.layer);
    if (requireOutlineLayer && layer !== OUTLINE_LAYER) continue;
    const source = polygonSource(item);
    if (source) rings.push(...parsePolygonSource(source));
  }
  if (items.length === 0 && Array.isArray(value)) rings.push(...parsePolygonSource(value));
  return rings.filter((ring) => ring.length >= 3);
}

/** Chain loose board-outline lines/arcs (layer 11) into one point cloud ring. */
function outlineFromLines(tracks: Rec[], arcs: Rec[]): Point[][] {
  const points: Point[] = [];
  for (const t of tracks) {
    if (num(t.layer) !== OUTLINE_LAYER) continue;
    const a = segmentEnds(t);
    if (a) points.push(a[0], a[1]);
  }
  for (const arc of arcs) {
    if (num(arc.layer) !== OUTLINE_LAYER) continue;
    const a = segmentEnds(arc);
    if (a) points.push(...arcPolyline(a[0], a[1], num(arc.arcAngle) ?? 0));
  }
  if (points.length < 3) return [];
  // Order by angle around the centroid: good enough for convex-ish outlines, used for bbox/area.
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  return [[...points].sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx))];
}

function resolveOutline(snapshot: PcbSnapshotLike, options: AnalyzeOptions, estimate: BBox | undefined): Outline {
  const fromOutline = ringsFrom(snapshot.outline, false);
  if (fromOutline.length > 0) return { source: "outline", rings: fromOutline, bbox: bboxOfPoints(fromOutline.flat()) };
  const fromPolylines = ringsFrom(options.outlinePrimitives, true);
  const fromLines = outlineFromLines(records(snapshot.tracks), records(snapshot.arcs));
  const rings = fromPolylines.length > 0 ? fromPolylines : fromLines;
  if (rings.length > 0) return { source: "board-outline-layer", rings, bbox: bboxOfPoints(rings.flat()) };
  return { source: "estimated", rings: [], bbox: estimate };
}

/** The outermost ring (largest area) is the board; others are cut-outs. */
function boardRing(outline: Outline): Point[] | undefined {
  let best: Point[] | undefined;
  for (const ring of outline.rings) if (!best || polygonArea(ring) > polygonArea(best)) best = ring;
  return best;
}

// ---- pads & components -------------------------------------------------------

type PadInfo = {
  id: string;
  label: string;
  net?: string;
  layer: number;
  center: Point;
  shape: Shape;
  bbox: BBox;
  componentId?: string;
};

function padRadians(rotation: number): number {
  return Math.abs(rotation) > 2 * Math.PI + 1e-6 ? (rotation * Math.PI) / 180 : rotation;
}

function padShape(pad: Rec, center: Point): Shape {
  const spec = Array.isArray(pad.pad) ? (pad.pad as unknown[]) : [];
  const kind = typeof spec[0] === "string" ? (spec[0] as string).toUpperCase() : "RECT";
  const w = num(spec[1]) ?? num(pad.width) ?? 0;
  const h = num(spec[2]) ?? num(pad.height) ?? w;
  const rot = padRadians(num(pad.rotation) ?? 0);
  if (kind === "POLYGON" || kind === "POLYLINE") {
    const rings = parsePolygonSource(spec[1]);
    const ring = rings[0];
    if (ring && ring.length >= 3) {
      // Pad polygons are relative to the pad centre.
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      return { points: ring.map((p) => ({ x: center.x + p.x * cos - p.y * sin, y: center.y + p.x * sin + p.y * cos })), closed: true, radius: 0 };
    }
    return { points: [center], closed: false, radius: 5 };
  }
  if (w <= 0 || h <= 0) return { points: [center], closed: false, radius: Math.max(w, h, 0) / 2 };
  if (kind === "ELLIPSE" || kind === "CIRCLE") return { points: ellipsePolygon(center, w, h, rot), closed: true, radius: 0 };
  return { points: rotatedRect(center, w, h, rot), closed: true, radius: 0 };
}

function normalizeRotation(deg: number): number {
  let r = deg % 360;
  if (r < 0) r += 360;
  return r;
}

// ---- routing primitives ------------------------------------------------------

function segmentEnds(item: Rec): [Point, Point] | undefined {
  const sx = num(item.startX);
  const sy = num(item.startY);
  const ex = num(item.endX);
  const ey = num(item.endY);
  if (sx === undefined || sy === undefined || ex === undefined || ey === undefined) return undefined;
  return [{ x: sx, y: sy }, { x: ex, y: ey }];
}

type Node = { kind: "pad" | "track" | "arc" | "via" | "pour"; layers: "all" | number; shape: Shape; bbox: BBox; pad?: PadInfo };

class UnionFind {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

function shareLayer(a: Node, b: Node): boolean {
  return a.layers === "all" || b.layers === "all" || a.layers === b.layers;
}

function boxesNear(a: BBox, b: BBox, tol: number): boolean {
  return a.minX <= b.maxX + tol && b.minX <= a.maxX + tol && a.minY <= b.maxY + tol && b.minY <= a.maxY + tol;
}

/** Group a net's pads by copper connectivity. */
function padGroups(nodes: Node[], tolerance: number): string[][] {
  const uf = new UnionFind(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      if (!shareLayer(a, b) || !boxesNear(a.bbox, b.bbox, tolerance)) continue;
      if (uf.find(i) === uf.find(j)) continue;
      if (shapesTouch(a.shape, b.shape, tolerance)) uf.union(i, j);
    }
  }
  const groups = new Map<number, string[]>();
  nodes.forEach((node, index) => {
    if (!node.pad) return;
    const root = uf.find(index);
    const list = groups.get(root) ?? [];
    list.push(node.pad.label);
    groups.set(root, list);
  });
  return [...groups.values()].map((group) => group.sort()).sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
}

// ---- main --------------------------------------------------------------------

export function analyzePcb(snapshot: PcbSnapshotLike, options: AnalyzeOptions = {}): PcbAnalysis {
  const top = Math.max(1, Math.floor(options.top ?? 10));
  const tolerance = options.tolerance ?? 0.5;
  const findings: Finding[] = [];

  const components = records(snapshot.components);
  const pads = records(snapshot.pads);
  const tracks = records(snapshot.tracks);
  const arcs = records(snapshot.arcs);
  const vias = records(snapshot.vias);
  const pours = records(snapshot.pours);
  const fills = records(snapshot.fills);
  const layers = records(snapshot.layers);
  const layerName = new Map<number, string>();
  for (const layer of layers) {
    const id = num(layer.id);
    if (id !== undefined) layerName.set(id, str(layer.name) ?? String(id));
  }
  const nameOf = (id: number) => layerName.get(id) ?? (id === TOP ? "Top Layer" : id === BOTTOM ? "Bottom Layer" : `Layer ${id}`);

  // Pads, keyed by their primitive id.
  const padById = new Map<string, PadInfo>();
  const padInfos: PadInfo[] = [];
  for (const pad of pads) {
    const x = num(pad.x);
    const y = num(pad.y);
    if (x === undefined || y === undefined) continue;
    const center = { x, y };
    const shape = padShape(pad, center);
    const info: PadInfo = {
      id: str(pad.primitiveId) ?? `pad${padInfos.length}`,
      label: str(pad.padNumber) ?? "?",
      ...(str(pad.net) ? { net: str(pad.net)! } : {}),
      layer: num(pad.layer) ?? MULTI,
      center,
      shape,
      bbox: shapeBBox(shape) ?? { minX: x, minY: y, maxX: x, maxY: y }
    };
    padById.set(info.id, info);
    padInfos.push(info);
  }

  // Components and their pads (pad primitiveId = component id + pad id).
  const componentInfos: ComponentInfo[] = [];
  for (const comp of components) {
    const primitiveId = str(comp.primitiveId) ?? `comp${componentInfos.length}`;
    const designator = str(comp.designator) ?? primitiveId;
    const layer = num(comp.layer) ?? TOP;
    let padBox: BBox | undefined;
    let padCount = 0;
    let connected = 0;
    for (const ref of records(comp.pads)) {
      const refId = str(ref.primitiveId);
      const pad = refId ? padById.get(`${primitiveId}${refId}`) ?? padById.get(refId) : undefined;
      padCount++;
      if (str(ref.net) ?? pad?.net) connected++;
      if (pad) {
        pad.componentId = primitiveId;
        pad.label = `${designator}.${str(ref.padNumber) ?? pad.label}`;
        padBox = unionBBox(padBox, pad.bbox);
      }
    }
    const apiBox = options.bboxes?.[primitiveId];
    const bbox = apiBox ?? padBox;
    const footprint = comp.footprint && typeof comp.footprint === "object" ? str((comp.footprint as Rec).name) : undefined;
    componentInfos.push({
      designator,
      primitiveId,
      side: layer === BOTTOM ? "bottom" : "top",
      layer,
      x: round(num(comp.x) ?? 0, 3),
      y: round(num(comp.y) ?? 0, 3),
      rotation: round(num(comp.rotation) ?? 0, 3),
      ...(footprint ? { footprint } : {}),
      ...(bbox ? { bbox: roundBox(bbox) } : {}),
      bboxSource: apiBox ? "api" : padBox ? "pads" : "none",
      width: bbox ? round(bboxWidth(bbox)) : 0,
      height: bbox ? round(bboxHeight(bbox)) : 0,
      ...(padBox ? { padBBox: roundBox(padBox) } : {}),
      pads: padCount,
      connectedPads: connected
    });
  }
  // Free pads (not part of a component) keep a readable label.
  for (const pad of padInfos) if (!pad.componentId) pad.label = `pad:${pad.id}`;

  // ---- board ----
  let estimate: BBox | undefined;
  for (const c of componentInfos) estimate = unionBBox(estimate, c.bbox);
  for (const p of padInfos) estimate = unionBBox(estimate, p.bbox);
  for (const t of tracks) {
    const ends = segmentEnds(t);
    if (ends && isCopper(num(t.layer) ?? 0)) estimate = unionBBox(estimate, inflateBBox(bboxOfPoints(ends)!, (num(t.lineWidth) ?? 0) / 2));
  }
  for (const v of vias) {
    const x = num(v.x);
    const y = num(v.y);
    if (x !== undefined && y !== undefined) estimate = unionBBox(estimate, inflateBBox({ minX: x, minY: y, maxX: x, maxY: y }, (num(v.diameter) ?? 0) / 2));
  }
  const outline = resolveOutline(snapshot, options, estimate);
  const ring = boardRing(outline);
  const boardBox = outline.bbox;
  const boardArea = ring ? polygonArea(ring) - outline.rings.filter((r) => r !== ring).reduce((sum, r) => sum + polygonArea(r), 0) : boardBox ? bboxArea(boardBox) : undefined;
  const copperLayers = options.copperLayers ?? (layers.filter((l) => l.type === "SIGNAL" || l.type === "INTERNAL_PLANE" || l.type === "PLANE").filter((l) => num(l.layerStatus) !== 0).length || 2);

  if (outline.source === "estimated") {
    findings.push({ severity: "info", code: "outline-missing", message: "No board outline in the snapshot; the board size is estimated from the copper and component extents and the outside-board check is skipped." });
  }

  const inBoard = (box: BBox): boolean => {
    if (!boardBox) return true;
    if (!bboxInside(box, boardBox, tolerance)) return false;
    if (!ring) return true;
    return bboxCorners(box).every((p) => pointInPolygon(p, ring));
  };

  // ---- placement checks ----
  if (outline.source !== "estimated") {
    for (const c of componentInfos) {
      if (c.padBBox && !inBoard(c.padBBox)) {
        findings.push({ severity: "error", code: "pads-outside-board", message: `${c.designator}: pads extend outside the board outline.`, designators: [c.designator], data: { padBBox: c.padBBox } });
      } else if (c.bbox && !inBoard(c.bbox)) {
        findings.push({ severity: "warning", code: "outside-board", message: `${c.designator}: body box (${c.bboxSource}) is not inside the board outline.`, designators: [c.designator], data: { bbox: c.bbox } });
      }
    }
  }

  for (const c of componentInfos) {
    const r = normalizeRotation(c.rotation);
    const off = Math.min(r % 90, 90 - (r % 90));
    if (off > 0.01) {
      findings.push({ severity: "info", code: "rotation-not-90", message: `${c.designator}: rotation ${c.rotation} is not a multiple of 90 degrees.`, designators: [c.designator] });
    }
    if (options.grid && options.grid > 0) {
      const g = options.grid;
      const dx = Math.abs(c.x / g - Math.round(c.x / g)) * g;
      const dy = Math.abs(c.y / g - Math.round(c.y / g)) * g;
      if (dx > 0.01 || dy > 0.01) {
        findings.push({ severity: "info", code: "off-grid", message: `${c.designator}: origin (${c.x}, ${c.y}) is off the ${g} mil grid.`, designators: [c.designator] });
      }
    }
  }

  const closestPairs: PcbAnalysis["placement"]["closestPairs"] = [];
  for (const side of ["top", "bottom"] as const) {
    const list = componentInfos.filter((c) => c.side === side && c.bbox);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const gap = bboxGap(a.bbox!, b.bbox!);
        for (const [self, other] of [[a, b], [b, a]] as const) {
          if (!self.nearest || gap < self.nearest.gap) self.nearest = { designator: other.designator, gap: round(gap) };
        }
        closestPairs.push({ side, a: a.designator, b: b.designator, gap: round(gap) });
        const overlap = bboxOverlapArea(a.bbox!, b.bbox!);
        if (overlap > tolerance * tolerance) {
          const mechanical = a.connectedPads === 0 || b.connectedPads === 0;
          const padOverlap = !!(a.padBBox && b.padBBox && bboxOverlapArea(a.padBBox, b.padBBox) > 0);
          const bothFromPads = a.bboxSource !== "api" && b.bboxSource !== "api";
          const severity: Severity = mechanical ? "info" : padOverlap || bothFromPads ? "warning" : "info";
          findings.push({
            severity,
            code: "overlap",
            message: `${a.designator} and ${b.designator} (${side}) overlap by ${round(overlap, 1)} sq mil${mechanical ? " (one has no connected pads)" : padOverlap ? " (pad areas overlap)" : bothFromPads ? "" : " (body boxes only)"}.`,
            designators: [a.designator, b.designator],
            data: { side, overlapArea: round(overlap, 1), padOverlap }
          });
        }
      }
    }
  }
  closestPairs.sort((p, q) => p.gap - q.gap || p.a.localeCompare(q.a));

  const sideStats = (side: "top" | "bottom") => {
    const list = componentInfos.filter((c) => c.side === side);
    const area = list.reduce((sum, c) => sum + (c.bbox ? bboxArea(c.bbox) : 0), 0);
    return { components: list.length, bboxArea: round(area, 1), ...(boardArea ? { density: round(area / boardArea, 4) } : {}) };
  };

  // ---- routing ----
  const netNames = new Set<string>();
  for (const item of [...padInfos, ...records(snapshot.nets).map((n) => ({ net: str(n.net) })), ...tracks.map((t) => ({ net: str(t.net) })), ...vias.map((v) => ({ net: str(v.net) }))]) {
    if (item.net) netNames.add(item.net);
  }
  const easyedaLength = new Map<string, number>();
  for (const n of records(snapshot.nets)) {
    const name = str(n.net);
    const length = num(n.length);
    if (name && length !== undefined) easyedaLength.set(name, length);
  }

  const nodesByNet = new Map<string, Node[]>();
  const push = (net: string | undefined, node: Node) => {
    if (!net) return;
    const list = nodesByNet.get(net) ?? [];
    list.push(node);
    nodesByNet.set(net, list);
  };
  const stats = new Map<string, NetRouting>();
  const stat = (net: string): NetRouting => {
    let s = stats.get(net);
    if (!s) {
      s = { net, pads: 0, trackLength: 0, segments: 0, arcs: 0, vias: 0, pours: 0, layers: [], status: "no-pads" };
      stats.set(net, s);
    }
    return s;
  };
  for (const net of netNames) stat(net);
  const addLayer = (s: NetRouting, layer: number) => {
    const name = nameOf(layer);
    if (!s.layers.includes(name)) s.layers.push(name);
  };
  const addWidth = (s: NetRouting, width: number) => {
    s.minWidth = s.minWidth === undefined ? width : Math.min(s.minWidth, width);
    s.maxWidth = s.maxWidth === undefined ? width : Math.max(s.maxWidth, width);
  };

  for (const pad of padInfos) {
    if (!pad.net) continue;
    stat(pad.net).pads++;
    push(pad.net, { kind: "pad", layers: pad.layer === MULTI || !isCopper(pad.layer) ? "all" : pad.layer, shape: pad.shape, bbox: pad.bbox, pad });
  }
  for (const t of tracks) {
    const layer = num(t.layer) ?? 0;
    const ends = segmentEnds(t);
    const net = str(t.net);
    if (!ends || !isCopper(layer) || !net) continue;
    const width = num(t.lineWidth) ?? 0;
    const s = stat(net);
    s.segments++;
    s.trackLength += Math.hypot(ends[1].x - ends[0].x, ends[1].y - ends[0].y);
    addLayer(s, layer);
    addWidth(s, width);
    const shape: Shape = { points: ends, closed: false, radius: width / 2 };
    push(net, { kind: "track", layers: layer, shape, bbox: shapeBBox(shape)! });
  }
  for (const a of arcs) {
    const layer = num(a.layer) ?? 0;
    const ends = segmentEnds(a);
    const net = str(a.net);
    if (!ends || !isCopper(layer) || !net) continue;
    const width = num(a.lineWidth) ?? 0;
    const angle = num(a.arcAngle) ?? 0;
    const s = stat(net);
    s.arcs++;
    s.trackLength += arcLength(ends[0], ends[1], angle);
    addLayer(s, layer);
    addWidth(s, width);
    const shape: Shape = { points: arcPolyline(ends[0], ends[1], angle), closed: false, radius: width / 2 };
    push(net, { kind: "arc", layers: layer, shape, bbox: shapeBBox(shape)! });
  }
  for (const v of vias) {
    const x = num(v.x);
    const y = num(v.y);
    const net = str(v.net);
    if (x === undefined || y === undefined || !net) continue;
    stat(net).vias++;
    const shape: Shape = { points: [{ x, y }], closed: false, radius: (num(v.diameter) ?? num(v.holeDiameter) ?? 0) / 2 };
    push(net, { kind: "via", layers: "all", shape, bbox: shapeBBox(shape)! });
  }
  let pourGeometry = 0;
  let pourNoGeometry = 0;
  for (const p of [...pours, ...fills]) {
    const layer = num(p.layer) ?? 0;
    const net = str(p.net);
    if (!net || !isCopper(layer)) continue;
    const rings = parsePolygonSource(polygonSource(p));
    const outer = rings.reduce<Point[] | undefined>((best, r) => (!best || polygonArea(r) > polygonArea(best) ? r : best), undefined);
    if (!outer || outer.length < 3) {
      pourNoGeometry++;
      continue;
    }
    pourGeometry++;
    stat(net).pours++;
    addLayer(stat(net), layer);
    const shape: Shape = { points: outer, closed: true, radius: (num(p.lineWidth) ?? 0) / 2 };
    push(net, { kind: "pour", layers: layer, shape, bbox: shapeBBox(shape)! });
  }

  const netList = [...stats.values()];
  for (const s of netList) {
    s.trackLength = round(s.trackLength, 2);
    if (easyedaLength.has(s.net)) s.easyedaLength = round(easyedaLength.get(s.net)!, 2);
    if (s.minWidth !== undefined) s.minWidth = round(s.minWidth, 3);
    if (s.maxWidth !== undefined) s.maxWidth = round(s.maxWidth, 3);
    if (s.pads === 0) {
      s.status = "no-pads";
      continue;
    }
    if (s.pads === 1) {
      s.status = "single-pad";
      continue;
    }
    const groups = padGroups(nodesByNet.get(s.net) ?? [], tolerance);
    if (groups.length > 1) {
      s.status = "possibly-unrouted";
      s.padGroups = groups;
      findings.push({
        severity: pourNoGeometry > 0 ? "info" : "warning",
        code: "possibly-unrouted",
        message: `Net ${s.net}: ${groups.length} unconnected pad groups (${groups.map((g) => g.slice(0, 4).join("+") + (g.length > 4 ? "+..." : "")).join(" | ")}).`,
        net: s.net,
        data: { padGroups: groups }
      });
    } else {
      s.status = "routed";
    }
  }
  netList.sort((a, b) => b.trackLength - a.trackLength || a.net.localeCompare(b.net));

  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const summary = {
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
    infos: findings.filter((f) => f.severity === "info").length
  };

  const counts: Record<string, number> = {
    components: components.length,
    pads: pads.length,
    tracks: tracks.length,
    arcs: arcs.length,
    vias: vias.length,
    pours: pours.length,
    nets: netNames.size
  };

  return {
    units: "mil",
    board: {
      outlineSource: outline.source,
      ...(boardBox ? {
        bbox: roundBox(boardBox),
        width: round(bboxWidth(boardBox)),
        height: round(bboxHeight(boardBox)),
        widthMm: round(bboxWidth(boardBox) * MM_PER_MIL),
        heightMm: round(bboxHeight(boardBox) * MM_PER_MIL)
      } : {}),
      ...(boardArea !== undefined ? { area: round(boardArea, 1), areaMm2: round(boardArea * MM_PER_MIL * MM_PER_MIL) } : {}),
      copperLayers,
      counts
    },
    placement: {
      top: sideStats("top"),
      bottom: sideStats("bottom"),
      components: componentInfos,
      closestPairs: closestPairs.slice(0, top)
    },
    routing: {
      nets: netList,
      totalTrackLength: round(netList.reduce((sum, n) => sum + n.trackLength, 0), 2),
      vias: vias.length,
      longestNets: netList.filter((n) => n.trackLength > 0).slice(0, top).map((n) => ({ net: n.net, trackLength: n.trackLength })),
      possiblyUnrouted: netList.filter((n) => n.status === "possibly-unrouted").map((n) => n.net),
      pourConnectivity: pourNoGeometry > 0 ? "unknown" : pourGeometry > 0 ? "outline" : "none"
    },
    findings,
    summary,
    assumptions: ASSUMPTIONS
  };
}

function severityRank(severity: Severity): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : 2;
}

/** Concise human summary (CLI default output). */
export function formatPcbAnalysis(report: PcbAnalysis, top = 10): string {
  const lines: string[] = [];
  const { board, placement, routing, summary } = report;
  const status = summary.errors > 0 ? "ERRORS" : summary.warnings > 0 ? "WARNINGS" : "OK";
  lines.push(`${status}: ${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.infos} info`);
  const size = board.width !== undefined ? `${board.width} x ${board.height} mil (${board.widthMm} x ${board.heightMm} mm)` : "unknown size";
  lines.push(`Board: ${size}, outline from ${board.outlineSource}, ${board.copperLayers} copper layer(s); ${board.counts.components} components, ${board.counts.nets} nets, ${board.counts.tracks} tracks, ${board.counts.vias} vias`);
  const pct = (d?: number) => (d === undefined ? "n/a" : `${(d * 100).toFixed(1)}%`);
  lines.push(`Placement density: top ${placement.top.components} parts ${pct(placement.top.density)}, bottom ${placement.bottom.components} parts ${pct(placement.bottom.density)}`);
  if (placement.closestPairs.length) {
    lines.push(`Closest pairs: ${placement.closestPairs.slice(0, Math.min(top, 5)).map((p) => `${p.a}-${p.b} ${p.gap} mil (${p.side})`).join(", ")}`);
  }
  lines.push(`Routing: ${routing.totalTrackLength} mil of track, ${routing.vias} vias; pours ${routing.pourConnectivity === "outline" ? "counted by outline" : routing.pourConnectivity}`);
  if (routing.longestNets.length) {
    lines.push(`Longest nets: ${routing.longestNets.slice(0, Math.min(top, 5)).map((n) => `${n.net} ${n.trackLength}`).join(", ")}`);
  }
  lines.push(`Possibly unrouted: ${routing.possiblyUnrouted.length ? routing.possiblyUnrouted.join(", ") : "none"}`);
  const shown = report.findings.filter((f) => f.severity !== "info").slice(0, top);
  for (const finding of shown) lines.push(`  [${finding.severity}] ${finding.message}`);
  const hidden = report.findings.filter((f) => f.severity !== "info").length - shown.length;
  if (hidden > 0) lines.push(`  ... ${hidden} more (use --json)`);
  const infos = report.findings.filter((f) => f.severity === "info");
  if (infos.length) lines.push(`  info: ${infos.slice(0, 5).map((f) => f.message).join(" ")}${infos.length > 5 ? ` ... ${infos.length - 5} more` : ""}`);
  return `${lines.join("\n")}\n`;
}
