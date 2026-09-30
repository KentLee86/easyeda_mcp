// Catalog-driven exports, fabrication packages and the design check. Used by
// the CLI (over RemoteBridge), the MCP tools, and the hub's /v1/ops/* endpoints.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BridgeRpcError, errorToWire, type WireError } from "../bridge/errors.js";
import type { BridgeClient } from "../bridge/types.js";
import { compareNetlist, parseEnet, type NetlistComparison, type SnapshotLike } from "../schematic/compareNetlist.js";
import { EXPORT_CATALOG, extensionFor, getCatalogEntry, safeName, type CatalogEntry, type ExportDocument } from "./exportCatalog.js";
import { decodeText, isExportedFile, prepareExport } from "./exportFiles.js";
import { createZip } from "./zipWriter.js";

export const EXPORT_TIMEOUT_MS = 120_000;

export type DocumentRef = { uuid: string; documentType?: unknown; name?: string };
export type UseDocumentResult = { previous: DocumentRef | null; current: DocumentRef };

export async function useDocument(bridge: BridgeClient, kind: ExportDocument, timeoutMs = 30_000): Promise<UseDocumentResult> {
  return await bridge.call("useDocument", { kind }, timeoutMs) as UseDocumentResult;
}

export async function reopenDocument(bridge: BridgeClient, uuid: string, timeoutMs = 30_000): Promise<unknown> {
  return bridge.call("useDocument", { uuid }, timeoutMs);
}

/**
 * Switch documents for a sequence of groups with one useDocument per group,
 * then reopen the document that was active before the first switch.
 */
export class DocumentSession {
  private original: DocumentRef | null | undefined;
  private current?: DocumentRef;
  readonly switches: Array<{ kind: ExportDocument; uuid?: string; name?: string }> = [];

  constructor(private readonly bridge: BridgeClient) {}

  async use(kind: ExportDocument): Promise<DocumentRef> {
    const result = await useDocument(this.bridge, kind);
    if (this.original === undefined) {
      this.original = result.previous;
    }
    this.current = result.current;
    this.switches.push({ kind, uuid: result.current?.uuid, ...(result.current?.name ? { name: result.current.name } : {}) });
    return result.current;
  }

  /** Reopen the original document if we moved away from it. Never throws. */
  async restore(): Promise<{ restored: boolean; uuid?: string; error?: WireError }> {
    const original = this.original;
    if (!original?.uuid || original.uuid === this.current?.uuid) {
      return { restored: false };
    }
    try {
      await reopenDocument(this.bridge, original.uuid);
      this.current = original;
      return { restored: true, uuid: original.uuid };
    } catch (error) {
      return { restored: false, uuid: original.uuid, error: errorToWire(error).error };
    }
  }
}

export type PreparedFile = {
  kind: string;
  fileName: string;
  data: Buffer;
  mimeType?: string;
  /** Round trip for the export call, in ms. */
  ms: number;
  text?: string;
  note?: string;
};

/** Call exportFile for one catalog entry (the right document must already be active). */
export async function fetchExport(
  bridge: BridgeClient,
  entry: CatalogEntry,
  options: { baseName: string; format?: string; timeoutMs?: number }
): Promise<PreparedFile> {
  const format = options.format ?? entry.defaultFormat;
  if (options.format && !entry.formats?.includes(options.format)) {
    throw new BridgeRpcError(`Export "${entry.kind}" has no format "${options.format}"${entry.formats ? ` (use ${entry.formats.join(", ")})` : ""}.`, "invalid_argument");
  }
  const started = performance.now();
  const result = await bridge.call("exportFile", { path: entry.path, args: entry.args(options.baseName, { format }), fileName: options.baseName }, options.timeoutMs ?? EXPORT_TIMEOUT_MS);
  const ms = Math.round(performance.now() - started);
  if (!isExportedFile(result)) {
    throw new BridgeRpcError(`EasyEDA Pro returned no file for ${entry.path}.`, "export_empty");
  }
  const raw = Buffer.from(result.base64, "base64");
  const ext = extensionFor(entry, raw, result.fileName, result.mimeType, format);
  const prepared = prepareExport({ ...result, fileName: `${options.baseName}.${ext}` }, {
    kind: entry.kind,
    format,
    mode: entry.text === "bom" ? "bom" : entry.text === "text" ? "text" : "binary"
  });
  return { kind: entry.kind, fileName: prepared.fileName, data: prepared.data, mimeType: result.mimeType, ms, ...(prepared.text !== undefined ? { text: prepared.text } : {}), ...(prepared.note ? { note: prepared.note } : {}) };
}

/**
 * The extension status carries no project name (reading it on every heartbeat
 * would cost an RPC), so ask EasyEDA once per export/package/check.
 */
async function projectName(bridge: BridgeClient): Promise<string | undefined> {
  const status = await bridge.getStatus();
  if (status.projectName) {
    return status.projectName;
  }
  try {
    const info = await bridge.call("apiCall", { path: "dmt_Project.getCurrentProjectInfo" }, 10_000) as { friendlyName?: unknown; name?: unknown } | undefined;
    const name = info?.friendlyName ?? info?.name;
    if (typeof name === "string" && name.trim()) {
      return name;
    }
  } catch {
    // Older extensions without apiCall: fall back to the document name.
  }
  return status.documentName;
}

/** Export one catalog kind: switch to its document, export, switch back. */
export async function exportKind(
  bridge: BridgeClient,
  kind: string,
  options: { format?: string; scope?: "pcb" | "schematic" | "auto"; baseName?: string; timeoutMs?: number } = {}
): Promise<PreparedFile & { document: ExportDocument; restored: boolean }> {
  const entry = getCatalogEntry(kind, { scope: options.scope });
  const session = new DocumentSession(bridge);
  const project = safeName(await projectName(bridge));
  try {
    await session.use(entry.document);
    const file = await fetchExport(bridge, entry, { baseName: options.baseName ?? `${project}-${entry.kind}`, format: options.format, timeoutMs: options.timeoutMs });
    const restore = await session.restore();
    return { ...file, document: entry.document, restored: restore.restored };
  } catch (error) {
    await session.restore();
    throw error;
  }
}

export const PACKAGE_PRESETS: Record<string, readonly string[]> = {
  fab: ["gerber", "pcb-pdf", "netlist", "ipc356", "odb"],
  assembly: ["bom", "pnp", "step", "ibom"],
  docs: ["sch-pdf", "pcb-pdf", "sch-svg", "step"],
  all: EXPORT_CATALOG.map((entry) => entry.kind)
};

export function resolvePackageKinds(options: { kinds?: string[]; preset?: string }): CatalogEntry[] {
  let kinds: readonly string[];
  if (options.kinds && options.kinds.length > 0) {
    kinds = options.kinds;
  } else {
    const preset = options.preset ?? "fab";
    const found = PACKAGE_PRESETS[preset];
    if (!found) {
      throw new BridgeRpcError(`Unknown preset "${preset}". Use ${Object.keys(PACKAGE_PRESETS).join(", ")}.`, "invalid_argument");
    }
    kinds = found;
  }
  const entries = kinds.map((kind) => getCatalogEntry(kind));
  return entries.filter((entry, index) => entries.findIndex((other) => other.kind === entry.kind) === index);
}

export type DrcSummary = { ok: boolean; errorCount: number; categories?: unknown; error?: WireError };

export type PackageFile = { kind: string; path: string; bytes: number; sha256: string; ms: number; note?: string };

export type PackageManifest = {
  project: string;
  board?: string;
  generatedAt: string;
  extensionVersion?: string;
  easyedaVersion?: string;
  preset?: string;
  files: PackageFile[];
  failures: Array<{ kind: string; error: WireError }>;
  drc?: DrcSummary;
  counts?: unknown;
  documents: { switches: Array<{ kind: ExportDocument; uuid?: string; name?: string }>; restored: boolean; restoreError?: WireError };
};

export type CollectedPackage = { manifest: PackageManifest; files: PreparedFile[] };

function summarizeDrc(result: unknown): DrcSummary {
  const record = (result ?? {}) as { ok?: unknown; errorCount?: unknown; categories?: unknown };
  const errorCount = typeof record.errorCount === "number" ? record.errorCount : 0;
  return {
    ok: typeof record.ok === "boolean" ? record.ok : errorCount === 0,
    errorCount,
    ...(record.categories === undefined ? {} : { categories: record.categories })
  };
}

/**
 * Export several kinds with one useDocument per document type (PCB first),
 * run DRC on the PCB, and restore the original document. Per-file failures
 * are recorded, not thrown.
 */
export async function collectPackage(
  bridge: BridgeClient,
  options: { kinds?: string[]; preset?: string; drc?: boolean; now?: Date } = {}
): Promise<CollectedPackage> {
  const entries = resolvePackageKinds(options);
  const status = await bridge.getStatus();
  const projectTitle = await projectName(bridge);
  const project = safeName(projectTitle);
  const session = new DocumentSession(bridge);
  const files: PreparedFile[] = [];
  const failures: PackageManifest["failures"] = [];
  const manifest: PackageManifest = {
    project,
    generatedAt: (options.now ?? new Date()).toISOString(),
    ...(status.extensionVersion ? { extensionVersion: status.extensionVersion } : {}),
    ...(typeof (status as Record<string, unknown>).easyedaVersion === "string" ? { easyedaVersion: (status as Record<string, unknown>).easyedaVersion as string } : {}),
    ...(options.kinds?.length ? {} : { preset: options.preset ?? "fab" }),
    files: [],
    failures,
    documents: { switches: session.switches, restored: false }
  };
  const runDrc = options.drc ?? true;

  try {
    for (const document of ["pcb", "schematic"] as const) {
      const group = entries.filter((entry) => entry.document === document);
      if (group.length === 0 && !(document === "pcb" && runDrc)) {
        continue;
      }
      let current: DocumentRef;
      try {
        current = await session.use(document);
      } catch (error) {
        const wire = errorToWire(error).error;
        for (const entry of group) failures.push({ kind: entry.kind, error: wire });
        if (document === "pcb" && runDrc) manifest.drc = { ok: false, errorCount: 0, error: wire };
        continue;
      }
      if (document === "pcb") {
        manifest.board = current.name;
        if (runDrc) {
          try {
            manifest.drc = summarizeDrc(await bridge.call("pcbDrc", {}, EXPORT_TIMEOUT_MS));
          } catch (error) {
            manifest.drc = { ok: false, errorCount: 0, error: errorToWire(error).error };
          }
        }
        try {
          const snapshot = await bridge.call("pcbSnapshot", { include: ["components", "nets"] }, 60_000) as { counts?: unknown } | undefined;
          if (snapshot?.counts) manifest.counts = snapshot.counts;
        } catch {
          // counts are optional
        }
      }
      for (const entry of group) {
        try {
          files.push(await fetchExport(bridge, entry, { baseName: `${project}-${entry.kind}` }));
        } catch (error) {
          failures.push({ kind: entry.kind, error: errorToWire(error).error });
        }
      }
    }
  } finally {
    const restore = await session.restore();
    manifest.documents.restored = restore.restored;
    if (restore.error) manifest.documents.restoreError = restore.error;
  }

  manifest.files = files.map((file) => ({
    kind: file.kind,
    path: file.fileName,
    bytes: file.data.length,
    sha256: createHash("sha256").update(file.data).digest("hex"),
    ms: file.ms,
    ...(file.note ? { note: file.note } : {})
  }));
  return { manifest, files };
}

export function defaultPackageDir(project: string, now = new Date(), cwd = process.cwd()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return path.join(cwd, `easyeda-package-${project}-${stamp}`);
}

/** Write collected files + manifest.json into dir; optionally also <dir>.zip. */
export async function writePackage(collected: CollectedPackage, options: { outDir?: string; zip?: boolean; cwd?: string } = {}): Promise<{ dir: string; manifestPath: string; zipPath?: string; manifest: PackageManifest }> {
  const dir = path.resolve(options.cwd ?? process.cwd(), options.outDir ?? defaultPackageDir(collected.manifest.project, new Date(collected.manifest.generatedAt), options.cwd));
  await mkdir(dir, { recursive: true });
  for (const file of collected.files) {
    await writeFile(path.join(dir, file.fileName), file.data);
  }
  const manifestText = `${JSON.stringify(collected.manifest, null, 2)}\n`;
  const manifestPath = path.join(dir, "manifest.json");
  await writeFile(manifestPath, manifestText);
  let zipPath: string | undefined;
  if (options.zip) {
    zipPath = `${dir}.zip`;
    const root = path.basename(dir);
    await writeFile(zipPath, createZip([
      ...collected.files.map((file) => ({ name: `${root}/${file.fileName}`, data: file.data })),
      { name: `${root}/manifest.json`, data: Buffer.from(manifestText) }
    ], new Date(collected.manifest.generatedAt)));
  }
  return { dir, manifestPath, ...(zipPath ? { zipPath } : {}), manifest: collected.manifest };
}

export type DesignCheckReport = {
  ok: boolean;
  findings: number;
  project?: string;
  drc: DrcSummary;
  connectivity?: NetlistComparison;
  connectivityError?: WireError;
  unconnectedPins: { count: number; pins: string[] };
  counts: { pcb?: unknown; schematic?: unknown };
  documents: { switches: Array<{ kind: ExportDocument; uuid?: string; name?: string }>; restored: boolean };
};

/**
 * DRC + schematic-vs-PCB connectivity (PCB netlist export as ground truth) +
 * unconnected schematic pins. One switch to the PCB, one to the schematic,
 * then back to the original document.
 */
export async function runDesignCheck(bridge: BridgeClient, options: { strict?: boolean } = {}): Promise<DesignCheckReport> {
  const status = await bridge.getStatus();
  const checkProject = await projectName(bridge);
  const session = new DocumentSession(bridge);
  let drc: DrcSummary;
  let enetText: string | undefined;
  let connectivityError: WireError | undefined;
  let pcbCounts: unknown;
  let snapshot: (SnapshotLike & { counts?: unknown }) | undefined;
  let restored = false;
  try {
    await session.use("pcb");
    drc = summarizeDrc(await bridge.call("pcbDrc", {}, EXPORT_TIMEOUT_MS));
    try {
      const file = await fetchExport(bridge, getCatalogEntry("netlist"), { baseName: "check-netlist" });
      enetText = file.text ?? decodeText(file.data);
    } catch (error) {
      connectivityError = errorToWire(error).error;
    }
    const pcbSnapshot = await bridge.call("pcbSnapshot", { include: ["components", "nets"] }, 60_000) as { counts?: unknown } | undefined;
    pcbCounts = pcbSnapshot?.counts;
    await session.use("schematic");
    snapshot = await bridge.call("schematicSnapshot", { includeRaw: false, allPages: true }, 120_000) as SnapshotLike & { counts?: unknown };
  } finally {
    restored = (await session.restore()).restored;
  }

  let connectivity: NetlistComparison | undefined;
  if (enetText !== undefined && snapshot) {
    try {
      connectivity = compareNetlist(snapshot, parseEnet(enetText), options);
    } catch (error) {
      connectivityError = { code: "netlist_parse_error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  const partIds = new Set((snapshot?.components ?? []).filter((item) => item.componentType === "part").map((item) => `${item.page?.uuid ?? ""}\u0000${item.primitiveId}`));
  const unconnected = (snapshot?.pins ?? [])
    .filter((pin) => !pin.connected && partIds.has(`${pin.page?.uuid ?? ""}\u0000${pin.componentPrimitiveId}`))
    .map((pin) => `${pin.componentDesignator}.${pin.pinNumber}`);

  const findings = (drc.errorCount > 0 || !drc.ok ? 1 : 0)
    + (connectivity ? connectivity.discrepancies.length + connectivity.parts.missingOnPcb.length + connectivity.parts.missingInSchematic.length : 0)
    + (connectivityError ? 1 : 0);
  return {
    ok: findings === 0,
    findings,
    ...(checkProject ? { project: checkProject } : {}),
    drc,
    ...(connectivity ? { connectivity } : {}),
    ...(connectivityError ? { connectivityError } : {}),
    unconnectedPins: { count: unconnected.length, pins: unconnected.slice(0, 50) },
    counts: { pcb: pcbCounts, schematic: snapshot?.counts },
    documents: { switches: session.switches, restored }
  };
}

/** Human-readable summary of a design check (CLI default output). */
export function formatDesignCheck(report: DesignCheckReport): string {
  const lines: string[] = [];
  lines.push(`${report.ok ? "OK" : "FINDINGS"}: ${report.findings} finding(s)${report.project ? ` in ${report.project}` : ""}`);
  lines.push(`DRC: ${report.drc.error ? `failed to run (${report.drc.error.message})` : `${report.drc.errorCount} error(s)`}`);
  if (report.connectivity) {
    const { counters, stats, parts } = report.connectivity;
    lines.push(`Connectivity (schematic vs PCB netlist): ${stats.pinsCompared} pins compared; split ${counters.split}, merged ${counters.merged}, name ${counters.name}, missing in schematic data ${counters.missingInSnapshot}, missing on PCB ${counters.missingInNetlist}`);
    if (parts.missingOnPcb.length) lines.push(`Parts without a PCB footprint: ${parts.missingOnPcb.join(", ")}`);
    if (parts.schematicOnlyByDesign?.length) lines.push(`Schematic-only parts (addIntoPcb off, not a finding): ${parts.schematicOnlyByDesign.join(", ")}`);
    if (parts.missingInSchematic.length) lines.push(`PCB parts without a schematic symbol: ${parts.missingInSchematic.join(", ")}`);
    if (parts.pcbOnlyUnconnected.length) lines.push(`info: PCB-only unconnected parts (holes, fiducials): ${parts.pcbOnlyUnconnected.join(", ")}`);
    for (const item of report.connectivity.discrepancies.slice(0, 20)) lines.push(`  [${item.kind}] ${item.message}`);
    if (report.connectivity.discrepancies.length > 20) lines.push(`  ... ${report.connectivity.discrepancies.length - 20} more (use --json)`);
  } else if (report.connectivityError) {
    lines.push(`Connectivity: not compared (${report.connectivityError.code}: ${report.connectivityError.message})`);
  }
  lines.push(`Unconnected schematic pins: ${report.unconnectedPins.count}${report.unconnectedPins.count ? ` (${report.unconnectedPins.pins.slice(0, 10).join(", ")}${report.unconnectedPins.count > 10 ? ", ..." : ""})` : ""}`);
  return `${lines.join("\n")}\n`;
}
