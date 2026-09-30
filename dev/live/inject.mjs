// Hot-load the bridge extension into a running EasyEDA Pro without an .eext install.
// Bundles extension/src with the same esbuild settings as `npm run build:extension`,
// then evaluates it in the editor page with `eda` bound to the Pro API root.
// Re-running replaces the previous instance (its `deactivate()` closes the socket).
//   dev/live/node.sh node dev/live/inject.mjs
import * as esbuild from "esbuild";
import { Page } from "./cdp.mjs";

export async function bundleExtension() {
  const result = await esbuild.build({
    entryPoints: ["extension/src/index.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "edaEsbuildExportName",
    write: false,
    logLevel: "silent"
  });
  return result.outputFiles[0].text;
}

/**
 * `native` swaps eda.sys_WebSocket for the page's WebSocket. Pro only grants
 * sys_WebSocket to installed extensions with external interaction enabled, so
 * hot-loaded code uses the native socket; everything else is the real `eda`.
 */
export function injectionSource(bundle, { native = true, config = {} } = {}) {
  return `(() => {
  const previous = globalThis.__EASYEDA_MCP_DEV__;
  if (previous && typeof previous.deactivate === "function") {
    try { previous.deactivate(); } catch (error) { console.warn("previous deactivate failed", error); }
  }
  globalThis.__EASYEDA_MCP_BRIDGE_CONFIG__ = ${JSON.stringify({ stateKey: "Dev", ...config })};
  const root = window._EXTAPI_ROOT_;
  const sockets = new Map();
  const nativeSocket = {
    register(id, uri, onMessage, onOpen, onClose) {
      const old = sockets.get(id);
      if (old) old.close();
      const ws = new WebSocket(uri);
      sockets.set(id, ws);
      ws.onmessage = (event) => onMessage && onMessage(event);
      ws.onopen = () => onOpen && onOpen();
      ws.onclose = () => { if (sockets.get(id) === ws) sockets.delete(id); onClose && onClose(); };
    },
    send(id, data) {
      const ws = sockets.get(id);
      if (!ws || ws.readyState !== 1) throw new Error("WebSocket " + id + " is not open");
      ws.send(data);
    },
    close(id) {
      const ws = sockets.get(id);
      sockets.delete(id);
      if (ws) ws.close();
    }
  };
  const eda = ${native ? `new Proxy(root, { get: (target, key) => key === "sys_WebSocket" ? nativeSocket : target[key] })` : "root"};
${bundle}
  globalThis.__EASYEDA_MCP_DEV__ = edaEsbuildExportName;
  edaEsbuildExportName.activate("onStartupFinished", "dev-inject");
  return "injected";
})()`;
}

export async function injectExtension(page, options) {
  const bundle = await bundleExtension();
  return page.eval(injectionSource(bundle, options));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const page = await Page.open();
  const started = Date.now();
  console.log(await injectExtension(page, { native: !process.argv.includes("--sys-websocket") }), `${Date.now() - started}ms`);
  page.close();
}
