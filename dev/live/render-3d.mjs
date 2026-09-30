// Render the board's 3D preview from several viewpoints to PNG files.
// EasyEDA Pro has no API for the 3D preview, so this opens it and switches views
// through the UI (CDP clicks by tooltip) and takes each frame with
// dmt_EditorControl.getCurrentRenderedAreaImage (canvas only, no UI chrome).
//   dev/live/node.sh node dev/live/render-3d.mjs dev/live/.work/3d
// Combine into a PDF on the host, e.g. with Pillow (see docs/live-dev.md).
import fs from "node:fs";
import { Page, sleep } from "./cdp.mjs";

const outDir = process.argv[2] ?? "dev/live/.work/3d";
const VIEWS = [
  ["iso", null],
  ["top", "Top Side"],
  ["bottom", "Bottom Side"],
  ["front", "Front Side"],
  ["left", "Left Side"]
];

const page = await Page.open();
const clickTitle = async (title) => {
  const point = await page.waitFor(`(() => { const e = Array.from(document.querySelectorAll("[title]")).find(x => x.offsetParent && x.getAttribute("title") === ${JSON.stringify(title)});
    if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`, 20_000);
  await page.click(point[0], point[1]);
};
const frame = () => page.api(`const i = await eda.dmt_EditorControl.getCurrentRenderedAreaImage();
  const b = new Uint8Array(await i.arrayBuffer()); let s = ""; for (let k = 0; k < b.length; k += 32768) s += String.fromCharCode(...b.subarray(k, k + 32768)); return btoa(s);`);
// The 3D view renders progressively; take the frame once two in a row match.
const stableFrame = async () => {
  let last = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await frame();
    if (current === last) return current;
    last = current;
    await sleep(250);
  }
  return last;
};

const info = await page.api("return await eda.dmt_SelectControl.getCurrentDocumentInfo();");
if (info?.documentType !== 15) {
  const project = await page.api("return await eda.dmt_Project.getCurrentProjectInfo();");
  const pcb = project?.data?.find((board) => board.pcb)?.pcb?.uuid;
  if (!pcb) throw new Error("open a project with a PCB first");
  await page.api(`await eda.dmt_EditorControl.openDocument(${JSON.stringify(pcb)});`);
  await clickTitle("3D Preview");
  await page.waitFor("(async () => (await window._EXTAPI_ROOT_.dmt_SelectControl.getCurrentDocumentInfo()).documentType === 15)()", 60_000);
}

fs.mkdirSync(outDir, { recursive: true });
for (const [name, title] of VIEWS) {
  if (title) {
    await clickTitle(title);
    await sleep(300);
  }
  const started = Date.now();
  const png = Buffer.from(await stableFrame(), "base64");
  fs.writeFileSync(`${outDir}/${name}.png`, png);
  console.log(`${name}.png ${png.length} B ${Date.now() - started} ms`);
}
page.close();
