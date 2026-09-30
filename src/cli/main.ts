import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { errorToWire } from "../bridge/errors.js";
import { configDir } from "../bridge/config.js";
import type { BridgeClient } from "../bridge/types.js";
import { resolveExportTarget } from "../mcp/exportFiles.js";
import { describeCatalog } from "../mcp/exportCatalog.js";
import { collectPackage, exportKind, formatDesignCheck, runDesignCheck, writePackage } from "../mcp/exportOps.js";
import { buildRenderParams, isRenderedImage, movePcbComponent } from "../mcp/liveOps.js";
import { formatPcbAnalysis } from "../pcb/analyze.js";
import { runPcbAnalyze } from "../pcb/analyzeOps.js";
import { CliUsageError, parseCli, USAGE, type CliCommand, type CliInvocation } from "./args.js";
import { connectHub, findHub } from "./hub.js";

export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
};

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
};

/** Result of a command: what to print (JSON, or raw text) and the exit code. */
type Outcome = { output: unknown; text?: string; exitCode?: number };

/**
 * Run the CLI. Resolves to the exit code, or undefined for `daemon`, which
 * keeps the process alive.
 */
export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number | undefined> {
  let invocation: CliInvocation | undefined;
  try {
    invocation = parseCli(argv);
    const { command } = invocation;
    if (command.name === "help") {
      io.stdout(USAGE);
      return 0;
    }
    if (command.name === "daemon") {
      const { runDaemon } = await import("../daemon.js");
      await runDaemon();
      return undefined;
    }
    if (command.name === "export-list") {
      const catalog = describeCatalog();
      io.stdout(`${JSON.stringify(catalog, null, invocation.pretty ? 2 : undefined)}\n`);
      return 0;
    }
    const outcome = await execute(command, invocation, io);
    io.stdout(outcome.text ?? `${JSON.stringify(outcome.output ?? null, null, invocation.pretty ? 2 : undefined)}\n`);
    return outcome.exitCode ?? 0;
  } catch (error) {
    const wire = error instanceof CliUsageError
      ? { code: "usage", message: `${error.message}\nRun easyeda --help for usage.` }
      : errorToWire(error).error;
    io.stderr(`${JSON.stringify({ ok: false, error: wire }, null, invocation?.pretty ? 2 : undefined)}\n`);
    // `check` and `pcb analyze` reserve 1 for findings, so errors are 2 there.
    return error instanceof CliUsageError || invocation?.command.name === "check" || invocation?.command.name === "pcb-analyze" ? 2 : 1;
  }
}

async function execute(command: Exclude<CliCommand, { name: "help" | "daemon" | "export-list" }>, invocation: CliInvocation, io: CliIo): Promise<Outcome> {
  if (command.name === "status") {
    const connection = invocation.start
      ? await connectHub({ start: true, requireExtension: false })
      : await findHub();
    if (!connection) {
      return { output: { hub: null, configDir: configDir(), status: { connected: false, message: "No easyeda-mcp hub is running." } }, exitCode: 1 };
    }
    return { output: { hub: { url: connection.bridge.baseUrl, ...connection.info }, status: await connection.bridge.getStatus() } };
  }

  if (command.name === "stop") {
    const connection = await connectHub({ start: false, requireExtension: false });
    await connection.bridge.shutdown();
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!(await findHub())) {
        return { output: { stopped: true, pid: connection.info.pid } };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { output: { stopped: false, pid: connection.info.pid, message: "Shutdown requested but the hub still answers." }, exitCode: 1 };
  }

  const { bridge } = await connectHub({ start: invocation.start, requireExtension: true });
  return runEditorCommand(command, bridge, invocation.timeoutMs, io);
}

/** Commands that talk to EasyEDA through a bridge (exported for tests). */
export async function runEditorCommand(
  command: Exclude<CliCommand, { name: "help" | "daemon" | "status" | "stop" | "export-list" }>,
  bridge: BridgeClient,
  timeoutMs: number | undefined,
  io: Pick<CliIo, "readStdin">
): Promise<Outcome> {
  switch (command.name) {
    case "call":
      return { output: await bridge.call("apiCall", { path: command.path, args: command.args }, timeoutMs ?? 30_000) };
    case "batch": {
      const text = command.source === "-" ? await io.readStdin() : await readFile(command.source, "utf8");
      const parsed = JSON.parse(text) as unknown;
      const calls = Array.isArray(parsed) ? parsed : (parsed as { calls?: unknown }).calls;
      if (!Array.isArray(calls)) {
        throw new CliUsageError("Batch input must be a JSON array of {path, args} (or {calls: [...]}).");
      }
      const result = await bridge.call("apiBatch", { calls, stopOnError: command.stopOnError }, timeoutMs ?? 60_000) as { results?: Array<{ ok: boolean }> };
      const failed = Array.isArray(result?.results) && result.results.some((item) => !item.ok);
      return { output: result, exitCode: failed ? 1 : 0 };
    }
    case "describe":
      return { output: await bridge.call("apiDescribe", command.namespace ? { namespace: command.namespace } : {}, timeoutMs ?? 10_000) };
    case "pcb-snapshot": {
      const snapshot = await bridge.call("pcbSnapshot", command.include ? { include: command.include } : {}, timeoutMs ?? 60_000);
      return { output: await maybeWriteJson(snapshot, command.out) };
    }
    case "sch-snapshot": {
      const snapshot = await bridge.call("schematicSnapshot", { includeRaw: false, allPages: true }, timeoutMs ?? 60_000);
      return { output: await maybeWriteJson(snapshot, command.out) };
    }
    case "pcb-move":
      return { output: await movePcbComponent(bridge, command.request, timeoutMs ?? 30_000) };
    case "pcb-drc":
      return { output: await bridge.call("pcbDrc", { ...(command.strict ? { strict: true } : {}), ...(command.verbose ? { verbose: true } : {}) }, timeoutMs ?? 120_000) };
    case "export": {
      // Switches to the kind's document (useDocument) and back.
      const file = await exportKind(bridge, command.kind, { format: command.format, scope: command.scope, ...(timeoutMs ? { timeoutMs } : {}) });
      const target = await resolveExportTarget(command.out ?? "./", file.fileName);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.data, { flag: command.overwrite ? "w" : "wx" });
      return { output: { kind: file.kind, path: target, bytes: file.data.length, ms: file.ms, document: file.document, restoredDocument: file.restored, ...(file.note ? { note: file.note } : {}) } };
    }
    case "package": {
      const collected = await collectPackage(bridge, { kinds: command.kinds, preset: command.preset });
      const written = await writePackage(collected, { outDir: command.out, zip: command.zip });
      const { manifest } = written;
      const drcFailed = !manifest.drc || !manifest.drc.ok || manifest.drc.errorCount > 0;
      return {
        output: {
          dir: written.dir,
          ...(written.zipPath ? { zip: written.zipPath } : {}),
          files: manifest.files.map((file) => `${file.path} (${file.bytes} B, ${file.ms} ms)`),
          failures: manifest.failures,
          drc: manifest.drc ? { ok: manifest.drc.ok, errorCount: manifest.drc.errorCount, ...(manifest.drc.error ? { error: manifest.drc.error } : {}) } : undefined,
          restoredDocument: manifest.documents.restored
        },
        exitCode: manifest.failures.length > 0 || (command.drcGate && drcFailed) ? 1 : 0
      };
    }
    case "check": {
      const report = await runDesignCheck(bridge, { strict: command.strict });
      return { output: report, ...(command.json ? {} : { text: formatDesignCheck(report) }), exitCode: report.ok ? 0 : 1 };
    }
    case "pcb-analyze": {
      // Switches to the PCB (useDocument) and back.
      const report = await runPcbAnalyze(bridge, { top: command.top, grid: command.grid, bboxes: !command.padBBox, ...(timeoutMs ? { timeoutMs } : {}) });
      let written: string | undefined;
      if (command.out) {
        written = path.resolve(command.out);
        await mkdir(path.dirname(written), { recursive: true });
        await writeFile(written, `${JSON.stringify(report, null, 2)}\n`);
      }
      const text = formatPcbAnalysis(report, command.top ?? 10) + (written ? `Report: ${written}\n` : "");
      return { output: report, ...(command.json ? {} : { text }), exitCode: report.ok ? 0 : 1 };
    }
    case "render": {
      const params = await buildRenderParams(bridge, command, timeoutMs ?? 30_000);
      const image = await bridge.call("renderImage", params, timeoutMs ?? 30_000);
      if (!isRenderedImage(image)) {
        return { output: { ok: false, message: "EasyEDA Pro did not return an image.", result: image }, exitCode: 1 };
      }
      const data = Buffer.from(image.base64, "base64");
      const target = path.resolve(command.out);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
      return { output: { path: target, bytes: data.length, mimeType: image.mimeType, ...(image.region ? { region: image.region } : {}) } };
    }
  }
}

async function maybeWriteJson(value: unknown, out: string | undefined): Promise<unknown> {
  if (!out) {
    return value;
  }
  const target = path.resolve(out);
  await mkdir(path.dirname(target), { recursive: true });
  const text = JSON.stringify(value, null, 2);
  await writeFile(target, `${text}\n`);
  const counts = (value as { counts?: unknown } | undefined)?.counts;
  return { path: target, bytes: Buffer.byteLength(text) + 1, ...(counts ? { counts } : {}) };
}
