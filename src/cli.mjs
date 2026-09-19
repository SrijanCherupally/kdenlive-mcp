import { TOOL_DEFINITIONS, callTool, resolveDefaultSourcePath } from "./tools.mjs";

function camelCase(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return Number(raw);
  return raw;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--json") {
      const value = rest[++index];
      if (value === undefined) throw new Error("--json requires a JSON object");
      Object.assign(args, JSON.parse(value));
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const equals = token.indexOf("=");
    if (equals > 2) {
      args[camelCase(token.slice(2, equals))] = parseValue(token.slice(equals + 1));
      continue;
    }
    const key = camelCase(token.slice(2));
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = parseValue(value);
      index += 1;
    }
  }
  return { command, args };
}

function help() {
  const commands = TOOL_DEFINITIONS.map((definition) => `  ${definition.name.padEnd(28)} ${definition.description}`).join("\n");
  return `kdenlive-cli — transactional video-editing companion\n\nUsage:\n  kdenlive-cli <command> [--option value ...]\n  kdenlive-cli <command> --json '{"option":"value"}'\n\nCommands:\n${commands}\n\nExamples:\n  kdenlive-cli project_create --project-path edit.json --name "My edit"\n  kdenlive-cli clip_add --project-path edit.json --track-id v1 --source clip.mp4 --duration 8.5\n  kdenlive-cli project_export_kdenlive --project-path edit.json --output-path edit.kdenlive\n\nAll successful commands emit JSON to stdout. Errors emit JSON to stderr and use a non-zero exit code.\n`;
}

export async function runCli(argv) {
  if (argv.length === 0 || new Set(["help", "--help", "-h"]).has(argv[0])) {
    process.stdout.write(help());
    return;
  }
  const { command, args } = parseArgs(argv);
  const normalized = command.replaceAll("-", "_");
  if (!TOOL_DEFINITIONS.some((definition) => definition.name === normalized)) {
    throw new Error(`Unknown command: ${command}. Run 'kdenlive-cli help' for available commands.`);
  }
  if (normalized === "doctor" && args.sourcePath === undefined) {
    args.sourcePath = resolveDefaultSourcePath();
  }
  const result = await callTool(normalized, args);
  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
}

