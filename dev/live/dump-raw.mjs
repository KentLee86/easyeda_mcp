// Dump RawSchematicData (pages[]) from the live Pro for offline analysis tests.
// Pro primitives expose most fields as prototype getters, so they are flattened.
//   dev/live/node.sh node dev/live/dump-raw.mjs > dev/live/.work/raw.json
import { Page } from "./cdp.mjs";

const page = await Page.open();
const raw = await page.api(`
const plain = (value, depth = 0) => {
  if (value === null || typeof value !== "object") return value;
  if (depth > 5) return undefined;
  if (Array.isArray(value)) return value.map((item) => plain(item, depth + 1));
  const out = {};
  const names = new Set(Object.keys(value));
  for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) if (descriptor.get) names.add(name);
  }
  for (const name of names) {
    let item;
    try { item = value[name]; } catch { continue; }
    if (typeof item !== "function") out[name] = plain(item, depth + 1);
  }
  return out;
};
const original = (await eda.dmt_SelectControl.getCurrentDocumentInfo()).uuid;
const project = await eda.dmt_Project.getCurrentProjectInfo();
const board = project.data.find((b) => b.schematic.page.some((p) => p.uuid === original) || (b.pcb && b.pcb.uuid === original)) || project.data[0];
const pages = [];
for (const info of board.schematic.page) {
  await eda.dmt_EditorControl.openDocument(info.uuid);
  const components = await eda.sch_PrimitiveComponent.getAll(undefined, false);
  const pinsByComponent = {};
  for (const component of components) {
    try { pinsByComponent[component.primitiveId] = plain(await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(component.primitiveId)); } catch {}
  }
  pages.push({ uuid: info.uuid, name: info.name, components: plain(components), pinsByComponent,
    wires: plain(await eda.sch_PrimitiveWire.getAll()), texts: plain(await eda.sch_PrimitiveText.getAll()) });
}
await eda.dmt_EditorControl.openDocument(original);
return { pages, includeRaw: false };`);
console.log(JSON.stringify(raw));
page.close();
