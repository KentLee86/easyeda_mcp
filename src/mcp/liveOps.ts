// Operations shared by the MCP tools and the `easyeda` CLI: API-call
// classification, the mutation gate, moving a PCB component by designator,
// and resolving what to render.
import { BridgeRpcError } from "../bridge/errors.js";
import type { BridgeClient } from "../bridge/types.js";

/** Method names treated as read-only by easyeda_api_call. Everything else is mutating. */
const READ_ONLY_PREFIX = /^(get|is|has|check|calculate|convert|discretize|describe)(?=$|[A-Z_0-9])/;

/** Method part of an API path, e.g. "getAll" for "pcb_PrimitiveComponent.getAll". */
export function apiMethodName(apiPath: string): string {
  const dot = apiPath.lastIndexOf(".");
  return dot === -1 ? apiPath : apiPath.slice(dot + 1);
}

export function isReadOnlyApiPath(apiPath: string): boolean {
  return READ_ONLY_PREFIX.test(apiMethodName(apiPath));
}

/** `EASYEDA_MCP_ALLOW_MUTATIONS=1` lets MCP clients mutate without the confirmation phrase. */
export function mutationsAllowedByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EASYEDA_MCP_ALLOW_MUTATIONS === "1";
}

export type MoveRequest = {
  designator: string;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  rotation?: number;
  /** "top" (1), "bottom" (2), or an EasyEDA layer id. */
  layer?: string | number;
};

export type PcbComponentSummary = {
  primitiveId: string;
  designator?: string;
  x?: number;
  y?: number;
  rotation?: number;
  layer?: number | string;
  locked?: boolean;
  [key: string]: unknown;
};

export function parseLayer(layer: string | number): number {
  if (typeof layer === "number" && Number.isInteger(layer)) {
    return layer;
  }
  const text = String(layer).trim().toLowerCase();
  if (text === "top") return 1;
  if (text === "bottom") return 2;
  if (/^\d+$/.test(text)) return Number(text);
  throw new BridgeRpcError(`Invalid layer "${layer}". Use top, bottom, or a numeric layer id.`, "invalid_argument");
}

export function componentsOf(snapshot: unknown): PcbComponentSummary[] {
  const components = (snapshot as { components?: unknown } | undefined)?.components;
  return Array.isArray(components) ? components as PcbComponentSummary[] : [];
}

/** Exact designator match (case-insensitive). Errors when missing or ambiguous. */
export function findComponentByDesignator<T extends { designator?: unknown; primitiveId?: unknown }>(components: T[], designator: string): T {
  const wanted = designator.trim().toUpperCase();
  const matches = components.filter((component) => typeof component.designator === "string" && component.designator.toUpperCase() === wanted);
  if (matches.length === 0) {
    const known = components.map((component) => component.designator).filter(Boolean).slice(0, 20).join(", ");
    throw new BridgeRpcError(`No component with designator "${designator}" in the active document.${known ? ` Known: ${known}${components.length > 20 ? ", ..." : ""}` : ""}`, "component_not_found");
  }
  if (matches.length > 1) {
    throw new BridgeRpcError(`Designator "${designator}" matches ${matches.length} components (${matches.map((component) => component.primitiveId).join(", ")}); use easyeda_api_call with a primitiveId.`, "component_ambiguous");
  }
  if (typeof matches[0]!.primitiveId !== "string") {
    throw new BridgeRpcError(`Component "${designator}" has no primitiveId in the snapshot.`, "component_not_found");
  }
  return matches[0]!;
}

/** Property object for pcb_PrimitiveComponent.modify(primitiveId, props). */
export function buildMoveProperties(component: PcbComponentSummary, request: MoveRequest): Record<string, number> {
  if (request.x !== undefined && request.dx !== undefined) {
    throw new BridgeRpcError("Use either x or dx, not both.", "invalid_argument");
  }
  if (request.y !== undefined && request.dy !== undefined) {
    throw new BridgeRpcError("Use either y or dy, not both.", "invalid_argument");
  }
  const props: Record<string, number> = {};
  const relative = (axis: "x" | "y", delta: number) => {
    const current = component[axis];
    if (typeof current !== "number") {
      throw new BridgeRpcError(`Cannot apply d${axis}: current ${axis} of ${component.designator ?? component.primitiveId} is unknown.`, "invalid_argument");
    }
    return current + delta;
  };
  if (request.x !== undefined) props.x = request.x;
  if (request.dx !== undefined) props.x = relative("x", request.dx);
  if (request.y !== undefined) props.y = request.y;
  if (request.dy !== undefined) props.y = relative("y", request.dy);
  if (request.rotation !== undefined) props.rotation = request.rotation;
  if (request.layer !== undefined) props.layer = parseLayer(request.layer);
  for (const [key, value] of Object.entries(props)) {
    if (!Number.isFinite(value)) {
      throw new BridgeRpcError(`${key} must be a finite number.`, "invalid_argument");
    }
  }
  if (Object.keys(props).length === 0) {
    throw new BridgeRpcError("Nothing to change: give x, y, dx, dy, rotation, or layer.", "invalid_argument");
  }
  return props;
}

const PLACEMENT_FIELDS = ["primitiveId", "designator", "x", "y", "rotation", "layer", "locked"] as const;

export function placementOf(value: unknown): Record<string, unknown> {
  const item = Array.isArray(value) ? value[0] : value;
  if (typeof item !== "object" || item === null) {
    return {};
  }
  const record = item as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of PLACEMENT_FIELDS) {
    if (record[field] !== undefined) out[field] = record[field];
  }
  if (out.locked === undefined && record.primitiveLock !== undefined) out.locked = record.primitiveLock;
  return out;
}

export type MoveResult = {
  designator: string;
  primitiveId: string;
  requested: Record<string, number>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  modifyResult: unknown;
};

/** Resolve a designator via pcbSnapshot, modify it, and read it back. */
export async function movePcbComponent(bridge: BridgeClient, request: MoveRequest, timeoutMs = 30_000): Promise<MoveResult> {
  const snapshot = await bridge.call("pcbSnapshot", { include: ["components"] }, timeoutMs);
  const component = findComponentByDesignator(componentsOf(snapshot), request.designator);
  const requested = buildMoveProperties(component, request);
  const modifyResult = await bridge.call("apiCall", { path: "pcb_PrimitiveComponent.modify", args: [component.primitiveId, requested] }, timeoutMs);
  const readBack = await bridge.call("apiCall", { path: "pcb_PrimitiveComponent.get", args: [component.primitiveId] }, timeoutMs);
  return {
    designator: component.designator ?? request.designator,
    primitiveId: component.primitiveId,
    requested,
    before: placementOf(component),
    after: placementOf(readBack),
    modifyResult: summarizeModifyResult(modifyResult)
  };
}

function summarizeModifyResult(value: unknown): unknown {
  // modify() returns the whole primitive; keep only the placement to stay small.
  return typeof value === "object" && value !== null ? placementOf(value) : value;
}

export type Region = { left: number; right: number; top: number; bottom: number };

export type RenderRequest = {
  designator?: string;
  region?: Region;
  margin?: number;
};

/** Parse "l,r,t,b" into a region. */
export function parseRegion(text: string): Region {
  const parts = text.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new BridgeRpcError(`Region must be "left,right,top,bottom" numbers, got "${text}".`, "invalid_argument");
  }
  const [left, right, top, bottom] = parts as [number, number, number, number];
  return { left, right, top, bottom };
}

/** Build renderImage params; a designator is resolved on the active PCB or schematic. */
export async function buildRenderParams(bridge: BridgeClient, request: RenderRequest, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {};
  if (request.margin !== undefined) params.margin = request.margin;
  if (request.region) params.region = request.region;
  if (request.designator) {
    const status = await bridge.getStatus();
    const snapshot = status.activeDocumentType === "schematic"
      ? await bridge.call("schematicSnapshot", { includeRaw: false, allPages: false }, timeoutMs)
      : await bridge.call("pcbSnapshot", { include: ["components"] }, timeoutMs);
    const component = findComponentByDesignator(componentsOf(snapshot), request.designator);
    params.primitiveIds = [component.primitiveId];
  }
  return params;
}

export type RenderedImage = { mimeType: string; base64: string; size?: number; region?: unknown };

export function isRenderedImage(value: unknown): value is RenderedImage {
  return typeof value === "object" && value !== null
    && typeof (value as RenderedImage).base64 === "string"
    && typeof (value as RenderedImage).mimeType === "string";
}
