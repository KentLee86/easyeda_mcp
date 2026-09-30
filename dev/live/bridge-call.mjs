// Call extension bridge methods directly (no MCP layer): start a bridge, hot-load
// the extension, run [[method, params], ...] and print timings.
//   npm run build && dev/live/node.sh node dev/live/bridge-call.mjs '[["pcbDrc",{}]]'
//   dev/live/node.sh node dev/live/bridge-call.mjs calls.json --out dev/live/.work/results
import fs from "node:fs";
import { EasyEdaBridge } from "../../dist/bridge/EasyEdaBridge.js";
import { Page, sleep } from "./cdp.mjs";
import { injectExtension } from "./inject.mjs";

const input = process.argv[2] ?? "[]";
const calls = JSON.parse(input.trim().startsWith("[") ? input : fs.readFileSync(input, "utf8"));
const outDir = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : undefined;
const logger = { error: () => undefined, warn: () => undefined, info: () => undefined };

const bridge = new EasyEdaBridge({ logger });
await bridge.start();
const page = await Page.open();
await injectExtension(page, { native: true });
page.close();
for (let waited = 0; !bridge.getStatus().connected || bridge.getStatus().connectionState !== "connected"; waited += 50) {
  if (waited > 10_000) throw new Error("extension did not connect");
  await sleep(50);
}

let failed = 0;
for (const [index, [method, params = {}, preview = 300]] of calls.entries()) {
  const started = Date.now();
  try {
    const result = await bridge.call(method, params, 120_000);
    const body = JSON.stringify(result);
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(`${outDir}/${String(index).padStart(2, "0")}-${method}.json`, body);
    }
    console.log(`✓ ${method} ${Date.now() - started}ms ${body.length}B\n  ${body.slice(0, preview)}`);
  } catch (error) {
    failed += 1;
    console.log(`✗ ${method} ${Date.now() - started}ms ${String(error?.message ?? error).slice(0, 300)}`);
  }
}
await bridge.stop();
process.exit(failed ? 1 : 0);
