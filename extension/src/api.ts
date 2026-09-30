// Generic access to the EasyEDA Pro extension API (`eda.*`) for code-driven work:
// call any allowed method with JSON arguments and get JSON back, plus composite
// PCB reads. Pro primitives keep most fields behind prototype getters, so results
// are flattened with toPlain().
declare const eda: Record<string, any>;

/** Namespaces reachable through apiCall; sys_* (files, network, storage) stays closed. */
const ALLOWED_PREFIXES = ["dmt_", "pcb_", "sch_", "lib_", "pnl_"];
const PATH_PATTERN = /^([a-z]+_[A-Za-z0-9]+)\.([A-Za-z_][A-Za-z0-9_]*)$/;

type CodedError = Error & { code: string; details?: unknown };

function codedError(code: string, message: string, details?: unknown): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  error.details = details;
  return error;
}

/** JSON-safe copy: own fields plus prototype getters, no functions, no cycles. */
export function toPlain(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "function" || typeof value === "symbol" ? undefined
      : typeof value === "number" && !Number.isFinite(value) ? null
      : typeof value === "bigint" ? String(value)
      : value;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return { blob: true, name: (value as File).name, size: value.size, type: value.type };
  }
  if (seen.has(value) || depth > 8) {
    return undefined;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => toPlain(item, depth + 1, seen));
  }
  if (value instanceof Map) {
    return Object.fromEntries(Array.from(value.entries()).map(([key, item]) => [String(key), toPlain(item, depth + 1, seen)]));
  }
  if (value instanceof Set) {
    return Array.from(value).map((item) => toPlain(item, depth + 1, seen));
  }
  const names = new Set(Object.keys(value));
  for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (descriptor.get) {
        names.add(name);
      }
    }
  }
  const out: Record<string, unknown> = {};
  for (const name of names) {
    let item: unknown;
    try {
      item = (value as Record<string, unknown>)[name];
    } catch {
      continue;
    }
    const plain = toPlain(item, depth + 1, seen);
    if (plain !== undefined) {
      out[name] = plain;
    }
  }
  return out;
}

function resolve(path: unknown): { namespace: string; method: string; target: any } {
  const match = typeof path === "string" ? PATH_PATTERN.exec(path) : null;
  if (!match) {
    throw codedError("invalid_path", `Expected "<namespace>.<method>", e.g. "pcb_PrimitiveComponent.getAll"; got ${JSON.stringify(path)}.`);
  }
  const [, namespace, method] = match;
  if (!ALLOWED_PREFIXES.some((prefix) => namespace.startsWith(prefix))) {
    throw codedError("api_forbidden", `eda.${namespace} is not reachable through apiCall (allowed: ${ALLOWED_PREFIXES.join(", ")}).`);
  }
  const target = eda[namespace];
  if (!target || typeof target[method] !== "function") {
    throw codedError("api_unavailable", `eda.${namespace}.${method} does not exist in this EasyEDA Pro.`);
  }
  return { namespace, method, target };
}

export async function apiCall(params: Record<string, any>): Promise<unknown> {
  const { method, target } = resolve(params.path);
  const args = Array.isArray(params.args) ? params.args : params.args === undefined ? [] : [params.args];
  return toPlain(await target[method](...args));
}

export async function apiBatch(params: Record<string, any>): Promise<Record<string, unknown>> {
  const calls = Array.isArray(params.calls) ? params.calls : [];
  const stopOnError = params.stopOnError !== false;
  const results: unknown[] = [];
  for (const call of calls) {
    try {
      results.push({ ok: true, value: await apiCall(call ?? {}) });
    } catch (error) {
      const coded = error as Partial<CodedError>;
      results.push({ ok: false, error: { code: coded.code ?? "easyeda_api_error", message: coded.message ?? String(error) } });
      if (stopOnError) {
        break;
      }
    }
  }
  return { results };
}

export function apiDescribe(params: Record<string, any>): Record<string, unknown> {
  const namespaces: Record<string, string[]> = {};
  for (const namespace of Object.keys(eda).sort()) {
    if (!ALLOWED_PREFIXES.some((prefix) => namespace.startsWith(prefix))) continue;
    if (params.namespace && namespace !== params.namespace) continue;
    const proto = eda[namespace] && Object.getPrototypeOf(eda[namespace]);
    if (!proto) continue;
    namespaces[namespace] = Object.getOwnPropertyNames(proto).filter((name) => name !== "constructor" && typeof proto[name] === "function");
  }
  return { namespaces, allowedPrefixes: ALLOWED_PREFIXES };
}

const PCB_PARTS: Record<string, () => Promise<unknown>> = {
  components: () => eda.pcb_PrimitiveComponent.getAll(),
  pads: () => eda.pcb_PrimitivePad.getAll(),
  tracks: () => eda.pcb_PrimitiveLine.getAll(),
  arcs: () => eda.pcb_PrimitiveArc.getAll(),
  vias: () => eda.pcb_PrimitiveVia.getAll(),
  pours: () => eda.pcb_PrimitivePour.getAll(),
  fills: () => eda.pcb_PrimitiveFill.getAll(),
  regions: () => eda.pcb_PrimitiveRegion.getAll(),
  strings: () => eda.pcb_PrimitiveString.getAll(),
  nets: () => eda.pcb_Net.getAllNets(),
  layers: () => eda.pcb_Layer.getAllLayers(),
  outline: () => eda.pcb_Primitive.getPrimitiveBoardLine()
};

/** PCB APIs on a non-PCB tab open an error dialog and never resolve; refuse early. */
async function requirePcb(): Promise<Record<string, unknown>> {
  const info = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (!info || ![3, 12, 15].includes(info.documentType)) {
    throw codedError("unsupported_document", "Open the board's PCB in EasyEDA Pro first (the active document is not a PCB).", toPlain(info));
  }
  return info;
}

export async function pcbSnapshot(params: Record<string, any>): Promise<Record<string, unknown>> {
  const info = await requirePcb();
  const include: string[] = Array.isArray(params.include) && params.include.length > 0 ? params.include : Object.keys(PCB_PARTS);
  const snapshot: Record<string, unknown> = { document: toPlain(info), units: "mil" };
  const counts: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const part of include) {
    const read = PCB_PARTS[part];
    if (!read) {
      errors[part] = "unknown part";
      continue;
    }
    try {
      const value = toPlain(await read());
      snapshot[part] = value;
      if (Array.isArray(value)) counts[part] = value.length;
    } catch (error) {
      errors[part] = error instanceof Error ? error.message : String(error);
    }
  }
  return { ...snapshot, counts, ...(Object.keys(errors).length > 0 ? { errors } : {}) };
}

function countDrcErrors(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((sum: number, item) => sum + countDrcErrors(item), 0);
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.list)) return countDrcErrors(record.list);
    return record.errorType ? 1 : 0;
  }
  return 0;
}

export async function pcbDrc(params: Record<string, any>): Promise<Record<string, unknown>> {
  await requirePcb();
  // Without includeVerboseError Pro returns only a pass/fail boolean, so always ask
  // for the error tree and count it here.
  const raw = toPlain(await eda.pcb_Drc.check(params.strict !== false, false, true));
  if (typeof raw === "boolean") {
    return { ok: raw, errorCount: raw ? 0 : undefined, categories: [] };
  }
  const categories = Array.isArray(raw) ? raw.map((category: any) => ({ name: category?.name, count: countDrcErrors(category) })) : [];
  const errorCount = countDrcErrors(raw);
  return { ok: errorCount === 0, errorCount, categories, ...(params.verbose === false ? {} : { raw }) };
}

/**
 * PNG of what the editor canvas currently shows (~80 ms). Optionally zoom to a
 * region first ({left, right, top, bottom} in document units) or to primitives.
 */
/**
 * Fit a document-coordinate region into the view. zoomToRegion/navigateToRegion
 * do not change the zoom on PCB tabs, but zoomTo(center, scale) does and returns
 * the visible area in canvas units (PCB canvas = document mil / 10), so probe at
 * scale 1 and derive the scale that fits.
 */
async function fitView(region: { left: number; right: number; top: number; bottom: number }): Promise<void> {
  const cx = (region.left + region.right) / 2;
  const cy = (region.top + region.bottom) / 2;
  const probe = await eda.dmt_EditorControl.zoomTo(cx, cy, 1) as { left: number; right: number; top: number; bottom: number } | undefined;
  if (!probe || typeof probe.left !== "number") {
    return;
  }
  const canvasCx = (probe.left + probe.right) / 2;
  const unit = Math.abs(cx) > 1e-6 && Math.abs(canvasCx) > 1e-6 ? canvasCx / cx : 1;
  const width = Math.abs(region.right - region.left) * Math.abs(unit) || 1;
  const height = Math.abs(region.bottom - region.top) * Math.abs(unit) || 1;
  const scale = Math.min(Math.abs(probe.right - probe.left) / width, Math.abs(probe.bottom - probe.top) / height);
  await eda.dmt_EditorControl.zoomTo(cx, cy, scale);
}

export async function renderImage(params: Record<string, any>): Promise<Record<string, unknown>> {
  const info = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  const isPcb = [3, 12, 15].includes(info?.documentType);
  let region = params.region;
  if (!region && Array.isArray(params.primitiveIds) && params.primitiveIds.length > 0) {
    const box = toPlain(await (isPcb ? eda.pcb_Primitive : eda.sch_Primitive).getPrimitivesBBox(params.primitiveIds)) as Record<string, number> | undefined;
    if (box && typeof box.minX === "number") {
      const margin = Number(params.margin ?? 0.5);
      const dx = (box.maxX - box.minX) * margin + 1;
      const dy = (box.maxY - box.minY) * margin + 1;
      region = { left: box.minX - dx, right: box.maxX + dx, top: box.minY - dy, bottom: box.maxY + dy };
    }
  }
  if (region && ["left", "right", "top", "bottom"].every((key) => typeof region[key] === "number")) {
    await fitView(region);
    // getCurrentRenderedAreaImage renders the new view itself: images taken 0 ms
    // and 300 ms after zoomTo were byte-identical, so no settle wait by default.
    const settleMs = Number(params.settleMs ?? 0);
    if (settleMs > 0) {
      await new Promise((done) => setTimeout(done, settleMs));
    }
  }
  const image = await eda.dmt_EditorControl.getCurrentRenderedAreaImage();
  if (!image || typeof image.arrayBuffer !== "function") {
    throw codedError("render_failed", "EasyEDA Pro did not return an image.");
  }
  const encoded = await blobToBase64(image);
  return { mimeType: image.type || "image/png", size: encoded.size, base64: encoded.base64, ...(region ? { region } : {}) };
}

async function blobToBase64(blob: Blob): Promise<{ size: number; base64: string }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return { size: bytes.length, base64: btoa(binary) };
}

const DOCUMENT_KIND: Record<string, "pcb" | "schematic"> = { pcb_: "pcb", sch_: "schematic" };
const PCB_TYPES = [3, 12, 15];
const SCHEMATIC_TYPES = [1, 8, 9];

function documentKind(info: any): "pcb" | "schematic" | "other" {
  return PCB_TYPES.includes(info?.documentType) ? "pcb" : SCHEMATIC_TYPES.includes(info?.documentType) ? "schematic" : "other";
}

/**
 * Any *_ManufactureData.get* export as file contents. The document must match the
 * namespace: calling a PCB export on a schematic tab opens an error dialog and the
 * promise never settles.
 */
export async function exportFile(params: Record<string, any>): Promise<Record<string, unknown>> {
  const { namespace, method, target } = resolve(params.path);
  if (!/_ManufactureData$/.test(namespace) || !method.startsWith("get")) {
    throw codedError("api_forbidden", "exportFile only calls *_ManufactureData.get* methods.");
  }
  const wanted = DOCUMENT_KIND[namespace.slice(0, 4)];
  if (wanted) {
    const kind = documentKind(await eda.dmt_SelectControl.getCurrentDocumentInfo());
    if (kind !== wanted) {
      throw codedError("unsupported_document", `${namespace}.${method} needs the ${wanted} open (active: ${kind}); call useDocument first.`);
    }
  }
  const args = Array.isArray(params.args) ? params.args : [];
  const value = await target[method](...args);
  const blob: Blob | undefined = value instanceof Blob ? value : value?.file instanceof Blob ? value.file : undefined;
  if (!blob) {
    throw codedError("export_empty", `EasyEDA Pro returned no file from ${namespace}.${method}.`, toPlain(value));
  }
  const encoded = await blobToBase64(blob);
  return { fileName: params.fileName ?? (blob as File).name ?? method, mimeType: blob.type || undefined, size: encoded.size, base64: encoded.base64 };
}

/** Open the active board's PCB or a schematic page (or a document by uuid). */
export async function useDocument(params: Record<string, any>): Promise<Record<string, unknown>> {
  const before = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  const previous = before?.uuid ? { uuid: before.uuid, documentType: before.documentType } : null;
  let uuid: string | undefined = typeof params.uuid === "string" ? params.uuid : undefined;
  let name: string | undefined;
  if (!uuid) {
    const project = await eda.dmt_Project.getCurrentProjectInfo();
    const boards: any[] = Array.isArray(project?.data) ? project.data : [];
    const board = boards.find((item) => item?.pcb?.uuid === before?.uuid
      || (item?.schematic?.page ?? []).some((page: any) => page?.uuid === before?.uuid)) ?? boards[0];
    if (!board) {
      throw codedError("no_project", "No project is open in EasyEDA Pro.");
    }
    if (params.kind === "pcb") {
      if (!board.pcb?.uuid) throw codedError("no_pcb", `Board ${board.name ?? ""} has no PCB.`);
      uuid = board.pcb.uuid;
      name = board.pcb.name;
    } else {
      const pages: any[] = board.schematic?.page ?? [];
      const page = params.page ? pages.find((item) => item.uuid === params.page || item.name === params.page) : pages[0];
      if (!page) throw codedError("no_schematic", `Schematic page ${params.page ?? ""} not found.`);
      uuid = page.uuid;
      name = page.name;
    }
  }
  if (before?.uuid !== uuid) {
    await eda.dmt_EditorControl.openDocument(uuid);
  }
  const after = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  return { previous, current: { uuid: after?.uuid, documentType: after?.documentType, ...(name ? { name } : {}) } };
}
