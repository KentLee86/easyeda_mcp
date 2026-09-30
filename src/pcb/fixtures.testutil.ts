// Test helper (not used at runtime): a tiny synthetic pcbSnapshot result.
// Two single-pad parts on net N1 with no track between them.
export const SAMPLE_PCB = {
  units: "mil",
  outline: { layer: 11, polygon: { polygon: [0, 0, "L", 1000, 0, 1000, -1000, 0, -1000] } },
  components: [
    { primitiveId: "c1", designator: "U1", layer: 1, x: 200, y: -200, rotation: 0, pads: [{ primitiveId: "p1", net: "N1", padNumber: "1" }] },
    { primitiveId: "c2", designator: "U2", layer: 1, x: 600, y: -200, rotation: 0, pads: [{ primitiveId: "p1", net: "N1", padNumber: "1" }] }
  ],
  pads: [
    { primitiveId: "c1p1", padNumber: "1", layer: 1, x: 200, y: -200, rotation: 0, pad: ["RECT", 20, 20, 0], net: "N1" },
    { primitiveId: "c2p1", padNumber: "1", layer: 1, x: 600, y: -200, rotation: 0, pad: ["RECT", 20, 20, 0], net: "N1" }
  ],
  tracks: [],
  vias: [],
  counts: { components: 2 }
};
