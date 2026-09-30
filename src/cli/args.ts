import { parseArgs } from "node:util";
import { parseRegion, type MoveRequest, type Region } from "../mcp/liveOps.js";
import { getCatalogEntry } from "../mcp/exportCatalog.js";
import { PACKAGE_PRESETS } from "../mcp/exportOps.js";

export const PCB_SNAPSHOT_SECTIONS = ["components", "pads", "tracks", "vias", "arcs", "pours", "fills", "regions", "strings", "nets", "layers", "outline"] as const;

export type CliCommand =
  | { name: "help" }
  | { name: "status" }
  | { name: "call"; path: string; args: unknown[] }
  | { name: "batch"; source: string; stopOnError: boolean }
  | { name: "describe"; namespace?: string }
  | { name: "pcb-snapshot"; include?: string[]; out?: string }
  | { name: "pcb-move"; request: MoveRequest }
  | { name: "pcb-drc"; strict?: boolean; verbose?: boolean }
  | { name: "pcb-analyze"; json: boolean; top?: number; out?: string; grid?: number; padBBox: boolean }
  | { name: "sch-snapshot"; out?: string }
  | { name: "export"; kind: string; out?: string; format?: string; scope?: "pcb" | "schematic" | "auto"; overwrite: boolean }
  | { name: "export-list" }
  | { name: "package"; out?: string; kinds?: string[]; preset?: string; zip: boolean; drcGate: boolean }
  | { name: "check"; json: boolean; strict: boolean }
  | { name: "render"; designator?: string; region?: Region; margin?: number; out: string }
  | { name: "daemon" }
  | { name: "stop" };

export type CliInvocation = {
  command: CliCommand;
  pretty: boolean;
  /** Start a daemon when no hub is reachable. */
  start: boolean;
  timeoutMs?: number;
};

export class CliUsageError extends Error {
  readonly code = "usage";
}

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  pretty: { type: "boolean" },
  start: { type: "boolean" },
  "no-start": { type: "boolean" },
  timeout: { type: "string" },
  include: { type: "string" },
  out: { type: "string", short: "o" },
  x: { type: "string" },
  y: { type: "string" },
  dx: { type: "string" },
  dy: { type: "string" },
  rotation: { type: "string" },
  layer: { type: "string" },
  format: { type: "string" },
  scope: { type: "string" },
  overwrite: { type: "boolean" },
  strict: { type: "boolean" },
  verbose: { type: "boolean" },
  designator: { type: "string" },
  region: { type: "string" },
  margin: { type: "string" },
  "continue-on-error": { type: "boolean" },
  list: { type: "boolean" },
  kinds: { type: "string" },
  preset: { type: "string" },
  zip: { type: "boolean" },
  "drc-gate": { type: "boolean" },
  json: { type: "boolean" },
  top: { type: "string" },
  grid: { type: "string" },
  "pad-bbox": { type: "boolean" }
} as const;

type OptionName = keyof typeof OPTIONS;
type Values = { [K in OptionName]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string };

const GLOBAL_OPTIONS: OptionName[] = ["help", "pretty", "start", "no-start", "timeout"];
const COMMAND_OPTIONS: Record<CliCommand["name"], OptionName[]> = {
  help: [],
  status: [],
  call: [],
  batch: ["continue-on-error"],
  describe: [],
  "pcb-snapshot": ["include", "out"],
  "pcb-move": ["x", "y", "dx", "dy", "rotation", "layer"],
  "pcb-drc": ["strict", "verbose"],
  "pcb-analyze": ["json", "top", "out", "grid", "pad-bbox"],
  "sch-snapshot": ["out"],
  export: ["out", "format", "scope", "overwrite"],
  "export-list": ["list"],
  package: ["out", "kinds", "preset", "zip", "drc-gate"],
  check: ["json", "strict"],
  render: ["designator", "region", "margin", "out"],
  daemon: [],
  stop: []
};

/** Options whose value may be a negative number (`--dx -50`). */
const NUMERIC_OPTIONS = new Set(["x", "y", "dx", "dy", "rotation", "margin", "timeout"]);

/** Join `--dx -50` into `--dx=-50`, which parseArgs otherwise rejects as ambiguous. */
export function joinNegativeNumbers(argv: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    const next = argv[index + 1];
    if (token === "--") {
      out.push(...argv.slice(index));
      break;
    }
    if (token.startsWith("--") && NUMERIC_OPTIONS.has(token.slice(2)) && next !== undefined && /^-\d*\.?\d/.test(next)) {
      out.push(`${token}=${next}`);
      index++;
      continue;
    }
    out.push(token);
  }
  return out;
}

/** Each positional arg is JSON if it parses, otherwise a plain string. */
export function parseJsonArg(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function numberOption(values: Values, name: OptionName): number | undefined {
  const raw = values[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (typeof raw !== "string" || raw.trim() === "" || !Number.isFinite(value)) {
    throw new CliUsageError(`--${name} must be a number, got "${String(raw)}".`);
  }
  return value;
}

function oneOf<T extends string>(values: Values, name: OptionName, allowed: readonly T[]): T | undefined {
  const raw = values[name];
  if (raw === undefined) {
    return undefined;
  }
  if (!allowed.includes(raw as T)) {
    throw new CliUsageError(`--${name} must be one of ${allowed.join(", ")}, got "${String(raw)}".`);
  }
  return raw as T;
}

function need(positionals: string[], index: number, what: string): string {
  const value = positionals[index];
  if (value === undefined) {
    throw new CliUsageError(`Missing ${what}.`);
  }
  return value;
}

function noExtra(positionals: string[], count: number): void {
  if (positionals.length > count) {
    throw new CliUsageError(`Unexpected argument "${positionals[count]}".`);
  }
}

export function parseCli(argv: string[]): CliInvocation {
  let parsed;
  try {
    parsed = parseArgs({ args: joinNegativeNumbers(argv), options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
  const values = parsed.values as Values;
  const positionals = parsed.positionals;
  const command = values.help || positionals.length === 0 ? { name: "help" as const } : buildCommand(positionals, values);

  const allowed = new Set([...GLOBAL_OPTIONS, ...COMMAND_OPTIONS[command.name]]);
  for (const name of Object.keys(values) as OptionName[]) {
    if (!allowed.has(name)) {
      throw new CliUsageError(`Option --${name} does not apply to "${positionals.slice(0, 2).join(" ")}".`);
    }
  }
  if (values.start && values["no-start"]) {
    throw new CliUsageError("Use either --start or --no-start.");
  }
  const timeoutMs = numberOption(values, "timeout");
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    throw new CliUsageError("--timeout must be positive (milliseconds).");
  }
  return {
    command,
    pretty: values.pretty ?? false,
    start: values["no-start"] ? false : values.start ?? needsEditor(command),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  };
}

/** Commands that talk to EasyEDA (and so start a daemon by default). */
export function needsEditor(command: CliCommand): boolean {
  return !["help", "status", "daemon", "stop", "export-list"].includes(command.name);
}

function buildCommand(positionals: string[], values: Values): CliCommand {
  const [head, sub] = positionals;
  switch (head) {
    case "status":
    case "daemon":
    case "stop":
      noExtra(positionals, 1);
      return { name: head };
    case "help":
      return { name: "help" };
    case "call":
      return { name: "call", path: need(positionals, 1, "API path, e.g. pcb_PrimitiveComponent.getAll"), args: positionals.slice(2).map(parseJsonArg) };
    case "batch":
      noExtra(positionals, 2);
      return { name: "batch", source: need(positionals, 1, "batch file (or - for stdin)"), stopOnError: !values["continue-on-error"] };
    case "describe":
      noExtra(positionals, 2);
      return { name: "describe", ...(sub ? { namespace: sub } : {}) };
    case "pcb":
      return buildPcb(positionals, values);
    case "sch":
      if (sub !== "snapshot") {
        throw new CliUsageError(`Unknown sch command "${sub ?? ""}". Try: easyeda sch snapshot`);
      }
      noExtra(positionals, 2);
      return { name: "sch-snapshot", ...(values.out ? { out: values.out } : {}) };
    case "export": {
      if (values.list) {
        noExtra(positionals, 1);
        return { name: "export-list" };
      }
      noExtra(positionals, 2);
      const kind = need(positionals, 1, "export kind (see easyeda export --list)");
      const scope = oneOf(values, "scope", ["pcb", "schematic", "auto"] as const);
      let entry;
      try {
        entry = getCatalogEntry(kind, { scope });
      } catch (error) {
        throw new CliUsageError(error instanceof Error ? error.message : String(error));
      }
      if (scope && !["bom", "netlist", "pcb-pdf", "sch-pdf"].includes(entry.kind)) {
        throw new CliUsageError("--scope only applies to bom, netlist, and pdf.");
      }
      const format = values.format;
      if (format !== undefined && !entry.formats?.includes(format)) {
        throw new CliUsageError(entry.formats ? `--format for ${entry.kind} must be one of ${entry.formats.join(", ")}.` : `--format does not apply to ${entry.kind}.`);
      }
      return {
        name: "export",
        kind,
        overwrite: values.overwrite ?? false,
        ...(values.out ? { out: values.out } : {}),
        ...(format ? { format } : {}),
        ...(scope ? { scope } : {})
      };
    }
    case "package": {
      noExtra(positionals, 1);
      if (values.kinds !== undefined && values.preset !== undefined) {
        throw new CliUsageError("Use either --kinds or --preset.");
      }
      const kinds = values.kinds?.split(",").map((part) => part.trim()).filter(Boolean);
      if (values.kinds !== undefined && !kinds?.length) {
        throw new CliUsageError("--kinds needs a comma list, e.g. gerber,bom,pnp.");
      }
      for (const kind of kinds ?? []) {
        try {
          getCatalogEntry(kind);
        } catch (error) {
          throw new CliUsageError(error instanceof Error ? error.message : String(error));
        }
      }
      const preset = oneOf(values, "preset", Object.keys(PACKAGE_PRESETS));
      return {
        name: "package",
        zip: values.zip ?? false,
        drcGate: values["drc-gate"] ?? false,
        ...(values.out ? { out: values.out } : {}),
        ...(kinds ? { kinds } : {}),
        ...(preset ? { preset } : {})
      };
    }
    case "check":
      noExtra(positionals, 1);
      return { name: "check", json: values.json ?? false, strict: values.strict ?? false };
    case "render": {
      noExtra(positionals, 1);
      if (!values.out) {
        throw new CliUsageError("render needs --out <file.png>.");
      }
      const margin = numberOption(values, "margin");
      return {
        name: "render",
        out: values.out,
        ...(values.designator ? { designator: values.designator } : {}),
        ...(values.region ? { region: parseRegionOption(values.region) } : {}),
        ...(margin === undefined ? {} : { margin })
      };
    }
    default:
      throw new CliUsageError(`Unknown command "${head}". Run easyeda --help.`);
  }
}

function parseRegionOption(text: string): Region {
  try {
    return parseRegion(text);
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}

function buildPcb(positionals: string[], values: Values): CliCommand {
  const sub = positionals[1];
  switch (sub) {
    case "snapshot": {
      noExtra(positionals, 2);
      let include: string[] | undefined;
      if (values.include !== undefined) {
        include = values.include.split(",").map((part) => part.trim()).filter(Boolean);
        const unknown = include.filter((part) => !(PCB_SNAPSHOT_SECTIONS as readonly string[]).includes(part));
        if (unknown.length > 0 || include.length === 0) {
          throw new CliUsageError(`--include takes a comma list of ${PCB_SNAPSHOT_SECTIONS.join(", ")}${unknown.length ? ` (unknown: ${unknown.join(", ")})` : ""}.`);
        }
      }
      return { name: "pcb-snapshot", ...(include ? { include } : {}), ...(values.out ? { out: values.out } : {}) };
    }
    case "move": {
      noExtra(positionals, 3);
      const request: MoveRequest = { designator: need(positionals, 2, "designator, e.g. U1") };
      for (const key of ["x", "y", "dx", "dy", "rotation"] as const) {
        const value = numberOption(values, key);
        if (value !== undefined) request[key] = value;
      }
      if (values.layer !== undefined) {
        if (!/^(top|bottom|\d+)$/i.test(values.layer)) {
          throw new CliUsageError(`--layer must be top, bottom, or a layer number, got "${values.layer}".`);
        }
        request.layer = values.layer;
      }
      if (request.x !== undefined && request.dx !== undefined) throw new CliUsageError("Use either --x or --dx.");
      if (request.y !== undefined && request.dy !== undefined) throw new CliUsageError("Use either --y or --dy.");
      if (Object.keys(request).length === 1) {
        throw new CliUsageError("pcb move needs at least one of --x --y --dx --dy --rotation --layer.");
      }
      return { name: "pcb-move", request };
    }
    case "drc":
      noExtra(positionals, 2);
      return { name: "pcb-drc", ...(values.strict ? { strict: true } : {}), ...(values.verbose ? { verbose: true } : {}) };
    case "analyze": {
      noExtra(positionals, 2);
      const top = numberOption(values, "top");
      if (top !== undefined && (!Number.isInteger(top) || top < 1)) throw new CliUsageError("--top must be a positive integer.");
      const grid = numberOption(values, "grid");
      if (grid !== undefined && grid <= 0) throw new CliUsageError("--grid must be positive (mil).");
      return {
        name: "pcb-analyze",
        json: values.json ?? false,
        padBBox: values["pad-bbox"] ?? false,
        ...(top === undefined ? {} : { top }),
        ...(grid === undefined ? {} : { grid }),
        ...(values.out ? { out: values.out } : {})
      };
    }
    default:
      throw new CliUsageError(`Unknown pcb command "${sub ?? ""}". Use snapshot, move, drc, or analyze.`);
  }
}

export const USAGE = `easyeda — control EasyEDA Pro from the shell through the easyeda-mcp hub

Usage:
  easyeda status                          Hub + extension status
  easyeda call <path> [jsonArg ...]       Call one API method, e.g.
                                            easyeda call pcb_PrimitiveComponent.getAll
                                            easyeda call pcb_PrimitiveComponent.modify '"e12"' '{"x":100}'
  easyeda batch <file.json|->             Run [{path,args}, ...] in one round trip [--continue-on-error]
  easyeda describe [namespace]            List API namespaces/methods
  easyeda pcb snapshot [--include a,b] [--out file]
  easyeda pcb move <designator> [--x N] [--y N] [--dx N] [--dy N] [--rotation N] [--layer top|bottom|N]
  easyeda pcb drc [--strict] [--verbose]
  easyeda pcb analyze [--json] [--top N] [--out file] [--grid mil] [--pad-bbox]
                                          Placement/routing report (exit 0 clean, 1 warnings/errors, 2 error)
  easyeda sch snapshot [--out file]
  easyeda export <kind> [--out path] [--format csv|json|xlsx] [--scope pcb|schematic] [--overwrite]
  easyeda export --list                   All export kinds (gerber, step, pnp, bom, ibom, odb, ...)
  easyeda package [--out dir] [--preset fab|assembly|docs|all | --kinds a,b] [--zip] [--drc-gate]
  easyeda check [--json] [--strict]       DRC + schematic-vs-PCB netlist + unconnected pins (exit 0/1/2)
  easyeda render --out view.png [--designator U1] [--region l,r,t,b] [--margin 0.5]
  easyeda daemon                          Run the bridge + hub in the foreground
  easyeda stop                            Stop a running daemon

Global options:
  --pretty           Indent JSON output
  --timeout <ms>     Per-call timeout
  --start/--no-start Start a background daemon when no hub is running
                     (default: on for commands that talk to EasyEDA)

Each call arg is parsed as JSON; if that fails it is passed as a string.
Arguments starting with "-" go after "--". Units are mil.
Output is JSON on stdout; errors are JSON on stderr with a non-zero exit code.
`;
