import path from "node:path";
import {
  addMediaClip,
  addTitleClip,
  addTrack,
  addTransition,
  createProject,
  inspectProject,
  loadProject,
  moveClip,
  saveProject,
  setClipVolume,
  splitClip,
  trimClip,
  validateProject,
} from "./project.mjs";
import { exportKdenlive, exportOtio } from "./exporters.mjs";
import {
  createContactSheet,
  createWaveform,
  doctor,
  inspectMedia,
  previewFrame,
  renderKdenliveProject,
  verifyKdenliveProject,
} from "./toolchain.mjs";

const string = (description) => ({ type: "string", description });
const number = (description, minimum = undefined) => ({ type: "number", description, ...(minimum === undefined ? {} : { minimum }) });
const boolean = (description) => ({ type: "boolean", description });
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
  tool("track_add", "Add a video or audio track and save transactionally.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    kind: { type: "string", enum: ["video", "audio"] },
    name: string("Human-readable track name."),
    id: string("Optional stable track ID."),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "kind"]), localWrite),
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
  tool("transition_add", "Add a dissolve or wipe between two clips on one track; exported through OTIO.", objectSchema({
    projectPath: string("Path to the companion JSON project."),
    fromClipId: string("Outgoing clip ID."),
    toClipId: string("Incoming clip ID."),
    type: { type: "string", enum: ["dissolve", "wipe"] },
    duration: number("Transition duration in seconds.", 0),
    id: string("Optional stable transition ID."),
    expectedRevision: number("Optional optimistic-lock revision.", 0),
  }, ["projectPath", "fromClipId", "toClipId"]), localWrite),
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
  tool("project_verify_kdenlive", "Ask the installed Kdenlive binary to verify a .kdenlive file.", objectSchema({
    projectPath: string("Path to the .kdenlive project."),
    kdenlivePath: string("Optional explicit Kdenlive executable path."),
  }, ["projectPath"]), readOnly),
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
    case "track_add":
      return mutateProject(args, (project) => addTrack(project, args));
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
    case "transition_add":
      return mutateProject(args, (project) => addTransition(project, args));
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

