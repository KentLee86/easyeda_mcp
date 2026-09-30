declare const eda: EasyEdaApi;
import {
  buildSchematicSnapshot,
  findUnconnectedPins,
  getComponentPins,
  listSchematicComponents,
  traceComponent,
  traceNet,
  validateSchematicArea,
  verifyConnections,
  type RawSchematicPage,
  type SchematicSnapshot
} from "../../src/schematic/analysis.js";
import {
  PROTOCOL_VERSION,
  evaluateProtocolCompatibility,
  type ProtocolCompatibility
} from "../../src/protocol/messages.js";
import { getBridgeConfig, getBridgeUri } from "./bridgeConfig.js";
import { EXTENSION_VERSION } from "../../src/version.js";
import { apiBatch, apiCall, apiDescribe, exportFile, pcbDrc, pcbSnapshot, renderImage, useDocument } from "./api.js";

type EasyEdaApi = Record<string, any>;

type BridgeCallMessage = {
  kind: "call";
  requestId: string;
  method: string;
  params?: Record<string, any>;
  timeoutMs?: number;
};

type BridgeResultMessage = {
  kind: "result";
  requestId: string;
  result: unknown;
};

type BridgeErrorMessage = {
  kind: "error";
  requestId: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

const WS_ID = "easyeda-mcp-bridge";
const bridgeConfig = getBridgeConfig();
const FAST_RETRIES_AFTER_BYE = 8;
const FAST_OPEN_TIMEOUT_MS = 250;
const FAST_RETRY_DELAY_MS = 50;

type ConnectionPhase = "idle" | "connecting" | "connected" | "blocked";

type ConnectionState = {
  phase: ConnectionPhase;
  attemptIndex: number;
  lastError?: BridgeErrorMessage["error"];
  lastOpenAt?: string;
  lastStatusAt?: string;
  lastHandshakeAt?: string;
  lastAttemptAt?: string;
  /** Epoch ms of the last message received from the MCP server (acks, calls). */
  lastServerMessageAt?: number;
  connectedOnce: boolean;
  /** Set when the connection dropped, so the next successful open is announced. */
  lostSinceLastOpen: boolean;
  /** Build of the code whose timers/handlers own the connection. */
  codeFingerprint?: string;
  /** Short-timeout attempts left after a server "bye" (successor starting up). */
  fastRetries: number;
  /** The permission dialog was shown for the current blocked episode. */
  blockedNotified: boolean;
  disposed: boolean;
  compatibility: ProtocolCompatibility;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  openTimeoutTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
};

// EasyEDA Pro re-evaluates the whole extension script for every activation event
// and menu command, so module variables do not survive between calls. Connection
// state (and its timers) lives on a page global shared by those evaluations.
const runtimeGlobal = globalThis as unknown as Record<string, { state: ConnectionState } | undefined>;
const runtimeKey = `easyedaMcpBridgeRuntime${bridgeConfig.stateKey}`;
const connectionState: ConnectionState = (runtimeGlobal[runtimeKey] ??= {
  state: {
    phase: "idle",
    attemptIndex: 0,
    connectedOnce: false,
    lostSinceLastOpen: false,
    fastRetries: 0,
    blockedNotified: false,
    disposed: false,
    compatibility: evaluateProtocolCompatibility(PROTOCOL_VERSION)
  }
}).state;

const handlers: Record<string, (params: Record<string, any>) => Promise<unknown> | unknown> = {
  getContext,
  findComponent,
  findNet,
  schematicSnapshot,
  listSchematicComponents: listSchematicComponentsTool,
  listSchematicComponentsTool,
  getComponentPins: getComponentPinsTool,
  getComponentPinsTool,
  traceNet: traceNetTool,
  traceNetTool,
  traceComponent: traceComponentTool,
  traceComponentTool,
  findUnconnectedPins: findUnconnectedPinsTool,
  findUnconnectedPinsTool,
  validateSchematicArea: validateSchematicAreaTool,
  validateSchematicAreaTool,
  verifyConnections: verifyConnectionsTool,
  verifyConnectionsTool,
  navigateComponent,
  navigateRegion,
  zoomBoard,
  exportBom,
  exportNetlist,
  exportGerber,
  exportPdf,
  confirmedAction,
  apiCall,
  apiBatch,
  apiDescribe,
  pcbSnapshot,
  pcbDrc,
  renderImage,
  exportFile,
  useDocument
};

export function activate(status?: string, arg?: string): void {
  log("warn", `EasyEDA MCP Bridge activated: ${status ?? "manual"} ${arg ?? ""}`);
  if (status === "onChangeAllowExternalInteractions" && arg === "off") {
    deactivate();
    return;
  }
  takeOverFromOlderCode();
  connectionState.disposed = false;
  void ensureBridgeConnected({ reason: "activation", manual: false });
}

/**
 * Reinstalling or updating the extension does not stop the code that is already
 * running in the editor: its timers keep reconnecting and its message handler
 * keeps answering calls. The shared state records whose code owns the
 * connection; when a newer build activates, clear the old timers and socket so
 * the new handlers take over (without a restart of EasyEDA Pro).
 */
function takeOverFromOlderCode(): void {
  const fingerprint = codeFingerprint();
  // Builds before this field existed leave it undefined; treat them as older code.
  if (connectionState.codeFingerprint !== fingerprint) {
    log("warn", "Newer EasyEDA MCP Bridge code activated; taking over the connection.");
    resetConnectionTimers();
    closeSocket();
    connectionState.phase = "idle";
    connectionState.attemptIndex = 0;
  }
  connectionState.codeFingerprint = fingerprint;
}

let cachedFingerprint: string | undefined;

/** Hash of the handler sources: differs between builds, stable within one. */
function codeFingerprint(): string {
  if (!cachedFingerprint) {
    const source = EXTENSION_VERSION + Object.entries(handlers).map(([name, fn]) => name + String(fn)).join("") + String(startBridge) + String(handleMessage);
    let hash = 5381;
    for (let index = 0; index < source.length; index += 1) {
      hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0;
    }
    cachedFingerprint = (hash >>> 0).toString(16);
  }
  return cachedFingerprint;
}

/** Stop retrying and close the socket (extension unload or dev hot-reload). */
export function deactivate(): void {
  connectionState.disposed = true;
  resetConnectionTimers();
  closeSocket();
  connectionState.phase = "idle";
}

export function connect(): void {
  takeOverFromOlderCode();
  connectionState.disposed = false;
  void ensureBridgeConnected({ reason: "manual-connect", manual: true, resetAttempts: true });
}

export function reconnect(): void {
  takeOverFromOlderCode();
  connectionState.disposed = false;
  resetConnectionTimers();
  closeSocket();
  connectionState.phase = "idle";
  connectionState.attemptIndex = 0;
  void ensureBridgeConnected({ reason: "manual-reconnect", manual: true, resetAttempts: true });
}

export async function showStatus(): Promise<void> {
  const diagnostics = await collectDiagnostics();
  showMessage("EasyEDA MCP Bridge Status", formatStatusSummary(diagnostics));
}

export async function runDiagnostics(): Promise<void> {
  const diagnostics = await collectDiagnostics();
  showMessage("EasyEDA MCP Bridge Diagnostics", formatDiagnostics(diagnostics));
}

async function ensureBridgeConnected(options: { reason: string; manual: boolean; resetAttempts?: boolean }): Promise<void> {
  if (connectionState.disposed) {
    return;
  }

  if (options.resetAttempts) {
    connectionState.attemptIndex = 0;
  }

  if (connectionState.phase === "connecting") {
    return;
  }

  if (connectionState.phase === "connected" && !options.manual) {
    return;
  }

  await startBridge(options);
}

async function startBridge(options: { reason: string; manual: boolean }): Promise<void> {
  if (!eda.sys_WebSocket?.register) {
    handleConnectionFailure(normalizeError(apiError("api_unavailable", "EasyEDA Pro API eda.sys_WebSocket.register is unavailable; enable external interaction for this extension.")), {
      manual: options.manual,
      shouldRetry: true
    });
    return;
  }
  resetConnectionTimers();
  // sys_WebSocket.register reuses an OPEN/CONNECTING socket with the same id and
  // never reports close, so a stale socket must be closed before retrying.
  closeSocket();
  connectionState.phase = "connecting";
  connectionState.lastAttemptAt = new Date().toISOString();

  const wsUri = getBridgeUri(bridgeConfig);
  const attemptIndex = connectionState.attemptIndex;
  connectionState.openTimeoutTimer = setTimeout(() => {
    const error = apiError("bridge_open_timeout", `Timed out waiting for EasyEDA MCP Bridge to open ${wsUri}.`);
    handleConnectionFailure(normalizeError(error), {
      manual: options.manual,
      shouldRetry: true
    });
  }, connectionState.fastRetries > 0 ? FAST_OPEN_TIMEOUT_MS : bridgeConfig.openTimeoutMs);

  try {
    eda.sys_WebSocket.register(
      WS_ID,
      wsUri,
      async (event: MessageEvent<string>) => {
        await handleMessage(event.data);
      },
      async () => {
        if (connectionState.disposed) {
          closeSocket();
          return;
        }
        const announce = !connectionState.connectedOnce || options.manual || connectionState.lostSinceLastOpen;
        connectionState.phase = "connected";
        connectionState.lastOpenAt = new Date().toISOString();
        connectionState.lastHandshakeAt = connectionState.lastOpenAt;
        connectionState.lastServerMessageAt = Date.now();
        connectionState.lastError = undefined;
        connectionState.compatibility = evaluateProtocolCompatibility(PROTOCOL_VERSION);
        connectionState.attemptIndex = 0;
        connectionState.connectedOnce = true;
        connectionState.lostSinceLastOpen = false;
        connectionState.blockedNotified = false;
        connectionState.fastRetries = 0;
        clearOpenTimeout();
        send({
          kind: "hello",
          client: "easyeda-pro-extension",
          version: EXTENSION_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          compatibility: connectionState.compatibility,
          capabilities: detectCapabilities(),
          status: await getStatus()
        });
        startHeartbeat();
        if (announce) {
          showToast(`MCP bridge connected (${wsUri})`, "success");
        }
      }
    );
  } catch (error) {
    handleConnectionFailure(normalizeError(error), {
      manual: options.manual,
      shouldRetry: true
    });
    return;
  }

  log("warn", `Bridge connection attempt ${attemptIndex + 1} started for ${options.reason} -> ${wsUri}`);
}

function closeSocket(): void {
  try {
    eda.sys_WebSocket?.close?.(WS_ID);
  } catch {
    // Nothing registered yet, or permission missing; register will report it.
  }
}

async function handleMessage(raw: string): Promise<void> {
  connectionState.lastServerMessageAt = Date.now();
  let message: BridgeCallMessage | { kind: "ack" } | { kind: "bye" };
  try {
    message = JSON.parse(raw) as BridgeCallMessage | { kind: "ack" } | { kind: "bye" };
  } catch (error) {
    log("warn", "Ignored malformed MCP bridge message", error);
    return;
  }

  if (message.kind === "bye") {
    // The server is shutting down; a new one usually follows within seconds.
    connectionState.lostSinceLastOpen = true;
    closeSocket();
    // Next attempt uses delays[attemptIndex + 1]; -1 selects delays[0] (no wait).
    connectionState.attemptIndex = -1;
    // The successor usually binds the port within tens of ms, but a failed open
    // gives no signal; probe quickly for a short while before the normal cadence.
    connectionState.fastRetries = FAST_RETRIES_AFTER_BYE;
    handleConnectionFailure(normalizeError(apiError("bridge_closed", "The MCP server closed the bridge.")), {
      manual: false,
      shouldRetry: true
    });
    return;
  }

  if (message.kind !== "call" || !message.requestId || !message.method) {
    return;
  }

  try {
    const handler = handlers[message.method];
    if (!handler) {
      throw apiError("unknown_method", `Unsupported MCP bridge method: ${message.method}`);
    }
    const result = await handler(message.params ?? {});
    send({
      kind: "result",
      requestId: message.requestId,
      result
    });
  } catch (error) {
    try {
      send({
        kind: "error",
        requestId: message.requestId,
        error: normalizeError(error)
      });
    } catch {
      // The socket is gone; send() already scheduled a reconnect.
    }
  }
}

function send(message: Record<string, unknown>): void {
  ensureApi("sys_WebSocket", "send");
  try {
    eda.sys_WebSocket.send(WS_ID, JSON.stringify(message));
  } catch (error) {
    handleConnectionFailure(normalizeError(error), {
      manual: false,
      shouldRetry: true
    });
    throw error;
  }
}

async function getStatus(): Promise<Record<string, unknown>> {
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  return {
    connected: connectionState.phase === "connected",
    connectionState: connectionState.phase,
    extensionVersion: EXTENSION_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    compatibility: connectionState.compatibility,
    capabilities: detectCapabilities(),
    activeDocumentType: inferDocumentType(documentInfo),
    projectName: pickString(documentInfo, ["projectName", "project", "parentName"]),
    documentName: pickString(documentInfo, ["name", "title", "documentName"]),
    message: connectionState.lastError?.message,
    documentInfo: sanitize(documentInfo),
    updatedAt: new Date().toISOString()
  };
}

async function emitStatusUpdate(): Promise<void> {
  send({
    kind: "status",
    compatibility: connectionState.compatibility,
    status: await getStatus()
  });
  connectionState.lastStatusAt = new Date().toISOString();
}

function startHeartbeat(): void {
  if (connectionState.heartbeatTimer) {
    clearInterval(connectionState.heartbeatTimer);
  }
  connectionState.heartbeatTimer = setInterval(() => {
    // A closed browser WebSocket drops sends silently, so a missing server ack
    // is the only reliable sign that the MCP server went away.
    const silentMs = Date.now() - (connectionState.lastServerMessageAt ?? 0);
    if (silentMs > bridgeConfig.livenessTimeoutMs) {
      connectionState.lostSinceLastOpen = true;
      closeSocket();
      handleConnectionFailure(normalizeError(apiError("bridge_lost", `No reply from the MCP server for ${Math.round(silentMs / 1000)}s.`)), {
        manual: false,
        shouldRetry: true
      });
      return;
    }
    void emitStatusUpdate().catch((error) => {
      handleConnectionFailure(normalizeError(error), {
        manual: false,
        shouldRetry: true
      });
    });
  }, bridgeConfig.heartbeatIntervalMs);
}

function clearOpenTimeout(): void {
  if (connectionState.openTimeoutTimer) {
    clearTimeout(connectionState.openTimeoutTimer);
    connectionState.openTimeoutTimer = undefined;
  }
}

function resetConnectionTimers(): void {
  clearOpenTimeout();
  if (connectionState.reconnectTimer) {
    clearTimeout(connectionState.reconnectTimer);
    connectionState.reconnectTimer = undefined;
  }
  if (connectionState.heartbeatTimer) {
    clearInterval(connectionState.heartbeatTimer);
    connectionState.heartbeatTimer = undefined;
  }
}

function handleConnectionFailure(
  error: BridgeErrorMessage["error"],
  options: { manual: boolean; shouldRetry: boolean }
): void {
  clearOpenTimeout();
  if (connectionState.heartbeatTimer) {
    clearInterval(connectionState.heartbeatTimer);
    connectionState.heartbeatTimer = undefined;
  }
  if (connectionState.phase === "connected") {
    connectionState.lostSinceLastOpen = true;
  }

  connectionState.lastError = error;
  connectionState.compatibility = evaluateProtocolCompatibility(PROTOCOL_VERSION);
  connectionState.phase = isPermissionLikeError(error) ? "blocked" : "idle";

  // Keep retrying (the MCP server may start later or restart); after the initial
  // backoff the last delay repeats. This includes a missing external-interaction
  // permission: right after install it is off, and enabling it should connect
  // without a menu click.
  const retry = options.shouldRetry && !connectionState.disposed;
  if (retry && !connectionState.reconnectTimer) {
    const delays = bridgeConfig.reconnectDelayMs;
    const nextAttempt = connectionState.attemptIndex + 1;
    let delayMs = delays[Math.min(nextAttempt, delays.length - 1)];
    if (connectionState.fastRetries > 0) {
      connectionState.fastRetries -= 1;
      delayMs = FAST_RETRY_DELAY_MS;
    }
    connectionState.attemptIndex = nextAttempt;
    connectionState.reconnectTimer = setTimeout(() => {
      connectionState.reconnectTimer = undefined;
      void ensureBridgeConnected({
        reason: "retry",
        manual: false
      });
    }, delayMs);
  }

  const firstBlock = connectionState.phase === "blocked" && !connectionState.blockedNotified;
  if (connectionState.phase === "blocked") {
    connectionState.blockedNotified = true;
  }
  if (options.manual || firstBlock) {
    showMessage("EasyEDA MCP Bridge", [
      error.message,
      "",
      ...diagnosticHints(error)
    ].join("\n"));
  }
}

async function collectDiagnostics(): Promise<Record<string, unknown>> {
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  return {
    bridge: {
      uri: getBridgeUri(bridgeConfig),
      config: bridgeConfig
    },
    websocket: {
      registerAvailable: Boolean(eda.sys_WebSocket?.register),
      sendAvailable: Boolean(eda.sys_WebSocket?.send)
    },
    connection: {
      phase: connectionState.phase,
      connectedOnce: connectionState.connectedOnce,
      lastAttemptAt: connectionState.lastAttemptAt,
      lastOpenAt: connectionState.lastOpenAt,
      lastHandshakeAt: connectionState.lastHandshakeAt,
      lastStatusAt: connectionState.lastStatusAt,
      lastError: connectionState.lastError,
      compatibility: connectionState.compatibility
    },
    activeDocument: {
      available: Boolean(documentInfo),
      type: inferDocumentType(documentInfo),
      projectName: pickString(documentInfo, ["projectName", "project", "parentName"]),
      documentName: pickString(documentInfo, ["name", "title", "documentName"])
    },
    nextSteps: diagnosticHints(connectionState.lastError)
  };
}

function formatStatusSummary(diagnostics: Record<string, unknown>): string {
  const connection = diagnostics.connection as Record<string, unknown>;
  const document = diagnostics.activeDocument as Record<string, unknown>;
  return [
    `Bridge URI: ${getBridgeUri(bridgeConfig)}`,
    `Connection phase: ${String(connection.phase ?? "unknown")}`,
    `Last open: ${String(connection.lastOpenAt ?? "never")}`,
    `Document: ${String(document.documentName ?? document.projectName ?? "none")}`
  ].join("\n");
}

function formatDiagnostics(diagnostics: Record<string, unknown>): string {
  const websocket = diagnostics.websocket as Record<string, unknown>;
  const connection = diagnostics.connection as Record<string, unknown>;
  const document = diagnostics.activeDocument as Record<string, unknown>;
  const nextSteps = Array.isArray(diagnostics.nextSteps) ? diagnostics.nextSteps as string[] : [];

  return [
    `Bridge URI: ${getBridgeUri(bridgeConfig)}`,
    `WebSocket register available: ${String(websocket.registerAvailable)}`,
    `WebSocket send available: ${String(websocket.sendAvailable)}`,
    `Connection phase: ${String(connection.phase ?? "unknown")}`,
    `Last open: ${String(connection.lastOpenAt ?? "never")}`,
    `Last status: ${String(connection.lastStatusAt ?? "never")}`,
    `Compatibility: ${String((connection.compatibility as Record<string, unknown>)?.compatible ?? false)}`,
    `Document: ${String(document.documentName ?? document.projectName ?? "none")}`,
    nextSteps.length > 0 ? `Next steps:\n- ${nextSteps.join("\n- ")}` : "Next steps: none"
  ].join("\n");
}

function diagnosticHints(error?: BridgeErrorMessage["error"]): string[] {
  if (isPermissionLikeError(error)) {
    return [
      "Enable external interaction/WebSocket permission for the extension in EasyEDA Pro.",
      "Reload the extension and let it auto-connect again."
    ];
  }

  if (error?.code === "bridge_open_timeout") {
    return [
      "Make sure the MCP server is running locally.",
      `Confirm the bridge endpoint is reachable at ${getBridgeUri(bridgeConfig)}.`
    ];
  }

  return [
    "Keep EasyEDA Pro open while the MCP server is running.",
    "Use Reconnect or Run Diagnostics from the extension menu if the bridge stays unavailable."
  ];
}

function isPermissionLikeError(error?: BridgeErrorMessage["error"]): boolean {
  const message = `${error?.message ?? ""} ${error?.code ?? ""}`.toLowerCase();
  return message.includes("permission") || message.includes("external interaction") || message.includes("sys_websocket");
}

async function getContext(): Promise<Record<string, unknown>> {
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  const splitScreenTree = await optionalCall(() => eda.dmt_EditorControl.getSplitScreenTree());
  const pcbNets = await optionalCall(() => getPcbNetNames());
  const pcbComponents = await optionalCall(() => getPcbComponents());
  const schComponents = await optionalCall(() => getSchematicComponents());

  return {
    status: await getStatus(),
    documentInfo: sanitize(documentInfo),
    splitScreenTree: sanitize(splitScreenTree),
    counts: {
      pcbNets: Array.isArray(pcbNets) ? pcbNets.length : undefined,
      pcbComponents: Array.isArray(pcbComponents) ? pcbComponents.length : undefined,
      schematicComponents: Array.isArray(schComponents) ? schComponents.length : undefined
    },
    betaApi: true
  };
}

async function findComponent(params: Record<string, any>): Promise<Record<string, unknown>> {
  const query = String(params.query ?? "").toLowerCase();
  const limit = Number(params.limit ?? 20);
  const pcb = (await optionalCall(() => getPcbComponents())) ?? [];
  const schematic = (await optionalCall(() => getSchematicComponents())) ?? [];
  const all = [
    ...toArray(pcb).map((item) => ({ source: "pcb", item })),
    ...toArray(schematic).map((item) => ({ source: "schematic", item }))
  ];
  // Designator equality wins ("R1" must not pick R10); otherwise match designator,
  // value, name or footprint substrings.
  const fields = ({ item }: { item: unknown }) => {
    const simple = simplifyPrimitive(item);
    return {
      designator: String(simple.designator ?? "").toLowerCase(),
      text: [simple.designator, simple.value, (item as any)?.name, JSON.stringify(simple.footprint ?? "")].map((value) => String(value ?? "").toLowerCase())
    };
  };
  const exact = all.filter((entry) => fields(entry).designator === query);
  const matches = (exact.length > 0 ? exact : all.filter((entry) => fields(entry).text.some((value) => value.includes(query)))).slice(0, limit);

  return {
    query,
    count: matches.length,
    matches: matches.map(({ source, item }) => ({ source, component: simplifyPrimitive(item) })),
    betaApi: true
  };
}

async function findNet(params: Record<string, any>): Promise<Record<string, unknown>> {
  const query = String(params.query ?? "").toLowerCase();
  const limit = Number(params.limit ?? 20);
  const names = toArray(await getPcbNetNames()).filter((name) => String(name).toLowerCase().includes(query)).slice(0, limit);
  const nets = [];
  for (const name of names) {
    const detail = await optionalCall(() => eda.pcb_Net.getNet(name));
    const length = await optionalCall(() => eda.pcb_Net.getNetLength(name));
    nets.push({
      name,
      detail: sanitize(detail),
      length
    });
  }

  return {
    query,
    count: nets.length,
    nets,
    betaApi: true
  };
}

async function schematicSnapshot(params: Record<string, any>): Promise<SchematicSnapshot> {
  return collectSchematicSnapshot({
    includeRaw: params.includeRaw !== false,
    allPages: params.allPages !== false
  });
}

async function listSchematicComponentsTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw === true, allPages: params.allPages !== false });
  const components = listSchematicComponents(snapshot, stringOrUndefined(params.query), Number(params.limit ?? 100));
  return {
    components,
    count: components.length,
    totalComponents: snapshot.counts.components,
    confidence: snapshot.confidence,
    warnings: snapshot.warnings,
    betaApi: true
  };
}

async function getComponentPinsTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = getComponentPins(snapshot, String(params.query ?? ""));
  return {
    ...result,
    betaApi: true
  };
}

async function traceNetTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = traceNet(snapshot, String(params.query ?? ""));
  return {
    ...result,
    betaApi: true
  };
}

async function traceComponentTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = traceComponent(snapshot, String(params.query ?? ""));
  return {
    ...result,
    betaApi: true
  };
}

async function findUnconnectedPinsTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = findUnconnectedPins(snapshot, {
    includePowerPins: params.includePowerPins !== false,
    limit: Number(params.limit ?? 100)
  });
  return {
    ...result,
    betaApi: true
  };
}

async function validateSchematicAreaTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = validateSchematicArea(snapshot, {
    components: Array.isArray(params.components) ? params.components.map(String) : undefined,
    nets: Array.isArray(params.nets) ? params.nets.map(String) : undefined,
    includeGlobalChecks: params.includeGlobalChecks !== false
  });
  return {
    ...result,
    snapshotCounts: snapshot.counts,
    snapshotWarnings: snapshot.warnings,
    betaApi: true
  };
}

async function verifyConnectionsTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = verifyConnections(snapshot, Array.isArray(params.checks) ? params.checks : [], {
    maxHops: Number(params.maxHops ?? 4)
  });
  return {
    ...result,
    snapshotCounts: snapshot.counts,
    snapshotWarnings: snapshot.warnings,
    betaApi: true
  };
}

async function navigateComponent(params: Record<string, any>): Promise<Record<string, unknown>> {
  const result = await findComponent({ query: params.query, limit: 1 });
  const first = (result.matches as any[])?.[0];
  if (!first) {
    throw apiError("component_not_found", `No component matched "${params.query}".`);
  }

  const primitiveId = first.component.primitiveId ?? first.component.id ?? first.component.uuid;
  if (!primitiveId) {
    return {
      navigated: false,
      reason: "Matched component did not expose a primitive id.",
      match: first,
      betaApi: true
    };
  }

  const primitiveApi = first.source === "pcb" ? eda.pcb_Primitive : eda.sch_Primitive;
  const bbox = await optionalCall(() => primitiveApi.getPrimitivesBBox([primitiveId]));
  const region = normalizeBBox(bbox);
  if (region) {
    await zoomToRegion(region.left, region.right, region.top, region.bottom);
  }

  return {
    navigated: Boolean(region),
    primitiveId,
    region,
    match: first,
    betaApi: true
  };
}

async function navigateRegion(params: Record<string, any>): Promise<Record<string, unknown>> {
  if (isNumber(params.x) && isNumber(params.y)) {
    if (eda.pcb_Document?.navigateToCoordinates) {
      await eda.pcb_Document.navigateToCoordinates(params.x, params.y);
      return { navigated: true, mode: "coordinates", x: params.x, y: params.y };
    }
    if (eda.dmt_EditorControl?.zoomTo) {
      await eda.dmt_EditorControl.zoomTo(params.x, params.y, params.scaleRatio ?? 1);
      return { navigated: true, mode: "zoomTo", x: params.x, y: params.y, betaApi: true };
    }
  }

  for (const key of ["left", "right", "top", "bottom"]) {
    if (!isNumber(params[key])) {
      throw apiError("invalid_region", "Provide either x/y coordinates or left/right/top/bottom region values.");
    }
  }

  await zoomToRegion(params.left, params.right, params.top, params.bottom);
  return {
    navigated: true,
    mode: "region",
    region: {
      left: params.left,
      right: params.right,
      top: params.top,
      bottom: params.bottom
    },
    betaApi: true
  };
}

async function zoomBoard(): Promise<Record<string, unknown>> {
  ensureApi("pcb_Document", "zoomToBoardOutline");
  await eda.pcb_Document.zoomToBoardOutline();
  return {
    zoomed: true,
    betaApi: true
  };
}

async function exportBom(params: Record<string, any>): Promise<Record<string, unknown>> {
  const fileName = params.fileName ?? `easyeda-bom-${timestamp()}`;
  // Pro produces csv (tab-separated UTF-16) or xlsx; the server converts csv to real CSV/JSON.
  const fileType = params.format === "xlsx" ? "xlsx" : "csv";
  const api = await pickManufactureApi(params.scope, "getBomFile");
  const file = await api.getBomFile(fileName, fileType);
  return fileContents(file, `${fileName}.${fileType}`);
}

async function exportNetlist(params: Record<string, any>): Promise<Record<string, unknown>> {
  const fileName = params.fileName ?? `easyeda-netlist-${timestamp()}`;
  const api = await pickManufactureApi(params.scope, "getNetlistFile");
  const file = await api.getNetlistFile(fileName, params.netlistType);
  if (!extractFile(file) && api === eda.sch_ManufactureData) {
    // Pro 3.2 returns nothing for some (e.g. imported) schematics; the PCB path works.
    throw apiError("export_unavailable", "EasyEDA Pro returned no schematic netlist for this project. Open the board's PCB and export with scope \"pcb\".");
  }
  return fileContents(file, `${fileName}.enet`);
}

async function exportGerber(params: Record<string, any>): Promise<Record<string, unknown>> {
  ensureApi("pcb_ManufactureData", "getGerberFile");
  const fileName = params.fileName ?? `easyeda-gerber-${timestamp()}`;
  const file = await eda.pcb_ManufactureData.getGerberFile(fileName);
  return fileContents(file, `${fileName}.zip`);
}

async function exportPdf(params: Record<string, any>): Promise<Record<string, unknown>> {
  const fileName = params.fileName ?? `easyeda-export-${timestamp()}`;
  const api = await pickManufactureApi(params.scope, params.scope === "schematic" ? "getExportDocumentFile" : undefined);
  if (api === eda.sch_ManufactureData) {
    ensureApi("sch_ManufactureData", "getExportDocumentFile");
    const file = await eda.sch_ManufactureData.getExportDocumentFile(fileName, "PDF");
    return fileContents(file, `${fileName}.pdf`);
  }
  ensureApi("pcb_ManufactureData", "getPdfFile");
  const file = await eda.pcb_ManufactureData.getPdfFile(fileName);
  return fileContents(file, `${fileName}.pdf`);
}

async function confirmedAction(params: Record<string, any>): Promise<Record<string, unknown>> {
  const action = String(params.action ?? "");
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  const documentUuid = pickString(documentInfo, ["uuid", "documentUuid", "id"]);

  if (action === "save") {
    const documentType = inferDocumentType(documentInfo);
    const api = documentType === "pcb" ? eda.pcb_Document : documentType === "schematic" ? eda.sch_Document : undefined;
    if (!api?.save) {
      throw apiError("unsupported_document", `save needs an open schematic page or PCB; the active document is ${documentType}.`);
    }
    const saved = await api.save(documentUuid);
    if (saved === false) {
      throw apiError("save_failed", "EasyEDA Pro reported that the document was not saved.");
    }
    return { action, saved: true, documentType, documentUuid };
  }

  if (action === "importChanges") {
    ensureApi("pcb_Document", "importChanges");
    await eda.pcb_Document.importChanges(params.uuid ?? documentUuid);
    return { action, imported: true, documentUuid: params.uuid ?? documentUuid };
  }

  if (action === "autoroute" || action === "autolayout") {
    const method = action === "autoroute" ? "importAutoRouteJsonFile" : "importAutoLayoutJsonFile";
    ensureApi("pcb_Document", method);
    const json = params.params?.json;
    if (typeof json !== "string" || !json.trim()) {
      throw apiError("missing_json", `${action} requires params.json: the ${action} result JSON text from an EasyEDA-compatible router.`);
    }
    const imported = await eda.pcb_Document[method](new File([json], `${action}.json`, { type: "application/json" }));
    if (imported === false) {
      throw apiError("import_failed", `EasyEDA Pro rejected the ${action} JSON.`);
    }
    return { action, imported: true, betaApi: true };
  }

  throw apiError("unsupported_action", `Unsupported or unavailable confirmed action: ${action}.`);
}

function detectCapabilities(): Record<string, boolean> {
  return {
    websocket: Boolean(eda.sys_WebSocket?.register && eda.sys_WebSocket?.send),
    pcbDocument: Boolean(eda.pcb_Document),
    schDocument: Boolean(eda.sch_Document),
    pcbManufactureData: Boolean(eda.pcb_ManufactureData),
    schManufactureData: Boolean(eda.sch_ManufactureData),
    fileSystem: Boolean(eda.sys_FileSystem?.saveFile),
    apiCall: true
  };
}

async function getPcbComponents(): Promise<unknown[]> {
  ensureApi("pcb_PrimitiveComponent", "getAll");
  return toArray(await eda.pcb_PrimitiveComponent.getAll());
}

async function getSchematicComponents(): Promise<unknown[]> {
  ensureApi("sch_PrimitiveComponent", "getAll");
  return toArray(await eda.sch_PrimitiveComponent.getAll(undefined, true));
}

async function collectSchematicSnapshot(options: { includeRaw: boolean; allPages: boolean }): Promise<SchematicSnapshot> {
  ensureApi("sch_PrimitiveComponent", "getAll");
  const pages = options.allPages ? await listSchematicPages() : [];
  if (pages.length === 0) {
    return buildSchematicSnapshot({ ...(await readOpenSchematicPage()), includeRaw: options.includeRaw });
  }

  // Pins, wires and texts are only readable on the open page, so visit each page
  // and restore the document the user was looking at.
  const original = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  // Home/blank tabs have no uuid to reopen; the last visited page then stays open.
  const originalUuid = pickString(original, ["uuid"]);
  const rawPages: RawSchematicPage[] = [];
  let current = originalUuid;
  try {
    for (const page of pages) {
      if (current !== page.uuid) {
        await eda.dmt_EditorControl.openDocument(page.uuid);
        current = page.uuid;
      }
      rawPages.push({ uuid: page.uuid, name: page.name, ...(await readOpenSchematicPage()) });
    }
  } finally {
    if (originalUuid && current !== originalUuid) {
      await optionalCall(() => eda.dmt_EditorControl.openDocument(originalUuid));
    }
  }
  return buildSchematicSnapshot({ pages: rawPages, includeRaw: options.includeRaw });
}

async function readOpenSchematicPage(): Promise<Omit<RawSchematicPage, "uuid" | "name">> {
  const components = toArray(await eda.sch_PrimitiveComponent.getAll(undefined, false));
  const pinsByComponent: Record<string, unknown[]> = {};
  if (eda.sch_PrimitiveComponent?.getAllPinsByPrimitiveId) {
    for (const component of components) {
      const componentRecord = component && typeof component === "object" ? component as Record<string, unknown> : {};
      const primitiveId = stringOrUndefined(componentRecord.primitiveId ?? componentRecord.id ?? componentRecord.uuid);
      if (!primitiveId) {
        continue;
      }
      const pins = await optionalCall(() => eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId));
      pinsByComponent[primitiveId] = toArray(pins);
    }
  }
  return {
    components,
    pinsByComponent,
    wires: toArray(await optionalCall(() => eda.sch_PrimitiveWire?.getAll ? eda.sch_PrimitiveWire.getAll() : [])),
    texts: toArray(await optionalCall(() => eda.sch_PrimitiveText?.getAll ? eda.sch_PrimitiveText.getAll() : []))
  };
}

/** Schematic pages of the board that owns the active document (schematic page or PCB). */
async function listSchematicPages(): Promise<Array<{ uuid: string; name?: string }>> {
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  const currentUuid = pickString(documentInfo, ["uuid"]);
  const project = await optionalCall(() => eda.dmt_Project.getCurrentProjectInfo());
  const boards = toArray((project as Record<string, unknown> | undefined)?.data) as Array<Record<string, any>>;
  const board = boards.find((item) =>
    item?.pcb?.uuid === currentUuid
    || toArray(item?.schematic?.page).some((page: any) => page?.uuid === currentUuid)
  ) ?? (boards.length === 1 ? boards[0] : undefined);
  const pages = toArray(board?.schematic?.page) as Array<Record<string, unknown>>;
  return pages
    .map((page) => ({ uuid: stringOrUndefined(page.uuid) ?? "", name: stringOrUndefined(page.name) }))
    .filter((page) => page.uuid);
}

async function getPcbNetNames(): Promise<unknown[]> {
  ensureApi("pcb_Net", "getAllNetsName");
  if (eda.pcb_Net.getAllNetsName) {
    return toArray(await eda.pcb_Net.getAllNetsName());
  }
  return toArray(await eda.pcb_Net.getAllNetName());
}

async function zoomToRegion(left: number, right: number, top: number, bottom: number): Promise<void> {
  if (eda.pcb_Document?.navigateToRegion) {
    await eda.pcb_Document.navigateToRegion(left, right, top, bottom);
    return;
  }
  ensureApi("dmt_EditorControl", "zoomToRegion");
  await eda.dmt_EditorControl.zoomToRegion(left, right, top, bottom);
}

async function pickManufactureApi(scope: string | undefined, method?: string): Promise<any> {
  // The PCB API on a schematic tab (or vice versa) opens an error dialog and never
  // resolves, so "auto" follows the active document.
  const target = scope === "schematic" || scope === "pcb"
    ? scope
    : inferDocumentType(await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo()));
  if (target === "schematic") {
    if (method) ensureApi("sch_ManufactureData", method);
    return eda.sch_ManufactureData;
  }
  if (target === "pcb") {
    if (method) ensureApi("pcb_ManufactureData", method);
    return eda.pcb_ManufactureData;
  }
  throw apiError("unsupported_document", `Open a schematic page or PCB first (active document: ${target}), or pass scope.`);
}

/** Read an EasyEDA File as base64 so the MCP server can write it (no save dialog). */
async function fileContents(file: unknown, fallbackFileName: string): Promise<Record<string, unknown>> {
  const blob = extractFile(file);
  if (!blob || typeof (blob as Blob).arrayBuffer !== "function") {
    throw apiError("export_failed", "EasyEDA Pro did not return a file for this export.", sanitize(file));
  }
  const bytes = new Uint8Array(await (blob as Blob).arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return {
    fileName: (blob as File).name || fallbackFileName,
    mimeType: (blob as Blob).type || undefined,
    size: bytes.length,
    base64: btoa(binary)
  };
}

function extractFile(value: unknown): unknown {
  if (typeof File !== "undefined" && value instanceof File) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find((item) => typeof File !== "undefined" && item instanceof File) ?? value[0];
  }
  if (value && typeof value === "object" && "file" in value) {
    return (value as { file: unknown }).file;
  }
  return value;
}

function simplifyPrimitive(value: unknown): Record<string, unknown> {
  const item = sanitize(value) as Record<string, unknown>;
  return {
    primitiveId: item.primitiveId ?? item.id ?? item.uuid,
    designator: item.designator ?? item.name ?? item.displayName ?? item.prefix,
    value: item.value ?? item.comment ?? item.title,
    footprint: item.footprint ?? item.package ?? item.packageName,
    x: item.x,
    y: item.y,
    layer: item.layer,
    raw: item
  };
}

function normalizeBBox(value: unknown): { left: number; right: number; top: number; bottom: number } | undefined {
  const item = Array.isArray(value) ? value[0] : value;
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const box = item as Record<string, unknown>;
  const left = numeric(box.left ?? box.minX ?? box.x1);
  const right = numeric(box.right ?? box.maxX ?? box.x2);
  const top = numeric(box.top ?? box.minY ?? box.y1);
  const bottom = numeric(box.bottom ?? box.maxY ?? box.y2);
  if ([left, right, top, bottom].every((number) => number !== undefined)) {
    return { left, right, top, bottom } as { left: number; right: number; top: number; bottom: number };
  }
  return undefined;
}

function ensureApi(objectName: string, methodName: string): void {
  if (!eda[objectName]?.[methodName]) {
    throw apiError("api_unavailable", `EasyEDA Pro API eda.${objectName}.${methodName} is unavailable in this context.`);
  }
}

function apiError(code: string, message: string, details?: unknown): Error & { code: string; details?: unknown } {
  const error = new Error(message) as Error & { code: string; details?: unknown };
  error.code = code;
  error.details = details;
  return error;
}

function normalizeError(error: unknown): BridgeErrorMessage["error"] {
  if (error instanceof Error) {
    const coded = error as Error & { code?: string; details?: unknown };
    return {
      code: coded.code ?? "easyeda_extension_error",
      message: error.message,
      details: sanitize(coded.details)
    };
  }
  return {
    code: "easyeda_extension_error",
    message: String(error)
  };
}

async function optionalCall<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    log("warn", "Optional EasyEDA API call failed", error);
    return undefined;
  }
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return "[MaxDepth]";
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (typeof File !== "undefined" && value instanceof File) {
    return {
      name: value.name,
      size: value.size,
      type: value.type
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitize(item, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    if (typeof item !== "function") {
      output[key] = sanitize(item, depth + 1);
    }
  }
  return output;
}

function pickString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") {
      return record[key] as string;
    }
  }
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// EDMT_EditorDocumentType values from the Pro API.
const DOCUMENT_TYPES: Record<number, string> = {
  [-1]: "home",
  1: "schematic", 8: "schematic", 9: "schematic",
  3: "pcb", 12: "pcb", 15: "pcb",
  2: "symbol", 7: "symbol", 17: "symbol", 18: "symbol", 19: "symbol", 20: "symbol", 21: "symbol", 22: "symbol", 25: "symbol", 32: "symbol",
  4: "footprint",
  26: "panel", 27: "panel", 29: "panel"
};

function inferDocumentType(documentInfo: unknown): string {
  const record = isRecord(documentInfo) ? documentInfo : undefined;
  const numericType = record
    ? [
      record.documentType,
      record.doctype,
      record.type
    ].find((value) => typeof value === "number")
    : undefined;

  if (typeof numericType === "number") {
    return DOCUMENT_TYPES[numericType] ?? "unknown";
  }

  // Only look at type-like fields: document names may contain "PCB" or "SCH".
  const raw = [record?.documentType, record?.doctype, record?.type].filter((value) => typeof value === "string").join(" ").toLowerCase();
  if (raw.includes("pcb")) return "pcb";
  if (raw.includes("sch")) return "schematic";
  if (raw.includes("footprint")) return "footprint";
  if (raw.includes("symbol")) return "symbol";
  return "unknown";
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function log(level: "warn" | "error", message: string, details?: unknown): void {
  if (eda.sys_Log?.[level]) {
    eda.sys_Log[level](`[easyeda-mcp] ${message}`, details);
    return;
  }
  console[level](`[easyeda-mcp] ${message}`, details);
}

function showToast(message: string, type: "success" | "info" | "warn" | "error" = "info"): void {
  if (eda.sys_ToastMessage?.showMessage) {
    eda.sys_ToastMessage.showMessage(message, type);
    return;
  }
  log("warn", message);
}

function showMessage(title: string, message: string): void {
  if (eda.sys_Dialog?.showInformationMessage) {
    eda.sys_Dialog.showInformationMessage(message, title);
    return;
  }
  log("warn", `${title}: ${message}`);
}
