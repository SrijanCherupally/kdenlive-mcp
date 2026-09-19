import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const SCHEMA_VERSION = 1;
export const EFFECT_TYPES = Object.freeze([
  "brightness",
  "contrast",
  "saturation",
  "blur",
  "vignette",
  "opacity",
  "transform",
  "zoom_pan",
  "chroma_key",
  "fade_in",
  "fade_out",
  "mlt",
]);
export const DEFAULT_PROFILE = Object.freeze({
  width: 1920,
  height: 1080,
  fpsNumerator: 30,
  fpsDenominator: 1,
  progressive: true,
  sampleAspectNumerator: 1,
  sampleAspectDenominator: 1,
  displayAspectNumerator: 16,
  displayAspectDenominator: 9,
  colorspace: 709,
});

export class ProjectError extends Error {
  constructor(message, code = "PROJECT_ERROR", details = undefined) {
    super(message);
    this.name = "ProjectError";
    this.code = code;
    this.details = details;
  }
}

function assertFiniteNumber(value, name, { min = -Infinity, exclusiveMin = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProjectError(`${name} must be a finite number`, "INVALID_ARGUMENT");
  }
  if (exclusiveMin ? value <= min : value < min) {
    const comparison = exclusiveMin ? "greater than" : "at least";
    throw new ProjectError(`${name} must be ${comparison} ${min}`, "INVALID_ARGUMENT");
  }
  return value;
}

function assertNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProjectError(`${name} must be a non-empty string`, "INVALID_ARGUMENT");
  }
  return value.trim();
}

function getTrack(project, trackId) {
  const track = project.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new ProjectError(`Track not found: ${trackId}`, "NOT_FOUND");
  return track;
}

function findClip(project, clipId) {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((candidate) => candidate.id === clipId);
    if (index >= 0) return { track, index, clip: track.clips[index] };
  }
  throw new ProjectError(`Clip not found: ${clipId}`, "NOT_FOUND");
}

function sortedClips(track) {
  return [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart || a.id.localeCompare(b.id));
}

function clone(value) {
  return structuredClone(value);
}

export function createProject({ name, width, height, fpsNumerator, fpsDenominator } = {}) {
  const profile = { ...DEFAULT_PROFILE };
  if (width !== undefined) profile.width = assertFiniteNumber(width, "width", { min: 1 });
  if (height !== undefined) profile.height = assertFiniteNumber(height, "height", { min: 1 });
  if (fpsNumerator !== undefined) profile.fpsNumerator = assertFiniteNumber(fpsNumerator, "fpsNumerator", { min: 1 });
  if (fpsDenominator !== undefined) profile.fpsDenominator = assertFiniteNumber(fpsDenominator, "fpsDenominator", { min: 1 });

  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: randomUUID(),
    revision: 0,
    name: name?.trim() || "Untitled",
    createdAt: now,
    updatedAt: now,
    profile,
    tracks: [],
    transitions: [],
    metadata: {
      generator: "kdenlive-mcp/0.2.0",
      targetKdenliveVersion: "26.11.70",
    },
  };
}

export function addTrack(project, { kind, name, id } = {}) {
  if (!new Set(["video", "audio"]).has(kind)) {
    throw new ProjectError("kind must be 'video' or 'audio'", "INVALID_ARGUMENT");
  }
  const trackId = id?.trim() || `${kind[0]}${project.tracks.filter((track) => track.kind === kind).length + 1}`;
  if (project.tracks.some((track) => track.id === trackId)) {
    throw new ProjectError(`Track already exists: ${trackId}`, "CONFLICT");
  }
  const track = {
    id: trackId,
    kind,
    name: name?.trim() || trackId.toUpperCase(),
    muted: false,
    hidden: false,
    clips: [],
  };
  project.tracks.push(track);
  return clone(track);
}

export function addMediaClip(project, { trackId, source, timelineStart = 0, sourceIn = 0, duration, name, id, volume = 1 } = {}) {
  const track = getTrack(project, assertNonEmpty(trackId, "trackId"));
  const clipId = id?.trim() || randomUUID();
  try {
    findClip(project, clipId);
    throw new ProjectError(`Clip already exists: ${clipId}`, "CONFLICT");
  } catch (error) {
    if (!(error instanceof ProjectError) || error.code !== "NOT_FOUND") throw error;
  }
  const clip = {
    id: clipId,
    type: "media",
    name: name?.trim() || path.basename(assertNonEmpty(source, "source")),
    source: path.resolve(source),
    timelineStart: assertFiniteNumber(timelineStart, "timelineStart", { min: 0 }),
    sourceIn: assertFiniteNumber(sourceIn, "sourceIn", { min: 0 }),
    duration: assertFiniteNumber(duration, "duration", { min: 0, exclusiveMin: true }),
    volume: assertFiniteNumber(volume, "volume", { min: 0 }),
    speed: 1,
    effects: [],
  };
  track.clips.push(clip);
  validateProject(project, { throwOnError: true });
  return clone(clip);
}

export function addTitleClip(project, {
  trackId,
  text,
  timelineStart = 0,
  duration,
  name,
  id,
  font = "Sans",
  fontSize = 72,
  color = "#ffffff",
  background = "#00000000",
  x = "center",
  y = "center",
} = {}) {
  const track = getTrack(project, assertNonEmpty(trackId, "trackId"));
  if (track.kind !== "video") throw new ProjectError("Titles require a video track", "INVALID_ARGUMENT");
  const clip = {
    id: id?.trim() || randomUUID(),
    type: "title",
    name: name?.trim() || "Title",
    text: assertNonEmpty(text, "text"),
    timelineStart: assertFiniteNumber(timelineStart, "timelineStart", { min: 0 }),
    sourceIn: 0,
    duration: assertFiniteNumber(duration, "duration", { min: 0, exclusiveMin: true }),
    volume: 1,
    speed: 1,
    style: { font, fontSize, color, background, x, y },
    effects: [],
  };
  track.clips.push(clip);
  validateProject(project, { throwOnError: true });
  return clone(clip);
}

export function trimClip(project, { clipId, sourceIn, duration } = {}) {
  const { clip } = findClip(project, assertNonEmpty(clipId, "clipId"));
  if (clip.type === "title" && sourceIn !== undefined && sourceIn !== 0) {
    throw new ProjectError("Title clips cannot have a non-zero sourceIn", "INVALID_ARGUMENT");
  }
  if (sourceIn !== undefined) clip.sourceIn = assertFiniteNumber(sourceIn, "sourceIn", { min: 0 });
  if (duration !== undefined) clip.duration = assertFiniteNumber(duration, "duration", { min: 0, exclusiveMin: true });
  validateProject(project, { throwOnError: true });
  return clone(clip);
}

export function splitClip(project, { clipId, at, rightClipId } = {}) {
  const { track, index, clip } = findClip(project, assertNonEmpty(clipId, "clipId"));
  const splitAt = assertFiniteNumber(at, "at", { min: 0, exclusiveMin: true });
  if (splitAt >= clip.duration) {
    throw new ProjectError("at must be inside the clip duration", "INVALID_ARGUMENT");
  }
  const left = { ...clip, duration: splitAt };
  const right = {
    ...clone(clip),
    id: rightClipId?.trim() || randomUUID(),
    name: `${clip.name} (split)`,
    timelineStart: clip.timelineStart + splitAt,
    sourceIn: clip.sourceIn + splitAt * (clip.speed ?? 1),
    duration: clip.duration - splitAt,
  };
  if (project.tracks.some((candidate) => candidate.clips.some((item) => item.id === right.id))) {
    throw new ProjectError(`Clip already exists: ${right.id}`, "CONFLICT");
  }
  track.clips.splice(index, 1, left, right);
  return { left: clone(left), right: clone(right) };
}

export function moveClip(project, { clipId, trackId, timelineStart } = {}) {
  const found = findClip(project, assertNonEmpty(clipId, "clipId"));
  const targetTrack = trackId === undefined ? found.track : getTrack(project, assertNonEmpty(trackId, "trackId"));
  if (found.clip.type === "title" && targetTrack.kind !== "video") {
    throw new ProjectError("Titles require a video track", "INVALID_ARGUMENT");
  }
  const oldStart = found.clip.timelineStart;
  const nextStart = timelineStart === undefined ? oldStart : assertFiniteNumber(timelineStart, "timelineStart", { min: 0 });
  found.track.clips.splice(found.index, 1);
  found.clip.timelineStart = nextStart;
  targetTrack.clips.push(found.clip);
  try {
    validateProject(project, { throwOnError: true });
  } catch (error) {
    targetTrack.clips.splice(targetTrack.clips.indexOf(found.clip), 1);
    found.clip.timelineStart = oldStart;
    found.track.clips.splice(found.index, 0, found.clip);
    throw error;
  }
  return clone(found.clip);
}

export function setClipVolume(project, { clipId, volume } = {}) {
  const { clip } = findClip(project, assertNonEmpty(clipId, "clipId"));
  if (clip.type !== "media") throw new ProjectError("Volume applies only to media clips", "INVALID_ARGUMENT");
  clip.volume = assertFiniteNumber(volume, "volume", { min: 0 });
  return clone(clip);
}

export function setClipSpeed(project, { clipId, speed, ripple = true } = {}) {
  const found = findClip(project, assertNonEmpty(clipId, "clipId"));
  if (found.clip.type !== "media") throw new ProjectError("Speed applies only to media clips", "INVALID_ARGUMENT");
  const nextSpeed = assertFiniteNumber(speed, "speed", { min: 0, exclusiveMin: true });
  const oldSpeed = found.clip.speed ?? 1;
  const oldDuration = found.clip.duration;
  const sourceSpan = oldDuration * oldSpeed;
  const nextDuration = sourceSpan / nextSpeed;
  const delta = nextDuration - oldDuration;
  found.clip.speed = nextSpeed;
  found.clip.duration = nextDuration;
  if (ripple && Math.abs(delta) > 1e-9) {
    for (const clip of found.track.clips) {
      if (clip.id !== found.clip.id && clip.timelineStart >= found.clip.timelineStart + oldDuration - 1e-9) {
        clip.timelineStart += delta;
      }
    }
  }
  try {
    validateProject(project, { throwOnError: true });
  } catch (error) {
    found.clip.speed = oldSpeed;
    found.clip.duration = oldDuration;
    if (ripple && Math.abs(delta) > 1e-9) {
      for (const clip of found.track.clips) {
        if (clip.id !== found.clip.id && clip.timelineStart >= found.clip.timelineStart + nextDuration - 1e-9) {
          clip.timelineStart -= delta;
        }
      }
    }
    throw error;
  }
  return clone(found.clip);
}

function normalizeKeyframes(keyframes = []) {
  if (!Array.isArray(keyframes)) throw new ProjectError("keyframes must be an array", "INVALID_ARGUMENT");
  return keyframes.map((keyframe, index) => {
    if (!keyframe || typeof keyframe !== "object") throw new ProjectError(`keyframes[${index}] must be an object`, "INVALID_ARGUMENT");
    const time = assertFiniteNumber(keyframe.time, `keyframes[${index}].time`, { min: 0 });
    if (!keyframe.values || typeof keyframe.values !== "object" || Array.isArray(keyframe.values)) {
      throw new ProjectError(`keyframes[${index}].values must be an object`, "INVALID_ARGUMENT");
    }
    return { time, values: clone(keyframe.values), easing: keyframe.easing ?? "linear" };
  }).sort((a, b) => a.time - b.time);
}

export function addClipEffect(project, { clipId, type, parameters = {}, keyframes = [], enabled = true, id } = {}) {
  const { clip } = findClip(project, assertNonEmpty(clipId, "clipId"));
  if (!EFFECT_TYPES.includes(type)) {
    throw new ProjectError(`Unsupported effect type: ${type}. Supported: ${EFFECT_TYPES.join(", ")}`, "INVALID_ARGUMENT");
  }
  if (type === "mlt" && (typeof parameters.service !== "string" || parameters.service.trim() === "")) {
    throw new ProjectError("Raw MLT effects require parameters.service", "INVALID_ARGUMENT");
  }
  const effect = {
    id: id?.trim() || randomUUID(),
    type,
    enabled: enabled !== false,
    parameters: clone(parameters),
    keyframes: normalizeKeyframes(keyframes),
  };
  if (clip.effects.some((candidate) => candidate.id === effect.id)) {
    throw new ProjectError(`Effect already exists: ${effect.id}`, "CONFLICT");
  }
  for (const keyframe of effect.keyframes) {
    if (keyframe.time > clip.duration + 1e-9) throw new ProjectError(`Effect keyframe exceeds clip duration: ${keyframe.time}`, "INVALID_ARGUMENT");
  }
  clip.effects.push(effect);
  return clone(effect);
}

export function updateClipEffect(project, { clipId, effectId, parameters, keyframes, enabled } = {}) {
  const { clip } = findClip(project, assertNonEmpty(clipId, "clipId"));
  const effect = clip.effects.find((candidate) => candidate.id === assertNonEmpty(effectId, "effectId"));
  if (!effect) throw new ProjectError(`Effect not found: ${effectId}`, "NOT_FOUND");
  if (parameters !== undefined) effect.parameters = { ...effect.parameters, ...clone(parameters) };
  if (keyframes !== undefined) effect.keyframes = normalizeKeyframes(keyframes);
  if (enabled !== undefined) effect.enabled = Boolean(enabled);
  for (const keyframe of effect.keyframes) {
    if (keyframe.time > clip.duration + 1e-9) throw new ProjectError(`Effect keyframe exceeds clip duration: ${keyframe.time}`, "INVALID_ARGUMENT");
  }
  return clone(effect);
}

export function removeClipEffect(project, { clipId, effectId } = {}) {
  const { clip } = findClip(project, assertNonEmpty(clipId, "clipId"));
  const index = clip.effects.findIndex((candidate) => candidate.id === assertNonEmpty(effectId, "effectId"));
  if (index < 0) throw new ProjectError(`Effect not found: ${effectId}`, "NOT_FOUND");
  return clone(clip.effects.splice(index, 1)[0]);
}

export function removeClip(project, { clipId } = {}) {
  const found = findClip(project, assertNonEmpty(clipId, "clipId"));
  const [removed] = found.track.clips.splice(found.index, 1);
  project.transitions = project.transitions.filter(
    (transition) => transition.fromClipId !== removed.id && transition.toClipId !== removed.id,
  );
  return clone(removed);
}

export function duplicateClip(project, { clipId, trackId, timelineStart, id } = {}) {
  const found = findClip(project, assertNonEmpty(clipId, "clipId"));
  const targetTrack = trackId ? getTrack(project, trackId) : found.track;
  const duplicate = clone(found.clip);
  duplicate.id = id?.trim() || randomUUID();
  duplicate.name = `${duplicate.name} (copy)`;
  duplicate.timelineStart = timelineStart === undefined
    ? found.clip.timelineStart + found.clip.duration
    : assertFiniteNumber(timelineStart, "timelineStart", { min: 0 });
  targetTrack.clips.push(duplicate);
  validateProject(project, { throwOnError: true });
  return clone(duplicate);
}

export function removeTrack(project, { trackId, deleteClips = false } = {}) {
  const track = getTrack(project, assertNonEmpty(trackId, "trackId"));
  if (track.clips.length && !deleteClips) {
    throw new ProjectError("Track is not empty; set deleteClips=true to remove it", "CONFLICT");
  }
  const clipIds = new Set(track.clips.map((clip) => clip.id));
  project.transitions = project.transitions.filter(
    (transition) => !clipIds.has(transition.fromClipId) && !clipIds.has(transition.toClipId),
  );
  project.tracks.splice(project.tracks.indexOf(track), 1);
  return clone(track);
}

export function addCaptions(project, { trackId, cues = [], style = {} } = {}) {
  if (!Array.isArray(cues) || cues.length === 0) throw new ProjectError("cues must be a non-empty array", "INVALID_ARGUMENT");
  const added = [];
  for (const [index, cue] of cues.entries()) {
    const start = assertFiniteNumber(cue.start, `cues[${index}].start`, { min: 0 });
    const end = assertFiniteNumber(cue.end, `cues[${index}].end`, { min: 0, exclusiveMin: true });
    if (end <= start) throw new ProjectError(`cues[${index}].end must be greater than start`, "INVALID_ARGUMENT");
    added.push(addTitleClip(project, {
      trackId,
      text: assertNonEmpty(cue.text, `cues[${index}].text`),
      timelineStart: start,
      duration: end - start,
      name: `Caption ${index + 1}`,
      font: style.font ?? "Sans",
      fontSize: style.fontSize ?? 54,
      color: style.color ?? "#ffffff",
      background: style.background ?? "#000000aa",
      x: style.x ?? "center",
      y: style.y ?? "bottom",
    }));
  }
  return added;
}

export function addTransition(project, { fromClipId, toClipId, type = "dissolve", duration = 1, id } = {}) {
  const from = findClip(project, assertNonEmpty(fromClipId, "fromClipId"));
  const to = findClip(project, assertNonEmpty(toClipId, "toClipId"));
  if (from.track.id !== to.track.id) throw new ProjectError("Transition clips must be on the same track", "INVALID_ARGUMENT");
  if (!new Set(["dissolve", "wipe"]).has(type)) throw new ProjectError("type must be 'dissolve' or 'wipe'", "INVALID_ARGUMENT");
  const ordered = sortedClips(from.track);
  const fromIndex = ordered.findIndex((clip) => clip.id === from.clip.id);
  if (fromIndex < 0 || ordered[fromIndex + 1]?.id !== to.clip.id) {
    throw new ProjectError("Transition clips must be consecutive and ordered from outgoing to incoming", "INVALID_ARGUMENT");
  }
  if (Math.abs(from.clip.timelineStart + from.clip.duration - to.clip.timelineStart) > 1e-6) {
    throw new ProjectError("Transition clips must be adjacent on the timeline", "INVALID_ARGUMENT");
  }
  const transitionDuration = assertFiniteNumber(duration, "duration", { min: 0, exclusiveMin: true });
  if (transitionDuration > from.clip.duration || transitionDuration > to.clip.duration) {
    throw new ProjectError("Transition duration cannot exceed either clip duration", "INVALID_ARGUMENT");
  }
  const transition = {
    id: id?.trim() || randomUUID(),
    fromClipId: from.clip.id,
    toClipId: to.clip.id,
    type,
    duration: transitionDuration,
  };
  if (project.transitions.some((item) => item.id === transition.id)) {
    throw new ProjectError(`Transition already exists: ${transition.id}`, "CONFLICT");
  }
  project.transitions.push(transition);
  validateProject(project, { throwOnError: true });
  return clone(transition);
}

export function inspectProject(project) {
  const tracks = project.tracks.map((track) => ({
    id: track.id,
    name: track.name,
    kind: track.kind,
    clipCount: track.clips.length,
    duration: sortedClips(track).reduce((max, clip) => Math.max(max, clip.timelineStart + clip.duration), 0),
    clips: sortedClips(track).map((clip) => ({
      id: clip.id,
      name: clip.name,
      type: clip.type,
      timelineStart: clip.timelineStart,
      sourceIn: clip.sourceIn,
      duration: clip.duration,
      source: clip.source,
      volume: clip.volume,
      speed: clip.speed ?? 1,
      effects: clone(clip.effects ?? []),
    })),
  }));
  return {
    schemaVersion: project.schemaVersion,
    id: project.id,
    revision: project.revision,
    name: project.name,
    profile: clone(project.profile),
    duration: tracks.reduce((max, track) => Math.max(max, track.duration), 0),
    trackCount: tracks.length,
    transitionCount: project.transitions.length,
    tracks,
  };
}

export function validateProject(project, { throwOnError = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!project || typeof project !== "object") errors.push("Project must be an object");
  if (project?.schemaVersion !== SCHEMA_VERSION) errors.push(`Unsupported schemaVersion: ${project?.schemaVersion}`);
  if (!Array.isArray(project?.tracks)) errors.push("tracks must be an array");
  if (!Array.isArray(project?.transitions)) errors.push("transitions must be an array");

  const trackIds = new Set();
  const clipIds = new Set();
  const clipLocations = new Map();
  for (const track of project?.tracks ?? []) {
    if (!track.id || trackIds.has(track.id)) errors.push(`Duplicate or missing track id: ${track.id ?? "<missing>"}`);
    trackIds.add(track.id);
    if (!new Set(["video", "audio"]).has(track.kind)) errors.push(`Invalid track kind for ${track.id}`);
    if (!Array.isArray(track.clips)) {
      errors.push(`clips must be an array for track ${track.id}`);
      continue;
    }
    let previousEnd = 0;
    const orderedClips = sortedClips(track);
    for (let clipIndex = 0; clipIndex < orderedClips.length; clipIndex += 1) {
      const clip = orderedClips[clipIndex];
      if (!clip.id || clipIds.has(clip.id)) errors.push(`Duplicate or missing clip id: ${clip.id ?? "<missing>"}`);
      clipIds.add(clip.id);
      clipLocations.set(clip.id, { trackId: track.id, clipIndex, clip });
      if (!new Set(["media", "title"]).has(clip.type)) errors.push(`Invalid clip type for ${clip.id}`);
      if (!Number.isFinite(clip.timelineStart) || clip.timelineStart < 0) errors.push(`Invalid timelineStart for ${clip.id}`);
      if (!Number.isFinite(clip.sourceIn) || clip.sourceIn < 0) errors.push(`Invalid sourceIn for ${clip.id}`);
      if (!Number.isFinite(clip.duration) || clip.duration <= 0) errors.push(`Invalid duration for ${clip.id}`);
      if (!Number.isFinite(clip.speed ?? 1) || (clip.speed ?? 1) <= 0) errors.push(`Invalid speed for ${clip.id}`);
      if (clip.type === "media" && !clip.source) errors.push(`Missing source for ${clip.id}`);
      if (clip.type === "title" && track.kind !== "video") errors.push(`Title ${clip.id} is not on a video track`);
      if (clip.timelineStart < previousEnd - 1e-9) errors.push(`Clips overlap on track ${track.id} at ${clip.id}`);
      if (!Array.isArray(clip.effects)) errors.push(`effects must be an array for ${clip.id}`);
      for (const effect of clip.effects ?? []) {
        if (!effect.id || !EFFECT_TYPES.includes(effect.type)) errors.push(`Invalid effect on ${clip.id}: ${effect.id ?? "<missing>"}`);
        if (!Array.isArray(effect.keyframes)) errors.push(`keyframes must be an array for effect ${effect.id}`);
        for (const keyframe of effect.keyframes ?? []) {
          if (!Number.isFinite(keyframe.time) || keyframe.time < 0 || keyframe.time > clip.duration + 1e-9) {
            errors.push(`Invalid keyframe time for effect ${effect.id}`);
          }
        }
      }
      previousEnd = Math.max(previousEnd, clip.timelineStart + clip.duration);
    }
  }
  const transitionIds = new Set();
  for (const transition of project?.transitions ?? []) {
    if (!transition.id || transitionIds.has(transition.id)) errors.push(`Duplicate or missing transition id: ${transition.id ?? "<missing>"}`);
    transitionIds.add(transition.id);
    if (!clipIds.has(transition.fromClipId) || !clipIds.has(transition.toClipId)) {
      errors.push(`Transition ${transition.id} references a missing clip`);
    } else {
      const from = clipLocations.get(transition.fromClipId);
      const to = clipLocations.get(transition.toClipId);
      if (from.trackId !== to.trackId || to.clipIndex !== from.clipIndex + 1) {
        errors.push(`Transition ${transition.id} clips are not consecutive on one track`);
      } else if (Math.abs(from.clip.timelineStart + from.clip.duration - to.clip.timelineStart) > 1e-6) {
        errors.push(`Transition ${transition.id} clips are not adjacent`);
      }
    }
    if (!Number.isFinite(transition.duration) || transition.duration <= 0) errors.push(`Invalid duration for transition ${transition.id}`);
  }
  if ((project?.tracks ?? []).length === 0) warnings.push("Project has no tracks");

  const result = { valid: errors.length === 0, errors, warnings };
  if (!result.valid && throwOnError) {
    throw new ProjectError(`Project validation failed: ${errors.join("; ")}`, "VALIDATION_FAILED", result);
  }
  return result;
}

export async function loadProject(filePath) {
  const absolutePath = path.resolve(assertNonEmpty(filePath, "projectPath"));
  let parsed;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new ProjectError(`Unable to read project ${absolutePath}: ${error.message}`, "READ_FAILED");
  }
  validateProject(parsed, { throwOnError: true });
  return parsed;
}

function backupStamp(date = new Date()) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export async function saveProject(filePath, project, { expectedRevision, createBackup = true } = {}) {
  const absolutePath = path.resolve(assertNonEmpty(filePath, "projectPath"));
  validateProject(project, { throwOnError: true });
  await mkdir(path.dirname(absolutePath), { recursive: true });

  let existing = null;
  try {
    existing = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new ProjectError(`Unable to inspect existing project: ${error.message}`, "READ_FAILED");
  }
  if (expectedRevision !== undefined && (existing?.revision ?? 0) !== expectedRevision) {
    throw new ProjectError(
      `Revision conflict: expected ${expectedRevision}, found ${existing?.revision ?? 0}`,
      "REVISION_CONFLICT",
    );
  }

  const next = clone(project);
  next.revision = (existing?.revision ?? project.revision ?? 0) + 1;
  next.updatedAt = new Date().toISOString();
  const tempPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  let backupPath = null;
  if (existing && createBackup) {
    const backupDirectory = path.join(path.dirname(absolutePath), ".kdenlive-mcp-backups");
    await mkdir(backupDirectory, { recursive: true });
    backupPath = path.join(backupDirectory, `${path.basename(absolutePath)}.${backupStamp()}.bak`);
    await copyFile(absolutePath, backupPath);
  }
  await rename(tempPath, absolutePath);
  Object.assign(project, next);
  return { projectPath: absolutePath, backupPath, revision: next.revision };
}

export async function listProjectBackups(projectPath) {
  const absolutePath = path.resolve(assertNonEmpty(projectPath, "projectPath"));
  const directory = path.join(path.dirname(absolutePath), ".kdenlive-mcp-backups");
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const prefix = `${path.basename(absolutePath)}.`;
    return entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".bak"))
      .map((entry) => path.join(directory, entry.name))
      .sort()
      .reverse();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function restoreProjectBackup(projectPath, backupPath) {
  const backups = await listProjectBackups(projectPath);
  const selected = backupPath ? path.resolve(backupPath) : backups[0];
  if (!selected) throw new ProjectError("No project backup is available", "NOT_FOUND");
  if (!backups.includes(selected)) throw new ProjectError("backupPath is not a backup for this project", "INVALID_ARGUMENT");
  const restored = JSON.parse(await readFile(selected, "utf8"));
  validateProject(restored, { throwOnError: true });
  const current = await loadProject(projectPath);
  restored.revision = current.revision;
  const saved = await saveProject(projectPath, restored, { expectedRevision: current.revision, createBackup: true });
  return { restoredFrom: selected, saved, project: inspectProject(restored) };
}

export async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function framesFromSeconds(seconds, profile) {
  return Math.round(seconds * profile.fpsNumerator / profile.fpsDenominator);
}

export function secondsFromFrames(frames, profile) {
  return frames * profile.fpsDenominator / profile.fpsNumerator;
}
