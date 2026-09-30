export class BridgeUnavailableError extends Error {
  constructor(message = "EasyEDA Pro extension is not connected. Open EasyEDA Pro, install the extension, and enable external interaction permission.") {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

export class BridgeProtocolCompatibilityError extends Error {
  readonly expectedProtocolVersion: string;
  readonly actualProtocolVersion?: string;

  constructor(message: string, expectedProtocolVersion: string, actualProtocolVersion?: string) {
    super(message);
    this.name = "BridgeProtocolCompatibilityError";
    this.expectedProtocolVersion = expectedProtocolVersion;
    this.actualProtocolVersion = actualProtocolVersion;
  }
}

export class BridgeRpcError extends Error {
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "BridgeRpcError";
    this.code = code;
    this.details = details;
  }
}

export class BridgeTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Timed out waiting ${timeoutMs}ms for EasyEDA Pro extension method "${method}".`);
    this.name = "BridgeTimeoutError";
  }
}

/** Error shape used by the hub HTTP API (`{ ok: false, error }`). */
export type WireError = {
  code: string;
  message: string;
  details?: unknown;
};

/** Map a bridge error to the hub HTTP API error body and status code. */
export function errorToWire(error: unknown): { status: number; error: WireError } {
  if (error instanceof BridgeUnavailableError) {
    return { status: 503, error: { code: "bridge_unavailable", message: error.message } };
  }
  if (error instanceof BridgeTimeoutError) {
    return { status: 504, error: { code: "bridge_timeout", message: error.message } };
  }
  if (error instanceof BridgeProtocolCompatibilityError) {
    return {
      status: 409,
      error: {
        code: "bridge_protocol_mismatch",
        message: error.message,
        details: { expectedProtocolVersion: error.expectedProtocolVersion, actualProtocolVersion: error.actualProtocolVersion }
      }
    };
  }
  if (error instanceof BridgeRpcError) {
    return {
      status: 502,
      error: { code: error.code ?? "easyeda_rpc_error", message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
    };
  }
  return { status: 500, error: { code: "unexpected_error", message: error instanceof Error ? error.message : String(error) } };
}

/** Inverse of errorToWire, so a proxied call fails with the same error class as a local one. */
export function errorFromWire(error: WireError): Error {
  switch (error.code) {
    case "bridge_unavailable":
      return new BridgeUnavailableError(error.message);
    case "bridge_timeout": {
      const timeout = new BridgeTimeoutError("", 0);
      timeout.message = error.message;
      return timeout;
    }
    case "bridge_protocol_mismatch": {
      const details = (error.details ?? {}) as { expectedProtocolVersion?: string; actualProtocolVersion?: string };
      return new BridgeProtocolCompatibilityError(error.message, details.expectedProtocolVersion ?? "", details.actualProtocolVersion);
    }
    default:
      return new BridgeRpcError(error.message, error.code, error.details);
  }
}
