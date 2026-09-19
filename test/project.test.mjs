import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
} from "../src/project.mjs";
import { exportKdenlive, exportOtio, toKdenliveXml, toOtio } from "../src/exporters.mjs";

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

