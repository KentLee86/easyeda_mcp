// One table of EasyEDA Pro file exports, shared by the CLI, the MCP tools and
// (through GET /v1/exports and the /v1/ops/* endpoints) the Python client.
// Timings were measured on EasyEDA Pro 3.2.149 with a 79-part 2-layer board.
import { BridgeRpcError } from "../bridge/errors.js";

export type ExportDocument = "pcb" | "schematic";

export type CatalogEntry = {
  kind: string;
  title: string;
  /** Document that must be active; the caller switches to it with useDocument. */
  document: ExportDocument;
  /** ManufactureData method called through the extension's exportFile. */
  path: string;
  /** Build the method args from the base file name and options. */
  args: (name: string, options: { format?: string }) => unknown[];
  /** Known file extension; undefined = detect from the returned bytes/name. */
  ext?: string;
  /** Text handling in writeExport: BOM TSV conversion, or plain text. */
  text?: "bom" | "text";
  formats?: readonly string[];
  defaultFormat?: string;
  /** Typical EasyEDA time in ms (for docs and --list). */
  typicalMs: number;
  notes?: string;
};

export type UnsupportedExport = { kind: string; path: string; reason: string };

const name = (base: string) => [base];

export const EXPORT_CATALOG: readonly CatalogEntry[] = [
  { kind: "gerber", title: "Gerber + drill (zip)", document: "pcb", path: "pcb_ManufactureData.getGerberFile", args: name, ext: "zip", typicalMs: 300, notes: "Drill files are inside the zip." },
  { kind: "step", title: "3D model (STEP)", document: "pcb", path: "pcb_ManufactureData.get3DFile", args: (base) => [base, "step"], ext: "step", typicalMs: 475 },
  { kind: "obj", title: "3D model (OBJ, zip)", document: "pcb", path: "pcb_ManufactureData.get3DFile", args: (base) => [base, "obj"], ext: "zip", typicalMs: 243 },
  { kind: "pnp", title: "Pick and place / CPL (csv)", document: "pcb", path: "pcb_ManufactureData.getPickAndPlaceFile", args: (base) => [base, "csv", "mm"], ext: "csv", text: "text", typicalMs: 12, notes: "Coordinates in mm." },
  {
    kind: "bom",
    title: "Bill of materials",
    document: "pcb",
    path: "pcb_ManufactureData.getBomFile",
    // Pro only makes csv (tab-separated UTF-16) or xlsx; json is converted from csv.
    args: (base, { format }) => [base, format === "xlsx" ? "xlsx" : "csv"],
    text: "bom",
    formats: ["csv", "json", "xlsx"],
    defaultFormat: "csv",
    typicalMs: 30,
    notes: "EasyEDA's tab-separated UTF-16 csv is converted to UTF-8 CSV (or JSON rows)."
  },
  { kind: "netlist", title: "Netlist (EasyEDA .enet JSON)", document: "pcb", path: "pcb_ManufactureData.getNetlistFile", args: name, ext: "enet", text: "text", typicalMs: 317, notes: "From the PCB; the schematic export is often empty." },
  { kind: "dxf", title: "DXF", document: "pcb", path: "pcb_ManufactureData.getDxfFile", args: name, ext: "dxf", typicalMs: 521, notes: "About 2 MB." },
  { kind: "pcb-pdf", title: "PCB PDF", document: "pcb", path: "pcb_ManufactureData.getPdfFile", args: name, ext: "pdf", typicalMs: 399 },
  { kind: "sch-pdf", title: "Schematic PDF (all pages)", document: "schematic", path: "sch_ManufactureData.getExportDocumentFile", args: (base) => [base, "PDF"], ext: "pdf", typicalMs: 368 },
  { kind: "sch-svg", title: "Schematic SVG (zip)", document: "schematic", path: "sch_ManufactureData.getExportDocumentFile", args: (base) => [base, "SVG"], ext: "zip", typicalMs: 239 },
  { kind: "sch-png", title: "Schematic PNG (zip)", document: "schematic", path: "sch_ManufactureData.getExportDocumentFile", args: (base) => [base, "PNG"], ext: "zip", typicalMs: 443 },
  { kind: "ipc356", title: "IPC-D-356A netlist", document: "pcb", path: "pcb_ManufactureData.getIpcD356AFile", args: name, ext: "356a", text: "text", typicalMs: 21 },
  { kind: "odb", title: "ODB++ (zip)", document: "pcb", path: "pcb_ManufactureData.getOpenDatabaseDoublePlusFile", args: name, ext: "zip", typicalMs: 301 },
  { kind: "ibom", title: "Interactive BOM (html)", document: "pcb", path: "pcb_ManufactureData.getInteractiveBomFile", args: name, ext: "html", typicalMs: 1_500, notes: "About 9 MB." },
  { kind: "dsn", title: "Specctra DSN", document: "pcb", path: "pcb_ManufactureData.getDsnFile", args: name, ext: "dsn", text: "text", typicalMs: 157 },
  { kind: "flying-probe", title: "Flying probe test", document: "pcb", path: "pcb_ManufactureData.getFlyingProbeTestFile", args: name, ext: "txt", text: "text", typicalMs: 14 },
  { kind: "pcb-info", title: "PCB info", document: "pcb", path: "pcb_ManufactureData.getPcbInfoFile", args: name, ext: "txt", text: "text", typicalMs: 7 },
  { kind: "altium", title: "Altium Designer", document: "pcb", path: "pcb_ManufactureData.getAltiumDesignerFile", args: name, typicalMs: 620 },
  { kind: "pads", title: "PADS", document: "pcb", path: "pcb_ManufactureData.getPadsFile", args: name, typicalMs: 540 },
  { kind: "testpoint", title: "Test points (csv)", document: "pcb", path: "pcb_ManufactureData.getTestPointFile", args: (base) => [base, "csv"], ext: "csv", text: "text", typicalMs: 5, notes: "Fails with export_empty when the board has no test points." }
];

/** Known broken in EasyEDA Pro 3.2.149; never offered. */
export const UNSUPPORTED_EXPORTS: readonly UnsupportedExport[] = [
  { kind: "ipc2581", path: "pcb_ManufactureData.getIpc2581CFile", reason: "Never resolves in EasyEDA Pro 3.2.149." },
  { kind: "sch-dxf", path: "sch_ManufactureData.getDxfFile", reason: "Shows an error dialog and never resolves in EasyEDA Pro 3.2.149." },
  { kind: "3d-shell", path: "pcb_ManufactureData.get3DShellFile", reason: "Returns nothing and leaves a warning dialog when the board has no 3D shell objects." },
  { kind: "autoroute-json", path: "pcb_ManufactureData.getAutoRouteJsonFile", reason: "Returns nothing in EasyEDA Pro 3.2.149." },
  { kind: "spice", path: "sch_ManufactureData.getNetlistFile (spice)", reason: "Returns nothing in EasyEDA Pro 3.2.149." }
];

/** Legacy names accepted by `easyeda export`. */
const ALIASES: Record<string, string> = { pdf: "pcb-pdf", "3d": "step", cpl: "pnp", "pick-and-place": "pnp", odbpp: "odb", "ipc-d-356": "ipc356", specctra: "dsn" };

export const EXPORT_KINDS = EXPORT_CATALOG.map((entry) => entry.kind);

export function getCatalogEntry(kind: string, options: { scope?: "pcb" | "schematic" | "auto" } = {}): CatalogEntry {
  let wanted = ALIASES[kind] ?? kind;
  if (kind === "pdf" && options.scope === "schematic") {
    wanted = "sch-pdf";
  }
  const unsupported = UNSUPPORTED_EXPORTS.find((item) => item.kind === wanted);
  if (unsupported) {
    throw new BridgeRpcError(`Export "${kind}" is not supported: ${unsupported.reason}`, "export_unsupported", unsupported);
  }
  const entry = EXPORT_CATALOG.find((item) => item.kind === wanted);
  if (!entry) {
    throw new BridgeRpcError(`Unknown export kind "${kind}". Known: ${EXPORT_KINDS.join(", ")}.`, "invalid_argument");
  }
  if (options.scope === "schematic" && (entry.kind === "bom" || entry.kind === "netlist")) {
    // Same file from the schematic side.
    return { ...entry, document: "schematic", path: entry.path.replace(/^pcb_/, "sch_") };
  }
  return entry;
}

/** Plain description of the catalog (for --list, GET /v1/exports, and tool docs). */
export function describeCatalog(): { supported: Array<Omit<CatalogEntry, "args">>; unsupported: readonly UnsupportedExport[] } {
  return {
    supported: EXPORT_CATALOG.map(({ args: _args, ...rest }) => rest),
    unsupported: UNSUPPORTED_EXPORTS
  };
}

const MIME_EXTENSIONS: Record<string, string> = {
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/pdf": "pdf",
  "text/html": "html",
  "image/png": "png",
  "image/svg+xml": "svg",
  "text/csv": "csv",
  "application/json": "json",
  "text/plain": "txt",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx"
};

/**
 * File extension for exported bytes: known magic numbers first, then the
 * extension of the name EasyEDA returned, then the mime type, then "bin".
 */
export function detectExtension(data: Buffer, fileName?: string, mimeType?: string): string {
  const head = data.subarray(0, 64).toString("latin1");
  if (head.startsWith("PK\u0003\u0004") || head.startsWith("PK\u0005\u0006")) return "zip";
  if (head.startsWith("%PDF")) return "pdf";
  if (head.startsWith("\u0089PNG")) return "png";
  if (head.startsWith("ISO-10303-21")) return "step";
  if (/^\s*<(!doctype html|html)/i.test(head)) return "html";
  if (/^\s*<svg/i.test(head)) return "svg";
  const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(fileName ?? "")?.[1];
  if (fromName) return fromName.toLowerCase();
  const fromMime = mimeType ? MIME_EXTENSIONS[mimeType.split(";")[0]!.trim().toLowerCase()] : undefined;
  return fromMime ?? "bin";
}

/** Extension for an entry's output (format wins for BOM). */
export function extensionFor(entry: CatalogEntry, data: Buffer, fileName?: string, mimeType?: string, format?: string): string {
  if (entry.formats && format) {
    return format;
  }
  if (entry.formats && entry.defaultFormat) {
    return entry.defaultFormat;
  }
  return entry.ext ?? detectExtension(data, fileName, mimeType);
}

/** Safe file-name stem from a project/board name. */
export function safeName(text: string | undefined, fallback = "easyeda"): string {
  const cleaned = (text ?? "").normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^[._]+|[._]+$/g, "").slice(0, 80);
  return cleaned || fallback;
}
