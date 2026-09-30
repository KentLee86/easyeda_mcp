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
// The comparison itself lives in src/schematic/compareNetlist.ts (also used by `easyeda check`).
const { compareNetlist } = await import(path.join(here, "../../dist/schematic/compareNetlist.js"));

const raw = JSON.parse(readFileSync(rawPath, "utf8"));
const netlist = JSON.parse(readFileSync(netlistPath, "utf8"));
const snapshot = buildSchematicSnapshot({ ...raw, includeRaw: false });
const result = compareNetlist(snapshot, netlist, { strict });
const { counters, stats, notes } = result;
const discrepancies = result.discrepancies.map((item) => `[${item.kind}] ${item.message}`);

console.log(`pins compared: ${stats.pinsCompared} (Pro netlist ${stats.netlistPins}, snapshot parts ${stats.snapshotPins})`);
console.log(`connected pins: Pro ${stats.connectedPins.pro}, snapshot ${stats.connectedPins.snapshot}`);
console.log(`Pro nets with >=2 pins: ${stats.proNetsWithTwoOrMorePins}`);
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
