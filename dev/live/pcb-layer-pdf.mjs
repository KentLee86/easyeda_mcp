// Export a PCB PDF with one page per layer, nothing mirrored, via EasyEDA Pro's
// Export PDF dialog. pcb_ManufactureData.getPdfFile() ignores its arguments and
// prints whatever that dialog is set to; the default (a fresh profile) packs
// several layers and BOM tables onto pages as wide as the whole canvas, and
// mirrors bottom layers. There is no API for the dialog, so it is driven over CDP.
//   dev/live/node.sh node dev/live/pcb-layer-pdf.mjs dev/live/.work/board-layers.pdf
import fs from "node:fs";
import { Page, sleep } from "./cdp.mjs";

const out = process.argv[2] ?? "dev/live/.work/pcb-layers.pdf";
const COMMON_LAYERS = ["Background", "Board Outline", "Multi", "Hole"];
const PAGES = [
  ["Top Copper", "Top"], ["Bottom Copper", "Bottom"],
  ["Top Silkscreen", "Top Silkscreen"], ["Bottom Silkscreen", "Bottom Silkscreen"],
  ["Top Solder Mask", "Top Solder Mask"], ["Bottom Solder Mask", "Bottom Solder Mask"],
  ["Top Paste Mask", "Top Paste Mask"], ["Bottom Paste Mask", "Bottom Paste Mask"],
  ["Top Assembly", "Top Assembly"], ["Bottom Assembly", "Bottom Assembly"],
  ["Board Outline", "Board Outline"], ["Multi Layer", "Multi"],
  ["Document", "Document"], ["Mechanical", "Mechanical"],
  ["Hole", "Hole"], ["Drill Drawing", "Drill Drawing"]
];
const BUILTIN_PAGES = ["Top Auto Designator Placement", "Bottom Auto Designator Placement", "BOM",
  "Top Assembly Drawings", "Bottom Assembly Drawings", "Drill Drawing"];

const page = await Page.open();
const MAIN = "Array.from(document.querySelectorAll('[class*=modal_dialog_]')).find(e => e.offsetParent && e.innerText.startsWith('Export PDF') && e.innerText.includes('Graph Page Config'))";

/** Trusted click on the element an expression returns (waits for it). */
async function clickJs(expression, timeoutMs = 15_000) {
  const point = await page.waitFor(`(() => { const e = (${expression}); if (!e) return null; e.scrollIntoView?.({ block: "center" });
    const r = e.getBoundingClientRect(); if (!r.width) return null; return [r.x + r.width / 2, r.y + r.height / 2]; })()`, timeoutMs);
  await page.click(point[0], point[1]);
}

async function openDialog() {
  const project = await page.api("return await eda.dmt_Project.getCurrentProjectInfo();");
  const pcb = project?.data?.find((board) => board.pcb)?.pcb;
  if (!pcb) throw new Error("open a project with a PCB first");
  await page.api(`await eda.dmt_EditorControl.openDocument(${JSON.stringify(pcb.uuid)});`);
  await clickJs("Array.from(document.querySelectorAll('span[title=Export]')).find(e => e.offsetParent && getComputedStyle(e).visibility === 'visible')");
  await sleep(300);
  await clickJs("Array.from(document.querySelectorAll('*')).find(e => e.offsetParent && getComputedStyle(e).visibility === 'visible' && e.children.length === 0 && /^PDF\\(G\\)/.test(e.textContent.trim()))");
  await page.waitFor(`!!(${MAIN})`, 30_000);
  return pcb;
}

async function mainOptions() {
  if (!(await page.eval(`(${MAIN}).querySelector('input[type=radio][value=paged]').checked`))) {
    await clickJs(`(${MAIN}).querySelector('input[type=radio][value=paged]')`);
  }
  for (const label of ["Display attributes as menu", "Show outline only"]) {
    const box = `Array.from((${MAIN}).querySelectorAll('label')).find(e => e.innerText.includes(${JSON.stringify(label)}))?.querySelector('input[type=checkbox]')`;
    if (await page.eval(`!!(${box}) && (${box}).checked`)) await clickJs(box);
  }
}

const rowByName = (name) => `Array.from((${MAIN}).querySelectorAll('tr')).find(row => row.querySelector('td[data-col-key=name]')?.textContent.trim() === ${JSON.stringify(name)})`;

async function deleteCustomPages() {
  for (;;) {
    const custom = await page.eval(`Array.from((${MAIN}).querySelectorAll('tr')).map(row => row.querySelector('td[data-col-key=name]')?.textContent.trim()).filter(name => name && !${JSON.stringify(BUILTIN_PAGES)}.includes(name))`);
    if (!custom.length) return;
    await clickJs(rowByName(custom[0]));
    await clickJs(`(${MAIN}).querySelector('[title=Delete]')`);
    await sleep(300);
  }
}

async function configurePage(layer) {
  const wanted = [...new Set([...COMMON_LAYERS, layer])];
  const state = await page.eval(`(() => {
    const dialogs = Array.from(document.querySelectorAll('[class*=modal_dialog_]')).filter(e => e.offsetParent && e.innerText.includes('Page Config') && e.innerText.includes('Export Layer'));
    const dialog = dialogs[dialogs.length - 1];
    const tables = Array.from(dialog.querySelectorAll('table'));
    const header = (title) => tables.find(t => Array.from(t.querySelectorAll('th')).some(th => th.innerText.includes(title)));
    const body = (h) => h.parentElement.parentElement.querySelector('[class*=lc-table-body] table');
    const layerBody = body(header('Export Layer'));
    const objectHeader = header('Export Object');
    const objectBody = body(objectHeader);
    const wanted = new Set(${JSON.stringify(wanted)});
    for (const row of layerBody.querySelectorAll('tr')) {
      const name = row.querySelector('td[data-col-key=layerId] span[title]')?.title;
      const box = row.querySelector('td[data-col-key=layerId] input[type=checkbox]');
      if (box && box.checked !== wanted.has(name)) box.click();
      const mirror = row.querySelector('td[data-col-key=isMirror] input[type=checkbox]');
      if (mirror && mirror.checked) mirror.click();
    }
    const all = objectHeader.querySelector('input[type=checkbox]');
    if (!all.checked) all.click();
    for (const row of Array.from(objectBody.querySelectorAll('tr')).slice(0, 2)) {
      const mark = row.querySelector('input[type=checkbox]');
      if (mark && mark.checked) mark.click();   // NC / X marks for parts without BOM
    }
    return Array.from(layerBody.querySelectorAll('tr')).map(row => ({
      name: row.querySelector('td[data-col-key=layerId] span[title]')?.title,
      on: row.querySelector('td[data-col-key=layerId] input[type=checkbox]')?.checked,
      mirror: row.querySelector('td[data-col-key=isMirror] input[type=checkbox]')?.checked
    })).filter(r => r.on);
  })()`);
  const got = state.map((row) => row.name).sort();
  if (JSON.stringify(got) !== JSON.stringify([...wanted].sort()) || state.some((row) => row.mirror)) {
    throw new Error(`layer config mismatch for ${layer}: ${JSON.stringify(state)}`);
  }
  await clickJs("Array.from(document.querySelectorAll('button[title=Confirm]')).filter(e => e.offsetParent).slice(-1)[0]");
  await sleep(300);
}

async function addPages() {
  // New pages are inserted at the top: add them in reverse order.
  for (const [, layer] of [...PAGES].reverse()) {
    await clickJs(`(${MAIN}).querySelector('[title=Add]')`);
    await sleep(200);
    await clickJs(`Array.from((${MAIN}).querySelectorAll('tr')).find(row => row.className.includes('selected')).querySelector('[title=Edit]')`);
    await sleep(300);
    await configurePage(layer);
  }
}

async function disableBuiltins() {
  for (const name of BUILTIN_PAGES) {
    const box = `(${rowByName(name)})?.querySelector('input[type=checkbox]')`;
    if (await page.eval(`!!(${box}) && (${box}).checked`)) {
      await clickJs(box);
      await sleep(200);
    }
  }
  const selected = await page.eval(`Array.from((${MAIN}).querySelectorAll('tr')).filter(row => row.querySelector('td[data-col-key=name]') && row.querySelector('input[type=checkbox]')?.checked).map(row => row.querySelector('td[data-col-key=name]').textContent.trim())`);
  if (selected.length !== PAGES.length) throw new Error(`unexpected selected pages: ${JSON.stringify(selected)}`);
}

const started = Date.now();
const pcb = await openDialog();
await mainOptions();
await deleteCustomPages();
await addPages();
await disableBuiltins();
const base64 = await page.api(`const f = await eda.pcb_ManufactureData.getPdfFile(${JSON.stringify(pcb.name ?? "pcb")});
  const b = new Uint8Array(await f.arrayBuffer()); let s = ""; for (let k = 0; k < b.length; k += 32768) s += String.fromCharCode(...b.subarray(k, k + 32768)); return btoa(s);`);
await clickJs(`Array.from((${MAIN}).querySelectorAll('button')).find(b => b.title === 'Cancel')`);
const pdf = Buffer.from(base64, "base64");
if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("EasyEDA did not return a PDF");
fs.writeFileSync(out, pdf);
console.log(`${out} ${pdf.length} B, pages: ${PAGES.map(([name]) => name).join(" | ")} (${Date.now() - started} ms)`);
page.close();
