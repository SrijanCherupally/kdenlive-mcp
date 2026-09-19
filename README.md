# Kdenlive MCP companion

This is a dependency-free Node.js companion for Kdenlive. One transactional editing engine is exposed through both a scriptable CLI and a local STDIO MCP server.

It supports the stable Kdenlive 26.08 line and newer (MLT 7.38 minimum) without modifying the upstream Kdenlive checkout.

## What works

- Create a revisioned edit project with video and audio tracks.
- Add, trim, split, move, and arrange media clips by seconds.
- Add styled title clips, set clip volume, and declare dissolves/wipes.
- Change clip speed with ripple editing, duplicate/remove clips, and remove tracks safely.
- Add, update, inspect, and remove effects with keyframes.
- Use named color/blur/transform/chroma/fade effects or the raw MLT escape hatch for any installed Kdenlive/MLT filter.
- Add timed caption batches for short-form and talking-head edits.
- Generate transparent lower thirds, title cards, badges, callouts, progress bars, and subscribe graphics as SVG.
- Generate-and-import a graphic into the timeline in one MCP call.
- Reject invalid timing, duplicate IDs, broken transitions, and same-track overlap.
- Save atomically, keep timestamped backups, expose history/undo, and reject stale revision writes.
- Export OpenTimelineIO (`.otio`) and an MLT-based Kdenlive project (`.kdenlive`).
- Inspect media and create frames, waveforms, contact sheets, and real before/after effect comparisons when FFmpeg is available.
- Produce SVG timeline and effect/keyframe maps that are returned inline to MCP clients, giving the agent visual feedback even before rendering.
- Verify exported projects through MLT, open them in the Kdenlive desktop app, and render through Kdenlive when the toolchain is installed.
- Expose every companion-engine operation as one of 38 MCP tools with read/write/expensive-operation hints. The CLI and MCP server use the same registry and handlers, so they cannot drift.

This is the companion-app phase, not a live bridge into an already-running Kdenlive window. Transitions are carried faithfully in the companion JSON and OTIO export. The direct `.kdenlive` exporter stores their declarations as project metadata, but does not yet construct Kdenlive's internal timeline-mix objects; import the OTIO file when transition fidelity is required.

For practical edit recipes, see [Polished workflows](docs/POLISHED_WORKFLOWS.md).

## MCP feature coverage

| Area | MCP tools |
| --- | --- |
| Project safety | `project_create`, `project_inspect`, `project_validate`, `project_history`, `project_undo` |
| Timeline | `track_add`, `track_remove`, `clip_add`, `clip_trim`, `clip_split`, `clip_move`, `clip_duplicate`, `clip_remove` |
| Finishing | `clip_set_volume`, `clip_set_speed`, `transition_add`, `captions_add` |
| Effects | `clip_effect_list`, `clip_effect_add`, `clip_effect_update`, `clip_effect_remove` |
| Graphics | `graphic_templates`, `graphic_create`, `graphic_create_and_add`, `title_add` |
| Agent vision | `visualize_timeline`, `visualize_effects`, `preview_frame`, `preview_contact_sheet`, `preview_waveform`, `preview_effect_comparison` |
| Interchange/output | `project_export_otio`, `project_export_kdenlive`, `project_verify_kdenlive`, `project_open_kdenlive`, `project_render` |
| Discovery | `doctor`, `media_inspect` |

Generated `.svg`, `.png`, `.jpg`, and `.webp` results up to 5 MB are embedded directly in MCP tool responses, so a compatible client can inspect them without a second file-read tool.

## Requirements

- Node.js 22 or newer.
- Optional: Kdenlive for native verification and rendering.
- Optional: FFmpeg/ffprobe for media inspection and visual previews.

There is no package-install step and no runtime dependency download.

## Quick start

From this directory:

```powershell
node .\bin\kdenlive-cli.mjs doctor --source-path "C:\path\to\kdenlive"

node .\bin\kdenlive-cli.mjs project-create `
  --project-path .\demo.edit.json `
  --name "Demo edit" `
  --fps-numerator 30

node .\bin\kdenlive-cli.mjs clip-add `
  --project-path .\demo.edit.json `
  --track-id v1 `
  --source "C:\media\shot-01.mp4" `
  --source-in 2.5 `
  --duration 8

node .\bin\kdenlive-cli.mjs title-add `
  --project-path .\demo.edit.json `
  --track-id v1 `
  --text "Opening title" `
  --timeline-start 10 `
  --duration 3

node .\bin\kdenlive-cli.mjs project-export-otio `
  --project-path .\demo.edit.json `
  --output-path .\demo.otio

node .\bin\kdenlive-cli.mjs project-export-kdenlive `
  --project-path .\demo.edit.json `
  --output-path .\demo.kdenlive
```

Both hyphenated and underscored command names work. Every successful CLI call writes JSON to stdout; failures write JSON to stderr and return a non-zero exit status. Run `node .\bin\kdenlive-cli.mjs help` for the full tool list.

## Register the local MCP server in Codex

Use an absolute Node executable and server path. A project-local `.codex/config.toml` can contain:

```toml
[mcp_servers.kdenlive]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["C:\\path\\to\\kdenlive-mcp\\bin\\kdenlive-mcp.mjs"]
env = { KDENLIVE_SOURCE_PATH = "C:\\path\\to\\kdenlive" }
startup_timeout_sec = 10
tool_timeout_sec = 3600
default_tools_approval_mode = "writes"
```

Or register it from a Codex CLI installation:

```powershell
codex mcp add kdenlive `
  --env KDENLIVE_SOURCE_PATH="C:\path\to\kdenlive" `
  -- "C:\Program Files\nodejs\node.exe" "C:\path\to\kdenlive-mcp\bin\kdenlive-mcp.mjs"
```

Restart or open a new local Codex session after changing MCP configuration, then inspect the connected server/tool list. The render tool is marked as an expensive write and should remain approval-gated.

## Toolchain discovery

The server checks `PATH`, common Windows Kdenlive locations, and these optional overrides:

- `KDENLIVE_MCP_KDENLIVE_PATH`
- `KDENLIVE_MCP_MELT_PATH`
- `KDENLIVE_MCP_FFMPEG_PATH`
- `KDENLIVE_MCP_FFPROBE_PATH`
- `KDENLIVE_SOURCE_PATH`

## Tests

```powershell
npm test
npm run check
```

The tests cover editing invariants, backups and optimistic locking, OTIO/MLT export, effects/keyframes, speed/ripple editing, captions, generated graphics, timeline/effect visualization, inline MCP images, XML escaping, MCP initialization, tool discovery, and MCP error results.

## Project format

The companion JSON is intentionally small and auditable. Times are stored in seconds; exporters convert them to the selected project frame rate. A typical edit has this shape:

```json
{
  "schemaVersion": 1,
  "revision": 3,
  "profile": { "width": 1920, "height": 1080, "fpsNumerator": 30, "fpsDenominator": 1 },
  "tracks": [
    {
      "id": "v1",
      "kind": "video",
      "clips": [
        { "id": "shot-1", "type": "media", "source": "C:\\media\\shot.mp4", "timelineStart": 0, "sourceIn": 2, "duration": 8, "volume": 1 }
      ]
    }
  ],
  "transitions": []
}
```

Backups are written beside a project or export in `.kdenlive-mcp-backups`.

## Next implementation layer

The clean next step is a native Kdenlive/Qt bridge that maps this stable operation model onto `TimelineModel` commands in a running application. That will enable live timeline edits, native undo/redo, effect/keyframe APIs, and exact internal transition objects while preserving this CLI/MCP contract.
