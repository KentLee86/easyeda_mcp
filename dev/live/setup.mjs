// One-time setup of the live EasyEDA Pro container: activate the client with the
// mounted activation file (kept in the easyeda-mcp-live-home volume afterwards).
//   dev/live/node.sh node dev/live/setup.mjs
import { Page, sleep } from "./cdp.mjs";

const ACTIVATION = "/run/secrets/easyeda-pro-activation";

const page = await Page.open();
const state = await page.waitFor(`document.querySelector('.upload-input') ? 'activation'
  : (window._EXTAPI_ROOT_ && document.querySelector('[class*=client_start_project]') ? 'ready' : '')`, 180_000);

if (state === "activation") {
  // The file is handed to the client's own file input; its content is never read here.
  const { root } = await page.call("DOM.getDocument", { depth: 0 });
  const { nodeId } = await page.call("DOM.querySelector", { nodeId: root.nodeId, selector: ".upload-input" });
  await page.call("DOM.setFileInputFiles", { nodeId, files: [ACTIVATION] });
  await page.eval("document.querySelector('.upload-input').dispatchEvent(new Event('change', { bubbles: true })); 1");
  await page.waitFor("(document.querySelector('.activateContent') || { value: '' }).value.length > 0", 30_000);
  await page.eval(`Array.from(document.querySelectorAll('a, button, span, div'))
    .find(e => e.children.length == 0 && e.textContent.trim() == 'Activate' && e.offsetParent).click(); 1`);
  await sleep(5000);
  page.close();
  const next = await Page.open();
  await next.waitFor("!!(window._EXTAPI_ROOT_ && document.querySelector('[class*=client_start_project]'))", 180_000);
  console.log("activated");
  next.close();
} else {
  console.log("already activated");
  page.close();
}
