import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEasyEdaTools } from "./registerTools.js";
import type { BridgeClient } from "../bridge/types.js";
import { PROTOCOL_VERSION } from "../protocol/messages.js";
import { SERVER_VERSION } from "../version.js";

export const MCP_SERVER_NAME = "easyeda-pro-mcp";
export const MCP_SERVER_VERSION = SERVER_VERSION;
export const MCP_BRIDGE_PROTOCOL_VERSION = PROTOCOL_VERSION;

export function createMcpServer(bridge: BridgeClient): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION
  });

  registerEasyEdaTools(server, bridge);

  return server;
}
