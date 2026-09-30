// Compare schematic connectivity (from a schematic snapshot) with EasyEDA
// Pro's own PCB netlist export (.enet JSON), treated as ground truth.
//
// Connectivity is compared as a partition over (designator, pinNumber):
//   - split:   a Pro net with >= 2 pins whose pins are not all on one snapshot node;
//   - merged:  a snapshot node joining pins of different Pro nets (a pin with Pro
//              net "" is unconnected and counts as its own net);
//   - name:    for pins whose Pro net is a real name (not "" and not an auto
//              "Net..." name), the snapshot pin net must equal it (case-insensitive);
//   - missing: pins present on only one side. Pins Pro reports unconnected (net "")
//              that the snapshot lacks are informational unless strict: Pro takes
//              pins from footprint pads, so e.g. mounting holes whose schematic
//              symbol has no pins never appear in the schematic data.
import type { SchematicComponent, SchematicPin } from "./analysis.js";

export type EnetNetlist = {
  components?: Record<string, {
    props?: { Designator?: string; [key: string]: unknown };
    pinInfoMap?: Record<string, { number?: string; net?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type SnapshotLike = {
  components: Array<Pick<SchematicComponent, "primitiveId" | "page" | "componentType" | "designator" | "addIntoPcb">>;
  pins: Array<Pick<SchematicPin, "page" | "componentPrimitiveId" | "componentDesignator" | "pinNumber" | "nodeId" | "net" | "connected">>;
};

export type DiscrepancyKind = "split" | "merged" | "name" | "missingInSnapshot" | "missingInNetlist";

export type Discrepancy = { kind: DiscrepancyKind; message: string; pins?: string[]; net?: string; node?: string };

export type NetlistComparison = {
  ok: boolean;
  counters: Record<DiscrepancyKind, number>;
  discrepancies: Discrepancy[];
  /** Pro-unconnected pins absent from the snapshot (not counted unless strict). */
  notes: string[];
  stats: {
    pinsCompared: number;
    netlistPins: number;
    snapshotPins: number;
    connectedPins: { pro: number; snapshot: number };
    proNetsWithTwoOrMorePins: number;
  };
  /** Designators present on only one side. */
  parts: {
    /** Schematic parts with no PCB footprint. */
    missingOnPcb: string[];
    /** addIntoPcb=false parts; informational, not a finding. */
    schematicOnlyByDesign: string[];
    /** PCB parts with at least one connected pad but no schematic symbol. */
    missingInSchematic: string[];
    /** PCB-only parts whose pads are all unconnected (mounting holes, fiducials); informational. */
    pcbOnlyUnconnected: string[];
  };
};

const pinKey = (designator: string | undefined, pinNumber: string | undefined) => `${designator}.${pinNumber}`;
const isAutoName = (name: string) => /^Net/.test(name);

export function parseEnet(text: string): EnetNetlist {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Netlist is not a JSON object.");
  }
  return parsed as EnetNetlist;
}

export function compareNetlist(snapshot: SnapshotLike, netlist: EnetNetlist, options: { strict?: boolean } = {}): NetlistComparison {
  const strict = options.strict ?? false;

  // Ground truth: pin -> Pro net ("" = unconnected).
  const proNetByPin = new Map<string, string>();
  const pcbDesignators = new Set<string>();
  const pcbConnected = new Set<string>();
  for (const component of Object.values(netlist.components ?? {})) {
    const designator = component?.props?.Designator;
    if (designator) pcbDesignators.add(designator);
    if (designator && Object.values(component?.pinInfoMap ?? {}).some((info) => info?.net)) pcbConnected.add(designator);
    for (const [pin, info] of Object.entries(component?.pinInfoMap ?? {})) {
      proNetByPin.set(pinKey(designator, info?.number ?? pin), info?.net ?? "");
    }
  }

  // Snapshot: only real parts (netflags/netports are not netlist components).
  const partComponents = snapshot.components.filter((item) => item.componentType === "part");
  const partIds = new Set(partComponents.map((item) => `${item.page?.uuid ?? ""}\u0000${item.primitiveId}`));
  // Parts marked "not in PCB" (bare-board BOM lines, mechanical notes) are expected
  // to be missing from the PCB netlist.
  const schematicOnlyByDesign = new Set(partComponents.filter((item) => item.addIntoPcb === false)
    .map((item) => item.designator).filter((item): item is string => Boolean(item)));
  const schematicDesignators = new Set(partComponents.map((item) => item.designator)
    .filter((item): item is string => Boolean(item) && !schematicOnlyByDesign.has(item as string)));
  const snapPins = new Map<string, SnapshotLike["pins"][number]>();
  for (const pin of snapshot.pins) {
    if (!partIds.has(`${pin.page?.uuid ?? ""}\u0000${pin.componentPrimitiveId}`)) continue;
    snapPins.set(pinKey(pin.componentDesignator, pin.pinNumber), pin);
  }

  const discrepancies: Discrepancy[] = [];
  const counters: Record<DiscrepancyKind, number> = { split: 0, merged: 0, name: 0, missingInSnapshot: 0, missingInNetlist: 0 };
  const notes: string[] = [];
  const report = (item: Discrepancy) => {
    counters[item.kind] += 1;
    discrepancies.push(item);
  };

  for (const key of proNetByPin.keys()) {
    if (snapPins.has(key)) continue;
    const net = proNetByPin.get(key) ?? "";
    if (!net && !strict) notes.push(key);
    else report({ kind: "missingInSnapshot", message: `${key} (Pro net ${JSON.stringify(net)})`, pins: [key], net });
  }
  for (const key of snapPins.keys()) {
    if (!proNetByPin.has(key)) report({ kind: "missingInNetlist", message: key, pins: [key] });
  }

  const compared = [...proNetByPin.keys()].filter((key) => snapPins.has(key));
  const nodeOf = (key: string) => snapPins.get(key)?.nodeId;

  const pinsByProNet = new Map<string, string[]>();
  for (const key of compared) {
    const net = proNetByPin.get(key);
    if (!net) continue;
    pinsByProNet.set(net, [...(pinsByProNet.get(net) ?? []), key]);
  }
  for (const [net, pins] of [...pinsByProNet].sort(([a], [b]) => a.localeCompare(b))) {
    if (pins.length < 2) continue;
    const nodes = new Set(pins.map((key) => nodeOf(key) ?? `<unconnected ${key}>`));
    if (nodes.size > 1) {
      const detail = pins.map((key) => `${key}=${nodeOf(key) ?? "-"}`).join(", ");
      report({ kind: "split", message: `Pro net ${net} spans ${nodes.size} snapshot nodes: ${detail}`, net, pins });
    }
  }

  const pinsByNode = new Map<string, string[]>();
  for (const key of compared) {
    const node = nodeOf(key);
    if (!node) continue;
    pinsByNode.set(node, [...(pinsByNode.get(node) ?? []), key]);
  }
  for (const [node, pins] of pinsByNode) {
    const proNets = new Set(pins.map((key) => proNetByPin.get(key) || `<unconnected ${key}>`));
    if (proNets.size > 1) {
      const detail = pins.map((key) => `${key}=${proNetByPin.get(key) || "-"}`).join(", ");
      report({ kind: "merged", message: `snapshot node ${node} joins ${proNets.size} Pro nets: ${detail}`, node, pins });
    }
  }

  for (const key of compared) {
    const proNet = proNetByPin.get(key);
    if (!proNet || isAutoName(proNet)) continue;
    const snapNet = snapPins.get(key)?.net;
    if ((snapNet ?? "").toLowerCase() !== proNet.toLowerCase()) {
      report({ kind: "name", message: `${key}: Pro ${proNet} vs snapshot ${snapNet ?? "-"}`, pins: [key], net: proNet });
    }
  }

  return {
    ok: discrepancies.length === 0,
    counters,
    discrepancies,
    notes,
    stats: {
      pinsCompared: compared.length,
      netlistPins: proNetByPin.size,
      snapshotPins: snapPins.size,
      connectedPins: {
        pro: compared.filter((key) => proNetByPin.get(key)).length,
        snapshot: compared.filter((key) => snapPins.get(key)?.connected).length
      },
      proNetsWithTwoOrMorePins: [...pinsByProNet.values()].filter((pins) => pins.length >= 2).length
    },
    parts: {
      missingOnPcb: [...schematicDesignators].filter((item) => !pcbDesignators.has(item)).sort(),
      missingInSchematic: [...pcbDesignators].filter((item) => !schematicDesignators.has(item) && pcbConnected.has(item)).sort(),
      pcbOnlyUnconnected: [...pcbDesignators].filter((item) => !schematicDesignators.has(item) && !pcbConnected.has(item)).sort(),
      schematicOnlyByDesign: [...schematicOnlyByDesign].sort()
    }
  };
}
