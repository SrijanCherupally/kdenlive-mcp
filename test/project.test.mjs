import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addCaptions,
  addClipEffect,
  addMediaClip,
  addTitleClip,
  addTrack,
  addTransition,
  createProject,
  inspectProject,
  listProjectBackups,
  loadProject,
  moveClip,
  removeClipEffect,
  restoreProjectBackup,
  saveProject,
  setClipVolume,
  setClipSpeed,
  splitClip,
  trimClip,
  validateProject,
} from "../src/project.mjs";
import { exportKdenlive, exportOtio, toKdenliveXml, toOtio } from "../src/exporters.mjs";
import { createGraphic, listGraphicTemplates } from "../src/graphics.mjs";
import { visualizeEffects, visualizeTimeline } from "../src/visualize.mjs";

function sampleProject() {
  const project = createProject({ name: "Demo", fpsNumerator: 25 });
  addTrack(project, { id: "v1", kind: "video", name: "Video 1" });
  addTrack(project, { id: "v2", kind: "video", name: "Titles" });
  addTrack(project, { id: "a1", kind: "audio", name: "Audio 1" });
  addMediaClip(project, {
    id: "clip-a",
    trackId: "v1",
    source: "C:\\media\\a.mp4",
    timelineStart: 0,
    sourceIn: 2,
    duration: 5,
  });
  addMediaClip(project, {
    id: "clip-b",
    trackId: "v1",
    source: "C:\\media\\b.mp4",
    timelineStart: 5,
    duration: 4,
  });
  addTitleClip(project, {
    id: "title-1",
    trackId: "v2",
    text: "Hello & goodbye",
    timelineStart: 1,
    duration: 2,
  });
  addTransition(project, {
    id: "transition-1",
    fromClipId: "clip-a",
    toClipId: "clip-b",
    duration: 1,
  });
  return project;
}

test("timeline editing operations preserve a valid project", () => {
  const project = createProject({ name: "Editing" });
  addTrack(project, { id: "v1", kind: "video" });
  addTrack(project, { id: "v2", kind: "video" });
  addMediaClip(project, { id: "c1", trackId: "v1", source: "one.mp4", duration: 10 });
  const split = splitClip(project, { clipId: "c1", at: 4, rightClipId: "c2" });
  assert.equal(split.left.duration, 4);
  assert.equal(split.right.sourceIn, 4);
  trimClip(project, { clipId: "c2", sourceIn: 5, duration: 3 });
  moveClip(project, { clipId: "c2", trackId: "v2", timelineStart: 2 });
  setClipVolume(project, { clipId: "c2", volume: 0.5 });
  assert.equal(validateProject(project).valid, true);
  assert.equal(inspectProject(project).duration, 5);
});

test("overlapping clips on one track are rejected", () => {
  const project = createProject();
  addTrack(project, { id: "v1", kind: "video" });
  addMediaClip(project, { id: "c1", trackId: "v1", source: "one.mp4", duration: 5 });
  assert.throws(
    () => addMediaClip(project, { id: "c2", trackId: "v1", source: "two.mp4", timelineStart: 4, duration: 3 }),
    /overlap/,
  );
});

test("save is revisioned, reloadable, and backs up replacements", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kdenlive-mcp-test-"));
  const projectPath = path.join(directory, "edit.json");
  const project = sampleProject();
  const first = await saveProject(projectPath, project);
  assert.equal(first.revision, 1);
  project.name = "Changed";
  const second = await saveProject(projectPath, project, { expectedRevision: 1 });
  assert.equal(second.revision, 2);
  assert.ok(second.backupPath);
  const loaded = await loadProject(projectPath);
  assert.equal(loaded.name, "Changed");
  assert.equal(loaded.revision, 2);
  const backups = await listProjectBackups(projectPath);
  assert.equal(backups.length, 1);
  const restored = await restoreProjectBackup(projectPath);
  assert.equal(restored.project.name, "Demo");
  assert.equal((await loadProject(projectPath)).revision, 3);
  await assert.rejects(() => saveProject(projectPath, project, { expectedRevision: 1 }), /Revision conflict/);
});

test("OTIO export contains tracks, gaps, titles, and transitions", () => {
  const otio = toOtio(sampleProject());
  assert.equal(otio.OTIO_SCHEMA, "Timeline.1");
  assert.equal(otio.tracks.children.length, 3);
  const videoChildren = otio.tracks.children[0].children;
  assert.equal(videoChildren[1].OTIO_SCHEMA, "Transition.1");
  assert.equal(videoChildren[1].transition_type, "SMPTE_Dissolve");
  assert.equal(otio.tracks.children[1].children[0].OTIO_SCHEMA, "Gap.1");
  assert.equal(otio.tracks.children[1].children[1].media_references.DEFAULT_MEDIA.generator_kind, "kdenlive:Title");
});

test("Kdenlive XML export produces MLT project structure and escapes text", () => {
  const xml = toKdenliveXml(sampleProject(), { rootDirectory: "C:\\edits" });
  assert.match(xml, /^<\?xml version='1\.0'/);
  assert.match(xml, /<playlist id="main_bin">/);
  assert.match(xml, /<tractor id="tractor3"/);
  assert.match(xml, /Hello &amp; goodbye/);
  assert.match(xml, /kdenlive:docproperties\.kdenliveversion/);
});

test("file exporters write parseable artifacts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kdenlive-mcp-export-"));
  const project = sampleProject();
  const otioPath = path.join(directory, "edit.otio");
  const kdenlivePath = path.join(directory, "edit.kdenlive");
  await exportOtio(project, otioPath);
  await exportKdenlive(project, kdenlivePath);
  const parsed = JSON.parse(await readFile(otioPath, "utf8"));
  assert.equal(parsed.name, "Demo");
  assert.match(await readFile(kdenlivePath, "utf8"), /<mlt /);
});

test("speed changes ripple later clips and effects carry keyframes", () => {
  const project = createProject({ name: "Effects" });
  addTrack(project, { id: "v1", kind: "video" });
  addMediaClip(project, { id: "c1", trackId: "v1", source: "one.mp4", duration: 10 });
  addMediaClip(project, { id: "c2", trackId: "v1", source: "two.mp4", timelineStart: 10, duration: 4 });
  setClipSpeed(project, { clipId: "c1", speed: 2, ripple: true });
  assert.equal(project.tracks[0].clips[0].duration, 5);
  assert.equal(project.tracks[0].clips[1].timelineStart, 5);
  const effect = addClipEffect(project, {
    clipId: "c1",
    id: "fx1",
    type: "brightness",
    parameters: { amount: 0.1 },
    keyframes: [{ time: 0, values: { amount: 0 } }, { time: 5, values: { amount: 0.2 } }],
  });
  assert.equal(effect.keyframes.length, 2);
  const xml = toKdenliveXml(project);
  assert.match(xml, /mlt_service">timewarp/);
  assert.match(xml, /mlt_service">brightness/);
  assert.match(xml, /level">0=0;150=0\.2/);
  removeClipEffect(project, { clipId: "c1", effectId: "fx1" });
  assert.equal(project.tracks[0].clips[0].effects.length, 0);
  addClipEffect(project, {
    clipId: "c1",
    id: "raw-fx",
    type: "mlt",
    parameters: { service: "avfilter.unsharp", properties: { "av.luma_amount": 0.8 } },
  });
  assert.match(toKdenliveXml(project), /avfilter\.unsharp/);
});

test("caption batches create timed title clips", () => {
  const project = createProject();
  addTrack(project, { id: "captions", kind: "video" });
  const captions = addCaptions(project, {
    trackId: "captions",
    cues: [
      { start: 0, end: 1.5, text: "First" },
      { start: 1.5, end: 3, text: "Second" },
    ],
    style: { fontSize: 48 },
  });
  assert.equal(captions.length, 2);
  assert.equal(captions[0].style.y, "bottom");
  assert.equal(validateProject(project).valid, true);
});

test("graphic templates and visual maps generate valid SVG artifacts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kdenlive-mcp-graphics-"));
  const graphicPath = path.join(directory, "lower-third.svg");
  const timelinePath = path.join(directory, "timeline.svg");
  const effectsPath = path.join(directory, "effects.svg");
  assert.ok(listGraphicTemplates().some((entry) => entry.template === "lower_third"));
  await createGraphic({ template: "lower_third", outputPath: graphicPath, title: "Ada & Co.", subtitle: "Editor" });
  const graphic = await readFile(graphicPath, "utf8");
  assert.match(graphic, /Ada &amp; Co\./);

  const project = sampleProject();
  addClipEffect(project, { clipId: "clip-a", id: "fx1", type: "blur", parameters: { sigma: 6 } });
  await visualizeTimeline({ project, outputPath: timelinePath });
  await visualizeEffects({ project, clipId: "clip-a", outputPath: effectsPath });
  assert.match(await readFile(timelinePath, "utf8"), /Smoke|Demo/);
  assert.match(await readFile(effectsPath, "utf8"), /blur/);
});
