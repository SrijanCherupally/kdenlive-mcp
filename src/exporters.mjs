import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { framesFromSeconds, inspectProject, ProjectError, validateProject } from "./project.mjs";

function clone(value) {
  return structuredClone(value);
}

function rationalTime(value, rate) {
  return { OTIO_SCHEMA: "RationalTime.1", rate, value };
}

function timeRange(start, duration, rate) {
  return {
    OTIO_SCHEMA: "TimeRange.1",
    duration: rationalTime(duration, rate),
    start_time: rationalTime(start, rate),
  };
}

function otioGap(duration, rate) {
  return {
    OTIO_SCHEMA: "Gap.1",
    metadata: {},
    name: "",
    source_range: timeRange(0, duration, rate),
    effects: [],
    markers: [],
    enabled: true,
  };
}

function otioClip(clip, rate) {
  if (clip.type === "title") {
    return {
      OTIO_SCHEMA: "Clip.2",
      metadata: { kdenliveMcp: { type: "title", text: clip.text, style: clone(clip.style) } },
      name: clip.name,
      source_range: timeRange(0, clip.duration * rate, rate),
      effects: [],
      markers: [],
      enabled: true,
      media_references: {
        DEFAULT_MEDIA: {
          OTIO_SCHEMA: "GeneratorReference.1",
          metadata: { kdenlive: { text: clip.text, style: clone(clip.style) } },
          name: clip.name,
          generator_kind: "kdenlive:Title",
          available_range: timeRange(0, clip.duration * rate, rate),
          parameters: { text: clip.text, ...clone(clip.style) },
        },
      },
      active_media_reference_key: "DEFAULT_MEDIA",
    };
  }

  return {
    OTIO_SCHEMA: "Clip.2",
    metadata: { kdenliveMcp: { id: clip.id, volume: clip.volume, effects: clone(clip.effects ?? []) } },
    name: clip.name,
    source_range: timeRange(clip.sourceIn * rate, clip.duration * rate, rate),
    effects: [],
    markers: [],
    enabled: true,
    media_references: {
      DEFAULT_MEDIA: {
        OTIO_SCHEMA: "ExternalReference.1",
        metadata: {},
        name: clip.name,
        available_range: null,
        available_image_bounds: null,
        target_url: pathToFileURL(clip.source).href,
      },
    },
    active_media_reference_key: "DEFAULT_MEDIA",
  };
}

function otioTransition(transition, rate) {
  const frames = transition.duration * rate;
  return {
    OTIO_SCHEMA: "Transition.1",
    metadata: { kdenliveMcp: { id: transition.id, type: transition.type } },
    name: transition.type === "wipe" ? "Wipe" : "Dissolve",
    transition_type: transition.type === "wipe" ? "SMPTE_Dissolve" : "SMPTE_Dissolve",
    in_offset: rationalTime(frames / 2, rate),
    out_offset: rationalTime(frames / 2, rate),
  };
}

export function toOtio(project) {
  validateProject(project, { throwOnError: true });
  const rate = project.profile.fpsNumerator / project.profile.fpsDenominator;
  const transitionByPair = new Map(
    project.transitions.map((transition) => [`${transition.fromClipId}\u0000${transition.toClipId}`, transition]),
  );

  const tracks = project.tracks.map((track) => {
    const children = [];
    const clips = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart || a.id.localeCompare(b.id));
    let cursor = 0;
    let previous = null;
    for (const clip of clips) {
      const gap = clip.timelineStart - cursor;
      if (gap > 1e-9) children.push(otioGap(gap * rate, rate));
      if (previous) {
        const transition = transitionByPair.get(`${previous.id}\u0000${clip.id}`);
        if (transition && Math.abs(previous.timelineStart + previous.duration - clip.timelineStart) < 1e-6) {
          children.push(otioTransition(transition, rate));
        }
      }
      children.push(otioClip(clip, rate));
      cursor = clip.timelineStart + clip.duration;
      previous = clip;
    }
    return {
      OTIO_SCHEMA: "Track.1",
      metadata: { kdenliveMcp: { id: track.id, muted: track.muted, hidden: track.hidden } },
      name: track.name,
      source_range: null,
      effects: [],
      markers: [],
      enabled: !track.hidden,
      children,
      kind: track.kind === "video" ? "Video" : "Audio",
    };
  });

  return {
    OTIO_SCHEMA: "Timeline.1",
    metadata: {
      kdenliveMcp: {
        projectId: project.id,
        revision: project.revision,
        profile: clone(project.profile),
      },
    },
    name: project.name,
    global_start_time: null,
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      metadata: {},
      name: "tracks",
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      children: tracks,
    },
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function property(name, value, indent = "  ") {
  return `${indent}<property name="${escapeXml(name)}">${escapeXml(value)}</property>`;
}

function producerXml(clip, producerId, profile) {
  const durationFrames = Math.max(1, framesFromSeconds(clip.duration, profile));
  const sourceInFrames = framesFromSeconds(clip.sourceIn, profile);
  const sourceOutFrames = sourceInFrames + durationFrames - 1;
  const properties = [];
  if (clip.type === "title") {
    properties.push(property("resource", clip.text));
    properties.push(property("mlt_service", "qtext"));
    properties.push(property("text", clip.text));
    properties.push(property("fgcolour", clip.style.color));
    properties.push(property("bgcolour", clip.style.background));
    properties.push(property("family", clip.style.font));
    properties.push(property("size", clip.style.fontSize));
    properties.push(property("weight", 400));
    properties.push(property("kdenlive:clip_type", 2));
  } else {
    const extension = path.extname(clip.source).toLowerCase();
    const isImage = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]).has(extension);
    const speed = clip.speed ?? 1;
    if (speed !== 1 && !isImage) {
      properties.push(property("resource", `${speed}:${clip.source}`));
      properties.push(property("warp_resource", clip.source));
      properties.push(property("warp_speed", speed));
      properties.push(property("mlt_service", "timewarp"));
    } else {
      properties.push(property("resource", clip.source));
      properties.push(property("mlt_service", isImage ? "qimage" : "avformat-novalidate"));
      if (isImage) properties.push(property("ttl", durationFrames));
    }
    properties.push(property("kdenlive:clip_type", 0));
  }
  properties.push(property("kdenlive:id", clip.id));
  properties.push(property("kdenlive:clipname", clip.name));
  properties.push(property("kdenlive:folderid", -1));
  if (clip.type === "media" && clip.volume !== 1) {
    properties.push("  <filter>");
    properties.push(property("mlt_service", "volume", "   "));
    properties.push(property("level", clip.volume, "   "));
    properties.push(property("kdenlive_id", "volume", "   "));
    properties.push("  </filter>");
  }
  return [
    `<producer id="${producerId}" in="${sourceInFrames}" out="${sourceOutFrames}">`,
    ...properties,
    " </producer>",
  ].join("\n");
}

function effectValue(effect, parameterName, fallback, profile) {
  const keyframes = (effect.keyframes ?? []).filter((keyframe) => keyframe.values?.[parameterName] !== undefined);
  if (keyframes.length) {
    return keyframes.map((keyframe) => `${framesFromSeconds(keyframe.time, profile)}=${keyframe.values[parameterName]}`).join(";");
  }
  return effect.parameters?.[parameterName] ?? fallback;
}

function effectFilterXml(effect, profile, indent = "   ") {
  const lines = [`${indent}<filter>`];
  const add = (name, value) => lines.push(property(name, value, `${indent} `));
  const serviceByType = {
    brightness: "brightness",
    contrast: "avfilter.eq",
    saturation: "avfilter.eq",
    blur: "avfilter.gblur",
    vignette: "avfilter.vignette",
    opacity: "brightness",
    transform: "qtblend",
    zoom_pan: "qtblend",
    chroma_key: "avfilter.chromakey",
    fade_in: "brightness",
    fade_out: "brightness",
    mlt: effect.parameters?.service,
  };
  const service = serviceByType[effect.type];
  if (!service) return "";
  add("mlt_service", service);
  add("kdenlive_id", effect.type === "mlt" ? (effect.parameters?.kdenliveId ?? service) : effect.type);
  add("disable", effect.enabled === false ? 1 : 0);
  add("kdenlive-mcp:effect", JSON.stringify(effect));
  switch (effect.type) {
    case "brightness": add("level", effectValue(effect, "amount", 0, profile)); break;
    case "contrast": add("av.contrast", effectValue(effect, "amount", 1, profile)); break;
    case "saturation": add("av.saturation", effectValue(effect, "amount", 1, profile)); break;
    case "blur": add("av.sigma", effectValue(effect, "sigma", 8, profile)); break;
    case "vignette": add("av.angle", effectValue(effect, "angle", "PI/5", profile)); break;
    case "opacity": add("alpha", effectValue(effect, "amount", 1, profile)); break;
    case "chroma_key":
      add("av.color", effect.parameters?.color ?? "0x00ff00");
      add("av.similarity", effectValue(effect, "similarity", 0.2, profile));
      add("av.blend", effectValue(effect, "blend", 0.1, profile));
      break;
    case "transform":
    case "zoom_pan": {
      const x = effect.parameters?.x ?? 0;
      const y = effect.parameters?.y ?? 0;
      const width = effect.parameters?.width ?? "100%";
      const height = effect.parameters?.height ?? "100%";
      add("rect", effectValue(effect, "rect", `${x} ${y} ${width} ${height} 1`, profile));
      add("rotation", effectValue(effect, "rotation", 0, profile));
      break;
    }
    case "fade_in":
      add("alpha", `0=0;${framesFromSeconds(effect.parameters?.duration ?? 1, profile)}=1`);
      break;
    case "fade_out":
      add("alpha", `0=1;${framesFromSeconds(effect.parameters?.duration ?? 1, profile)}=0`);
      break;
    case "mlt":
      for (const [name, value] of Object.entries(effect.parameters?.properties ?? {})) add(name, value);
      break;
  }
  lines.push(`${indent}</filter>`);
  return lines.join("\n");
}

function playlistXml(track, playlistId, clipToProducer, profile) {
  const lines = [` <playlist id="${playlistId}">`];
  if (track.kind === "audio") lines.push(property("kdenlive:audio_track", 1));
  let cursorFrames = 0;
  for (const clip of [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart || a.id.localeCompare(b.id))) {
    const startFrames = framesFromSeconds(clip.timelineStart, profile);
    if (startFrames > cursorFrames) lines.push(`  <blank length="${startFrames - cursorFrames}"/>`);
    const inFrame = framesFromSeconds(clip.sourceIn, profile);
    const durationFrames = Math.max(1, framesFromSeconds(clip.duration, profile));
    lines.push(`  <entry producer="${clipToProducer.get(clip.id)}" in="${inFrame}" out="${inFrame + durationFrames - 1}">`);
    lines.push(property("kdenlive:id", clip.id, "   "));
    for (const effect of clip.effects ?? []) {
      const filter = effectFilterXml(effect, profile);
      if (filter) lines.push(filter);
    }
    lines.push("  </entry>");
    cursorFrames = startFrames + durationFrames;
  }
  lines.push(" </playlist>");
  return lines.join("\n");
}

function trackTractorXml(track, tractorId, playlistA, playlistB, profile) {
  const end = Math.max(
    0,
    ...track.clips.map((clip) => framesFromSeconds(clip.timelineStart + clip.duration, profile) - 1),
  );
  const hide = track.kind === "audio" ? "video" : "audio";
  const lines = [` <tractor id="${tractorId}" in="0" out="${end}">`];
  if (track.kind === "audio") lines.push(property("kdenlive:audio_track", 1));
  lines.push(property("kdenlive:track_name", track.name));
  lines.push(property("kdenlive:timeline_active", track.hidden ? 0 : 1));
  lines.push(property("kdenlive:locked_track", 0));
  lines.push(`  <track hide="${hide}" producer="${playlistA}"/>`);
  lines.push(`  <track hide="${hide}" producer="${playlistB}"/>`);
  if (track.muted) {
    lines.push("  <filter>");
    lines.push(property("mlt_service", "volume", "   "));
    lines.push(property("level", 0, "   "));
    lines.push("  </filter>");
  }
  lines.push(" </tractor>");
  return lines.join("\n");
}

export function toKdenliveXml(project, { rootDirectory = "." } = {}) {
  validateProject(project, { throwOnError: true });
  const profile = project.profile;
  const clipToProducer = new Map();
  const producers = [];
  let producerIndex = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const producerId = `producer${producerIndex++}`;
      clipToProducer.set(clip.id, producerId);
      producers.push(producerXml(clip, producerId, profile));
    }
  }

  const projectInfo = inspectProject(project);
  const lines = [
    "<?xml version='1.0' encoding='utf-8'?>",
    `<mlt LC_NUMERIC="C" producer="main_bin" version="7.38.0" root="${escapeXml(path.resolve(rootDirectory))}">`,
    ` <profile frame_rate_num="${profile.fpsNumerator}" frame_rate_den="${profile.fpsDenominator}" width="${profile.width}" height="${profile.height}" progressive="${profile.progressive ? 1 : 0}" sample_aspect_num="${profile.sampleAspectNumerator}" sample_aspect_den="${profile.sampleAspectDenominator}" display_aspect_num="${profile.displayAspectNumerator}" display_aspect_den="${profile.displayAspectDenominator}" colorspace="${profile.colorspace}" description="${escapeXml(`${profile.width}x${profile.height} ${profile.fpsNumerator / profile.fpsDenominator} fps`)}"/>`,
    ...producers,
    " <playlist id=" + '"main_bin">',
    property("kdenlive:docproperties.version", "1.1"),
    property("kdenlive:docproperties.patchversion", "1"),
    property("kdenlive:docproperties.kdenliveversion", project.metadata?.targetKdenliveVersion ?? "26.11.70"),
    property("kdenlive:docproperties.documentid", project.id),
    property("kdenlive:docproperties.position", 0),
    property("kdenlive:docproperties.zonein", 0),
    property("kdenlive:docproperties.zoneout", Math.max(0, framesFromSeconds(projectInfo.duration, profile) - 1)),
    property("kdenlive:docproperties.audioChannels", 2),
    property("kdenlive:docproperties.enableproxy", 0),
    property("kdenlive:docproperties.enableexternalproxy", 0),
    property("kdenlive:documentnotes", `Created by kdenlive-mcp; source project ${project.id}`),
    property("kdenlive-mcp:transitions", JSON.stringify(project.transitions)),
    property("xml_retain", 1),
  ];
  for (const [clipId, producerId] of clipToProducer) {
    lines.push(`  <entry producer="${producerId}" in="0" out="0">`);
    lines.push(property("kdenlive:id", clipId, "   "));
    lines.push("  </entry>");
  }
  lines.push(" </playlist>");
  lines.push(" <producer id=" + '"black_track" in="0" out="2147483646">');
  lines.push(property("length", 2147483647));
  lines.push(property("eof", "continue"));
  lines.push(property("resource", "black"));
  lines.push(property("mlt_service", "color"));
  lines.push(property("mlt_image_format", "rgba"));
  lines.push(" </producer>");

  const trackTractors = [];
  project.tracks.forEach((track, index) => {
    const playlistA = `playlist${index * 2}`;
    const playlistB = `playlist${index * 2 + 1}`;
    const tractorId = `tractor${index}`;
    lines.push(playlistXml(track, playlistA, clipToProducer, profile));
    lines.push(` <playlist id="${playlistB}"${track.kind === "audio" ? "><property name=\"kdenlive:audio_track\">1</property></playlist>" : "/>"}`);
    lines.push(trackTractorXml(track, tractorId, playlistA, playlistB, profile));
    trackTractors.push({ id: tractorId, kind: track.kind });
  });

  const mainTractorId = `tractor${project.tracks.length}`;
  lines.push(` <tractor id="${mainTractorId}" in="0" out="${Math.max(0, framesFromSeconds(projectInfo.duration, profile) - 1)}">`);
  lines.push("  <track producer=" + '"black_track"/>');
  trackTractors.forEach((track, index) => {
    lines.push(`  <track producer="${track.id}"/>`);
    lines.push("  <transition>");
    lines.push(property("a_track", 0, "   "));
    lines.push(property("b_track", index + 1, "   "));
    lines.push(property("mlt_service", track.kind === "audio" ? "mix" : "frei0r.cairoblend", "   "));
    lines.push(property("kdenlive_id", track.kind === "audio" ? "mix" : "frei0r.cairoblend", "   "));
    lines.push(property("always_active", 1, "   "));
    if (track.kind === "audio") {
      lines.push(property("accepts_blanks", 1, "   "));
      lines.push(property("sum", 1, "   "));
    }
    lines.push("  </transition>");
  });
  lines.push(" </tractor>");
  lines.push("</mlt>");
  return `${lines.join("\n")}\n`;
}

async function atomicWrite(filePath, contents, { createBackup = true } = {}) {
  const absolutePath = path.resolve(filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, contents, { encoding: "utf8", flag: "wx" });
  let backupPath = null;
  try {
    await readFile(absolutePath);
    if (createBackup) {
      const backupDirectory = path.join(path.dirname(absolutePath), ".kdenlive-mcp-backups");
      await mkdir(backupDirectory, { recursive: true });
      backupPath = path.join(backupDirectory, `${path.basename(absolutePath)}.${new Date().toISOString().replaceAll(":", "-")}.bak`);
      await copyFile(absolutePath, backupPath);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await rename(tempPath, absolutePath);
  return { outputPath: absolutePath, backupPath };
}

export async function exportOtio(project, outputPath, options) {
  if (!outputPath) throw new ProjectError("outputPath is required", "INVALID_ARGUMENT");
  return atomicWrite(outputPath, `${JSON.stringify(toOtio(project), null, 2)}\n`, options);
}

export async function exportKdenlive(project, outputPath, options) {
  if (!outputPath) throw new ProjectError("outputPath is required", "INVALID_ARGUMENT");
  return atomicWrite(outputPath, toKdenliveXml(project, { rootDirectory: path.dirname(path.resolve(outputPath)) }), options);
}
