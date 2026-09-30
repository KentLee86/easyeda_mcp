import { describe, expect, it } from "vitest";
import { compareNetlist, type EnetNetlist, type SnapshotLike } from "./compareNetlist.js";

const page = { uuid: "p1" };

function snapshot(pins: Array<[string, string, string | undefined, string | undefined]>, extraParts: string[] = []): SnapshotLike {
  // pins: [designator, pinNumber, nodeId, net]
  const designators = [...new Set([...pins.map(([designator]) => designator), ...extraParts])];
  return {
    components: [
      ...designators.map((designator) => ({ primitiveId: `id-${designator}`, page, componentType: "part", designator })),
      { primitiveId: "flag", page, componentType: "netflag", designator: "GND" }
    ],
    pins: pins.map(([designator, pinNumber, nodeId, net]) => ({
      page,
      componentPrimitiveId: `id-${designator}`,
      componentDesignator: designator,
      pinNumber,
      nodeId,
      net,
      connected: Boolean(nodeId)
    }))
  };
}

function enet(parts: Record<string, Record<string, string>>): EnetNetlist {
  return {
    components: Object.fromEntries(Object.entries(parts).map(([designator, pins], index) => [
      `c${index}`,
      { props: { Designator: designator }, pinInfoMap: Object.fromEntries(Object.entries(pins).map(([pin, net]) => [pin, { number: pin, net }])) }
    ]))
  };
}

describe("compareNetlist", () => {
  it("reports a clean match", () => {
    const result = compareNetlist(
      snapshot([["R1", "1", "n1", "VCC"], ["R1", "2", "n2", "Net1"], ["U1", "1", "n1", "VCC"], ["U1", "2", "n2", "Net1"]]),
      enet({ R1: { 1: "VCC", 2: "Net1" }, U1: { 1: "VCC", 2: "Net1" } })
    );
    expect(result.ok).toBe(true);
    expect(result.stats).toMatchObject({ pinsCompared: 4, proNetsWithTwoOrMorePins: 2, connectedPins: { pro: 4, snapshot: 4 } });
  });

  it("does not count parts marked addIntoPcb=false as missing on the PCB", () => {
    const sch = snapshot([["R1", "1", "n1", "VCC"], ["U1", "1", "n1", "VCC"]], ["!PCB1", "X9"]);
    for (const component of sch.components) {
      if (component.designator === "!PCB1") Object.assign(component, { addIntoPcb: false });
    }
    const result = compareNetlist(sch, enet({ R1: { 1: "VCC" }, U1: { 1: "VCC" } }));
    expect(result.parts.missingOnPcb).toEqual(["X9"]);
    expect(result.parts.schematicOnlyByDesign).toEqual(["!PCB1"]);
  });

  it("finds split nets, merged nodes and name mismatches", () => {
    const result = compareNetlist(
      snapshot([
        ["R1", "1", "a", "VCC"], ["U1", "1", "b", "VCC"], // VCC split over nodes a,b
        ["R1", "2", "m", "SDA"], ["U1", "2", "m", "SDA"], ["U1", "3", "m", "SDA"] // U1.3 is SCL in Pro -> merged + name
      ]),
      enet({ R1: { 1: "VCC", 2: "SDA" }, U1: { 1: "VCC", 2: "SDA", 3: "SCL" } })
    );
    expect(result.ok).toBe(false);
    expect(result.counters).toMatchObject({ split: 1, merged: 1, name: 1 });
    expect(result.discrepancies.find((item) => item.kind === "split")).toMatchObject({ net: "VCC", pins: ["R1.1", "U1.1"] });
    expect(result.discrepancies.find((item) => item.kind === "name")?.message).toBe("U1.3: Pro SCL vs snapshot SDA");
  });

  it("treats Pro-unconnected pins missing from the snapshot as notes unless strict", () => {
    const sch = snapshot([["R1", "1", "n", "VCC"], ["U1", "1", "n", "VCC"]]);
    const pro = enet({ R1: { 1: "VCC" }, U1: { 1: "VCC" }, H1: { 1: "" } });
    const loose = compareNetlist(sch, pro);
    expect(loose.ok).toBe(true);
    expect(loose.notes).toEqual(["H1.1"]);
    expect(loose.parts).toMatchObject({ missingInSchematic: [], pcbOnlyUnconnected: ["H1"] });
    const strict = compareNetlist(sch, pro, { strict: true });
    expect(strict.counters.missingInSnapshot).toBe(1);
  });

  it("reports pins and parts missing on the PCB side, ignoring netflags", () => {
    const result = compareNetlist(snapshot([["R1", "1", "n", "VCC"], ["R2", "1", "n", "VCC"]]), enet({ R1: { 1: "VCC" } }));
    expect(result.counters.missingInNetlist).toBe(1);
    expect(result.parts.missingOnPcb).toEqual(["R2"]);
    const extra = compareNetlist(snapshot([["R1", "1", "n", "VCC"]]), enet({ R1: { 1: "VCC" }, R9: { 1: "VCC" } }));
    expect(extra.parts.missingInSchematic).toEqual(["R9"]);
  });
});
