import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_WS_PORT = 8765;
export const DEFAULT_HTTP_PORT = 8766;
export const HUB_HOST = "127.0.0.1";

/** Written next to the token by the process that owns the bridge port. */
export type HubInfo = {
  pid: number;
  role: "mcp" | "daemon";
  wsPort: number;
  httpPort: number;
  startedAt: string;
  version?: string;
};

type Env = NodeJS.ProcessEnv;

/**
 * `$EASYEDA_MCP_CONFIG_DIR`, else `$XDG_CONFIG_HOME/easyeda-mcp`, else
 * `~/.config/easyeda-mcp`.
 */
export function configDir(env: Env = process.env): string {
  if (env.EASYEDA_MCP_CONFIG_DIR) {
    return path.resolve(env.EASYEDA_MCP_CONFIG_DIR);
  }
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return path.join(base, "easyeda-mcp");
}

export function tokenPath(dir = configDir()): string {
  return path.join(dir, "token");
}

export function hubInfoPath(dir = configDir()): string {
  return path.join(dir, "hub.json");
}

export function daemonLogPath(dir = configDir()): string {
  return path.join(dir, "daemon.log");
}

export function envHttpPort(env: Env = process.env): number | undefined {
  const raw = env.EASYEDA_MCP_HTTP_PORT;
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`EASYEDA_MCP_HTTP_PORT must be a port number, got "${raw}".`);
  }
  return port;
}

export function envWsPort(env: Env = process.env): number {
  return Number(env.EASYEDA_MCP_WS_PORT ?? DEFAULT_WS_PORT);
}

export async function ensureConfigDir(dir = configDir()): Promise<string> {
  const existed = await stat(dir).then(() => true, () => false);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!existed) {
    await chmod(dir, 0o700);
  }
  return dir;
}

/** Read the hub token, or undefined when it does not exist yet. */
export async function readToken(dir = configDir()): Promise<string | undefined> {
  try {
    const token = (await readFile(tokenPath(dir), "utf8")).trim();
    return token || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Reuse the token file if present, otherwise create it (dir 0700, file 0600). */
export async function ensureToken(dir = configDir()): Promise<string> {
  await ensureConfigDir(dir);
  const file = tokenPath(dir);
  const existing = await readToken(dir);
  if (existing) {
    const mode = (await stat(file)).mode & 0o777;
    if (mode & 0o077) {
      await chmod(file, 0o600);
    }
    return existing;
  }
  const token = randomBytes(32).toString("hex");
  try {
    await writeFile(file, `${token}\n`, { flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    // Another process created it between our read and write.
    const raced = await readToken(dir);
    if (!raced) {
      throw new Error(`Token file ${file} exists but is empty.`);
    }
    return raced;
  }
}

export async function readHubInfo(dir = configDir()): Promise<HubInfo | undefined> {
  try {
    const parsed = JSON.parse(await readFile(hubInfoPath(dir), "utf8")) as HubInfo;
    return typeof parsed.httpPort === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeHubInfo(info: HubInfo, dir = configDir()): Promise<void> {
  await ensureConfigDir(dir);
  const file = hubInfoPath(dir);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

/** Remove hub.json only if it still describes this process. */
export async function removeHubInfo(pid = process.pid, dir = configDir()): Promise<void> {
  const current = await readHubInfo(dir);
  if (current && current.pid === pid) {
    await rm(hubInfoPath(dir), { force: true });
  }
}
