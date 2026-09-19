# Polished editing workflows

The useful lesson from current agent-driven editors is not “expose hundreds of unrelated commands.” It is to give the agent a tight loop:

1. Inspect the source and timeline.
2. Make small non-destructive edits.
3. Generate or import supporting graphics.
4. See the structure and rendered result.
5. Revise, then render only after validation.

This project supports that entire loop through MCP.

## Talking-head YouTube video

1. Use `media_inspect` on the camera and microphone sources.
2. Create the project and place the main camera/audio with `clip_add`.
3. Remove mistakes with `clip_split`, `clip_trim`, `clip_move`, and `clip_remove`.
4. Put captions on a dedicated upper video track with `captions_add`.
5. Add gentle punch-ins with `clip_effect_add` using `zoom_pan` or `transform` keyframes.
6. Create the speaker’s lower third with `graphic_create_and_add`.
7. Add B-roll on a higher video track and use `clip_set_volume` for the mix.
8. Inspect pacing with `visualize_timeline` and the rendered draft with `preview_contact_sheet`.
9. Check a grade with `preview_effect_comparison`, then apply it to the clip.
10. Run `project_validate`, export `.kdenlive`, verify, and render.

## Product demo or tutorial

1. Add the screen recording as the base layer.
2. Split around each feature step.
3. Add `zoom_pan` keyframes to focus on UI details.
4. Generate `callout` and `badge` graphics and place them on overlay tracks.
5. Add section cards between major chapters with the `title_card` template.
6. Add a progress graphic or chapter indicator using `progress_bar`.
7. Generate an effect map for every transformed clip with `visualize_effects`.
8. Review a contact sheet before final export.

## Vertical short or reel

1. Create a 1080×1920 project.
2. Keep cuts tight with split/trim/remove operations and use ripple speed changes where useful.
3. Add large bottom captions with a high-contrast background.
4. Use badges, callouts, and a short subscribe overlay sparingly.
5. Put visual changes near narration beats.
6. Inspect the complete rhythm in `visualize_timeline`; use a filmstrip/contact sheet to catch weak frames.

## Effects and keyframes

Named effects:

- `brightness`
- `contrast`
- `saturation`
- `blur`
- `vignette`
- `opacity`
- `transform`
- `zoom_pan`
- `chroma_key`
- `fade_in`
- `fade_out`

Each effect can have `parameters` and an ordered `keyframes` array. A keyframe has a clip-relative `time`, a `values` object, and optional `easing` metadata.

For a Kdenlive/MLT effect that does not yet have a named wrapper, use:

```json
{
  "type": "mlt",
  "parameters": {
    "service": "avfilter.unsharp",
    "properties": {
      "av.luma_msize_x": 5,
      "av.luma_msize_y": 5,
      "av.luma_amount": 0.8
    }
  }
}
```

The exporter XML-escapes names and values and places the filter on the timeline entry. Installed MLT capabilities still determine whether Kdenlive can render a particular service.

## Generated graphics

The graphics tools generate editable SVG rather than opaque raster files. Templates share a 1920×1080 default canvas and accept colors, text, fonts, and layout parameters:

- `lower_third`
- `title_card`
- `badge`
- `callout`
- `progress_bar`
- `subscribe`

`graphic_create_and_add` writes the SVG and adds it to the selected video track in one transactional operation. The `.kdenlive` exporter uses MLT’s image producer for SVG, PNG, JPEG, WebP, BMP, and GIF sources.

## Visual review loop

- `visualize_timeline` produces a track/clip map with duration, speed, and effect counts.
- `visualize_effects` produces an effect stack and keyframe map for a selected clip.
- `preview_frame` renders a single frame.
- `preview_contact_sheet` samples the entire draft.
- `preview_waveform` shows audio energy and silence.
- `preview_effect_comparison` creates a labeled before/after frame for common FFmpeg-backed effects.

Image results are embedded in the MCP response when small enough, allowing the agent to inspect what it created and iterate.

## Safety and recovery

- Every mutation validates and writes atomically.
- Replacing a project creates a timestamped backup.
- `project_history` lists available backups.
- `project_undo` restores one while preserving the replaced state as another backup.
- `expectedRevision` prevents an agent from overwriting a concurrent human edit.
- The expensive final render tool is marked as a write/open-world operation so clients can approval-gate it.

## Design references

The workflow design draws on public patterns demonstrated by projects such as [MakeMyClip Editor](https://github.com/MakeMyClip/editor), [FableCut](https://github.com/ronak-create/FableCut), [ffmpeg-mcp-video-editor](https://github.com/AbyAbyss/ffmpeg-mcp-video-editor), and [mcpCut](https://github.com/musyta-labs/mcpcut): shared CLI/MCP handlers, operation history, compact timeline state, SVG overlays, effect keyframes, and preview-first iteration.
