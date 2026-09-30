import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** File contents returned by the extension for export methods (protocol 0.2.0). */
export type ExportedFile = {
  fileName: string;
  mimeType?: string;
  size?: number;
  base64: string;
};

export type ExportKind = "bom" | "netlist" | "gerber" | "pdf";

export type WrittenExport = {
  path: string;
  fileName: string;
  bytes: number;
  mimeType?: string;
  /** Decoded text for text formats (BOM csv/json, netlist), cut at maxInlineChars. */
  text?: string;
  truncated?: boolean;
  note?: string;
};

export function defaultExportDir(): string {
  return process.env.EASYEDA_MCP_EXPORT_DIR ?? path.join(os.tmpdir(), "easyeda-mcp-exports");
}

export function isExportedFile(value: unknown): value is ExportedFile {
  return typeof value === "object" && value !== null
    && typeof (value as ExportedFile).fileName === "string"
    && typeof (value as ExportedFile).base64 === "string";
}

/** Decode text, honouring the UTF-16/UTF-8 byte order marks EasyEDA uses for BOM exports. */
export function decodeText(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  return buffer.toString("utf8");
}

/** EasyEDA returns its "csv" BOM as tab-separated text; convert it to RFC 4180 CSV. */
export function tsvToCsv(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.split("\t").map(csvField).join(","))
    .join("\n");
}

/** Tab-separated table (first line = header) to an array of row objects. */
export function tsvToRows(text: string): Array<Record<string, string>> {
  const [header, ...lines] = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const columns = (header ?? "").split("\t").map((name) => name.trim());
  return lines.map((line) => {
    const cells = line.split("\t");
    return Object.fromEntries(columns.map((column, index) => [column, (cells[index] ?? "").trim()]));
  });
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}

function looksTabSeparated(text: string): boolean {
  const header = text.split(/\r?\n/, 1)[0] ?? "";
  return header.includes("\t") && !header.includes(",");
}

/** Target path for an export: default dir, a directory (trailing / or existing dir), or a file path. */
export async function resolveExportTarget(outputPath: string | undefined, fileName: string): Promise<string> {
  return resolveTarget(outputPath, fileName);
}

async function resolveTarget(outputPath: string | undefined, fileName: string): Promise<string> {
  if (!outputPath) {
    return path.join(defaultExportDir(), fileName);
  }
  const resolved = path.resolve(outputPath);
  const isDirectory = /[\\/]$/.test(outputPath) || (await stat(resolved).catch(() => undefined))?.isDirectory();
  return isDirectory ? path.join(resolved, fileName) : resolved;
}

export async function writeExport(
  file: ExportedFile,
  options: {
    kind: ExportKind | string;
    format?: string;
    outputPath?: string;
    overwrite?: boolean;
    maxInlineChars?: number;
    /** Override text handling: BOM conversion, plain text, or raw bytes. Default from kind. */
    mode?: "bom" | "text" | "binary";
  }
): Promise<WrittenExport> {
  const { data, fileName, text, note } = prepareExport(file, options);
  const target = await resolveTarget(options.outputPath, fileName);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data, { flag: options.overwrite ? "w" : "wx" });

  const maxInlineChars = options.maxInlineChars ?? 20_000;
  return {
    path: target,
    fileName: path.basename(target),
    bytes: data.length,
    mimeType: file.mimeType,
    ...(text === undefined ? {} : {
      text: text.slice(0, maxInlineChars),
      truncated: text.length > maxInlineChars
    }),
    ...(note ? { note } : {})
  };
}

/** Decode/convert exported bytes (BOM TSV to CSV/JSON, UTF-16 text to UTF-8) without writing them. */
export function prepareExport(
  file: ExportedFile,
  options: { kind: ExportKind | string; format?: string; mode?: "bom" | "text" | "binary" }
): { data: Buffer; fileName: string; text?: string; note?: string } {
  let data: Buffer = Buffer.from(file.base64, "base64");
  let fileName = file.fileName;
  let text: string | undefined;
  let note: string | undefined;

  const mode = options.mode ?? (options.kind === "bom" ? "bom" : options.kind === "netlist" ? "text" : "binary");
  const isBom = mode === "bom";
  const isText = mode === "text" || (isBom && options.format !== "xlsx");
  if (isText) {
    text = decodeText(data);
    if (isBom && options.format === "csv" && looksTabSeparated(text)) {
      text = tsvToCsv(text);
      note = "EasyEDA returned tab-separated UTF-16 text; converted to UTF-8 CSV.";
    } else if (isBom && options.format === "json" && looksTabSeparated(text)) {
      text = JSON.stringify(tsvToRows(text), null, 2);
      note = "EasyEDA returned a tab-separated BOM; converted to a JSON array of rows.";
    }
    data = Buffer.from(text, "utf8");
  }
  if (isBom && options.format && !fileName.toLowerCase().endsWith(`.${options.format}`)) {
    fileName = `${fileName.replace(/\.[^.]*$/, "")}.${options.format}`;
  }
  return { data, fileName, ...(text === undefined ? {} : { text }), ...(note ? { note } : {}) };
}
