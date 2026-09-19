import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProjectError } from "./project.mjs";

export const GRAPHIC_TEMPLATES = Object.freeze([
  "lower_third",
  "title_card",
  "badge",
  "callout",
  "progress_bar",
  "subscribe",
]);

function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function color(value, fallback) {
  const candidate = value ?? fallback;
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(candidate) && !/^[a-z]+$/i.test(candidate)) {
    throw new ProjectError(`Invalid SVG color: ${candidate}`, "INVALID_ARGUMENT");
  }
  return candidate;
}

function number(value, fallback, min = 0) {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate < min) throw new ProjectError(`Invalid numeric graphic parameter: ${candidate}`, "INVALID_ARGUMENT");
  return candidate;
}

function wrapSvg(width, height, body, background = "transparent") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${xml(background)}"/>
${body}
</svg>
`;
}

function renderTemplate(template, options) {
  const width = number(options.width, 1920, 1);
  const height = number(options.height, 1080, 1);
  const accent = color(options.accent, "#38bdf8");
  const foreground = color(options.foreground, "#ffffff");
  const background = color(options.background, "#101827dd");
  const title = xml(options.title ?? (template === "subscribe" ? "SUBSCRIBE" : "Title"));
  const subtitle = xml(options.subtitle ?? "");
  const fontFamily = xml(options.fontFamily ?? "Inter, Segoe UI, sans-serif");

  if (template === "lower_third") {
    const x = number(options.x, Math.round(width * 0.06));
    const y = number(options.y, Math.round(height * 0.72));
    const boxWidth = number(options.boxWidth, Math.round(width * 0.58), 100);
    const boxHeight = number(options.boxHeight, Math.round(height * 0.18), 80);
    return { width, height, svg: wrapSvg(width, height, `
  <g filter="url(#shadow)">
    <defs><filter id="shadow"><feDropShadow dx="0" dy="12" stdDeviation="16" flood-opacity="0.32"/></filter></defs>
    <rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" rx="22" fill="${background}"/>
    <rect x="${x}" y="${y}" width="12" height="${boxHeight}" rx="6" fill="${accent}"/>
    <text x="${x + 52}" y="${y + boxHeight * 0.47}" fill="${foreground}" font-family="${fontFamily}" font-size="${Math.round(height * 0.052)}" font-weight="700">${title}</text>
    <text x="${x + 52}" y="${y + boxHeight * 0.76}" fill="${accent}" font-family="${fontFamily}" font-size="${Math.round(height * 0.028)}" font-weight="500">${subtitle}</text>
  </g>`) };
  }

  if (template === "title_card") {
    return { width, height, svg: wrapSvg(width, height, `
  <defs><radialGradient id="bg" cx="50%" cy="40%" r="80%"><stop offset="0" stop-color="${accent}" stop-opacity="0.26"/><stop offset="1" stop-color="${background}"/></radialGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect x="${width * 0.42}" y="${height * 0.32}" width="${width * 0.16}" height="8" rx="4" fill="${accent}"/>
  <text x="${width / 2}" y="${height * 0.51}" text-anchor="middle" fill="${foreground}" font-family="${fontFamily}" font-size="${Math.round(height * 0.085)}" font-weight="800">${title}</text>
  <text x="${width / 2}" y="${height * 0.61}" text-anchor="middle" fill="${foreground}" opacity="0.78" font-family="${fontFamily}" font-size="${Math.round(height * 0.038)}">${subtitle}</text>`, background) };
  }

  if (template === "badge") {
    const x = number(options.x, Math.round(width * 0.06));
    const y = number(options.y, Math.round(height * 0.08));
    const boxWidth = number(options.boxWidth, Math.round(width * 0.28), 100);
    const boxHeight = number(options.boxHeight, Math.round(height * 0.09), 50);
    return { width, height, svg: wrapSvg(width, height, `
  <rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" rx="${boxHeight / 2}" fill="${background}" stroke="${accent}" stroke-width="4"/>
  <circle cx="${x + boxHeight / 2}" cy="${y + boxHeight / 2}" r="${boxHeight * 0.22}" fill="${accent}"/>
  <text x="${x + boxHeight}" y="${y + boxHeight * 0.66}" fill="${foreground}" font-family="${fontFamily}" font-size="${Math.round(boxHeight * 0.38)}" font-weight="700">${title}</text>`) };
  }

  if (template === "callout") {
    const x = number(options.x, Math.round(width * 0.58));
    const y = number(options.y, Math.round(height * 0.18));
    const targetX = number(options.targetX, Math.round(width * 0.74));
    const targetY = number(options.targetY, Math.round(height * 0.58));
    return { width, height, svg: wrapSvg(width, height, `
  <path d="M ${x + 220} ${y + 92} L ${targetX} ${targetY}" stroke="${accent}" stroke-width="8" stroke-linecap="round"/>
  <circle cx="${targetX}" cy="${targetY}" r="34" fill="none" stroke="${accent}" stroke-width="8"/>
  <rect x="${x}" y="${y}" width="440" height="120" rx="20" fill="${background}" stroke="${accent}" stroke-width="3"/>
  <text x="${x + 28}" y="${y + 72}" fill="${foreground}" font-family="${fontFamily}" font-size="42" font-weight="700">${title}</text>`) };
  }

  if (template === "progress_bar") {
    const progress = Math.min(1, Math.max(0, number(options.progress, 0.65)));
    const barWidth = width * 0.78;
    return { width, height, svg: wrapSvg(width, height, `
  <rect x="${width * 0.11}" y="${height * 0.88}" width="${barWidth}" height="28" rx="14" fill="${background}"/>
  <rect x="${width * 0.11}" y="${height * 0.88}" width="${barWidth * progress}" height="28" rx="14" fill="${accent}"/>
  <text x="${width * 0.11}" y="${height * 0.85}" fill="${foreground}" font-family="${fontFamily}" font-size="34" font-weight="600">${title}</text>`) };
  }

  if (template === "subscribe") {
    const boxWidth = width * 0.3;
    const boxHeight = height * 0.105;
    const x = (width - boxWidth) / 2;
    const y = height * 0.78;
    return { width, height, svg: wrapSvg(width, height, `
  <g filter="url(#shadow)"><defs><filter id="shadow"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-opacity="0.38"/></filter></defs>
    <rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" rx="${boxHeight / 2}" fill="${accent}"/>
    <path d="M ${x + 52} ${y + 34} L ${x + 52} ${y + boxHeight - 34} L ${x + 98} ${y + boxHeight / 2} Z" fill="${foreground}"/>
    <text x="${x + 132}" y="${y + boxHeight * 0.66}" fill="${foreground}" font-family="${fontFamily}" font-size="${Math.round(boxHeight * 0.36)}" font-weight="800">${title}</text>
  </g>`) };
  }

  throw new ProjectError(`Unknown graphic template: ${template}`, "INVALID_ARGUMENT");
}

async function atomicWrite(outputPath, contents) {
  const absolutePath = path.resolve(outputPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, contents, { encoding: "utf8", flag: "wx" });
  await rename(tempPath, absolutePath);
  return absolutePath;
}

export function listGraphicTemplates() {
  return GRAPHIC_TEMPLATES.map((template) => ({
    template,
    description: {
      lower_third: "Name/title panel for interviews and presenters.",
      title_card: "Full-frame branded section or opener card.",
      badge: "Small pill label for topics, chapters, or status.",
      callout: "Label connected to a highlighted point in the frame.",
      progress_bar: "Branded progress or chapter indicator.",
      subscribe: "Compact call-to-action button overlay.",
    }[template],
  }));
}

export async function createGraphic({ template, outputPath, ...options } = {}) {
  if (!GRAPHIC_TEMPLATES.includes(template)) {
    throw new ProjectError(`template must be one of: ${GRAPHIC_TEMPLATES.join(", ")}`, "INVALID_ARGUMENT");
  }
  if (!outputPath) throw new ProjectError("outputPath is required", "INVALID_ARGUMENT");
  const rendered = renderTemplate(template, options);
  const absolutePath = await atomicWrite(outputPath, rendered.svg);
  return {
    outputPath: absolutePath,
    template,
    width: rendered.width,
    height: rendered.height,
    mimeType: "image/svg+xml",
  };
}
