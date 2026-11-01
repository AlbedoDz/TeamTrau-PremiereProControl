# Podcast → Shorts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ba tool MCP mới (`transcribe_sequence`, `find_highlight_candidates`, `build_short`) cùng một Python sidecar, để Agent cắt một sequence podcast 16:9 thành các short 9:16 có caption tiếng Việt render sẵn (alpha).

**Architecture:** Logic quyết định là hàm thuần trong `src/analysis/` (transcript, highlights, captions). Handler trong `src/tools/domains/shorts.ts` lấy dữ liệu từ Premiere qua `readSequence`, gọi Python sidecar (`python/premiere_mcp_sidecar`) qua `src/analysis/sidecar.ts`, rồi áp kết quả bằng ExtendScript. Transcript dài chạy thành job nền: kết quả job trên đĩa đồng thời là cache.

**Tech Stack:** TypeScript (Node ≥ 18, zod, jest), Python 3.11–3.12 (faster-whisper 1.2.1, ctranslate2 4.8.4, opencv-python-headless, pillow, numpy, pytest), ffmpeg ≥ 6 (prores_ks, ebur128), ExtendScript qua CEP bridge.

**Spec:** `docs/superpowers/specs/2026-11-01-podcast-to-shorts-design.md`

## Global Constraints

- Mọi tool sửa sequence có `dryRun` và `backup` (mặc định `true`, dùng `ensureBackup` đúng như `src/tools/domains/editing.ts:28`), đọc lại sau khi sửa và trả `verified`.
- Track thoại chọn bằng **chỉ số** `dialogueTrackIndices: number[]` (mặc định: mọi track audio có clip), cùng quy ước `auto_duck_music`. Spec ghi "tên track", nhưng `readSequence` không trả tên, nên dùng chỉ số cho nhất quán với 1.4.0.
- ASR: `faster-whisper==1.2.1`, model `large-v3`, `language="vi"`, `word_timestamps=True`, `vad_filter=True`, `beam_size=5`, glossary nối bằng `", "` vào `initial_prompt`. Audio đọc bằng ffmpeg thành PCM 16 kHz mono float32, **không** gọi `faster_whisper.decode_audio` (PyAV 19.0.2 lỗi `metadata_errors`). Ghim `av==19.0.2` chỉ để import được.
- CUDA nếu có (`device="cuda", compute_type="float16"`), không có thì `device="cpu", compute_type="int8"` kèm cảnh báo.
- Thư mục dữ liệu: `PREMIERE_MCP_HOME` hoặc `~/.premiere-mcp` (Windows `%USERPROFILE%\.premiere-mcp`), gồm `venv/`, `models/`, `jobs/`, `renders/`.
- Thiếu sidecar → `{ success: false, retry: false, userActionRequired: true, errorCode: 'asr.not_installed', command: 'premiere-pro-mcp --setup-asr', nextStep }`. Các tool khác không bị ảnh hưởng.
- Ứng viên: `minSec=20`, `maxSec=90`, `limit=20`. Câu: ngắt ở `.?!` hoặc khoảng ngừng > `1.0` s. Từ đệm: `ờ, à, ừ, kiểu, thì là`.
- Caption: ≤ 3 từ hoặc ≤ 18 ký tự mỗi nhóm, ngắt ở dấu câu; 1080×1920; vùng an toàn trên 10%, dưới 15%, hai bên 6%; ProRes 4444 `yuva444p10le`; font Be Vietnam Pro (OFL). Style `clean` (trắng, viền đen 6 px, từ đang nói `#FFD400`), `pop` (CHỮ HOA, từ đang nói scale 1.0→1.15→1.0 trong 120 ms), `karaoke` (màu chạy theo từ).
- `targetLufs` mặc định `-14`. Marker cảnh báo: `"Cảnh nhiều người — kiểm tra khung reframe"`.
- Làm việc trong git worktree riêng: session phát hành 1.4.0 vẫn sửa trên `E:\antigravity\Adobe_Premiere_Pro_MCP`.

## Review Focus

1. **Clip đổi tốc độ hoặc chạy ngược** trên track thoại: `(outPoint − inPoint)` khác `(end − start)` quá 1 frame. Người dùng mong transcript không lệch: bỏ clip đó và cảnh báo. Test ở Task 5.
2. **Một file nguồn được cắt thành nhiều clip** (phỏng vấn đã dựng): file chỉ transcribe một lần, từ được gán đúng từng clip, phần bị cắt bỏ thì biến mất. Test ở Task 5.
3. **Sequence bị sửa sau khi transcribe**: sentence id cũ không còn đúng. `build_short` phải nhận ra transcript cũ (dấu vân tay danh sách clip khác) và yêu cầu chạy lại `transcribe_sequence`, không dựng sai đoạn. Test ở Task 9.
4. **Tên short có dấu tiếng Việt, `/`, `:`**: tên sequence giữ nguyên dấu, tên file `.mov` và bin được làm sạch. Test ở Task 8 và Task 9.
5. **Job sidecar chết giữa chừng** (khởi động lại MCP, tắt máy, Python crash): `jobStatus` báo `failed` kèm đuôi stderr, gọi lại thì chạy lại job, không treo mãi ở `running`. Test ở Task 3.

---

### Task 1: Worktree và dò rủi ro trên Premiere thật

Mục tiêu là trả lời hai rủi ro trong spec §10 trước khi viết `build_short`.

**Files:**
- Modify: `docs/superpowers/specs/2026-11-01-podcast-to-shorts-design.md` (§10, ghi kết quả)

- [ ] **Step 1:** Tạo worktree theo skill `superpowers:using-git-worktrees`, nhánh `feature/podcast-to-shorts` từ `release/1.3.0-footage-cleanup` (HEAD gồm 1.4.0 và spec). Chạy `npm ci && npm run build && npx jest`, mong đợi mọi test xanh.
- [ ] **Step 2:** Tạo file thử alpha:
  `ffmpeg -f lavfi -i "color=c=red@0.0:s=1080x1920:d=3,format=yuva444p10le,drawtext=text='Trưng Trắc':fontsize=120:fontcolor=white:x=100:y=900" -c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le -alpha_bits 16 probe-alpha.mov`
- [ ] **Step 3:** Qua MCP trên một project tạm (không phải project thật của người dùng): `import_media` file thử, `add_to_timeline` lên V2 của một sequence có video ở V1, `export_frame` tại 1 s. Mong đợi: thấy V1 qua nền trong suốt. Nếu không trong suốt, đổi sang chuỗi PNG và ghi lại.
- [ ] **Step 4:** Đặt in/out 5–25 s trên sequence 16:9 có người nói, chạy ExtendScript `var sub = seq.createSubsequence(true); var r = sub.autoReframeSequence(9, 16, "default", "probe 9x16", false);` qua `execute_extendscript`, rồi lập tức đọc `r.sequenceID`, `r.frameSizeHorizontal`, `r.frameSizeVertical`, và giá trị Position của clip đầu tiên trên V1. Đọc lại sau 10 s. Mong đợi: kích thước 9:16 ngay lập tức; ghi lại Position có đổi giữa hai lần đọc hay không (tức reframe chạy bất đồng bộ).
- [ ] **Step 5:** Ghi kết quả hai lần dò vào spec §10 (kèm phiên bản Premiere), rồi commit:
  `git commit -m "Record Premiere probes for alpha ProRes import and auto reframe timing."`

Nếu reframe chạy bất đồng bộ, Task 9 bước "đọc lại" phải chờ đến khi Position ổn định (tối đa 30 s, đọc mỗi 2 s) trước khi trả `verified`.

---

### Task 2: Python sidecar, lệnh `captions` và `check`

**Files:**
- Create: `python/pyproject.toml`, `python/requirements.txt`, `python/requirements-cuda.txt`
- Create: `python/premiere_mcp_sidecar/__init__.py`, `__main__.py`, `io.py`, `captions.py`, `check.py`
- Create: `python/premiere_mcp_sidecar/fonts/BeVietnamPro-Bold.ttf`, `BeVietnamPro-ExtraBold.ttf`, `OFL.txt` (lấy từ repo Google Fonts `ofl/bevietnampro`)
- Create: `python/tests/test_captions.py`, `python/tests/test_cli.py`
- Modify: `package.json` (thêm `"python"` vào `files`), `.gitignore` (`python/**/__pycache__`, `python/.venv`)

**Interfaces:**
- Produces: CLI `python -m premiere_mcp_sidecar <command> --input <in.json> --output <out.json> [--progress <progress.json>]`, exit 0 khi thành công. Khi lỗi: exit khác 0, ghi `{"error": "..."}` vào `--output`.
  - `captions` input: `{groups: CaptionGroup[], style: "clean"|"pop"|"karaoke", width: 1080, height: 1920, fps: number, duration: number, font?: string, safeArea: {top, bottom, side}, outPath: string}` → `{path, frames}`. `CaptionGroup = {start, end, text, words: [{w, start, end}]}`, thời gian tính bằng giây từ 0 của short.
  - `check` input `{}` → `{python, fasterWhisper: bool, cuda: bool, models: {whisper: bool, yunet: bool}, ffmpeg: bool}`.
- `io.py`: `read_input(path) -> dict`, `write_output(path, obj)`, `write_progress(path, done: float, eta_sec: float | None)`, `pcm16k(media_path, start=None, end=None) -> np.ndarray` (đọc bằng `ffmpeg -ac 1 -ar 16000 -f f32le -`).

- [ ] **Step 1: Viết test lỗi**, trong `test_captions.py`:
  - `test_render_has_alpha_and_frame_count`: hai nhóm `[{0.0–0.8 "Chào mừng các bạn"}, {0.8–1.6 "Trưng Trắc, Đinh, Lý, Trần"}]`, `fps=25`, `duration=2.0`. Assert `ffprobe` báo `pix_fmt == "yuva444p10le"`, `codec_name == "prores"`, `nb_read_frames == 50`.
  - `test_vietnamese_glyphs_render`: render 1 frame, assert mọi ký tự của `"Trưng Trắc Đinh"` có `font.getmask(ch).getbbox()` khác `None` (font có đủ glyph).
  - `test_text_inside_safe_area`: frame tại 0.4 s, bounding box của pixel alpha > 0 nằm trong `x ∈ [64.8, 1015.2]`, `y ∈ [192, 1632]`.
  - `test_active_word_color_clean`: frame tại thời điểm giữa từ thứ hai có pixel màu `#FFD400` (±8 mỗi kênh).
  - `test_pop_uppercases_and_scales_active_word`: style `pop`, frame tại 60 ms sau đầu một từ có bounding box của từ đó rộng hơn frame tại 120 ms (đã về 1.0); chữ hiển thị là CHỮ HOA (so khớp mask với render chữ hoa).
  - `test_karaoke_shows_whole_group_from_start`: style `karaoke`, frame tại đầu nhóm đã có pixel alpha của mọi từ trong nhóm; từ thứ hai chưa đổi màu, tới giữa từ thứ hai thì đổi.
  - `test_cli.py::test_unknown_command_writes_error`: exit khác 0 và output có khoá `error`.
- [ ] **Step 2:** Chạy `cd python && python -m pytest -q`. Mong đợi: FAIL (module chưa có).
- [ ] **Step 3:** Cài đặt `captions.render(spec: dict) -> dict`: vẽ từng frame bằng PIL (RGBA), ghi PNG vào thư mục tạm, rồi `ffmpeg -framerate {fps} -i %06d.png -c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le -alpha_bits 16`. Chữ căn giữa, đáy khối chữ nằm tại `height × (1 − safeArea.bottom) − 40`. Ngắt dòng khi vượt chiều rộng an toàn. Frame không có nhóm nào thì trong suốt hoàn toàn. Dùng thư mục tạm cho PNG và xoá sau khi xong.
- [ ] **Step 4:** Cài đặt `check.run() -> dict` và `__main__` dispatch (`captions`, `check`; `transcribe`, `faces` thêm ở Task 3).
- [ ] **Step 5:** Chạy `python -m pytest -q`. Mong đợi: PASS.
- [ ] **Step 6:** `requirements.txt`: `faster-whisper==1.2.1`, `ctranslate2==4.8.4`, `av==19.0.2`, `numpy>=2,<3`, `pillow>=11`, `opencv-python-headless>=4.10`, `pytest>=8`. `requirements-cuda.txt` (chỉ Windows/Linux): `nvidia-cublas-cu12==12.9.2.10`, `nvidia-cudnn-cu12==9.27.0.42`.
- [ ] **Step 7: Commit** `git commit -m "Add Python sidecar that renders Vietnamese word captions as ProRes 4444 with alpha."`

---

### Task 3: Sidecar `transcribe`, `faces` và job runner phía TypeScript

**Files:**
- Create: `python/premiere_mcp_sidecar/transcribe.py`, `faces.py`, `python/tests/test_transcribe.py`, `python/tests/test_faces.py`
- Create: `src/analysis/sidecar.ts`, `src/__tests__/analysis/sidecar.test.ts`

**Interfaces:**
- Produces (Python):
  - `transcribe` input `{mediaPath, modelDir, language: "vi", glossary: string[], device: "auto"}` → `{words: [{w, start, end, p}], device, computeType, durationSec}`. Ghi progress theo vị trí segment cuối cùng / độ dài file.
  - `faces` input `{mediaPath, modelPath, ranges: [{start, end}], fps: 1}` → `{samples: [{t, count}]}` với `t` là thời gian trong file. Dùng `cv2.FaceDetectorYN` với `score_threshold=0.8`.
- Produces (TS `src/analysis/sidecar.ts`):
  - `premiereMcpHome(): string`
  - `sidecarPython(): Promise<string | null>`: `venv/Scripts/python.exe` (Windows) hoặc `venv/bin/python`, trả `null` nếu không có.
  - `modelPaths(): { whisper: string; yunet: string }` = `models/faster-whisper-large-v3`, `models/face_detection_yunet_2023mar.onnx`
  - `runSidecar<T>(command: string, input: object, timeoutMs = 600_000): Promise<T>`: chạy và chờ; lỗi thì ném `SidecarError(message, stderrTail)`.
  - `startJob(key: string, command: string, input: object): Promise<JobState>` và `jobStatus(key: string): Promise<JobState | null>`. Thư mục job: `jobs/<sha1(key)>/` chứa `input.json`, `progress.json`, `output.json`, `stderr.log`, `pid`. Tiến trình chạy `detached`, `unref()`.
  - `interface JobState { status: 'running' | 'done' | 'failed'; progress: number; etaSec?: number; result?: unknown; error?: string }`
  - `sidecarMissingResult(tool: string): Record<string, unknown>` (đúng hình dạng trong Global Constraints, `nextStep` nói rõ cần khoảng 3 GB đĩa).
  - `class SidecarError extends Error { stderrTail: string }`

- [ ] **Step 1: Test Python lỗi**:
  - `test_transcribe.py::test_words_shape_with_fake_model`: monkeypatch `WhisperModel` thành fake trả 2 segment có `words`; assert output `words[0] == {"w": "Chào", "start": 0.0, "end": 0.3, "p": 0.9}`; assert `initial_prompt` nhận `"Vietcetera, Trưng Trắc"` khi glossary là `["Vietcetera", "Trưng Trắc"]`; assert không gọi `decode_audio`.
  - `test_transcribe.py::test_cpu_fallback`: fake ném lỗi CUDA khi `device="cuda"`; assert output có `device == "cpu"` và `computeType == "int8"`.
  - `test_faces.py::test_samples_per_second_in_range`: fake detector luôn trả 2 khuôn mặt; ranges `[{10, 13}]`; assert `[s["t"] for s in samples] == [10, 11, 12]` và mọi `count == 2`.
- [ ] **Step 2:** `python -m pytest -q` → FAIL.
- [ ] **Step 3:** Cài đặt `transcribe.run(spec, progress_path)` và `faces.run(spec)`. Đọc frame bằng `ffmpeg -ss t -i file -frames:v 1 -f image2pipe -vcodec bmp -`. Đăng ký hai lệnh trong `__main__`. Trên Windows, thêm thư mục `nvidia/cublas/bin` và `nvidia/cudnn/bin` trong site-packages vào `os.add_dll_directory` trước khi import ctranslate2.
- [ ] **Step 4:** `python -m pytest -q` → PASS.
- [ ] **Step 5: Test TS lỗi** (`sidecar.test.ts`, dùng `PREMIERE_MCP_HOME` trỏ vào thư mục tạm và một "python" giả là script node ghi file output):
  - `returns null and the install result when no venv exists`: `sidecarPython()` là `null`; `sidecarMissingResult('transcribe_sequence')` khớp `{ success: false, retry: false, userActionRequired: true, errorCode: 'asr.not_installed', command: 'premiere-pro-mcp --setup-asr' }`.
  - `startJob then jobStatus reaches done with the result`.
  - `same key while running does not start a second process` (đếm số lần spawn).
  - `dead pid without output.json is failed with the stderr tail` (Review Focus 5); gọi `startJob` lại sau đó thì chạy job mới.
  - `runSidecar rejects with SidecarError when output has error`.
- [ ] **Step 6:** Cài đặt `sidecar.ts`. Kiểm tra pid còn sống bằng `process.kill(pid, 0)`. Ghi `output.json` qua file tạm rồi rename, để không bao giờ đọc phải file ghi dở.
- [ ] **Step 7:** `npx jest src/__tests__/analysis/sidecar.test.ts` → PASS.
- [ ] **Step 8: Commit** `git commit -m "Add sidecar transcribe and face count commands, and a background job runner that survives restarts."`

---

### Task 4: `premiere-pro-mcp --setup-asr` và trạng thái ASR

**Files:**
- Create: `src/setup/asr.ts`, `src/__tests__/setup/asr.test.ts`
- Modify: `src/cli.ts` (case `'--setup-asr'` / `'setup-asr'` và `'asr-status'` in JSON của `asrStatus()`, thêm dòng trong help), `src/tools/domains/discovery.ts:452` (thêm `asr` vào capabilities), `scripts/doctor-windows.ps1` và `scripts/doctor-macos.sh` (gọi `node dist/cli.js asr-status`, in kết quả, **không** làm doctor thất bại khi chưa cài ASR), `python/premiere_mcp_sidecar/__main__.py` (lệnh `download-models`)

**Interfaces:**
- Consumes: `premiereMcpHome`, `sidecarPython`, `modelPaths`, `runSidecar` (Task 3).
- Produces: `setupAsr(log: (line: string) => void): Promise<number>` (exit code); `asrStatus(): Promise<{ installed: boolean; cuda?: boolean; models?: { whisper: boolean; yunet: boolean }; nextStep?: string }>`.
- `download-models` input `{modelsDir}`: tải `Systran/faster-whisper-large-v3` bằng `huggingface_hub.snapshot_download` (thêm `huggingface_hub` vào `requirements.txt`) và `face_detection_yunet_2023mar.onnx` từ `https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx`.

- [ ] **Step 1: Test lỗi** (mock `child_process.spawn`):
  - `uses uv when available`: thứ tự lệnh là `uv venv -p 3.12 <home>/venv`, `uv pip install -p <py> -r <pkg>/python/requirements.txt`, `uv pip install -p <py> <pkg>/python` (cài gói sidecar để `-m premiere_mcp_sidecar` chạy được từ mọi thư mục), rồi `requirements-cuda.txt` trên `win32`/`linux` nhưng **không** trên `darwin`, sau đó `<py> -m premiere_mcp_sidecar download-models`, cuối cùng `check`.
  - `falls back to python -m venv and pip when uv is missing`.
  - `asrStatus reports not installed with the setup nextStep`.
  - `get_capabilities includes asr status` (ở `src/__tests__/tools/index.test.ts`, mock `asrStatus`).
- [ ] **Step 2:** `npx jest src/__tests__/setup` → FAIL.
- [ ] **Step 3:** Cài đặt. Đường dẫn gói lấy từ `fileURLToPath(new URL('../../python', import.meta.url))`. Chạy lệnh tuần tự, mỗi dòng stdout chuyển cho `log`, gặp exit khác 0 thì dừng và trả code đó.
- [ ] **Step 4:** `npx jest` → PASS (toàn bộ).
- [ ] **Step 5:** Chạy thật `node dist/cli.js --setup-asr` trên máy dev. Mong đợi: `check` báo `cuda: true`, có cả hai model.
- [ ] **Step 6: Commit** `git commit -m "Add --setup-asr to install the transcription sidecar and report its status in get_capabilities."`

---

### Task 5: Hàm thuần cho transcript

**Files:**
- Create: `src/analysis/transcript.ts`, `src/__tests__/analysis/transcript.test.ts`

**Interfaces:**
- Consumes: `SequenceClip` (`src/analysis/cleanup.ts:49`).
- Produces:
  ```ts
  export interface AsrWord { w: string; start: number; end: number; p: number }          // thời gian trong file
  export interface TimelineWord extends AsrWord { trackIndex: number; clipId: string }    // thời gian timeline
  export interface Sentence { id: number; start: number; end: number; text: string; firstWord: number; lastWord: number }
  export function mapWordsToTimeline(clips: SequenceClip[], wordsByMedia: Map<string, AsrWord[]>, frameDuration: number):
    { words: TimelineWord[]; skippedClips: Array<{ clipId: string; reason: 'speed_changed' | 'no_media' }> }
  export function dedupeOverlaps(words: TimelineWord[]): TimelineWord[]
  export function repairTimestamps(words: TimelineWord[]): { words: TimelineWord[]; repaired: number }
  export function splitSentences(words: TimelineWord[], pauseSec?: number /* 1.0 */): Sentence[]
  export function clipFingerprint(clips: SequenceClip[]): string   // sha1 của các clip audio đã sắp xếp (id, start, end, inPoint, outPoint, mediaPath)
  ```

- [ ] **Step 1: Test lỗi**:
  - `maps file time to timeline time`: clip `{start: 100, inPoint: 30, outPoint: 40, end: 110}`, từ file tại 35.0 → timeline 105.0.
  - `drops words whose centre is outside the trimmed range`: từ 29.9–30.05 (tâm 29.975) bị bỏ, từ 39.9–40.2 (tâm 40.05) bị bỏ.
  - `one source cut into two clips keeps each part once` (Review Focus 2): clip A dùng file 0–10 ở timeline 0, clip B dùng file 20–30 ở timeline 10. Từ ở file 5 → 5, file 25 → 15, file 15 không xuất hiện.
  - `skips speed-changed clips` (Review Focus 1): `(outPoint − inPoint) = 20`, `(end − start) = 10` → `skippedClips[0].reason === 'speed_changed'`, không có từ nào từ clip đó.
  - `dedupe keeps the higher probability for the same word on two mics`: "chào" track 0 p=0.6 và track 1 p=0.9, chồng nhau 80% → còn đúng 1 từ, `trackIndex` 1.
  - `dedupe keeps both words when the text differs` (nói chồng).
  - `repair interpolates zero-length words`: `[a 1.0–1.2, b 1.2–1.2, c 1.4–1.6]` → `b.end > b.start`, `b.end <= 1.4`, `repaired === 1`.
  - `splits sentences on punctuation and on pauses over 1 s`: "Xin chào. Hôm nay" thành 2 câu; một khoảng ngừng 1.2 s không có dấu câu cũng tách câu; id tăng từ 0.
- [ ] **Step 2:** `npx jest src/__tests__/analysis/transcript.test.ts` → FAIL.
- [ ] **Step 3:** Cài đặt. Clip đổi tốc độ: `|(outPoint − inPoint) − (end − start)| > frameDuration`. "Chồng nhau" = giao / thời lượng từ ngắn hơn > 0.5. So sánh text: lowercase, NFC, bỏ dấu câu.
- [ ] **Step 4:** Chạy lại → PASS.
- [ ] **Step 5: Commit** `git commit -m "Add transcript mapping from source files to sequence time with mic dedupe and sentence splitting."`

---

### Task 6: Tool `transcribe_sequence`

**Files:**
- Create: `src/tools/domains/shorts.ts`, `src/__tests__/tools/shorts.test.ts`
- Modify: `src/tools/domains/index.ts` (thêm `shortsTools`), `src/__tests__/tools/catalog-structure.test.ts:34` (`124` → `125`)

**Interfaces:**
- Consumes: `readSequence`, `isError` (`cleanup.ts`); `startJob`, `jobStatus`, `sidecarPython`, `sidecarMissingResult`, `modelPaths` (Task 3); các hàm Task 5.
- Produces:
  - Tool `transcribe_sequence` với tham số `{ sequenceId?: string; dialogueTrackIndices?: number[]; glossary?: string[]; page?: number /* 0 */; pageSize?: number /* 200 */ }`.
  - `export async function loadTranscript(ctx, args): Promise<TranscriptReady | TranscriptPending | { success: false; error: string }>`, dùng chung cho Task 7 và 9. Trong đó:
    - `TranscriptReady = { status: 'done'; sequenceId: string; fingerprint: string; words: TimelineWord[]; sentences: Sentence[]; warnings: string[]; endTime: number; frameDuration: number }`
    - `TranscriptPending = { status: 'running'; progress: number; etaSec?: number; files: number }`
  - Key job cho mỗi file: `transcribe|<mediaPath>|<size>:<mtimeMs>|large-v3|<glossary.join('\n')>`.
  - Kết quả `done` ghi `transcript-<sequenceId>-<fingerprint>.json` (danh sách từ đầy đủ) vào `premiereMcpHome()/renders`, trả `wordsFile`.

- [ ] **Step 1: Test lỗi** trong `shorts.test.ts` (mock `../../analysis/sidecar.js`, harness giống `roughcut.test.ts`):
  - `returns the install result when the sidecar is missing`.
  - `starts one job per unique audio file and reports running`: 3 clip audio từ 2 file → `startJob` được gọi 2 lần; kết quả `{ status: 'running', files: 2 }`.
  - `returns paged sentences when every job is done`: `pageSize: 1` → `sentences.length === 1`, có `totalSentences` và `wordsFile`.
  - `errors when the dialogue tracks have no clips`: thông báo nêu chỉ số track.
  - `a failed job is reported with its error and restarted on the next call`.
  - Catalog: tăng số đếm lên 125.
- [ ] **Step 2:** `npx jest src/__tests__/tools/shorts.test.ts src/__tests__/tools/catalog-structure.test.ts` → FAIL.
- [ ] **Step 3:** Cài đặt `loadTranscript` và tool. `progress` là trung bình progress các job, file đã xong tính là 1. Gom warnings: số clip bị bỏ (kèm lý do), số timestamp đã sửa, CPU fallback.
- [ ] **Step 4:** Chạy lại → PASS; `npx jest` toàn bộ xanh.
- [ ] **Step 5: Commit** `git commit -m "Add transcribe_sequence: word-level Vietnamese transcript in sequence time, run as a background job."`

---

### Task 7: Ứng viên highlight

**Files:**
- Create: `src/analysis/highlights.ts`, `src/__tests__/analysis/highlights.test.ts`
- Modify: `src/analysis/ffmpeg.ts` (thêm `parseShortTermLoudness`), `src/tools/domains/shorts.ts` (tool `find_highlight_candidates`), `src/__tests__/tools/shorts.test.ts`, `catalog-structure.test.ts` (`125` → `126`)

**Interfaces:**
- Consumes: `loadTranscript` (Task 6); `cached`, `runFf`, `findFfTool`, `FrameSample` (`roughcut.ts`); `runSidecar` (Task 3).
- Produces:
  ```ts
  export const FILLERS = ['ờ', 'à', 'ừ', 'kiểu', 'thì là'];
  export interface Window { startSentenceId: number; endSentenceId: number; start: number; end: number }
  export interface CandidateSignals { wordsPerSec: number; loudnessRel: number; hasQuestion: boolean; hasExclaim: boolean; fillerRate: number; maxPauseSec: number; multiFaceRatio: number }
  export interface Candidate extends Window { text: string; signals: CandidateSignals; rawScore: number }
  export function candidateWindows(sentences: Sentence[], minSec: number, maxSec: number): Window[]
  export function signalsFor(w: Window, words: TimelineWord[], loudness: FrameSample[], medianLufs: number, faces: Array<{ t: number; count: number }>): CandidateSignals
  export function scoreCandidates(cands: Array<Omit<Candidate, 'rawScore'>>): Candidate[]   // z-score trên cả tập
  export function pickDiverse(cands: Candidate[], limit: number, totalSeconds: number): Candidate[]
  // ffmpeg.ts
  export function parseShortTermLoudness(stderr: string): FrameSample[]   // các dòng "t: X ... S: Y" của ebur128=framelog=verbose
  ```
  Tool `find_highlight_candidates` với tham số `{ sequenceId?, dialogueTrackIndices?, minSec = 20, maxSec = 90, limit = 20 }`.

- [ ] **Step 1: Test lỗi**:
  - `windows start and end on sentence boundaries within min/max`: câu dài 10 s × 6, min 20, max 30 → mọi cửa sổ gồm 2–3 câu.
  - `filler rate counts the two-word filler "thì là"`: 10 từ có "ờ" và "thì là" → `fillerRate === 0.3`.
  - `multiFaceRatio is the share of seconds with two or more faces`.
  - `scoreCandidates prefers louder, faster, question windows and penalises fillers, long pauses and multi-face`: trong tập 3 ứng viên tự dựng, ứng viên có tín hiệu tốt nhất có `rawScore` cao nhất, ứng viên nhiều từ đệm và nhiều mặt có `rawScore` thấp nhất.
  - `pickDiverse never overlaps and caps each tenth of the episode at ceil(limit/5)`: 100 ứng viên dồn vào 10% đầu, limit 10 → tối đa 2 ứng viên ở 10% đầu.
  - `parseShortTermLoudness reads t and S`, với một dòng ebur128 thật có `S: -18.3` → `{ t, v: -18.3 }`.
  - Tool: `returns running while the transcript is pending` và `returns candidates with text and signals` (mock sidecar `faces`, mock `runFf`).
- [ ] **Step 2:** Chạy → FAIL.
- [ ] **Step 3:** Cài đặt. `rawScore` = trung bình z-score của (`loudnessRel`, `wordsPerSec`, `hasQuestion ? 1 : 0`) trừ trung bình z-score của (`fillerRate`, `maxPauseSec`, `multiFaceRatio`); z-score tính trong `scoreCandidates` trên toàn bộ ứng viên trước khi `pickDiverse` lọc (độ lệch chuẩn 0 → z = 0). Loudness: `ffmpeg -i <file> -af ebur128=framelog=verbose -f null -` trên từng file audio nguồn, cache bằng `cached(mediaPath, 'ebur128-short', {})`, quy đổi sang thời gian timeline như từ. Faces: `runSidecar('faces')` trên từng file video ở track video cao nhất có clip, theo các khoảng clip, cache bằng `cached(mediaPath, 'faces-yunet', ranges)`.
- [ ] **Step 4:** Chạy → PASS, `npx jest` toàn bộ xanh.
- [ ] **Step 5: Commit** `git commit -m "Add find_highlight_candidates: sentence-bounded windows with loudness, pace, filler and face signals."`

---

### Task 8: Nhóm caption

**Files:**
- Create: `src/analysis/captions.ts`, `src/__tests__/analysis/captions.test.ts`

**Interfaces:**
- Consumes: `TimelineWord` (Task 5).
- Produces:
  ```ts
  export const SAFE_AREA = { top: 0.10, bottom: 0.15, side: 0.06 } as const;
  export interface CaptionGroup { start: number; end: number; text: string; words: Array<{ w: string; start: number; end: number }> }
  export function groupCaptions(words: TimelineWord[], offset: number, maxWords?: number /* 3 */, maxChars?: number /* 18 */): CaptionGroup[]
  export function applyCaptionOverrides(groups: CaptionGroup[], overrides: Array<{ start: number; end: number; text: string }>): CaptionGroup[]
  export function safeFileName(name: string): string
  ```

- [ ] **Step 1: Test lỗi**:
  - `groups at most 3 words and 18 characters`: "Chào mừng các bạn đã đến với Vietcetera Explained" → `["Chào mừng các", "bạn đã đến", "với Vietcetera", "Explained"]`.
  - `breaks after punctuation`: "Hai Bà Trưng, năm 40." → `["Hai Bà Trưng,", "năm 40."]`.
  - `times are relative to the short start`: `offset` 100, từ đầu tại 100.4 → `groups[0].start === 0.4`.
  - `override with the same word count keeps word timings`; `override with a different word count spreads words evenly`: nhóm 0–0.9 s, text mới 3 từ → 0–0.3, 0.3–0.6, 0.6–0.9.
  - `safeFileName keeps Vietnamese letters and replaces path characters` (Review Focus 4): `"Nữ quyền: 8/3?"` → `"Nữ quyền- 8-3-"`; chuỗi rỗng → `"short"`.
- [ ] **Step 2:** Chạy → FAIL. **Step 3:** Cài đặt. **Step 4:** Chạy → PASS.
- [ ] **Step 5: Commit** `git commit -m "Add caption grouping, overrides and safe file names for short captions."`

---

### Task 9: Tool `build_short`

**Files:**
- Modify: `src/tools/domains/shorts.ts`, `src/tools/domains/editing.ts` (export `qaSequence` và `ensureBackup`), `src/__tests__/tools/shorts.test.ts`, `catalog-structure.test.ts` (`126` → `127`)

**Interfaces:**
- Consumes: `loadTranscript`, `clipFingerprint`, `groupCaptions`, `applyCaptionOverrides`, `safeFileName`, `SAFE_AREA`, `runSidecar('captions')`, `normalizeLoudness`, `qaSequence`, `ensureBackup`, `readSequence`; dữ liệu faces từ Task 7 (dùng lại hàm faces có cache).
- Produces: tool `build_short` với tham số `{ sequenceId?, dialogueTrackIndices?, startSentenceId: number, endSentenceId: number, name: string, captionStyle: 'clean' | 'pop' | 'karaoke' = 'clean', captions?: {start, end, text}[], font?: string, targetLufs = -14, dryRun = false, backup = true }`.
  Kết quả chạy thật: `{ success, verified, shortSequenceId, name, durationSec, captionFile, backupPath?, qa, warnings, markers, failedStep? }`. Kết quả dryRun: `{ success: true, dryRun: true, start, end, durationSec, name, captions: CaptionGroup[] }`.

- [ ] **Step 1: Test lỗi** (mock bridge `executeScript`, `importMedia`, sidecar):
  - `dryRun returns caption groups and never calls Premiere writes or the renderer`.
  - `rejects a reversed or out-of-range sentence range`: `startSentenceId > endSentenceId`, hoặc id không tồn tại → lỗi nêu `totalSentences`.
  - `rejects a stale transcript` (Review Focus 3): fingerprint lúc chạy khác fingerprint của transcript → lỗi `"The sequence changed since it was transcribed. Run transcribe_sequence again."`.
  - `renders captions before touching Premiere`: renderer ném lỗi → không có `executeScript` nào chứa `createSubsequence`; kết quả `{ success: false, failedStep: 'render_captions' }`.
  - `runs the steps in order and verifies`: thứ tự gọi là backup → script reframe (chứa `setInPoint`, `createSubsequence(true)`, `autoReframeSequence(9, 16`) → import vào bin `Shorts/<safe name>` → script đặt caption lên track trên cùng tại 0 → normalize → qa → script marker; `verified: true` khi kích thước 1080×1920 và thời lượng khớp ±1 frame.
  - `stops at the failing step and keeps what was built`: reframe trả `success:false` → `{ verified: false, failedStep: 'reframe', backupPath }`.
  - `adds a warning marker for each multi-face stretch`: faces có count 2 trong 2 giây liên tiếp → 1 marker với đúng chuỗi trong Global Constraints.
  - `keeps the Vietnamese sequence name but writes a safe file name` (Review Focus 4).
- [ ] **Step 2:** Chạy → FAIL.
- [ ] **Step 3:** Cài đặt theo spec §4.3. Một ExtendScript cho bước reframe: đặt in/out, `createSubsequence(true)`, `autoReframeSequence(9, 16, "default", name, false)`, xoá subsequence trung gian bằng `app.project.deleteSequence`, trả `{sequenceID, frameSizeHorizontal, frameSizeVertical, end}`. Nếu Task 1 ghi nhận reframe bất đồng bộ, thêm vòng đọc lại chờ ổn định (tối đa 30 s, mỗi 2 s). File caption ghi vào `premiereMcpHome()/renders/<safeFileName(name)>-<timestamp>.mov`.
- [ ] **Step 4:** Chạy → PASS; `npm run build && npx jest && npm run lint` đều xanh.
- [ ] **Step 5: Commit** `git commit -m "Add build_short: 9:16 short from a transcript range with auto reframe, alpha captions, loudness and QA."`

---

### Task 10: Skill, tài liệu và chạy thật

**Files:**
- Create: `skills/podcast-to-shorts/SKILL.md`
- Modify: `README.md` (danh sách tool), `CHANGELOG.md` (mục `Unreleased`), `KNOWN_ISSUES.md`, `skills/premiere-pro-mcp/SKILL.md` (một dòng trỏ sang skill mới)

- [ ] **Step 1:** Viết `SKILL.md` theo spec §7: frontmatter `name: podcast-to-shorts`, mô tả có các từ kích hoạt "short", "reels", "highlight", "cắt podcast"; quy trình 3 lần duyệt; rubric; nhắc hỏi glossary trước khi transcribe; không tự export.
- [ ] **Step 2:** CHANGELOG/README nêu 3 tool, lệnh `--setup-asr`, yêu cầu khoảng 3 GB đĩa và GPU NVIDIA (không có GPU thì chạy CPU, chậm hơn khoảng 3–4 lần).
- [ ] **Step 3:** Chạy thật trên Premiere 25.6.3 với một podcast **có video** do người dùng cung cấp: `transcribe_sequence` (đo thời gian), `find_highlight_candidates`, `build_short` cho 2 short (`clean` và `pop`). Mong đợi: `verified: true`, `qa_sequence` sạch, caption khớp lời khi xem, loudness ra -14 ± 1 LUFS. Ghi số liệu và mọi hạn chế vào `KNOWN_ISSUES.md` và CHANGELOG.
- [ ] **Step 4: Commit** `git commit -m "Add podcast-to-shorts skill and record live verification on Premiere 25.6.3."`
