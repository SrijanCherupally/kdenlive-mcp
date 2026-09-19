import readline from "node:readline";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { TOOL_DEFINITIONS, callTool, resolveDefaultSourcePath } from "./tools.mjs";

const SERVER_INFO = { name: "kdenlive-mcp", version: "0.2.0" };
const INSTRUCTIONS = "All companion editing capabilities are available as MCP tools. Work in a loop: inspect media/project, apply small transactional edits, visualize the timeline/effects or render preview frames, revise, then validate and export. Generated SVG graphics can be created and added in one call. Use named effects when possible and type=mlt for an installed MLT filter that lacks a wrapper. Prefer project_validate before export, project_verify_kdenlive before render, and preview tools before an expensive final project_render. Ask for approval before final renders or overwriting important deliverables.";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorResponse(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

async function mediaContent(result) {
  const candidates = [result?.outputPath, result?.graphic?.outputPath].filter(Boolean);
  const mimeByExtension = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  const content = [];
  for (const candidate of candidates) {
    const mimeType = mimeByExtension[path.extname(candidate).toLowerCase()];
    if (!mimeType) continue;
    try {
      const info = await stat(candidate);
      if (info.size > 5 * 1024 * 1024) continue;
      content.push({ type: "image", data: (await readFile(candidate)).toString("base64"), mimeType });
    } catch {
      // The structured result still reports the path if the preview cannot be embedded.
    }
  }
  return content;
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
      const previews = await mediaContent(result);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }, ...previews],
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
