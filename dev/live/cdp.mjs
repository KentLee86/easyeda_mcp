// Minimal Chrome DevTools Protocol client for the EasyEDA Pro editor page.
// Runs inside the Node sidecar (dev/live/node.sh), where CDP is 127.0.0.1:9222.
import fs from "node:fs";
import WebSocket from "ws";

export const CDP_URL = process.env.EASYEDA_CDP_URL ?? "http://127.0.0.1:9222";

export async function targets() {
  const response = await fetch(`${CDP_URL}/json/list`);
  return response.json();
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function connect(url) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return ws;
}

export class Page {
  static async open(timeoutMs = 120_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        const page = (await targets()).find((t) => t.type === "page" && t.url.includes("client/editor"));
        if (page) {
          return new Page(await connect(page.webSocketDebuggerUrl), page);
        }
      } catch {
        // Pro is still starting.
      }
      if (Date.now() > end) throw new Error("EasyEDA Pro editor page not reachable over CDP");
      await sleep(1000);
    }
  }

  constructor(ws, target) {
    this.ws = ws;
    this.target = target;
    this.nextId = 0;
    this.pending = new Map();
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      const entry = message.id !== undefined && this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method}: ${JSON.stringify(message.error)}`));
      else entry.resolve(message.result);
    });
  }

  call(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  async eval(expression) {
    const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails);
      throw new Error(detail.slice(0, 2000));
    }
    return result.result.value;
  }

  /** Run `body` as an async function with `eda` bound to the Pro extension API root. */
  api(body) {
    return this.eval(`(async () => { const eda = window._EXTAPI_ROOT_; ${body} })()`);
  }

  async waitFor(expression, timeoutMs = 60_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        const value = await this.eval(expression);
        if (value) return value;
      } catch {
        // keep polling
      }
      if (Date.now() > end) throw new Error(`timed out: ${expression}`);
      await sleep(500);
    }
  }

  async click(x, y) {
    await this.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.call("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
  }

  /** Trusted click on the last visible element whose own text equals `text`. */
  async clickText(text, timeoutMs = 15_000) {
    const point = await this.waitFor(`(t => { const els = Array.from(document.querySelectorAll('*')).filter(e => e.offsetParent !== null
      && Array.from(e.childNodes).some(n => n.nodeType == 3 && n.textContent.trim() == t));
      const e = els[els.length - 1]; if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })(${JSON.stringify(text)})`, timeoutMs);
    await this.click(point[0], point[1]);
  }

  async screenshot(path) {
    const { data } = await this.call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path, Buffer.from(data, "base64"));
  }

  close() {
    this.ws.close();
  }
}
