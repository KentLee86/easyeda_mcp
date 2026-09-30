#!/usr/bin/env node
// Compare the MCP schematic snapshot against EasyEDA Pro's own netlist export.
//
// Usage:
//   npm run build
//   node dev/live/compare-netlist.mjs <raw.json> <netlist.enet> [--all]
//
//   raw.json      RawSchematicData dumped from the live Pro (e.g. by dev/live/dump-raw.mjs),
//                 `{ pages: [{ uuid, name, components, pinsByComponent, wires, texts }] }`.
//   netlist.enet  Pro's netlist export (JSON): components[<id>].props.Designator and
//                 components[<id>].pinInfoMap[<pin>] = { number, net }. Treated as ground truth.
//   --all         print every discrepancy instead of the first 15.
//   --strict      also fail on pins missing from the snapshot that Pro reports unconnected.
//
// Connectivity is compared as a partition over (designator, pinNumber):
//   - split:  a Pro net with >= 2 pins whose pins are not all on one snapshot node;
//   - merged: a snapshot node joining pins of different Pro nets (a pin with Pro net ""
//             is unconnected and counts as its own net);
//   - name:   for pins whose Pro net is a real name (not "" and not an auto "Net..." name),
//             the snapshot pin net must equal it (case-insensitive);
//   - missing: pins present on only one side. Pins Pro reports unconnected (net "") that the
//             snapshot lacks are listed as informational by default: Pro's netlist takes pins
//             from footprint pads, so e.g. mounting holes/fiducials whose schematic symbol has
//             no pins can never appear in the schematic API data.
// Exits 1 when any discrepancy is found, 0 otherwise.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const args = process.argv.slice(2);
const showAll = args.includes("--all");
const strict = args.includes("--strict");
const [rawPath, netlistPath] = args.filter((arg) => !arg.startsWith("--"));
if (!rawPath || !netlistPath) {
  console.error("usage: node dev/live/compare-netlist.mjs <raw.json> <netlist.enet> [--all]");
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const { buildSchematicSnapshot } = await import(path.join(here, "../../dist/schematic/analysis.js"));

const raw = JSON.parse(readFileSync(rawPath, "utf8"));
const netlist = JSON.parse(readFileSync(netlistPath, "utf8"));
const snapshot = buildSchematicSnapshot({ ...raw, includeRaw: false });

const key = (designator, pinNumber) => `${designator}.${pinNumber}`;
const isAutoName = (name) => /^Net/.test(name);

// Ground truth: pin -> Pro net ("" = unconnected).
const proNetByPin = new Map();
for (const component of Object.values(netlist.components ?? {})) {
  const designator = component?.props?.Designator;
  for (const [pinKey, info] of Object.entries(component?.pinInfoMap ?? {})) {
    proNetByPin.set(key(designator, info?.number ?? pinKey), info?.net ?? "");
  }
}

// Snapshot: pin -> node / net. Only real parts (netflags/netports are not netlist components).
const partIds = new Set(
  snapshot.components
    .filter((item) => item.componentType === "part")
    .map((item) => `${item.page?.uuid ?? ""}\u0000${item.primitiveId}`)
);
const snapPins = new Map();
for (const pin of snapshot.pins) {
  if (!partIds.has(`${pin.page?.uuid ?? ""}\u0000${pin.componentPrimitiveId}`)) continue;
  snapPins.set(key(pin.componentDesignator, pin.pinNumber), pin);
}

const discrepancies = [];
const counters = { split: 0, merged: 0, name: 0, missingInSnapshot: 0, missingInNetlist: 0 };
const notes = [];
const report = (kind, message) => {
  counters[kind] += 1;
  discrepancies.push(`[${kind}] ${message}`);
};

for (const pinKey of proNetByPin.keys()) {
  if (snapPins.has(pinKey)) continue;
  if (!proNetByPin.get(pinKey) && !strict) notes.push(pinKey);
  else report("missingInSnapshot", `${pinKey} (Pro net ${JSON.stringify(proNetByPin.get(pinKey))})`);
}
for (const pinKey of snapPins.keys()) {
  if (!proNetByPin.has(pinKey)) report("missingInNetlist", pinKey);
}

const compared = [...proNetByPin.keys()].filter((pinKey) => snapPins.has(pinKey));
const nodeOf = (pinKey) => snapPins.get(pinKey).nodeId;

// split
const pinsByProNet = new Map();
for (const pinKey of compared) {
  const net = proNetByPin.get(pinKey);
  if (!net) continue;
  pinsByProNet.set(net, [...(pinsByProNet.get(net) ?? []), pinKey]);
}
for (const [net, pins] of [...pinsByProNet].sort(([a], [b]) => a.localeCompare(b))) {
  if (pins.length < 2) continue;
  const nodes = new Set(pins.map((pinKey) => nodeOf(pinKey) ?? `<unconnected ${pinKey}>`));
  if (nodes.size > 1) {
    const detail = pins.map((pinKey) => `${pinKey}=${nodeOf(pinKey) ?? "-"}`).join(", ");
    report("split", `Pro net ${net} spans ${nodes.size} snapshot nodes: ${detail}`);
  }
}

// merged
const pinsByNode = new Map();
for (const pinKey of compared) {
  const node = nodeOf(pinKey);
  if (!node) continue;
  pinsByNode.set(node, [...(pinsByNode.get(node) ?? []), pinKey]);
}
for (const [node, pins] of pinsByNode) {
  const proNets = new Set(pins.map((pinKey) => proNetByPin.get(pinKey) || `<unconnected ${pinKey}>`));
  if (proNets.size > 1) {
    const detail = pins.map((pinKey) => `${pinKey}=${proNetByPin.get(pinKey) || "-"}`).join(", ");
    report("merged", `snapshot node ${node} joins ${proNets.size} Pro nets: ${detail}`);
  }
}

// names
for (const pinKey of compared) {
  const proNet = proNetByPin.get(pinKey);
  if (!proNet || isAutoName(proNet)) continue;
  const snapNet = snapPins.get(pinKey).net;
  if ((snapNet ?? "").toLowerCase() !== proNet.toLowerCase()) {
    report("name", `${pinKey}: Pro ${proNet} vs snapshot ${snapNet ?? "-"}`);
  }
}

const proConnected = compared.filter((pinKey) => proNetByPin.get(pinKey)).length;
const snapConnected = compared.filter((pinKey) => snapPins.get(pinKey).connected).length;
console.log(`pins compared: ${compared.length} (Pro netlist ${proNetByPin.size}, snapshot parts ${snapPins.size})`);
console.log(`connected pins: Pro ${proConnected}, snapshot ${snapConnected}`);
console.log(`Pro nets with >=2 pins: ${[...pinsByProNet.values()].filter((pins) => pins.length >= 2).length}`);
console.log(
  `split nets: ${counters.split}, merged nodes: ${counters.merged}, name mismatches: ${counters.name}, ` +
    `missing in snapshot: ${counters.missingInSnapshot}, missing in netlist: ${counters.missingInNetlist}`
);
if (notes.length > 0) {
  console.log(`info: ${notes.length} Pro-unconnected pins absent from the snapshot (not counted; --strict to fail): ${notes.join(", ")}`);
}
if (discrepancies.length > 0) {
  const shown = showAll ? discrepancies : discrepancies.slice(0, 15);
  console.log(`\nfirst ${shown.length} of ${discrepancies.length} discrepancies:`);
  for (const line of shown) console.log(`  ${line}`);
  process.exit(1);
}
console.log("\nOK: snapshot connectivity and net names match the Pro netlist.");
