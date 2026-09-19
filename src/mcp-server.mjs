import readline from "node:readline";
import { TOOL_DEFINITIONS, callTool, resolveDefaultSourcePath } from "./tools.mjs";

const SERVER_INFO = { name: "kdenlive-mcp", version: "0.1.0" };
const INSTRUCTIONS = "Use read-only inspection tools freely. Project edits are transactional and create backups when replacing files. Prefer project_validate before export, project_verify_kdenlive before render, and preview tools before an expensive final project_render. Ask for approval before final renders or overwriting important deliverables.";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorResponse(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

async function handleRequest(request) {
  const { id, method, params } = request;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOL_DEFINITIONS } };
  if (method === "tools/call") {
    const args = { ...(params?.arguments ?? {}) };
    if (params?.name === "doctor" && args.sourcePath === undefined) args.sourcePath = resolveDefaultSourcePath();
    try {
      const result = await callTool(params?.name, args);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        },
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: error.message }],
          structuredContent: { error: error.message, code: error.code, details: error.details },
          isError: true,
        },
      };
    }
  }
  if (method?.startsWith("notifications/")) return null;
  return errorResponse(id, -32601, `Method not found: ${method}`);
}

export async function runMcpServer() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      send(errorResponse(null, -32700, "Parse error", error.message));
      continue;
    }
    try {
      const response = await handleRequest(request);
      if (response && request.id !== undefined) send(response);
    } catch (error) {
      if (request.id !== undefined) send(errorResponse(request.id, -32603, error.message));
    }
  }
}

