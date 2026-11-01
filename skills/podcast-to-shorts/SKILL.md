---
name: podcast-to-shorts
description: Convert long edited 16:9 podcast sequences into 9:16 vertical shorts, reels, and highlights with animated Vietnamese captions ("cắt podcast"). Use when creating short-form vertical video from podcast timelines in Adobe Premiere Pro.
---

# Podcast to Shorts

Use this skill to convert an edited 16:9 podcast sequence (20–90 minutes, multi-camera angles already cut) into multiple 9:16 vertical shorts (20–90 seconds) with animated Vietnamese captions in Adobe Premiere Pro.

## When to Use

- Use when you have a finished, edited 16:9 timeline of a podcast, interview, or talk show with dialogue on audio tracks, and want to extract vertical highlights, reels, or shorts.
- Do NOT use for raw, unedited multicam footage that has not yet been edited into a master sequence.
- Operates on an open Premiere Pro project and generates new 9:16 vertical sequences while keeping the original master timeline intact.

## Prerequisites and Setup

The transcription, visual analysis, and caption rendering pipeline uses a local Python sidecar (`faster-whisper` with `large-v3-turbo` in `int8_float16` on NVIDIA GPU or `int8` on CPU, optional OpenCV YuNet for face detection, and Pillow/ffmpeg for ProRes 4444 alpha caption video generation).

1. Install the ASR dependencies:
   ```bash
   premiere-pro-mcp --setup-asr
   ```
2. **Disk space**: Setup downloads about 1.8 GB (Python packages + the 1.6 GB large-v3-turbo model); on PCs with an NVIDIA GPU it also installs the CUDA libraries, about 3.8 GB in total in `PREMIERE_MCP_HOME` or `~/.premiere-mcp` (`%USERPROFILE%\.premiere-mcp` on Windows) for the virtual environment and Whisper `large-v3-turbo` model weights. Without an NVIDIA GPU (including PCs with only an Intel/AMD integrated GPU) transcription runs on the CPU: about 0.7 minutes of processing per minute of audio on an 8-core CPU, roughly 1.4 minutes per minute on 2 cores (measured), about 1.9 GB RAM.
3. **Hardware acceleration**:
   - An NVIDIA GPU with CUDA (`int8_float16`) is optional but recommended (measured on a 9-minute Vietnamese podcast: ~51 s on an RTX 3070 using ~1.4 GB VRAM).
   - If CUDA is not available, inference automatically falls back to CPU (`int8`), which works but is ~7× slower.
4. If the sidecar is not installed when calling shorts tools, the tool returns error code `asr.not_installed` with instructions to run `premiere-pro-mcp --setup-asr`. Other MCP tools remain fully functional.

## Tool Execution Order and 3-Review Process

Never skip steps or jump straight to timeline edits. Always follow this exact workflow:

```
verify_premiere_connection
  │
  ▼
transcribe_sequence (ask user for glossary first; poll while running)
  │
  ▼
find_highlight_candidates (extracts signals, returns fingerprint)
  │
  ▼
Score candidates with Rubric
  │
  ▼
[Review 1] Present proposed candidate list to user for selection
  │
  ▼ (after Review 1: pass expectedFingerprint)
build_short (dryRun: true, pass expectedFingerprint) -> plan caption groupings
  │
  ▼
[Review 2] Present caption text to user for review/edits
  │
  ▼
build_short (dryRun: false, pass expectedFingerprint, pass edited captions if any)
  │
  ▼
[Review 3] Notify user of warning markers on timeline (if detectFaces enabled)
```

### 1. Connection Verification (`verify_premiere_connection`)
Always call `verify_premiere_connection` before starting to confirm Premiere Pro is open, the CEP bridge is connected, and to identify the active sequence and project details.

### 2. Transcription (`transcribe_sequence`)
**Before calling `transcribe_sequence`, always ask the user for a glossary of proper nouns, guest/host names, technical terms, or brand names.** Join these into the `glossary` parameter so Whisper spells them accurately in the Vietnamese context.

Tool arguments:
- `sequenceId` (optional): Sequence ID (defaults to active sequence).
- `dialogueTrackIndices` (optional): Array of zero-based audio track indices containing speech (e.g., `[0, 1]`). Defaults to all unmuted audio tracks with clips. Note: Use numeric indices, not track names.
- `glossary` (optional): Array of strings containing proper nouns (e.g., `["Vietcetera", "Trưng Trắc", "AI"]`).
- `page` (optional): Page number for paginated sentence results.
- `pageSize` (optional): Sentences per page (default: 200).

**Background Polling**:
If any source media file has not been cached, `transcribe_sequence` starts a background job and immediately returns:
```json
{ "status": "running", "jobId": "...", "progress": 0.45, "etaSec": 120 }
```
Poll by re-calling `transcribe_sequence` with the same arguments until it returns:
```json
{ "status": "done", "sentences": [...], "totalSentences": 350, "wordsFile": "...", "warnings": [] }
```

### 3. Highlight Extraction (`find_highlight_candidates`)
Once transcription is complete (`status: "done"`), request candidate highlight windows. If the transcript job is not finished, `find_highlight_candidates` returns `{ "status": "running" }` (call again later).

Tool arguments:
- `sequenceId` (optional): Sequence ID.
- `minSec` (optional): Minimum duration in seconds (default: 20).
- `maxSec` (optional): Maximum duration in seconds (default: 90).
- `limit` (optional): Maximum number of candidate windows to return (default: 20).
- `detectFaces?: boolean = false` (optional): Face counting is opt-in (default `false`). Turn it on ONLY when the podcast has wide two-person shots, because it decodes video (uses GPU decoding of keyframes only). When `false`, `multiFaceRatio` is 0 and no "Cảnh nhiều người — kiểm tra khung reframe" markers are added.

Returns `{ success: true, sequenceId, fingerprint, totalCandidates, candidates: [{ startSentenceId, endSentenceId, start, end, text, signals }], detectFaces, warnings }` (or `status: "running"` while transcription is still in progress), where:
- `fingerprint`: Sequence timeline fingerprint. Agents MUST pass this fingerprint as `expectedFingerprint` to every `build_short` call.
- Candidates array, where each candidate has:
  - `startSentenceId`: First sentence ID.
  - `endSentenceId`: Final sentence ID.
  - `start`: Start timestamp in seconds.
  - `end`: End timestamp in seconds.
  - `text`: Spoken text within the window.
  - `signals`: Ranking signals:
    - `wordsPerSec`: Speaking cadence.
    - `loudnessRel`: Short-term LUFS relative to episode median.
    - `hasQuestion`, `hasExclaim`: Engagement markers.
    - `fillerRate`: Frequency of filler words ("ờ", "à", "ừ", "kiểu", "thì là").
    - `maxPauseSec`: Longest internal silence pause.
    - `multiFaceRatio`: Fraction of video duration with ≥ 2 detected faces (0 if `detectFaces` is false).

### 4. Candidate Scoring & Review 1

The server's rough score only filters candidates. The **Agent must evaluate and rank candidates using the Editorial Rubric**:

#### Editorial Rubric (Spec §7)
1. **Hook in the first 3 seconds**: Starts immediately with an intriguing statement, question, high-energy declaration, or strong premise.
2. **Has payoff / resolution**: Delivers a clear answer, story conclusion, or insight within the 20–90 second window.
3. **Self-contained**: Makes sense standalone without context from earlier in the episode. Avoid clips that refer to prior discussions (e.g., "như tôi nói lúc nãy" / "as I mentioned earlier").
4. **Complete thought at the end**: Ends on a clean sentence boundary with no abrupt cutoff mid-thought.
5. **Low `multiFaceRatio`**: When `detectFaces` is enabled, prefer low `multiFaceRatio` for cleaner 9:16 Auto Reframe composition without awkward two-shot crops (`multiFaceRatio` is 0 if `detectFaces` is false).

#### Review 1: Proposed List
Present the ranked highlight candidates to the user:
- Candidate start/end timestamps and duration.
- Topic summary and spoken text excerpt.
- Key signals (speaking pace, loudness, multi-face ratio).
- Ask the user to choose which highlight(s) to build, suggest sequence names (e.g., `Short_01_AI_Ethics`), and select a caption style (`clean`, `pop`, or `karaoke`).

**After Review 1**:
Agents MUST pass the `fingerprint` from the `find_highlight_candidates` result as `expectedFingerprint` to every `build_short` call (dry run and real run). A mismatch returns:
`"The sequence changed since it was transcribed. Run transcribe_sequence again."`
Then re-run `transcribe_sequence` and `find_highlight_candidates` and re-pick. Without `expectedFingerprint`, `build_short` only warns.

### 5. Dry Run & Review 2 (`build_short` with `dryRun: true`)

Before mutating the timeline, call `build_short` with `dryRun: true` to generate the timeline plan and caption groupings.

Tool arguments:
- `sequenceId` (optional): Master sequence ID.
- `startSentenceId`: First sentence ID of the highlight.
- `endSentenceId`: Final sentence ID of the highlight.
- `name`: Target sequence name (e.g., `Short_01_AI_Ethics`).
- `expectedFingerprint?: string` (optional): Timeline fingerprint from `find_highlight_candidates`. Agents MUST pass this to every `build_short` call (dry run and real run).
- `detectFaces?: boolean = false` (optional): Face counting is opt-in (default `false`). Turn it on ONLY when the podcast has wide two-person shots, because it decodes video (uses GPU decoding of keyframes only). When `false`, `multiFaceRatio` is 0 and no "Cảnh nhiều người — kiểm tra khung reframe" markers are added.
- `captions?: {start, end, text}[]` (optional): Edited caption groups from the dry run; an empty text removes that group.
- `captionStyle` (optional): `"clean"` (default), `"pop"`, or `"karaoke"`.
  - `clean`: White text, 6 px black stroke, active word highlighted in `#FFD400`.
  - `pop`: Uppercase text, active word scales 1.0 -> 1.15 -> 1.0 over 120 ms.
  - `karaoke`: Full phrase visible, word color sweeps as spoken.
- `font` (optional): Path to custom `.ttf` font (default: bundled Be Vietnam Pro OFL).
- `targetLufs` (optional): Integrated loudness target (default: -14).
- `dryRun`: `true`
- `backup`: `true` (default)

The dry run returns the execution plan:
- Sequence name, time range, and duration.
- Caption groupings: ≤ 3 words or ≤ 18 characters per group, broken at punctuation, word-timed relative to 00:00 of the short.

#### Review 2: Caption Text Review
Present the grouped caption text to the user. Ask if any transcript words, punctuation, casing, or line breaks require edits.
If the user modifies captions, pass the updated array back via the `captions` argument in the execution step.

### 6. Timeline Assembly (`build_short` execution)

Call `build_short` with `dryRun: false`, the same `expectedFingerprint` (from `find_highlight_candidates`), and the edited captions if any.

Execution steps performed by the tool:
1. **Pre-render captions**: Sidecar renders an alpha ProRes 4444 `.mov` at the reframed sequence's real frame size (Auto Reframe follows source height, e.g. 1215×2160 from a 3840×2160 source) matching sequence framerate, with safe margins as percentages (10% top, 15% bottom, 6% sides). If rendering fails, execution stops immediately before Premiere is touched.
2. **Project backup**: Saves a timestamped project backup.
3. **Subsequence & Auto Reframe**: Sets in/out points on the master sequence, creates a subsequence, executes native `autoReframeSequence(9, 16)`, renames the sequence to `name`, and removes intermediate subsequences.
4. **Caption import & placement**: Imports the `.mov` into bin `Shorts/<name>`, adds a video track above existing footage, and aligns the caption clip at time 0.0s.
5. **Loudness normalisation**: Runs `normalize_loudness` to `targetLufs` (-14 LUFS) on the short sequence.
6. **Sequence QA**: Runs `qa_sequence` to verify no flash frames, gaps, or offline media.
7. **Warning markers**: Places timeline markers on any ranges where `multiFaceRatio > 0`: `"Cảnh nhiều người — kiểm tra khung reframe"` (only if `detectFaces: true`; when `false`, `multiFaceRatio` is 0 and no markers are added).
8. **Verification readback**: Readback waits for the "Auto Reframe" effect's Generated Keyframes (up to 30 s, polled every 2 s) and only warns on timeout — it is not a failure. Verifies a 9:16 aspect ratio within ±1 px (not a fixed 1080×1920), duration matches the source range within ±1 frame, and that the caption clip is present on the top track (`verified: true`).

#### Failure Contract (Spec §4.3)
- **Caption render failure** (Step 1): Execution stops immediately before Premiere is touched; the project remains completely unchanged.
- **Premiere step failure** (Steps 3–7): Execution stops, keeps what was created so the user can inspect it, and returns `verified: false`, `failedStep`, and the backup path (`backupPath`).
- **Reporting to user**: The agent must report failures honestly to the user. Never hide errors, guess, or claim success. State what failed, which step failed (`failedStep`), that the created partial sequence was preserved for inspection, and provide the backup path for restoration if desired.

### 7. Review 3: Warning Markers
After creation:
- Report the created sequence name and verification status.
- If `detectFaces` was enabled, direct the user to review any warning markers on the timeline: `"Cảnh nhiều người — kiểm tra khung reframe"`. (When `detectFaces: false`, no markers are added).
- Advise the user to inspect those timestamps in Premiere Pro to manually adjust Auto Reframe framing if a speaker was partially cut off.

## Captions for the full episode

After `transcribe_sequence` is `done`, `create_captions_from_transcript` (same `dialogueTrackIndices` and `glossary`) writes an SRT from the cached transcript and creates a native caption track in bin `Captions`, editable in Premiere's Captions panel. Run it with `dryRun: true` first to check the cue count and preview; use `startTime`/`endTime` to caption only part of the sequence. It does not run speech recognition again.

## Core Rules

- **Never export unless asked**: Do NOT run export tools (`export_sequence`, `add_to_render_queue`, etc.) automatically. The user will review the resulting sequences directly in Premiere Pro.
- **Track selection**: Always supply audio tracks as `dialogueTrackIndices` (0-based numbers), matching `auto_duck_music`.
- **User confirmation**: Always complete Review 1 (highlight selection) and Review 2 (caption text check) before running `build_short` with `dryRun: false`.
