import * as z from "zod/v4";
import type { BridgeClient } from "../bridge/types.js";
import { ok, fail } from "./toolResult.js";
import { defaultExportDir, isExportedFile, resolveExportTarget, writeExport, type ExportKind } from "./exportFiles.js";
import { EXPORT_CATALOG, UNSUPPORTED_EXPORTS } from "./exportCatalog.js";
import { collectPackage, defaultPackageDir, exportKind, formatDesignCheck, PACKAGE_PRESETS, runDesignCheck, writePackage } from "./exportOps.js";
import { mkdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROTOCOL_VERSION, type EditorStatus } from "../protocol/messages.js";
import { SERVER_VERSION } from "../version.js";
import { buildRenderParams, isReadOnlyApiPath, isRenderedImage, movePcbComponent, mutationsAllowedByEnv } from "./liveOps.js";
import { formatPcbAnalysis } from "../pcb/analyze.js";
import { runPcbAnalyze } from "../pcb/analyzeOps.js";

const DefaultTimeoutSchema = z.number().int().positive().max(120_000).default(10_000);
const EndpointRefSchema = z.union([
  z.object({
    component: z.string().min(1),
    pin: z.string().min(1).optional(),
    pinName: z.string().min(1).optional()
  }),
  z.object({
    net: z.string().min(1)
  })
]);
const PassiveConstraintSchema = z.object({
  kind: z.enum(["resistor", "capacitor", "inductor", "diode", "led", "passive"]).optional(),
  component: z.string().min(1).optional(),
  value: z.string().min(1).optional()
});
const ConnectionCheckSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("pin_connected"),
    component: z.string().min(1),
    pin: z.string().min(1).optional(),
    pinName: z.string().min(1).optional()
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("pin_on_net"),
    component: z.string().min(1),
    pin: z.string().min(1).optional(),
    pinName: z.string().min(1).optional(),
    net: z.string().min(1)
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("same_node"),
    left: EndpointRefSchema,
    right: EndpointRefSchema
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("path_exists"),
    from: EndpointRefSchema,
    to: EndpointRefSchema,
    through: PassiveConstraintSchema.optional(),
    maxHops: z.number().int().positive().max(20).optional()
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("path_absent"),
    from: EndpointRefSchema,
    to: EndpointRefSchema,
    through: PassiveConstraintSchema.optional(),
    maxHops: z.number().int().positive().max(20).optional()
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("pull_to_net"),
    signal: EndpointRefSchema,
    net: z.string().min(1),
    through: PassiveConstraintSchema,
    maxHops: z.number().int().positive().max(20).optional()
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("decoupled_to_net"),
    power: EndpointRefSchema,
    referenceNet: z.string().min(1),
    capacitorValue: z.string().min(1).optional(),
    maxHops: z.number().int().positive().max(20).optional()
  })
]);

const PcbSnapshotIncludeSchema = z.enum(["components", "pads", "tracks", "vias", "arcs", "pours", "fills", "regions", "strings", "nets", "layers", "outline"]);
const ApiPathSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/, "Use namespace.method, e.g. pcb_PrimitiveComponent.getAll");
const RegionSchema = z.object({ left: z.number(), right: z.number(), top: z.number(), bottom: z.number() });
const MUTATION_GATE_TEXT = "Mutating calls need confirmation exactly \"CONFIRM <gate>\" (case-insensitive), sent only after the user explicitly approved this change, unless the user started the server with EASYEDA_MCP_ALLOW_MUTATIONS=1.";

const ConfirmedActionSchema = z.enum(["save", "importChanges", "autoroute", "autolayout"]);
type ConfirmedAction = z.infer<typeof ConfirmedActionSchema>;

/** The exact phrase a client must send to run `action`, e.g. "CONFIRM save". */
export function expectedConfirmationPhrase(action: string): string {
  return `CONFIRM ${action}`;
}

/**
 * Strict gate: the confirmation must be exactly "CONFIRM <action>" (case-insensitive,
 * surrounding/inner whitespace normalized). Free-form text is rejected, so negations
 * like "not confirmed", other actions' phrases, and the old Portuguese "confirma salvar"
 * phrases no longer pass.
 */
export function hasExplicitMutationConfirmation(confirmation: string, action: string): boolean {
  const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
  return normalize(confirmation) === normalize(expectedConfirmationPhrase(action));
}

function confirmationRequired(action: ConfirmedAction | string, confirmation: string) {
  const expected = expectedConfirmationPhrase(action);
  const payload = {
    error: "confirmation_required",
    message: `Action "${action}" was blocked. Set confirmation to exactly "${expected}" (case-insensitive) after the user explicitly approves this action.`,
    retryable: false,
    action,
    expectedConfirmation: expected,
    receivedConfirmation: confirmation
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${payload.message}\n\n${JSON.stringify(payload, null, 2)}` }],
    structuredContent: payload
  };
}

export function registerEasyEdaTools(server: McpServer, bridge: BridgeClient): void {
  server.registerTool(
    "easyeda_live_status",
    {
      title: "EasyEDA Pro live status",
      description: "Checks whether the EasyEDA Pro extension is connected and reports active document/capability information.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const status = await bridge.getStatus();
      const summary = status.connected
        ? status.compatibility?.compatible === false
          ? "EasyEDA Pro extension is connected, but its bridge protocol is incompatible."
          : "EasyEDA Pro extension is connected."
        : "EasyEDA Pro extension is not connected.";
      return ok(summary, {
        status,
        bridgeEndpoint: bridge.endpoint
      });
    }
  );

  server.registerTool(
    "easyeda_doctor",
    {
      title: "EasyEDA Pro bridge diagnostics",
      description: "Returns a structured diagnosis of the local MCP bridge, EasyEDA Pro extension connection state, protocol compatibility, active document context, and suggested next steps.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const status = await bridge.getStatus();
      const hasDocumentContext = Boolean(status.documentName || status.projectName || status.documentInfo);
      const nextSteps = doctorNextSteps(status);
      const summary = status.connected
        ? status.compatibility?.compatible === false
          ? "Bridge diagnostics found a protocol compatibility problem."
          : "Bridge diagnostics look healthy."
        : "Bridge diagnostics found that the EasyEDA Pro extension is disconnected.";
      return ok(summary, {
        doctor: {
          server: {
            name: "easyeda-pro-mcp",
            version: SERVER_VERSION,
            protocolVersion: PROTOCOL_VERSION
          },
          bridge: {
            endpoint: bridge.endpoint,
            ...bridge.describe?.()
          },
          extension: {
            connected: status.connected,
            connectionState: status.connectionState ?? (status.connected ? "connected" : "disconnected"),
            version: status.extensionVersion,
            protocolVersion: status.protocolVersion,
            compatibility: status.compatibility ?? {
              compatible: false,
              expectedProtocolVersion: PROTOCOL_VERSION,
              actualProtocolVersion: status.protocolVersion,
              reason: "The extension has not reported protocol compatibility yet."
            }
          },
          activeDocument: {
            available: hasDocumentContext,
            type: status.activeDocumentType ?? "unknown",
            projectName: status.projectName,
            documentName: status.documentName
          },
          status,
          nextSteps
        }
      });
    }
  );

  registerReadTool(server, bridge, {
    name: "easyeda_get_context",
    title: "Get EasyEDA Pro editor context",
    description: "Summarizes active project, active document, selection, and editor context from the open EasyEDA Pro instance.",
    method: "getContext",
    inputSchema: {
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Fetched EasyEDA Pro context."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_find_component",
    title: "Find EasyEDA Pro component",
    description: "Finds a component by designator, name, value, footprint, or property in the active EasyEDA Pro project.",
    method: "findComponent",
    inputSchema: {
      query: z.string().min(1).describe("Designator, value, name, footprint, or property text to search for."),
      limit: z.number().int().positive().max(100).default(20),
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Searched EasyEDA Pro components."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_find_net",
    title: "Find EasyEDA Pro net",
    description: "Finds a net by name and returns available connections or metadata from the active project.",
    method: "findNet",
    inputSchema: {
      query: z.string().min(1).describe("Net name or partial net name to search for."),
      limit: z.number().int().positive().max(100).default(20),
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Searched EasyEDA Pro nets."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_schematic_snapshot",
    title: "Get EasyEDA Pro schematic snapshot",
    description: "Returns a structured snapshot of the active schematic: components, pins, nets, wires, labels, and confidence metadata.",
    method: "schematicSnapshot",
    inputSchema: {
      includeRaw: z.boolean().default(true).describe("Include compact raw EasyEDA API data for fallback reasoning."),
      allPages: z.boolean().default(true).describe("Collect all schematic pages when EasyEDA Pro exposes them."),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Fetched EasyEDA Pro schematic snapshot."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_list_schematic_components",
    title: "List schematic components",
    description: "Lists normalized schematic components with designator, value/name, footprint, position, and key properties.",
    method: "listSchematicComponents",
    inputSchema: {
      query: z.string().min(1).optional().describe("Optional text filter against component fields."),
      limit: z.number().int().positive().max(500).default(100),
      includeRaw: z.boolean().default(false),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Listed EasyEDA Pro schematic components."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_get_component_pins",
    title: "Get schematic component pins",
    description: "Returns all known pins for a schematic component, including pin number, pin name, position, and net when available.",
    method: "getComponentPins",
    inputSchema: {
      query: z.string().min(1).describe("Component designator or text query, such as U1, USB1, or regulator part number."),
      includeRaw: z.boolean().default(true),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Fetched schematic component pins."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_trace_net",
    title: "Trace schematic net",
    description: "Shows the pins, components, wires, labels, and ports associated with a schematic net.",
    method: "traceNet",
    inputSchema: {
      query: z.string().min(1).describe("Net name or partial net name, such as GND, VCC_5V, or SDA."),
      includeRaw: z.boolean().default(true),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Traced schematic net."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_trace_component",
    title: "Trace schematic component",
    description: "Groups a schematic component's connections by pin and net, with evidence for each connection.",
    method: "traceComponent",
    inputSchema: {
      query: z.string().min(1).describe("Component designator or text query, such as U1 or USB1."),
      includeRaw: z.boolean().default(true),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Traced schematic component."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_find_unconnected_pins",
    title: "Find unconnected schematic pins",
    description: "Identifies schematic pins without a confirmed net in the normalized EasyEDA Pro data.",
    method: "findUnconnectedPins",
    inputSchema: {
      includePowerPins: z.boolean().default(true).describe("When false, suppress pins whose names look like power pins."),
      limit: z.number().int().positive().max(500).default(100),
      includeRaw: z.boolean().default(true),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Found schematic pins without confirmed nets."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_validate_schematic_area",
    title: "Validate schematic area",
    description: "Runs generic read-only schematic checks against selected components/nets or the whole schematic.",
    method: "validateSchematicArea",
    inputSchema: {
      components: z.array(z.string().min(1)).optional().describe("Optional component designators or queries to focus on."),
      nets: z.array(z.string().min(1)).optional().describe("Optional net names or queries to focus on."),
      includeGlobalChecks: z.boolean().default(true),
      includeRaw: z.boolean().default(false),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Validated EasyEDA Pro schematic area."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_verify_connections",
    title: "Verify schematic connections",
    description: "Runs generic read-only connection assertions against the active schematic, including pin/net checks and passive paths through resistors, capacitors, inductors, diodes, or LEDs.",
    method: "verifyConnections",
    inputSchema: {
      checks: z.array(ConnectionCheckSchema).min(1).max(50).describe("Structured connection assertions to verify against the active schematic."),
      includeRaw: z.boolean().default(false),
      allPages: z.boolean().default(true),
      maxHops: z.number().int().positive().max(20).default(4),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Verified EasyEDA Pro schematic connections."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_navigate_component",
    title: "Navigate to EasyEDA Pro component",
    description: "Navigates/highlights a component in the EasyEDA Pro editor when the extension can locate it.",
    method: "navigateComponent",
    inputSchema: {
      query: z.string().min(1).describe("Component designator or search query."),
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Requested EasyEDA Pro component navigation."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_navigate_region",
    title: "Navigate to EasyEDA Pro region",
    description: "Navigates to coordinates or a rectangular region in the active EasyEDA Pro PCB/document.",
    method: "navigateRegion",
    inputSchema: {
      x: z.number().optional(),
      y: z.number().optional(),
      left: z.number().optional(),
      top: z.number().optional(),
      right: z.number().optional(),
      bottom: z.number().optional(),
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Requested EasyEDA Pro region navigation."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_zoom_board",
    title: "Zoom EasyEDA Pro board outline",
    description: "Zooms the active PCB editor to the board outline.",
    method: "zoomBoard",
    inputSchema: {
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Requested EasyEDA Pro board zoom."
  });

  const exportOutput = {
    outputPath: z.string().min(1).optional().describe("File path, or a directory ending in / . Default: $EASYEDA_MCP_EXPORT_DIR or <tmp>/easyeda-mcp-exports/."),
    overwrite: z.boolean().default(false).describe("Replace an existing file at the target path."),
    maxInlineChars: z.number().int().min(0).max(200_000).default(20_000).describe("For text exports, how much of the content to return inline.")
  };

  registerExportTool(server, bridge, {
    name: "easyeda_export_bom",
    kind: "bom",
    title: "Export EasyEDA Pro BOM",
    description: "Exports the BOM of the active project to a local file and returns its path; csv/json content is also returned as text (EasyEDA's tab-separated UTF-16 output is converted to UTF-8 CSV).",
    method: "exportBom",
    inputSchema: {
      fileName: z.string().min(1).optional(),
      format: z.enum(["csv", "xlsx", "json"]).default("csv"),
      scope: z.enum(["pcb", "schematic", "auto"]).default("auto"),
      ...exportOutput,
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    }
  });

  registerExportTool(server, bridge, {
    name: "easyeda_export_netlist",
    kind: "netlist",
    title: "Export EasyEDA Pro netlist",
    description: "Exports the netlist of the active schematic or PCB to a local file and returns its path and text content.",
    method: "exportNetlist",
    inputSchema: {
      fileName: z.string().min(1).optional(),
      scope: z.enum(["pcb", "schematic", "auto"]).default("auto"),
      ...exportOutput,
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    }
  });

  registerExportTool(server, bridge, {
    name: "easyeda_export_gerber",
    kind: "gerber",
    title: "Export EasyEDA Pro Gerber",
    description: "Exports Gerber fabrication files (zip) of the active PCB to a local file and returns its path.",
    method: "exportGerber",
    inputSchema: {
      fileName: z.string().min(1).optional(),
      ...exportOutput,
      timeoutMs: DefaultTimeoutSchema.default(60_000)
    }
  });

  registerExportTool(server, bridge, {
    name: "easyeda_export_pdf",
    kind: "pdf",
    title: "Export EasyEDA Pro PDF",
    description: "Exports a PDF of the active PCB or schematic to a local file and returns its path.",
    method: "exportPdf",
    inputSchema: {
      fileName: z.string().min(1).optional(),
      scope: z.enum(["pcb", "schematic", "auto"]).default("auto"),
      ...exportOutput,
      timeoutMs: DefaultTimeoutSchema.default(60_000)
    }
  });

  registerReadTool(server, bridge, {
    name: "easyeda_pcb_snapshot",
    title: "Get EasyEDA Pro PCB snapshot",
    description: "Returns the active PCB as JSON in mil: components (primitiveId, designator, footprint, x, y, rotation, layer, locked), pads, tracks, vias, arcs, pours, fills, regions, strings, nets, layers, outline, and counts. Use include to fetch only some sections (faster, smaller).",
    method: "pcbSnapshot",
    inputSchema: {
      include: z.array(PcbSnapshotIncludeSchema).min(1).optional().describe("Sections to return (default: all)."),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Fetched EasyEDA Pro PCB snapshot."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_pcb_drc",
    title: "Run EasyEDA Pro PCB DRC",
    description: "Runs the design rule check on the active PCB and returns { ok, errorCount, categories } plus the raw Pro DRC tree. Does not modify the design.",
    method: "pcbDrc",
    inputSchema: {
      strict: z.boolean().optional(),
      verbose: z.boolean().optional(),
      timeoutMs: DefaultTimeoutSchema.default(60_000)
    },
    summary: "Ran EasyEDA Pro DRC."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_api_describe",
    title: "Describe EasyEDA Pro API",
    description: "Lists the EasyEDA Pro API namespaces (dmt_, pcb_, sch_, lib_, pnl_) and their method names that easyeda_api_call can reach.",
    method: "apiDescribe",
    inputSchema: {
      namespace: z.string().min(1).optional().describe("Only this namespace, e.g. pcb_PrimitiveComponent."),
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Described the EasyEDA Pro API."
  });

  server.registerTool(
    "easyeda_api_call",
    {
      title: "Call an EasyEDA Pro API method",
      description: "Calls one EasyEDA Pro API method by path (namespace.method, namespaces dmt_/pcb_/sch_/lib_/pnl_ only) with JSON args and returns its JSON-plain result. " +
        "Methods whose name starts with get/is/has/check/calculate/convert/discretize/describe are treated as read-only and run directly; every other method is treated as mutating. " +
        MUTATION_GATE_TEXT.replace("<gate>", "api <path>") + " Example: \"CONFIRM api pcb_PrimitiveComponent.modify\". Use easyeda_api_describe to list methods.",
      inputSchema: {
        path: ApiPathSchema.describe("namespace.method, e.g. pcb_PrimitiveComponent.getAll"),
        args: z.array(z.unknown()).default([]).describe("Positional arguments, as JSON values."),
        confirmation: z.string().optional().describe("For mutating methods: exactly \"CONFIRM api <path>\", only after the user approved this change."),
        timeoutMs: DefaultTimeoutSchema.default(30_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ path, args, confirmation, timeoutMs }) => {
      try {
        const readOnly = isReadOnlyApiPath(path);
        const gate = `api ${path}`;
        if (!readOnly && !mutationsAllowedByEnv() && !hasExplicitMutationConfirmation(confirmation ?? "", gate)) {
          return confirmationRequired(gate, confirmation ?? "");
        }
        const result = await bridge.call("apiCall", { path, args }, timeoutMs);
        return ok(`Called ${path}.`, { path, readOnly, result });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_pcb_move_component",
    {
      title: "Move a PCB component",
      description: "Moves/rotates/flips a component on the active PCB by designator (units: mil; layer top|bottom or a layer id) and returns its placement before and after (read back from EasyEDA). " +
        "Use x/y for absolute or dx/dy for relative moves. " + MUTATION_GATE_TEXT.replace("<gate>", "move <designator>") + " Example: \"CONFIRM move U1\".",
      inputSchema: {
        designator: z.string().min(1),
        x: z.number().optional(),
        y: z.number().optional(),
        dx: z.number().optional(),
        dy: z.number().optional(),
        rotation: z.number().optional(),
        layer: z.union([z.enum(["top", "bottom"]), z.number().int()]).optional(),
        confirmation: z.string().optional().describe("Exactly \"CONFIRM move <designator>\", only after the user approved this move."),
        timeoutMs: DefaultTimeoutSchema.default(30_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ confirmation, timeoutMs, ...request }) => {
      try {
        const gate = `move ${request.designator}`;
        if (!mutationsAllowedByEnv() && !hasExplicitMutationConfirmation(confirmation ?? "", gate)) {
          return confirmationRequired(gate, confirmation ?? "");
        }
        const moved = await movePcbComponent(bridge, request, timeoutMs);
        return ok(`Moved ${moved.designator}.`, { ...moved });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_render_view",
    {
      title: "Render EasyEDA Pro view as an image",
      description: "Returns a PNG of the EasyEDA Pro canvas fitted to a component (designator, on the active PCB or schematic), a region (document units), or the current view. Does not modify the design, but it changes the editor view (zoom/pan).",
      inputSchema: {
        designator: z.string().min(1).optional(),
        region: RegionSchema.optional().describe("left/right/top/bottom in document units."),
        margin: z.number().min(0).max(10).optional().describe("Extra space around the target as a fraction of its bounding box (default 0.5)."),
        timeoutMs: DefaultTimeoutSchema.default(30_000)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ timeoutMs, ...request }) => {
      try {
        const params = await buildRenderParams(bridge, request, timeoutMs);
        const image = await bridge.call("renderImage", params, timeoutMs);
        if (!isRenderedImage(image)) {
          return ok("EasyEDA Pro did not return an image.", { result: image });
        }
        const info = { mimeType: image.mimeType, size: image.size, region: image.region, params };
        return {
          content: [
            { type: "text" as const, text: `Rendered ${request.designator ?? (request.region ? "region" : "current view")} (${image.mimeType}, ${image.size ?? Math.round(image.base64.length * 0.75)} bytes).` },
            { type: "image" as const, data: image.base64, mimeType: image.mimeType }
          ],
          structuredContent: info
        };
      } catch (error) {
        return fail(error);
      }
    }
  );

  const catalogText = EXPORT_CATALOG.map((entry) => `${entry.kind} (${entry.title}${entry.document === "schematic" ? ", schematic" : ""})`).join("; ");
  const unsupportedText = UNSUPPORTED_EXPORTS.map((item) => item.kind).join(", ");

  server.registerTool(
    "easyeda_export",
    {
      title: "Export a file from EasyEDA Pro",
      description: `Exports one file from the active project and saves it locally. Kinds: ${catalogText}. ` +
        `Not available (broken in EasyEDA Pro 3.2.149): ${unsupportedText}. ` +
        "The tool switches the editor to the PCB or schematic the kind needs and switches back afterwards. Text files (netlist, pnp, BOM csv/json, ...) are also returned inline.",
      inputSchema: {
        kind: z.string().min(1).describe(`One of: ${EXPORT_CATALOG.map((entry) => entry.kind).join(", ")}.`),
        format: z.enum(["csv", "json", "xlsx"]).optional().describe("BOM only (default csv)."),
        scope: z.enum(["pcb", "schematic"]).optional().describe("bom/netlist/pdf: take it from the schematic instead of the PCB."),
        outputPath: z.string().min(1).optional().describe("File path, or a directory ending in / . Default: $EASYEDA_MCP_EXPORT_DIR or <tmp>/easyeda-mcp-exports/."),
        overwrite: z.boolean().default(false),
        maxInlineChars: z.number().int().min(0).max(200_000).default(20_000),
        timeoutMs: DefaultTimeoutSchema.default(120_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ kind, format, scope, outputPath, overwrite, maxInlineChars, timeoutMs }) => {
      try {
        const file = await exportKind(bridge, kind, { format, scope, timeoutMs });
        const target = await resolveExportTarget(outputPath, file.fileName);
        await mkdir(nodePath.dirname(target), { recursive: true });
        await writeFile(target, file.data, { flag: overwrite ? "w" : "wx" });
        return ok(`Saved ${file.kind} export to ${target} (${file.data.length} bytes, ${file.ms} ms).`, {
          result: {
            kind: file.kind,
            path: target,
            bytes: file.data.length,
            ms: file.ms,
            document: file.document,
            restoredDocument: file.restored,
            ...(file.note ? { note: file.note } : {}),
            ...(file.text === undefined ? {} : { text: file.text.slice(0, maxInlineChars), truncated: file.text.length > maxInlineChars })
          }
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_package",
    {
      title: "Build a fabrication/assembly package",
      description: "Exports several files into one folder named <project>-<kind>.<ext> plus manifest.json (sha256, sizes, timings, DRC summary, failures), optionally zipped. " +
        `Presets: ${Object.entries(PACKAGE_PRESETS).filter(([name]) => name !== "all").map(([name, kinds]) => `${name} = ${kinds.join(", ")}`).join("; ")}; all = every supported kind. ` +
        "Switches the editor to the PCB and schematic once each (DRC runs on the PCB) and restores the original document. Per-file failures are recorded, not fatal.",
      inputSchema: {
        outDir: z.string().min(1).optional().describe("Target folder. Default: easyeda-package-<project>-<timestamp> under $EASYEDA_MCP_EXPORT_DIR or <tmp>/easyeda-mcp-exports/."),
        preset: z.enum(["fab", "assembly", "docs", "all"]).optional().describe("Default fab when kinds is not given."),
        kinds: z.array(z.string().min(1)).min(1).optional().describe("Explicit kinds instead of a preset."),
        zip: z.boolean().default(false).describe("Also write <folder>.zip.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ outDir, preset, kinds, zip }) => {
      try {
        const collected = await collectPackage(bridge, { kinds, preset });
        const written = await writePackage(collected, {
          outDir: outDir ?? defaultPackageDir(collected.manifest.project, new Date(collected.manifest.generatedAt), defaultExportDir()),
          zip
        });
        const { manifest } = written;
        return ok(`Wrote ${manifest.files.length} file(s) to ${written.dir}${manifest.failures.length ? ` (${manifest.failures.length} failed)` : ""}${manifest.drc ? `; DRC ${manifest.drc.errorCount} error(s)` : ""}.`, {
          dir: written.dir,
          ...(written.zipPath ? { zip: written.zipPath } : {}),
          manifest
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_design_check",
    {
      title: "Check the design (DRC + schematic vs PCB)",
      description: "Runs DRC, compares schematic connectivity (all pages) with the PCB netlist export as a pin partition (split/merged nets, net-name mismatches, parts missing on either side), and counts unconnected schematic pins. " +
        "Does not change the design; it switches the editor to the PCB and the schematic and then back to the original document.",
      inputSchema: {
        strict: z.boolean().default(false).describe("Also count PCB-only unconnected pads (mounting holes, fiducials) missing from the schematic.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ strict }) => {
      try {
        const report = await runDesignCheck(bridge, { strict });
        return ok(formatDesignCheck(report).trimEnd(), { report });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_pcb_analyze",
    {
      title: "Analyze PCB placement and routing",
      description: "Reads the PCB (snapshot + component boxes) and reports board size/area/layers, per-side placement density, parts outside the outline, same-side overlaps, closest part pairs, per-net track length/segments/vias/layers/widths, and nets whose pads are not all joined by copper (tracks, vias, pours by outline). Units mil. " +
        "Does not change the design; it switches the editor to the PCB if needed and then back to the original document.",
      inputSchema: {
        top: z.number().int().positive().max(200).default(10).describe("Entries in the closest-pairs and longest-nets lists."),
        grid: z.number().positive().optional().describe("Also report parts whose origin is off this grid (mil), as info."),
        padBBox: z.boolean().default(false).describe("Use pad extents as component boxes instead of pcb_Primitive.getPrimitivesBBox (which may include silkscreen).")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ top, grid, padBBox }) => {
      try {
        const report = await runPcbAnalyze(bridge, { top, grid, bboxes: !padBBox });
        return ok(formatPcbAnalysis(report, top).trimEnd(), { report });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_confirmed_action",
    {
      title: "Confirmed EasyEDA Pro action",
      description: "Runs a mutating EasyEDA Pro action only after explicit user approval. The confirmation field must be exactly \"CONFIRM <action>\" for the same action (case-insensitive), e.g. \"CONFIRM save\" or \"CONFIRM autoroute\"; anything else is blocked with error confirmation_required.",
      inputSchema: {
        action: ConfirmedActionSchema,
        confirmation: z.string().describe("Exactly \"CONFIRM <action>\" matching the action field (case-insensitive), e.g. \"CONFIRM save\". Only send it after the user explicitly approved this action."),
        params: z.record(z.string(), z.unknown()).optional(),
        timeoutMs: DefaultTimeoutSchema.default(60_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ action, confirmation, params, timeoutMs }) => {
      try {
        if (!hasExplicitMutationConfirmation(confirmation, action)) {
          return confirmationRequired(action, confirmation);
        }
        const result = await bridge.call("confirmedAction", { action, confirmation, params }, timeoutMs);
        return ok(`Executed confirmed EasyEDA Pro action: ${action}.`, {
          action,
          result
        });
      } catch (error) {
        return fail(error);
      }
    }
  );
}

function doctorNextSteps(status: EditorStatus): string[] {
  if (!status.connected) {
    return [
      "Open EasyEDA Pro.",
      "Install or reload the EasyEDA MCP extension.",
      "Enable external interaction/WebSocket permission in EasyEDA Pro.",
      "Keep the MCP server running and wait for the extension to auto-connect."
    ];
  }

  if (status.compatibility?.compatible === false) {
    return [
      "Rebuild and reload the EasyEDA Pro extension.",
      "Restart the MCP client session so it reloads the latest tool catalog.",
      "Verify that the extension and MCP server are built from the same repository state."
    ];
  }

  if (!status.documentName && !status.projectName) {
    return [
      "Open a schematic or PCB document in EasyEDA Pro.",
      "Run easyeda_get_context or easyeda_live_status again after the document finishes loading."
    ];
  }

  return [
    "The bridge looks healthy.",
    "Use easyeda_live_status for quick checks and easyeda_get_context for deeper editor state."
  ];
}

type ReadToolConfig = {
  name: string;
  title: string;
  description: string;
  method: string;
  inputSchema: z.ZodRawShape;
  summary: string;
};

type ExportToolConfig = {
  name: string;
  kind: ExportKind;
  title: string;
  description: string;
  method: string;
  inputSchema: Record<string, z.ZodType>;
};

function registerExportTool(server: McpServer, bridge: BridgeClient, config: ExportToolConfig): void {
  server.registerTool(
    config.name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    } as never,
    async (args: Record<string, unknown>) => {
      try {
        const { timeoutMs, outputPath, overwrite, maxInlineChars, ...params } = args as Record<string, unknown> & {
          timeoutMs?: number;
          outputPath?: string;
          overwrite?: boolean;
          maxInlineChars?: number;
        };
        const result = await bridge.call(config.method, params, timeoutMs);
        if (!isExportedFile(result)) {
          return ok(`EasyEDA Pro did not return file contents for ${config.name}.`, { result });
        }
        const written = await writeExport(result, {
          kind: config.kind,
          format: typeof params.format === "string" ? params.format : undefined,
          outputPath,
          overwrite,
          maxInlineChars
        });
        return ok(`Saved ${config.kind} export to ${written.path} (${written.bytes} bytes).`, { result: written });
      } catch (error) {
        return fail(error);
      }
    }
  );
}

function registerReadTool(
  server: McpServer,
  bridge: BridgeClient,
  config: ReadToolConfig
): void {
  server.registerTool(
    config.name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    } as never,
    async (args: Record<string, unknown>) => {
      try {
        const { timeoutMs, ...params } = args as Record<string, unknown> & { timeoutMs?: number };
        const result = await bridge.call(config.method, params, timeoutMs);
        return ok(config.summary, {
          result
        });
      } catch (error) {
        return fail(error);
      }
    }
  );
}
