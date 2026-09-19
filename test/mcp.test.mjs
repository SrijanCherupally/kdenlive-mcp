import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function startServer() {
  return spawn(process.execPath, [path.join(packageRoot, "bin", "kdenlive-mcp.mjs")], {
    cwd: packageRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function responseReader(stream) {
  let buffer = "";
  const waiting = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line && waiting.length) waiting.shift().resolve(JSON.parse(line));
    }
  });
  return () => new Promise((resolve, reject) => waiting.push({ resolve, reject }));
}

test("MCP server initializes and lists editing tools", async (context) => {
  const child = startServer();
  context.after(() => child.kill());
  const nextResponse = responseReader(child.stdout);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`);
  const initialized = await nextResponse();
  assert.equal(initialized.result.serverInfo.name, "kdenlive-mcp");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  const listed = await nextResponse();
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("project_create"));
  assert.ok(names.includes("project_render"));
  assert.equal(listed.result.tools.find((tool) => tool.name === "project_inspect").annotations.readOnlyHint, true);
});

test("MCP tool errors are returned as tool results", async (context) => {
  const child = startServer();
  context.after(() => child.kill());
  const nextResponse = responseReader(child.stdout);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "project_inspect", arguments: { projectPath: "missing.json" } } })}\n`);
  const response = await nextResponse();
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Unable to read project/);
});

