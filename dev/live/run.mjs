// Live check loop: start the MCP server (stdio), hot-load the extension into
// EasyEDA Pro, wait for the bridge, then run a list of tool calls.
//   dev/live/node.sh node dev/live/run.mjs dev/live/calls/smoke.json [--no-inject] [--server dist/index.js]
// A calls file is a JSON array of [toolName, arguments?, previewChars?].
// Full results go to dev/live/.work/results/<n>-<tool>.json.
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Page, sleep } from "./cdp.mjs";
import { injectExtension } from "./inject.mjs";

const args = process.argv.slice(2);
const callsFile = args.find((arg) => arg.endsWith(".json"));
const serverEntry = args.includes("--server") ? args[args.indexOf("--server") + 1] : "dist/index.js";
const calls = callsFile ? JSON.parse(fs.readFileSync(callsFile, "utf8")) : [["easyeda_doctor"]];
const outDir = "dev/live/.work/results";
fs.mkdirSync(outDir, { recursive: true });

const client = new Client({ name: "easyeda-live-check", version: "0" });
// The SDK passes only a minimal environment by default; keep EASYEDA_MCP_* etc.
await client.connect(new StdioClientTransport({ command: "node", args: [serverEntry], stderr: "inherit", env: { ...process.env } }));

const started = Date.now();
if (!args.includes("--no-inject")) {
  const page = await Page.open();
  console.log("inject:", await injectExtension(page, { native: true }), `${Date.now() - started}ms`);
  page.close();
}

let status;
for (let waited = 0; waited < 30_000; waited += 250) {
  status = (await client.callTool({ name: "easyeda_live_status", arguments: {} })).structuredContent?.status;
  if (status?.connected) break;
  await sleep(250);
}
console.log("connected:", Boolean(status?.connected), `${Date.now() - started}ms`, "document:", status?.activeDocumentType);

// Pro reports some API misuse only through a modal dialog (and the call may never
// resolve), so flag any dialog a tool call leaves open.
const probe = await Page.open();
const openDialogs = () => probe.eval(`Array.from(document.querySelectorAll('[class*=modal_dialog_]'))
  .filter(e => e.offsetParent && /dialog_[A-Za-z0-9]+$/.test(String(e.className).split(' ')[0]))
  .map(e => e.innerText.replace(/\\s+/g, ' ').slice(0, 120))`);
const closeErrorDialogs = () => probe.eval(`Array.from(document.querySelectorAll('[class*=modal_dialog_]'))
  .filter(e => e.offsetParent && e.innerText.startsWith('Error'))
  .forEach(e => Array.from(e.querySelectorAll('button')).filter(b => b.textContent.trim() == 'Confirm').forEach(b => b.click())); 1`);
await closeErrorDialogs();
const before = new Set(await openDialogs());

let failures = 0;
for (const [index, [name, toolArgs = {}, preview = 400]] of calls.entries()) {
  const t0 = Date.now();
  let result;
  try {
    result = await client.callTool({ name, arguments: toolArgs }, undefined, { timeout: 120_000 });
  } catch (error) {
    failures += 1;
    console.log(`✗ ${name} threw: ${String(error).slice(0, 300)}`);
    continue;
  }
  const body = JSON.stringify(result.structuredContent ?? result.content);
  fs.writeFileSync(path.join(outDir, `${String(index).padStart(2, "0")}-${name}.json`), body);
  if (result.isError) failures += 1;
  console.log(`${result.isError ? "✗" : "✓"} ${name} ${JSON.stringify(toolArgs).slice(0, 100)} ${Date.now() - t0}ms ${body.length}B\n  ${body.slice(0, preview)}`);
  const leftOpen = (await openDialogs()).filter((text) => !before.has(text));
  if (leftOpen.length > 0) {
    failures += 1;
    console.log(`  ! dialog left open by ${name}: ${JSON.stringify(leftOpen)}`);
    await closeErrorDialogs();
  }
}
probe.close();
await client.close();
process.exit(failures ? 1 : 0);
