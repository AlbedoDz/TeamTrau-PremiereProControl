---
name: premiere-pro-mcp
description: Install, verify, troubleshoot, and operate the Adobe Premiere Pro MCP server. Use when a user wants an agent to set up Premiere MCP, connect Claude Code/Codex/Claude Desktop, control Premiere, import media, build sequences, edit timelines, apply effects, or diagnose bridge issues.
---

# Adobe Premiere Pro MCP

Use this skill when working with the Adobe Premiere Pro MCP server from `AlbedoDz/TeamTrau-PremiereProControl`.

## Core Rules

- Use the MCP tools for Premiere operations; do not invent ExtendScript unless the MCP tool surface is missing the needed operation.
- Default MCP `tools/list` is a small always-on set. Call `search_tools` (BM25 query or regex pattern), then `invoke_tool` with the exact name. `PREMIERE_MCP_TOOLSET=full` lists every tool.
- Prefer read-only discovery first: `get_project_info`, `list_sequences`, `list_project_items`, `get_active_sequence`, and relevant resource reads.
- Use real imported media. If the user asks to edit with assets, verify file paths exist, import them with `import_media`, then place the imported project item IDs on a sequence.
- Keep the temp directory consistent across the MCP server and CEP panel: `/tmp/premiere-mcp-bridge` unless the user explicitly configured another path.
- Ask before destructive or externally visible actions: deleting clips/media, overwriting exports, closing projects, saving over important project files, or sending files elsewhere.
- For generated/demo edits, prefer creating a new clearly named sequence instead of modifying the user's active sequence.
- If a tool returns `success: false`, report the exact error and run diagnostics before retrying blindly.

## Install Workflow

If the user asks you to install or set up the MCP:

1. Check the OS. The automated installer is macOS-focused.
2. Clone or open the repo:

```bash
git clone https://github.com/AlbedoDz/TeamTrau-PremiereProControl.git
cd TeamTrau-PremiereProControl
```

3. On macOS, run:

```bash
npm run setup:mac
```

4. For non-macOS or manual client setup, run:

```bash
npm install
npm run build
```

5. Register the MCP server in the user's client with:

```text
command: node /absolute/path/to/TeamTrau-PremiereProControl/dist/index.js
env: PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge
```

For Codex, prefer:

```bash
codex mcp add premiere_pro --env PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge -- node /absolute/path/to/TeamTrau-PremiereProControl/dist/index.js
```

## Premiere Bridge Startup

After installing:

1. Restart the MCP client if it reads config only at startup.
2. Restart Premiere Pro.
3. Open `Window > Extensions > TeamTrau PremiereProControl`.
4. Set `Temp Directory` to `/tmp/premiere-mcp-bridge`.
5. Click `Save Configuration`.
6. Click `Start Bridge`.
7. Confirm the bridge panel says Premiere is ready before running editing tools.

If Premiere is not running, you can install/build/register the MCP, but tell the user live tool verification requires Premiere and the CEP bridge panel.

## Verification

Run local checks:

```bash
npm run setup:doctor
```

If Premiere is running and the bridge is started, verify with safe read-only calls:

- `get_project_info`
- `list_sequences`
- `list_project_items`

For deeper validation in a disposable project, create a test sequence with `create_sequence_from_clips` or `create_sequence` plus a real `.sqpreset` path, then call `list_sequences` and confirm it exists. Do not call blank sequence creation without a preset because newer Premiere versions can open a native dialog that blocks CEP.

## Editing Strategy

- Start by understanding the project: project info, active sequence, existing media, tracks, markers, and selected sequence.
- Build a plan in concrete Premiere operations before changing anything.
- For rough cuts, import media first, then use `create_sequence_from_clips` so Premiere derives settings without a native dialog. Use `create_sequence` only with a real `.sqpreset`; use `duplicate_sequence` with `clearContents=true` when an existing sequence defines the intended settings.
- For product or brand spots, prefer `assemble_product_spot` or `build_brand_spot_from_mogrt_and_assets` when the user's request fits those workflows.
- For turning edited podcast sequences into 9:16 vertical shorts, reels, or highlights with animated captions, use the `podcast-to-shorts` skill.
- For black-and-white looks, use `apply_effect` with `Black & White` rather than generic saturation-only changes.
- For timeline cuts, prefer sequence-aware tools and include `sequenceId` when available.
- Export only after confirming output path, format/preset, and overwrite behavior.

## Efficient Editing

One real session spent 96 calls on a cut that needed about 7: 16 razors, 9 ripple deletes, 35 single `add_to_timeline` calls and repeated listings in between. Work like this instead:

- **Decide first, write once.** Work out every keep range (from analysis, a transcript, or the user) before touching the timeline, then place them all with one `add_to_timeline_batch` call using `sourceInPoint`/`sourceOutPoint`. Single-item tools in `search_tools` results carry a `batchAlternative` field; use it when changing more than 3 items.
- **Rebuild, don't razor.** With more than ~5 cuts, build a stringout on a fresh sequence (`duplicate_sequence` with `clearContents=true`) rather than razoring and ripple-deleting in place.
- **Work on a copy.** Duplicate the sequence before bulk edits so the original stays as the reference and undo is never the recovery plan.
- **Read once, verify once.** `list_sequence_tracks` before the edit and once after, then `qa_sequence`. Do not list between every mutation.
- **Let analysis tools decide.** `detect_silence`, `find_dead_segments`, `score_clips`, `assemble_rough_cut` and `analyze_music` return ranges computed by ffmpeg; feed those ranges into the batch call instead of eyeballing.
- **Search once with schemas.** `search_tools` with `detail: "schema"` returns arguments and the batch sibling together, so no separate `get_tool_schema` round-trip.
- **Whole-sequence batch tools are not multi-select.** `batch_apply_effect`, `batch_enable_disable`, `batch_rename_clips` and `apply_audio_effect_to_all_clips` change EVERY clip of the sequence. For specific clips, call the single tool per clip.
- Numbers and booleans sent as strings (`"12"`, `"false"`) are converted where the schema expects them; ids stay strings.

### B-roll over voice-over

From a live build that covered 149 s of narration with 35 shots:

- Exclude clips already used elsewhere in the project, and never place one source range twice.
- Trim ~0.6 s off each clip's head and tail, where handheld cameras shake on record start/stop.
- Cap shot length to the brief (e.g. 5–6 s) and match shots to the sentence they sit under.
- Check each placed shot by exporting its middle frame (`export_frame`) before reporting; look for blur, obstruction, reframing, or people looking into the lens.

## Troubleshooting

If commands time out or report bridge errors:

1. Confirm Premiere is open.
2. Confirm `Window > Extensions > TeamTrau PremiereProControl` is open and bridge is started.
3. Confirm both sides use the same temp directory.
4. Run:

```bash
npm run setup:doctor
```

5. Ask the user to click `Run Diagnostics` in the CEP panel.
6. Read `/tmp/premiere-mcp-bridge/premiere-mcp-diagnostics-latest.json` if it exists.
7. Remove stale command/response files only if they are clearly old and the bridge is stopped or idle.

Common fixes:

- `ENOENT` on temp directory: create `/tmp/premiere-mcp-bridge`, save config again, restart bridge.
- Tool succeeds in Premiere but reports failure: run `list_sequences` or the relevant list tool to confirm state before retrying.
- Empty or malformed temp directory config: set the field to the path only, not JSON or an env assignment.
