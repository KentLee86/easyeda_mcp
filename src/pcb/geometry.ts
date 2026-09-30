// Small 2D helpers for the PCB analysis. Units are whatever the caller uses
// (EasyEDA PCB snapshots: mil). No dependency on EasyEDA types.

export type Point = { x: number; y: number };
export type BBox = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * A copper shape as "core + radius": a point (1 point), a polyline/segment
 * (open, 2+ points) or a filled polygon (closed), inflated by `radius`.
 * Tracks are segments with radius = width / 2, vias are points with
 * radius = diameter / 2, pads and pours are filled polygons with radius 0.
 */
export type Shape = { points: Point[]; closed: boolean; radius: number };

export function bboxOfPoints(points: Iterable<Point>): BBox | undefined {
  let box: BBox | undefined;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (!box) box = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
    else {
      box.minX = Math.min(box.minX, p.x);
      box.minY = Math.min(box.minY, p.y);
      box.maxX = Math.max(box.maxX, p.x);
      box.maxY = Math.max(box.maxY, p.y);
    }
  }
  return box;
}

export function unionBBox(a: BBox | undefined, b: BBox | undefined): BBox | undefined {
  if (!a) return b;
  if (!b) return a;
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

export function inflateBBox(box: BBox, by: number): BBox {
  return { minX: box.minX - by, minY: box.minY - by, maxX: box.maxX + by, maxY: box.maxY + by };
}

export function bboxWidth(box: BBox): number {
  return box.maxX - box.minX;
}

export function bboxHeight(box: BBox): number {
  return box.maxY - box.minY;
}

export function bboxArea(box: BBox): number {
  return Math.max(0, bboxWidth(box)) * Math.max(0, bboxHeight(box));
}

/** Area of the intersection (0 when they only touch or are apart). */
export function bboxOverlapArea(a: BBox, b: BBox): number {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Edge-to-edge gap between two boxes (0 when they touch or overlap). */
export function bboxGap(a: BBox, b: BBox): number {
  const dx = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX));
  const dy = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY));
  return Math.hypot(dx, dy);
}

export function bboxInside(inner: BBox, outer: BBox, tolerance = 0): boolean {
  return inner.minX >= outer.minX - tolerance && inner.minY >= outer.minY - tolerance && inner.maxX <= outer.maxX + tolerance && inner.maxY <= outer.maxY + tolerance;
}

export function bboxCorners(box: BBox): Point[] {
  return [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY }
  ];
}

/** Shoelace area (absolute). */
export function polygonArea(ring: Point[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Even-odd ray cast. Points exactly on an edge may go either way. */
export function pointInPolygon(p: Point, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function orient(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

export function segmentSegmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

function edges(shape: Shape): Array<[Point, Point]> {
  const pts = shape.points;
  if (pts.length === 1) return [[pts[0]!, pts[0]!]];
  const out: Array<[Point, Point]> = [];
  for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i]!, pts[i + 1]!]);
  if (shape.closed && pts.length > 2) out.push([pts[pts.length - 1]!, pts[0]!]);
  return out;
}

/** Distance between the cores of two shapes (0 when a core lies inside a filled polygon). */
export function coreDistance(a: Shape, b: Shape): number {
  if (a.points.length === 0 || b.points.length === 0) return Infinity;
  if (a.closed && a.points.length > 2 && b.points.some((p) => pointInPolygon(p, a.points))) return 0;
  if (b.closed && b.points.length > 2 && a.points.some((p) => pointInPolygon(p, b.points))) return 0;
  let best = Infinity;
  for (const [p, q] of edges(a)) {
    for (const [r, s] of edges(b)) {
      best = Math.min(best, segmentSegmentDistance(p, q, r, s));
      if (best === 0) return 0;
    }
  }
  return best;
}

/** True when the copper of two shapes touches or overlaps (within tolerance). */
export function shapesTouch(a: Shape, b: Shape, tolerance: number): boolean {
  return coreDistance(a, b) <= a.radius + b.radius + tolerance;
}

export function shapeBBox(shape: Shape): BBox | undefined {
  const box = bboxOfPoints(shape.points);
  return box ? inflateBBox(box, shape.radius) : undefined;
}

/** Corners of a w x h rectangle centred on c, rotated by `radians`. */
export function rotatedRect(c: Point, w: number, h: number, radians: number): Point[] {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([dx, dy]) => ({
    x: c.x + dx! * cos - dy! * sin,
    y: c.y + dx! * sin + dy! * cos
  }));
}

/** Ellipse approximated by a polygon (inscribed; slightly smaller than the ellipse). */
export function ellipsePolygon(c: Point, w: number, h: number, radians: number, steps = 16): Point[] {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const out: Point[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    const dx = (w / 2) * Math.cos(t);
    const dy = (h / 2) * Math.sin(t);
    out.push({ x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos });
  }
  return out;
}

/**
 * Circular arc from `start` to `end` sweeping `angleDeg` degrees (sign picks the
 * side), as a polyline including both ends. Degenerate input returns the chord.
 */
export function arcPolyline(start: Point, end: Point, angleDeg: number, maxStepDeg = 10): Point[] {
  const theta = (angleDeg * Math.PI) / 180;
  const chord = Math.hypot(end.x - start.x, end.y - start.y);
  if (!Number.isFinite(theta) || Math.abs(theta) < 1e-9 || chord === 0) return [start, end];
  const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  // Distance from the chord midpoint to the centre (negative past 180 degrees).
  const h = radius * Math.cos(Math.abs(theta) / 2);
  const ux = (end.x - start.x) / chord;
  const uy = (end.y - start.y) / chord;
  // Left normal for positive angles.
  const sign = theta > 0 ? 1 : -1;
  const center = { x: mid.x - uy * h * sign, y: mid.y + ux * h * sign };
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const steps = Math.max(1, Math.ceil(Math.abs(angleDeg) / maxStepDeg));
  const out: Point[] = [start];
  for (let i = 1; i < steps; i++) {
    const a = a0 + (theta * i) / steps;
    out.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  out.push(end);
  return out;
}

/** Length of a circular arc given its chord end points and sweep angle in degrees. */
export function arcLength(start: Point, end: Point, angleDeg: number): number {
  const chord = Math.hypot(end.x - start.x, end.y - start.y);
  const theta = Math.abs((angleDeg * Math.PI) / 180);
  if (!Number.isFinite(theta) || theta < 1e-9) return chord;
  const radius = chord / (2 * Math.sin(theta / 2));
  return radius * theta;
}

/**
 * Parse an EasyEDA Pro polygon source (`[x, y, "L", x, y, ...]`, with "ARC"/
 * "CARC" angle x y, "C" bezier, "R" x y w h [rot r], "CIRCLE" cx cy r) into
 * rings. Nested arrays are separate rings (complex polygons). Unknown tokens
 * end the current ring's parsing gracefully.
 */
export function parsePolygonSource(source: unknown): Point[][] {
  if (!Array.isArray(source)) return [];
  if (source.some((item) => Array.isArray(item))) {
    return source.flatMap((item) => (Array.isArray(item) ? parsePolygonSource(item) : []));
  }
  const tokens = source as Array<number | string>;
  const rings: Point[][] = [];
  let ring: Point[] = [];
  let mode: string = "L";
  let i = 0;
  const num = (k: number) => (typeof tokens[k] === "number" ? (tokens[k] as number) : Number.NaN);
  while (i < tokens.length) {
    const token = tokens[i];
    if (typeof token === "string") {
      mode = token.toUpperCase();
      i++;
      if (mode === "R") {
        const [x, y, w, h] = [num(i), num(i + 1), num(i + 2), num(i + 3)];
        if ([x, y, w, h].every(Number.isFinite)) {
          // EasyEDA rect: x,y is the top-left corner, height grows downward (negative y).
          rings.push([{ x, y }, { x: x + w, y }, { x: x + w, y: y - h }, { x, y: y - h }]);
        }
        i += 4;
        while (i < tokens.length && typeof tokens[i] === "number") i++;
        continue;
      }
      if (mode === "CIRCLE") {
        const [cx, cy, r] = [num(i), num(i + 1), num(i + 2)];
        if ([cx, cy, r].every(Number.isFinite)) rings.push(ellipsePolygon({ x: cx, y: cy }, 2 * r, 2 * r, 0, 32));
        i += 3;
        continue;
      }
      continue;
    }
    if (mode === "ARC" || mode === "CARC") {
      const [angle, x, y] = [num(i), num(i + 1), num(i + 2)];
      if (![angle, x, y].every(Number.isFinite)) break;
      const start = ring[ring.length - 1];
      if (start) ring.push(...arcPolyline(start, { x, y }, angle).slice(1));
      else ring.push({ x, y });
      i += 3;
      continue;
    }
    if (mode === "C") {
      const coords = [num(i), num(i + 1), num(i + 2), num(i + 3), num(i + 4), num(i + 5)];
      if (!coords.every(Number.isFinite)) break;
      ring.push({ x: coords[0]!, y: coords[1]! }, { x: coords[2]!, y: coords[3]! }, { x: coords[4]!, y: coords[5]! });
      i += 6;
      continue;
    }
    const [x, y] = [num(i), num(i + 1)];
    if (!Number.isFinite(x) || !Number.isFinite(y)) break;
    ring.push({ x, y });
    i += 2;
  }
  if (ring.length > 0) rings.unshift(ring);
  // Drop a closing point equal to the first.
  return rings.map((r) => (r.length > 2 && r[0]!.x === r[r.length - 1]!.x && r[0]!.y === r[r.length - 1]!.y ? r.slice(0, -1) : r)).filter((r) => r.length > 0);
}
