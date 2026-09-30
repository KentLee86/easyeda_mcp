import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { errorToWire } from "../bridge/errors.js";
import { configDir } from "../bridge/config.js";
import type { BridgeClient } from "../bridge/types.js";
import { isExportedFile, writeExport } from "../mcp/exportFiles.js";
import { buildRenderParams, isRenderedImage, movePcbComponent } from "../mcp/liveOps.js";
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

const EXPORT_METHODS = { bom: "exportBom", netlist: "exportNetlist", gerber: "exportGerber", pdf: "exportPdf" } as const;

/** Result of a command: what to print and the exit code. */
type Outcome = { output: unknown; exitCode?: number };

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
    const outcome = await execute(command, invocation, io);
    io.stdout(`${JSON.stringify(outcome.output ?? null, null, invocation.pretty ? 2 : undefined)}\n`);
    return outcome.exitCode ?? 0;
  } catch (error) {
    const wire = error instanceof CliUsageError
      ? { code: "usage", message: `${error.message}\nRun easyeda --help for usage.` }
      : errorToWire(error).error;
    io.stderr(`${JSON.stringify({ ok: false, error: wire }, null, invocation?.pretty ? 2 : undefined)}\n`);
    return error instanceof CliUsageError ? 2 : 1;
  }
}

async function execute(command: Exclude<CliCommand, { name: "help" | "daemon" }>, invocation: CliInvocation, io: CliIo): Promise<Outcome> {
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
  command: Exclude<CliCommand, { name: "help" | "daemon" | "status" | "stop" }>,
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
      const params = { ...(command.format ? { format: command.format } : {}), ...(command.scope ? { scope: command.scope } : {}) };
      const result = await bridge.call(EXPORT_METHODS[command.kind], params, timeoutMs ?? 120_000);
      if (!isExportedFile(result)) {
        return { output: { ok: false, message: "EasyEDA Pro did not return file contents.", result }, exitCode: 1 };
      }
      const { text: _text, truncated: _truncated, ...written } = await writeExport(result, {
        kind: command.kind,
        format: command.format,
        outputPath: command.out,
        overwrite: command.overwrite,
        maxInlineChars: 0
      });
      return { output: written };
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
