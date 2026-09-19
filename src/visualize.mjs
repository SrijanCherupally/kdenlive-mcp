import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { findExecutable, runProcess } from "./toolchain.mjs";
import { inspectProject, ProjectError } from "./project.mjs";

function xml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function writeSvg(outputPath, svg) {
  const absolutePath = path.resolve(outputPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, svg, { encoding: "utf8", flag: "wx" });
  await rename(tempPath, absolutePath);
  return { outputPath: absolutePath, mimeType: "image/svg+xml" };
}

function clipColor(type, kind) {
  if (type === "title") return "#a855f7";
  return kind === "audio" ? "#10b981" : "#0ea5e9";
}

export async function visualizeTimeline({ project, outputPath, width = 1600, rowHeight = 96 } = {}) {
  if (!outputPath) throw new ProjectError("outputPath is required", "INVALID_ARGUMENT");
  const summary = inspectProject(project);
  const labelWidth = 150;
  const top = 70;
  const height = top + Math.max(1, summary.tracks.length) * rowHeight + 50;
  const duration = Math.max(1, summary.duration);
  const scale = (width - labelWidth - 40) / duration;
  const ticks = [];
  const interval = duration <= 20 ? 1 : duration <= 120 ? 5 : 30;
  for (let second = 0; second <= duration; second += interval) {
    const x = labelWidth + second * scale;
    ticks.push(`<line x1="${x}" y1="44" x2="${x}" y2="${height - 30}" stroke="#334155" stroke-width="1"/><text x="${x + 4}" y="34" fill="#94a3b8" font-size="18">${second}s</text>`);
  }
  const rows = [];
  summary.tracks.forEach((track, index) => {
    const y = top + index * rowHeight;
    rows.push(`<rect x="20" y="${y}" width="${width - 40}" height="${rowHeight - 10}" rx="10" fill="#111827"/>`);
    rows.push(`<text x="36" y="${y + 35}" fill="#f8fafc" font-size="21" font-weight="700">${xml(track.name)}</text>`);
    rows.push(`<text x="36" y="${y + 62}" fill="#64748b" font-size="15">${track.kind.toUpperCase()}</text>`);
    for (const clip of track.clips) {
      const x = labelWidth + clip.timelineStart * scale;
      const clipWidth = Math.max(6, clip.duration * scale);
      const color = clipColor(clip.type, track.kind);
      rows.push(`<rect x="${x}" y="${y + 10}" width="${clipWidth}" height="${rowHeight - 30}" rx="8" fill="${color}" opacity="0.9"/>`);
      rows.push(`<text x="${x + 10}" y="${y + 37}" fill="#ffffff" font-size="17" font-weight="700">${xml(clip.name)}</text>`);
      rows.push(`<text x="${x + 10}" y="${y + 61}" fill="#e2e8f0" font-size="14">${clip.duration.toFixed(2)}s · ${clip.effects.length} fx · ${clip.speed}×</text>`);
    }
  });
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#020617"/>
  <text x="24" y="34" fill="#f8fafc" font-family="Inter,Segoe UI,sans-serif" font-size="24" font-weight="800">${xml(summary.name)} · ${summary.duration.toFixed(2)}s</text>
  <g font-family="Inter,Segoe UI,sans-serif">${ticks.join("\n")}${rows.join("\n")}</g>
</svg>\n`;
  return { ...(await writeSvg(outputPath, svg)), width, height, duration: summary.duration, trackCount: summary.trackCount };
}

function findClip(project, clipId) {
  for (const track of project.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { track, clip };
  }
  throw new ProjectError(`Clip not found: ${clipId}`, "NOT_FOUND");
}

export async function visualizeEffects({ project, clipId, outputPath, width = 1200 } = {}) {
  if (!outputPath) throw new ProjectError("outputPath is required", "INVALID_ARGUMENT");
  const { clip } = findClip(project, clipId);
  const cardHeight = 150;
  const height = 100 + Math.max(1, clip.effects.length) * cardHeight;
  const cards = clip.effects.length ? clip.effects.map((effect, index) => {
    const y = 80 + index * cardHeight;
    const keyframeDots = (effect.keyframes ?? []).map((keyframe) => {
      const x = 260 + (keyframe.time / clip.duration) * (width - 310);
      return `<circle cx="${x}" cy="${y + 105}" r="7" fill="#f59e0b"/><text x="${x + 10}" y="${y + 110}" fill="#cbd5e1" font-size="13">${keyframe.time}s</text>`;
    }).join("");
    return `<rect x="24" y="${y}" width="${width - 48}" height="${cardHeight - 16}" rx="12" fill="#111827" stroke="#334155"/>
      <text x="48" y="${y + 38}" fill="#f8fafc" font-size="23" font-weight="800">${xml(effect.type)}</text>
      <text x="48" y="${y + 68}" fill="#94a3b8" font-size="15">${xml(JSON.stringify(effect.parameters))}</text>
      <line x1="260" y1="${y + 105}" x2="${width - 50}" y2="${y + 105}" stroke="#475569" stroke-width="3"/>${keyframeDots}`;
  }).join("\n") : `<text x="48" y="130" fill="#94a3b8" font-size="22">No effects on this clip.</text>`;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#020617"/>
  <g font-family="Inter,Segoe UI,sans-serif">
    <text x="24" y="42" fill="#f8fafc" font-size="26" font-weight="800">Effects · ${xml(clip.name)} · ${clip.duration.toFixed(2)}s</text>
    ${cards}
  </g>
</svg>\n`;
  return { ...(await writeSvg(outputPath, svg)), width, height, clipId, effectCount: clip.effects.length };
}

function effectFilter(effect) {
  const p = effect.parameters ?? {};
  switch (effect.type) {
    case "brightness": return `eq=brightness=${Number(p.amount ?? p.level ?? 0)}`;
    case "contrast": return `eq=contrast=${Number(p.amount ?? p.level ?? 1)}`;
    case "saturation": return `eq=saturation=${Number(p.amount ?? p.level ?? 1)}`;
    case "blur": return `gblur=sigma=${Number(p.sigma ?? p.amount ?? 8)}`;
    case "vignette": return `vignette=PI/${Number(p.angleDivisor ?? 5)}`;
    case "opacity": return `format=rgba,colorchannelmixer=aa=${Number(p.amount ?? 1)}`;
    case "chroma_key": return `chromakey=${p.color ?? "0x00ff00"}:${Number(p.similarity ?? 0.2)}:${Number(p.blend ?? 0.1)}`;
    default: return null;
  }
}

export async function previewEffectComparison({ source, outputPath, at = 0, effect, width = 720, ffmpegPath } = {}) {
  if (!source || !outputPath || !effect) throw new ProjectError("source, outputPath, and effect are required", "INVALID_ARGUMENT");
  const filter = effectFilter(effect);
  if (!filter) throw new ProjectError(`Effect comparison does not support ${effect.type}`, "INVALID_ARGUMENT");
  const executable = await findExecutable("ffmpeg", ffmpegPath);
  if (!executable) throw new ProjectError("ffmpeg was not found; install Kdenlive/FFmpeg or set KDENLIVE_MCP_FFMPEG_PATH", "TOOL_NOT_FOUND");
  const absoluteOutput = path.resolve(outputPath);
  await mkdir(path.dirname(absoluteOutput), { recursive: true });
  const graph = `[0:v]scale=${width}:-2,split=2[before][fxin];[fxin]${filter}[after];[before]drawtext=text='BEFORE':x=24:y=24:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6[b];[after]drawtext=text='AFTER':x=24:y=24:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6[a];[b][a]hstack=inputs=2[out]`;
  const result = await runProcess(executable, [
    "-hide_banner", "-loglevel", "error", "-y", "-ss", String(at), "-i", path.resolve(source),
    "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", absoluteOutput,
  ]);
  if (result.code !== 0) throw new ProjectError(`ffmpeg effect preview failed: ${result.stderr.trim()}`, "PROCESS_FAILED", result);
  return { outputPath: absoluteOutput, mimeType: "image/png", at, effect };
}

