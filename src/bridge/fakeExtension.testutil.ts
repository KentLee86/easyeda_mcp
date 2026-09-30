// Test helper (not used at runtime): a fake EasyEDA Pro extension that
// connects to a bridge WebSocket, says hello, and answers calls.
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "../protocol/messages.js";

export type FakeHandler = (method: string, params: unknown) => unknown;

export type FakeExtension = {
  socket: WebSocket;
  received: Array<Record<string, unknown>>;
  close(): void;
};

export async function connectFakeExtension(endpoint: string, handler: FakeHandler = (method, params) => ({ method, params })): Promise<FakeExtension> {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const received: Array<Record<string, unknown>> = [];
  socket.on("message", async (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    received.push(message);
    if (message.kind !== "call") {
      return;
    }
    try {
      const result = await handler(String(message.method), message.params);
      socket.send(JSON.stringify({ kind: "result", requestId: message.requestId, result }));
    } catch (error) {
      const err = error as { code?: string; message?: string };
      socket.send(JSON.stringify({ kind: "error", requestId: message.requestId, error: { code: err.code ?? "fake_error", message: err.message ?? String(error) } }));
    }
  });
  socket.send(JSON.stringify({
    kind: "hello",
    client: "easyeda-pro-extension",
    version: "test",
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { websocket: true, apiCall: true },
    status: { documentName: "fake pcb", activeDocumentType: "pcb" }
  }));
  await waitFor(() => received.some((message) => message.kind === "ack"));
  return { socket, received, close: () => socket.close() };
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined };
