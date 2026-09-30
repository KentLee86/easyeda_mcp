import { describe, expect, it } from "vitest";
import {
  arcLength,
  arcPolyline,
  bboxGap,
  bboxOverlapArea,
  coreDistance,
  parsePolygonSource,
  pointInPolygon,
  polygonArea,
  rotatedRect,
  shapesTouch
} from "./geometry.js";

describe("pcb geometry", () => {
  it("measures box overlap and gaps", () => {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(bboxOverlapArea(a, { minX: 5, minY: 5, maxX: 15, maxY: 15 })).toBe(25);
    expect(bboxOverlapArea(a, { minX: 10, minY: 0, maxX: 20, maxY: 10 })).toBe(0);
    expect(bboxGap(a, { minX: 13, minY: 0, maxX: 20, maxY: 10 })).toBe(3);
    expect(bboxGap(a, { minX: 13, minY: 14, maxX: 20, maxY: 20 })).toBe(5);
  });

  it("arc length is r * theta and the polyline ends at the end point", () => {
    // Semicircle over a chord of 2: radius 1, length pi.
    expect(arcLength({ x: 0, y: 0 }, { x: 2, y: 0 }, 180)).toBeCloseTo(Math.PI, 6);
    expect(arcLength({ x: 0, y: 0 }, { x: 2, y: 0 }, 0)).toBe(2);
    for (const angle of [90, -90, 180, 270]) {
      const pts = arcPolyline({ x: 0, y: 0 }, { x: 2, y: 0 }, angle);
      const last = pts[pts.length - 1]!;
      expect(last).toEqual({ x: 2, y: 0 });
      // Every interior point is at the same distance from the chord ends' circle.
      let length = 0;
      for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
      expect(length).toBeCloseTo(arcLength({ x: 0, y: 0 }, { x: 2, y: 0 }, angle), 1);
    }
  });

  it("parses EasyEDA polygon sources", () => {
    const [ring] = parsePolygonSource([0, 0, "L", 100, 0, 100, -50, 0, -50, 0, 0]);
    expect(ring).toHaveLength(4);
    expect(polygonArea(ring!)).toBe(5000);
    expect(pointInPolygon({ x: 50, y: -25 }, ring!)).toBe(true);
    expect(pointInPolygon({ x: 150, y: -25 }, ring!)).toBe(false);
    const [rect] = parsePolygonSource(["R", 0, 0, 100, 50, 0, 0]);
    expect(polygonArea(rect!)).toBe(5000);
    const [circle] = parsePolygonSource(["CIRCLE", 0, 0, 10]);
    expect(polygonArea(circle!)).toBeCloseTo(Math.PI * 100, -1);
    expect(parsePolygonSource([[0, 0, "L", 1, 0, 1, 1], [5, 5, "L", 6, 5, 6, 6]])).toHaveLength(2);
    const rounded = parsePolygonSource([0, 0, "L", 10, 0, "ARC", 90, 20, 10, "L", 20, 20, 0, 20]);
    expect(rounded[0]!.length).toBeGreaterThan(5);
  });

  it("detects touching copper", () => {
    const track = { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: false, radius: 5 };
    const pad = { points: rotatedRect({ x: 108, y: 0 }, 10, 10, 0), closed: true, radius: 0 };
    expect(coreDistance(track, pad)).toBeCloseTo(3);
    expect(shapesTouch(track, pad, 0.5)).toBe(true);
    const farPad = { points: rotatedRect({ x: 120, y: 0 }, 10, 10, 0), closed: true, radius: 0 };
    expect(shapesTouch(track, farPad, 0.5)).toBe(false);
    const via = { points: [{ x: 50, y: 0 }], closed: false, radius: 12 };
    const pour = { points: [{ x: 40, y: -10 }, { x: 60, y: -10 }, { x: 60, y: 10 }, { x: 40, y: 10 }], closed: true, radius: 0 };
    expect(coreDistance(via, pour)).toBe(0);
  });
});
