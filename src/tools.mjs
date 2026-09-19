import path from "node:path";
import {
  addCaptions,
  addClipEffect,
  addMediaClip,
  addTitleClip,
  addTrack,
  addTransition,
  createProject,
  duplicateClip,
  inspectProject,
  listProjectBackups,
  loadProject,
  moveClip,
  removeClip,
  removeClipEffect,
  removeTrack,
  restoreProjectBackup,
  saveProject,
  setClipSpeed,
  setClipVolume,
  splitClip,
  trimClip,
  updateClipEffect,
  validateProject,
} from "./project.mjs";
import { exportKdenlive, exportOtio } from "./exporters.mjs";
import { createGraphic, listGraphicTemplates } from "./graphics.mjs";
import { previewEffectComparison, visualizeEffects, visualizeTimeline } from "./visualize.mjs";
import {
  createContactSheet,
  createWaveform,
  doctor,
  inspectMedia,
  openKdenliveProject,
  previewFrame,
  renderKdenliveProject,
  verifyKdenliveProject,
} from "./toolchain.mjs";

const string = (description) => ({ type: "string", description });
const number = (description, minimum = undefined) => ({ type: "number", description, ...(minimum === undefined ? {} : { minimum }) });
const boolean = (description) => ({ type: "boolean", description });
const freeObject = (description) => ({ type: "object", description, additionalProperties: true });
const objectSchema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

function tool(name, description, inputSchema, annotations) {
  return { name, description, inputSchema, annotations };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const localWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const expensiveWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export const TOOL_DEFINITIONS = [
  tool("doctor", "Check the local Kdenlive, MLT, FFmpeg, and Node toolchain and report available capabilities.", objectSchema({
    sourcePath: string("Optional Kdenlive source checkout path."),
    kdenlivePath: string("Optional explicit path to kdenlive executable."),
    meltPath: string("Optional explicit path to melt executable."),
    ffmpegPath: string("Optional explicit path to ffmpeg executable."),
    ffprobePath: string("Optional explicit path to ffprobe executable."),
  }), readOnly),
  tool("project_create", "Create a transactional companion project with default V1 and A1 tracks.", objectSchema({
    projectPath: string("Output path for the companion JSON project."),
    name: string("Project name."),
    width: number("Frame width in pixels.", 1),
    height: number("Frame height in pixels.", 1),
    fpsNumerator: number("Frame-rate numerator.", 1),
    fpsDenominator: number("Frame-rate denominator.", 1),
  }, ["projectPath"]), localWrite),
  tool("project_inspect", "Read a concise timeline summary from a companion project.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
  }, ["projectPath"]), readOnly),
  tool("project_validate", "Validate project structure, timing, unique IDs, references, and track overlaps.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
  }, ["projectPath"]), readOnly),
  tool("project_history", "List transactional backups available for undo or recovery.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
  }, ["projectPath"]), readOnly),
  tool("project_undo", "Restore the latest or a selected transactional project backup.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    backupPath: string("Optional backup returned by project_history; defaults to the newest."),
  }, ["projectPath"]), localWrite),
  tool("track_add", "Add a video or audio track and save transactionally.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    kind: { type: "string", enum: ["video", "audio"] },
    name: string("Human-readable track name."),
    id: string("Optional stable track ID."),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "kind"]), localWrite),
  tool("track_remove", "Remove an empty track, or remove it with all clips when explicitly requested.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    trackId: string("Track ID."),
    deleteClips: boolean("Must be true to remove a non-empty track."),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "trackId"]), localWrite),
  tool("clip_add", "Add a trimmed media clip to a track at an exact timeline time.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    trackId: string("Destination track ID."),
    source: string("Source media path."),
    timelineStart: number("Timeline start in seconds.", 0),
    sourceIn: number("Source in-point in seconds.", 0),
    duration: number("Clip duration in seconds.", 0),
    name: string("Optional clip name."),
    id: string("Optional stable clip ID."),
    volume: number("Linear volume multiplier.", 0),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "trackId", "source", "duration"]), localWrite),
  tool("title_add", "Add a styled title clip to a video track.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    trackId: string("Destination video track ID."),
    text: string("Title text."),
    timelineStart: number("Timeline start in seconds.", 0),
    duration: number("Title duration in seconds.", 0),
    name: string("Optional title name."),
    id: string("Optional stable clip ID."),
    font: string("Font family."),
    fontSize: number("Font size.", 1),
    color: string("Foreground color."),
    background: string("Background color."),
    x: string("Horizontal alignment or coordinate."),
    y: string("Vertical alignment or coordinate."),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "trackId", "text", "duration"]), localWrite),
  tool("clip_trim", "Change a clip source in-point and/or duration.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    clipId: string("Clip ID."),
    sourceIn: number("New source in-point in seconds.", 0),
    duration: number("New duration in seconds.", 0),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "clipId"]), localWrite),
  tool("clip_split", "Split a clip at an offset from its start.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    clipId: string("Clip ID."),
    at: number("Split offset in seconds from the clip start.", 0),
    rightClipId: string("Optional ID for the new right-hand clip."),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "clipId", "at"]), localWrite),
  tool("clip_move", "Move a clip to a time and optionally another compatible track.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    clipId: string("Clip ID."),
    trackId: string("Optional destination track ID."),
    timelineStart: number("New timeline start in seconds.", 0),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "clipId"]), localWrite),
  tool("clip_set_volume", "Set a media clip's linear volume multiplier.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    clipId: string("Clip ID."),
    volume: number("Linear volume multiplier; 0 is silent and 1 is unchanged.", 0),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "clipId", "volume"]), localWrite),
  tool("clip_set_speed", "Change clip playback speed and optionally ripple later clips on the track.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    clipId: string("Clip ID."),
    speed: number("Playback multiplier, such as 0.5 or 2.", 0.01),
    ripple: boolean("Shift later clips to preserve sequence continuity; defaults to true."),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "clipId", "speed"]), localWrite),
  tool("clip_duplicate", "Duplicate a clip, including its effects and keyframes.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    clipId: string("Source clip ID."),
    trackId: string("Optional destination track ID."),
    timelineStart: number("Optional destination timeline start.", 0),
    id: string("Optional stable ID for the duplicate."),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "clipId"]), localWrite),
  tool("clip_remove", "Remove a clip and transitions that reference it.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    clipId: string("Clip ID."),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "clipId"]), localWrite),
  tool("clip_effect_list", "Inspect all effects and keyframes on one clip.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    clipId: string("Clip ID."),
  }, ["projectPath", "clipId"]), readOnly),
  tool("clip_effect_add", "Add a non-destructive effect with optional keyframes. Common effects have named types; use type=mlt with parameters.service and parameters.properties for any installed MLT/Kdenlive filter.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    clipId: string("Clip ID."),
    type: { type: "string", enum: ["brightness", "contrast", "saturation", "blur", "vignette", "opacity", "transform", "zoom_pan", "chroma_key", "fade_in", "fade_out", "mlt"] },
    parameters: freeObject("Effect parameters."),
    keyframes: { type: "array", description: "Keyframes relative to the clip start.", items: objectSchema({ time: number("Time in seconds.", 0), values: freeObject("Parameter values at this keyframe."), easing: string("Easing name; linear by default.") }, ["time", "values"]) },
    enabled: boolean("Whether the effect is enabled."),
    id: string("Optional stable effect ID."),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "clipId", "type"]), localWrite),
  tool("clip_effect_update", "Merge effect parameters, replace keyframes, or toggle an effect.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    clipId: string("Clip ID."),
    effectId: string("Effect ID."),
    parameters: freeObject("Parameters to merge."),
    keyframes: { type: "array", items: objectSchema({ time: number("Time in seconds.", 0), values: freeObject("Parameter values."), easing: string("Easing name.") }, ["time", "values"]) },
    enabled: boolean("Whether the effect is enabled."),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "clipId", "effectId"]), localWrite),
  tool("clip_effect_remove", "Remove an effect from a clip.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    clipId: string("Clip ID."),
    effectId: string("Effect ID."),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "clipId", "effectId"]), localWrite),
  tool("captions_add", "Add a set of timed caption title clips to a dedicated video track.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    trackId: string("Caption video track ID."),
    cues: { type: "array", minItems: 1, items: objectSchema({ start: number("Start time in seconds.", 0), end: number("End time in seconds.", 0), text: string("Caption text.") }, ["start", "end", "text"]) },
    style: freeObject("Shared caption font, fontSize, colors, and position."),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "trackId", "cues"]), localWrite),
  tool("transition_add", "Add a dissolve or wipe between two clips on one track; exported through OTIO.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    fromClipId: string("Outgoing clip ID."),
    toClipId: string("Incoming clip ID."),
    type: { type: "string", enum: ["dissolve", "wipe"] },
    duration: number("Transition duration in seconds.", 0),
    id: string("Optional stable transition ID."),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "fromClipId", "toClipId"]), localWrite),
  tool("graphic_templates", "List built-in SVG templates for polished timeline overlays.", objectSchema({}), readOnly),
  tool("graphic_create", "Generate a transparent SVG overlay such as a lower third, title card, badge, callout, progress bar, or subscribe prompt.", objectSchema({
    template: { type: "string", enum: ["lower_third", "title_card", "badge", "callout", "progress_bar", "subscribe"] },
    outputPath: string("Destination .svg path."),
    title: string("Primary text."),
    subtitle: string("Secondary text."),
    width: number("Canvas width.", 1),
    height: number("Canvas height.", 1),
    accent: string("Accent color."),
    foreground: string("Text color."),
    background: string("Background/panel color."),
    fontFamily: string("Font-family stack."),
    x: number("Optional x position.", 0),
    y: number("Optional y position.", 0),
    boxWidth: number("Optional panel width.", 1),
    boxHeight: number("Optional panel height.", 1),
    targetX: number("Callout target x.", 0),
    targetY: number("Callout target y.", 0),
    progress: number("Progress-bar fill from 0 to 1.", 0),
  }, ["template", "outputPath"]), localWrite),
  tool("graphic_create_and_add", "Generate an SVG graphic and import it into a project track as a timeline clip in one transaction.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    trackId: string("Destination video track ID."),
    template: { type: "string", enum: ["lower_third", "title_card", "badge", "callout", "progress_bar", "subscribe"] },
    outputPath: string("Destination .svg path."),
    timelineStart: number("Timeline start in seconds.", 0),
    duration: number("Graphic duration in seconds.", 0.01),
    title: string("Primary text."),
    subtitle: string("Secondary text."),
    width: number("Canvas width.", 1),
    height: number("Canvas height.", 1),
    accent: string("Accent color."),
    foreground: string("Text color."),
    background: string("Background/panel color."),
    fontFamily: string("Font-family stack."),
    x: number("Optional x position.", 0),
    y: number("Optional y position.", 0),
    boxWidth: number("Optional panel width.", 1),
    boxHeight: number("Optional panel height.", 1),
    targetX: number("Callout target x.", 0),
    targetY: number("Callout target y.", 0),
    progress: number("Progress-bar fill from 0 to 1.", 0),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "trackId", "template", "outputPath", "duration"]), localWrite),
  tool("visualize_timeline", "Generate an SVG overview of tracks, clips, durations, speeds, and effect counts so an agent can inspect the edit structure.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    outputPath: string("Destination .svg path."),
    width: number("Visualization width.", 600),
    rowHeight: number("Height per track.", 60),
  }, ["projectPath", "outputPath"]), localWrite),
  tool("visualize_effects", "Generate an SVG effect/keyframe map for one clip.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    clipId: string("Clip ID."),
    outputPath: string("Destination .svg path."),
    width: number("Visualization width.", 600),
  }, ["projectPath", "clipId", "outputPath"]), localWrite),
  tool("preview_effect_comparison", "Render a real before/after frame for one supported effect with FFmpeg.", objectSchema({
    source: string("Source media path."),
    outputPath: string("Destination image path."),
    at: number("Timestamp in seconds.", 0),
    effect: objectSchema({ type: { type: "string", enum: ["brightness", "contrast", "saturation", "blur", "vignette", "opacity", "chroma_key"] }, parameters: freeObject("Effect parameters.") }, ["type"]),
    width: number("Width of each side of the comparison.", 1),
    ffmpegPath: string("Optional explicit ffmpeg path."),
  }, ["source", "outputPath", "effect"]), localWrite),
  tool("project_export_otio", "Export an OpenTimelineIO file for import into Kdenlive or another NLE.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    outputPath: string("Destination .otio path."),
  }, ["projectPath", "outputPath"]), localWrite),
  tool("project_export_kdenlive", "Export an MLT-based .kdenlive project for Kdenlive verification, editing, and rendering.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    outputPath: string("Destination .kdenlive path."),
  }, ["projectPath", "outputPath"]), localWrite),
  tool("media_inspect", "Inspect streams, duration, codecs, frame rate, and metadata with ffprobe.", objectSchema({
    source: string("Source media path."),
    ffprobePath: string("Optional explicit ffprobe path."),
  }, ["source"]), readOnly),
  tool("preview_frame", "Render one scaled inspection frame from a source or rendered draft.", objectSchema({
    source: string("Source video path."),
    outputPath: string("Destination image path."),
    at: number("Timestamp in seconds.", 0),
    width: number("Output width.", 1),
    ffmpegPath: string("Optional explicit ffmpeg path."),
  }, ["source", "outputPath"]), localWrite),
  tool("preview_waveform", "Render an audio waveform image for inspection.", objectSchema({
    source: string("Source media path."),
    outputPath: string("Destination image path."),
    width: number("Output width.", 1),
    height: number("Output height.", 1),
    ffmpegPath: string("Optional explicit ffmpeg path."),
  }, ["source", "outputPath"]), localWrite),
  tool("preview_contact_sheet", "Render a contact sheet sampled across a source video.", objectSchema({
    source: string("Source media path."),
    outputPath: string("Destination image path."),
    columns: number("Grid columns.", 1),
    rows: number("Grid rows.", 1),
    tileWidth: number("Tile width.", 1),
    ffmpegPath: string("Optional explicit ffmpeg path."),
  }, ["source", "outputPath"]), localWrite),
  tool("project_verify_kdenlive", "Validate a .kdenlive file with the installed MLT engine, including compatibility with Kdenlive 26.08.", objectSchema({
    projectPath: string("Path to the .kdenlive project."),
    kdenlivePath: string("Optional Kdenlive path used to locate its adjacent melt executable."),
    meltPath: string("Optional explicit melt executable path."),
  }, ["projectPath"]), readOnly),
  tool("project_open_kdenlive", "Open a .kdenlive project in the installed Kdenlive desktop application.", objectSchema({
    projectPath: string("Path to the .kdenlive project."),
    kdenlivePath: string("Optional explicit Kdenlive executable path."),
  }, ["projectPath"]), localWrite),
  tool("project_render", "Run a potentially expensive final Kdenlive render. The client should request approval before calling this tool.", objectSchema({
    projectPath: string("Path to the .kdenlive project."),
    outputPath: string("Destination rendered media path."),
    preset: string("Kdenlive render preset name."),
    async: boolean("Return after the detached render starts."),
    kdenlivePath: string("Optional explicit Kdenlive executable path."),
  }, ["projectPath", "outputPath"]), expensiveWrite),
];

async function mutateProject(args, mutator) {
  const project = await loadProject(args.projectPath);
  const value = mutator(project);
  const saved = await saveProject(args.projectPath, project, { expectedRevision: args.expectedRevision });
  return { value, saved, project: inspectProject(project) };
}

export async function callTool(name, args = {}) {
  switch (name) {
    case "doctor":
      return doctor(args);
    case "project_create": {
      const project = createProject(args);
      addTrack(project, { id: "v1", name: "V1", kind: "video" });
      addTrack(project, { id: "a1", name: "A1", kind: "audio" });
      const saved = await saveProject(args.projectPath, project, { createBackup: true });
      return { saved, project: inspectProject(project) };
    }
    case "project_inspect":
      return inspectProject(await loadProject(args.projectPath));
    case "project_validate": {
      const project = await loadProject(args.projectPath);
      return validateProject(project);
    }
    case "project_history":
      return { projectPath: path.resolve(args.projectPath), backups: await listProjectBackups(args.projectPath) };
    case "project_undo":
      return restoreProjectBackup(args.projectPath, args.backupPath);
    case "track_add":
      return mutateProject(args, (project) => addTrack(project, args));
    case "track_remove":
      return mutateProject(args, (project) => removeTrack(project, args));
    case "clip_add":
      return mutateProject(args, (project) => addMediaClip(project, args));
    case "title_add":
      return mutateProject(args, (project) => addTitleClip(project, args));
    case "clip_trim":
      return mutateProject(args, (project) => trimClip(project, args));
    case "clip_split":
      return mutateProject(args, (project) => splitClip(project, args));
    case "clip_move":
      return mutateProject(args, (project) => moveClip(project, args));
    case "clip_set_volume":
      return mutateProject(args, (project) => setClipVolume(project, args));
    case "clip_set_speed":
      return mutateProject(args, (project) => setClipSpeed(project, args));
    case "clip_duplicate":
      return mutateProject(args, (project) => duplicateClip(project, args));
    case "clip_remove":
      return mutateProject(args, (project) => removeClip(project, args));
    case "clip_effect_list": {
      const project = await loadProject(args.projectPath);
      for (const track of project.tracks) {
        const clip = track.clips.find((candidate) => candidate.id === args.clipId);
        if (clip) return { clipId: clip.id, clipName: clip.name, effects: clip.effects };
      }
      throw new Error(`Clip not found: ${args.clipId}`);
    }
    case "clip_effect_add":
      return mutateProject(args, (project) => addClipEffect(project, args));
    case "clip_effect_update":
      return mutateProject(args, (project) => updateClipEffect(project, args));
    case "clip_effect_remove":
      return mutateProject(args, (project) => removeClipEffect(project, args));
    case "captions_add":
      return mutateProject(args, (project) => addCaptions(project, args));
    case "transition_add":
      return mutateProject(args, (project) => addTransition(project, args));
    case "graphic_templates":
      return { templates: listGraphicTemplates() };
    case "graphic_create":
      return createGraphic(args);
    case "graphic_create_and_add": {
      const graphic = await createGraphic(args);
      const mutation = await mutateProject(args, (project) => addMediaClip(project, {
        trackId: args.trackId,
        source: graphic.outputPath,
        timelineStart: args.timelineStart ?? 0,
        sourceIn: 0,
        duration: args.duration,
        name: args.title || args.template,
      }));
      return { graphic, ...mutation };
    }
    case "visualize_timeline": {
      const project = await loadProject(args.projectPath);
      return visualizeTimeline({ ...args, project });
    }
    case "visualize_effects": {
      const project = await loadProject(args.projectPath);
      return visualizeEffects({ ...args, project });
    }
    case "preview_effect_comparison":
      return previewEffectComparison(args);
    case "project_export_otio": {
      const project = await loadProject(args.projectPath);
      return { ...(await exportOtio(project, args.outputPath)), project: inspectProject(project) };
    }
    case "project_export_kdenlive": {
      const project = await loadProject(args.projectPath);
      return { ...(await exportKdenlive(project, args.outputPath)), project: inspectProject(project) };
    }
    case "media_inspect":
      return inspectMedia(args);
    case "preview_frame":
      return previewFrame(args);
    case "preview_waveform":
      return createWaveform(args);
    case "preview_contact_sheet":
      return createContactSheet(args);
    case "project_verify_kdenlive":
      return verifyKdenliveProject(args);
    case "project_open_kdenlive":
      return openKdenliveProject(args);
    case "project_render":
      return renderKdenliveProject(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function resolveDefaultSourcePath() {
  return process.env.KDENLIVE_SOURCE_PATH
    ? path.resolve(process.env.KDENLIVE_SOURCE_PATH)
    : undefined;
}
