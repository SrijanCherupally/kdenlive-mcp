import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { ProjectError } from "./project.mjs";

const WINDOWS_CANDIDATES = {
  kdenlive: [
    "C:\\Program Files\\kdenlive\\bin\\kdenlive.exe",
    "C:\\Program Files\\Kdenlive\\bin\\kdenlive.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Kdenlive", "bin", "kdenlive.exe"),
  ],
  melt: [
    "C:\\Program Files\\kdenlive\\bin\\melt.exe",
    "C:\\Program Files\\Kdenlive\\bin\\melt.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Kdenlive", "bin", "melt.exe"),
  ],
  ffmpeg: [
    "C:\\Program Files\\kdenlive\\bin\\ffmpeg.exe",
    "C:\\Program Files\\Kdenlive\\bin\\ffmpeg.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Kdenlive", "bin", "ffmpeg.exe"),
  ],
  ffprobe: [
    "C:\\Program Files\\kdenlive\\bin\\ffprobe.exe",
    "C:\\Program Files\\Kdenlive\\bin\\ffprobe.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Kdenlive", "bin", "ffprobe.exe"),
  ],
};

async function isExecutable(filePath) {
  if (!filePath) return false;
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function searchPath(name) {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, process.platform === "win32" ? `${name}${extension.toLowerCase()}` : name);
      if (await isExecutable(candidate)) return candidate;
      const originalCase = path.join(directory, `${name}${extension}`);
      if (originalCase !== candidate && await isExecutable(originalCase)) return originalCase;
    }
  }
  return null;
}

export async function findExecutable(name, explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!(await isExecutable(resolved))) throw new ProjectError(`${name} executable not found: ${resolved}`, "TOOL_NOT_FOUND");
    return resolved;
  }
  const fromEnvironment = process.env[`KDENLIVE_MCP_${name.toUpperCase()}_PATH`];
  if (fromEnvironment && await isExecutable(fromEnvironment)) return path.resolve(fromEnvironment);
  const fromPath = await searchPath(name);
  if (fromPath) return fromPath;
  if (process.platform === "win32") {
    for (const candidate of WINDOWS_CANDIDATES[name] ?? []) {
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export function runProcess(executable, args, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new ProjectError(`Process timed out after ${timeoutMs} ms`, "PROCESS_TIMEOUT", { executable, args }));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ProjectError(`Unable to start ${executable}: ${error.message}`, "PROCESS_START_FAILED"));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, command: [executable, ...args] });
    });
  });
}

async function versionOf(executable, args = ["--version"]) {
  if (!executable) return null;
  try {
    const result = await runProcess(executable, args, { timeoutMs: 10_000 });
    const firstLine = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).find((line) => line.trim());
    return { path: executable, available: result.code === 0, version: firstLine?.trim() ?? null };
  } catch (error) {
    return { path: executable, available: false, version: null, error: error.message };
  }
}

export async function doctor({ kdenlivePath, meltPath, ffmpegPath, ffprobePath, sourcePath } = {}) {
  const resolved = {
    kdenlive: await findExecutable("kdenlive", kdenlivePath),
    melt: await findExecutable("melt", meltPath),
    ffmpeg: await findExecutable("ffmpeg", ffmpegPath),
    ffprobe: await findExecutable("ffprobe", ffprobePath),
  };
  const [kdenlive, melt, ffmpeg, ffprobe] = await Promise.all([
    versionOf(resolved.kdenlive),
    versionOf(resolved.melt),
    versionOf(resolved.ffmpeg, ["-version"]),
    versionOf(resolved.ffprobe, ["-version"]),
  ]);
  let source = null;
  if (sourcePath) {
    const absoluteSource = path.resolve(sourcePath);
    try {
      await access(path.join(absoluteSource, "CMakeLists.txt"), constants.R_OK);
      source = { path: absoluteSource, available: true };
    } catch {
      source = { path: absoluteSource, available: false };
    }
  }
  return {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    hostname: os.hostname(),
    source,
    tools: { kdenlive, melt, ffmpeg, ffprobe },
    capabilities: {
      edit: true,
      exportOtio: true,
      exportKdenlive: true,
      inspectMedia: Boolean(ffprobe?.available),
      previewFrames: Boolean(ffmpeg?.available),
      renderKdenlive: Boolean(kdenlive?.available),
      renderMlt: Boolean(melt?.available),
    },
  };
}

export async function inspectMedia({ source, ffprobePath } = {}) {
  if (!source) throw new ProjectError("source is required", "INVALID_ARGUMENT");
  const executable = await findExecutable("ffprobe", ffprobePath);
  if (!executable) throw new ProjectError("ffprobe was not found; install Kdenlive/FFmpeg or set KDENLIVE_MCP_FFPROBE_PATH", "TOOL_NOT_FOUND");
  const result = await runProcess(executable, [
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-of", "json",
    path.resolve(source),
  ]);
  if (result.code !== 0) throw new ProjectError(`ffprobe failed: ${result.stderr.trim()}`, "PROCESS_FAILED", result);
  return JSON.parse(result.stdout);
}

export async function previewFrame({ source, outputPath, at = 0, width = 960, ffmpegPath } = {}) {
  if (!source || !outputPath) throw new ProjectError("source and outputPath are required", "INVALID_ARGUMENT");
  const executable = await findExecutable("ffmpeg", ffmpegPath);
  if (!executable) throw new ProjectError("ffmpeg was not found; install Kdenlive/FFmpeg or set KDENLIVE_MCP_FFMPEG_PATH", "TOOL_NOT_FOUND");
  const absoluteOutput = path.resolve(outputPath);
  await mkdir(path.dirname(absoluteOutput), { recursive: true });
  const result = await runProcess(executable, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(at), "-i", path.resolve(source),
    "-frames:v", "1", "-vf", `scale=${width}:-2`, absoluteOutput,
  ]);
  if (result.code !== 0) throw new ProjectError(`ffmpeg failed: ${result.stderr.trim()}`, "PROCESS_FAILED", result);
  return { outputPath: absoluteOutput, at, width };
}

export async function createWaveform({ source, outputPath, width = 1200, height = 240, ffmpegPath } = {}) {
  if (!source || !outputPath) throw new ProjectError("source and outputPath are required", "INVALID_ARGUMENT");
  const executable = await findExecutable("ffmpeg", ffmpegPath);
  if (!executable) throw new ProjectError("ffmpeg was not found; install Kdenlive/FFmpeg or set KDENLIVE_MCP_FFMPEG_PATH", "TOOL_NOT_FOUND");
  const absoluteOutput = path.resolve(outputPath);
  await mkdir(path.dirname(absoluteOutput), { recursive: true });
  const result = await runProcess(executable, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", path.resolve(source),
    "-filter_complex", `aformat=channel_layouts=mono,showwavespic=s=${width}x${height}:colors=0x38bdf8`,
    "-frames:v", "1", absoluteOutput,
  ]);
  if (result.code !== 0) throw new ProjectError(`ffmpeg failed: ${result.stderr.trim()}`, "PROCESS_FAILED", result);
  return { outputPath: absoluteOutput, width, height };
}

export async function createContactSheet({ source, outputPath, columns = 4, rows = 3, tileWidth = 320, ffmpegPath } = {}) {
  if (!source || !outputPath) throw new ProjectError("source and outputPath are required", "INVALID_ARGUMENT");
  const executable = await findExecutable("ffmpeg", ffmpegPath);
  if (!executable) throw new ProjectError("ffmpeg was not found; install Kdenlive/FFmpeg or set KDENLIVE_MCP_FFMPEG_PATH", "TOOL_NOT_FOUND");
  const media = await inspectMedia({ source });
  const duration = Number(media.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new ProjectError("Unable to determine media duration", "MEDIA_INVALID");
  const total = columns * rows;
  const interval = duration / (total + 1);
  const absoluteOutput = path.resolve(outputPath);
  await mkdir(path.dirname(absoluteOutput), { recursive: true });
  const result = await runProcess(executable, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", path.resolve(source),
    "-vf", `fps=1/${interval},scale=${tileWidth}:-2,tile=${columns}x${rows}:padding=4:margin=4`,
    "-frames:v", "1", absoluteOutput,
  ]);
  if (result.code !== 0) throw new ProjectError(`ffmpeg failed: ${result.stderr.trim()}`, "PROCESS_FAILED", result);
  return { outputPath: absoluteOutput, columns, rows, sampledDuration: duration };
}

export async function verifyKdenliveProject({ projectPath, kdenlivePath, meltPath } = {}) {
  if (!projectPath) throw new ProjectError("projectPath is required", "INVALID_ARGUMENT");
  const absoluteProject = path.resolve(projectPath);
  try {
    await access(absoluteProject, constants.R_OK);
  } catch {
    throw new ProjectError(`Kdenlive project not found: ${absoluteProject}`, "PROJECT_NOT_FOUND");
  }

  // Kdenlive added --verify-file after the 26.08 release. MLT can validate
  // the same XML on every supported release without starting the GUI.
  const adjacentMelt = kdenlivePath ? path.join(path.dirname(path.resolve(kdenlivePath)), process.platform === "win32" ? "melt.exe" : "melt") : undefined;
  const explicitMelt = meltPath ?? ((await isExecutable(adjacentMelt)) ? adjacentMelt : undefined);
  const executable = await findExecutable("melt", explicitMelt);
  if (!executable) throw new ProjectError("MLT melt was not found; install Kdenlive/MLT or set KDENLIVE_MCP_MELT_PATH", "TOOL_NOT_FOUND");
  const result = await runProcess(executable, [
    absoluteProject,
    "in=0",
    "out=0",
    "-consumer", "null",
    "real_time=-1",
    "-silent",
  ], { timeoutMs: 60_000 });
  const warnings = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    valid: result.code === 0,
    engine: "melt",
    mediaAvailable: !warnings.some((line) => /failed to load producer|invalid resource|failed to open/i.test(line)),
    warnings,
    ...result,
  };
}

export async function openKdenliveProject({ projectPath, kdenlivePath } = {}) {
  if (!projectPath) throw new ProjectError("projectPath is required", "INVALID_ARGUMENT");
  const absoluteProject = path.resolve(projectPath);
  try {
    await access(absoluteProject, constants.R_OK);
  } catch {
    throw new ProjectError(`Kdenlive project not found: ${absoluteProject}`, "PROJECT_NOT_FOUND");
  }
  const executable = await findExecutable("kdenlive", kdenlivePath);
  if (!executable) throw new ProjectError("Kdenlive was not found; install it or set KDENLIVE_MCP_KDENLIVE_PATH", "TOOL_NOT_FOUND");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [absoluteProject], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", (error) => reject(new ProjectError(`Unable to open Kdenlive: ${error.message}`, "PROCESS_START_FAILED")));
    child.once("spawn", () => {
      child.unref();
      resolve({ opened: true, projectPath: absoluteProject, executable, pid: child.pid });
    });
  });
}

export async function renderKdenliveProject({ projectPath, outputPath, preset = "MP4-H264/AAC", async = false, kdenlivePath } = {}) {
  if (!projectPath || !outputPath) throw new ProjectError("projectPath and outputPath are required", "INVALID_ARGUMENT");
  const executable = await findExecutable("kdenlive", kdenlivePath);
  if (!executable) throw new ProjectError("Kdenlive was not found; install it or set KDENLIVE_MCP_KDENLIVE_PATH", "TOOL_NOT_FOUND");
  const absoluteOutput = path.resolve(outputPath);
  await mkdir(path.dirname(absoluteOutput), { recursive: true });
  const args = ["--render", "--render-preset", preset];
  if (async) args.push("--render-async");
  args.push(path.resolve(projectPath), absoluteOutput);
  const result = await runProcess(executable, args, { timeoutMs: async ? 60_000 : 24 * 60 * 60 * 1000 });
  if (result.code !== 0) throw new ProjectError(`Kdenlive render failed: ${result.stderr.trim()}`, "PROCESS_FAILED", result);
  return { outputPath: absoluteOutput, preset, async, ...result };
}
