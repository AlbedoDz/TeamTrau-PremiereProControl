# Podcast → Shorts (sub-project A) — Design

Ngày: 2026-11-01 · Trạng thái: chờ duyệt · Nền: bản 1.4.0 (295 tool)

## 1. Mục tiêu

Agent nhận một **sequence 16:9 đã dựng** của một tập podcast dài (20–90 phút) và tạo ra **nhiều sequence 9:16** trong Premiere, mỗi sequence là một short 20–90 giây có caption động tiếng Việt. Người dùng vẫn chỉnh tay được mọi thứ trong Premiere.

Thành công khi:
- Một tập 60 phút có transcript từng từ trong ≤ 15 phút trên GPU RTX 3070, và lần chạy sau dùng cache.
- Agent đề xuất được ≥ 10 ứng viên có text và tín hiệu, người dùng chọn, mỗi short dựng xong trong một lời gọi `build_short`.
- Short dựng ra: 9:16, đã Auto Reframe, caption alpha trên track trên cùng, loudness -14 LUFS, `qa_sequence` sạch, `verified: true`.

Đây là sub-project đầu tiên trong 4 (A Shorts, B thư viện motion/text có xem trước, C playbook theo thể loại, D 3D/Rive/Lottie). B, C, D có spec riêng.

## 2. Quyết định đã chốt

| Chủ đề | Quyết định | Lý do |
|---|---|---|
| Đầu vào | Sequence 16:9 đã dựng (góc máy đã cắt sẵn) | Không phải tự sync multicam |
| ASR | **faster-whisper + Whisper large-v3** | Spike (mục 9): có dấu câu, viết hoa, số dạng chữ số, đúng tên riêng |
| Chọn highlight | Agent đang chat chấm điểm; server chỉ chuẩn bị ứng viên + tín hiệu | Không cần API key, không thêm chi phí |
| Reframe | `autoReframeSequence` gốc của Premiere | Đa số cảnh 1 người/khung; cảnh nhiều người chỉ đánh dấu |
| Caption | Render ra `.mov` ProRes 4444 alpha rồi import | Người dùng chốt: motion/text render ra file |
| Kiến trúc | Tool MCP TypeScript + Python sidecar (CLI JSON) | Dùng được mọi MCP client, test được, theo pattern `src/analysis` |

Loại bỏ: PhoWhisper (mất chữ, timestamp độ dài 0, không dấu câu). Hoãn: Zipformer (CPU nhanh nhưng sai tên riêng, cần model dấu câu, giấy phép 68M chưa rõ, 30M là CC-BY-NC-ND).

## 3. Kiến trúc

```
MCP client (Agent)
   │ invoke_tool
   ▼
src/tools/domains/shorts.ts          handler: lấy dữ liệu Premiere, gọi sidecar, áp kết quả
   ├─ src/analysis/transcript.ts     thuần: quy đổi thời gian file→timeline, loại trùng mic, tách câu
   ├─ src/analysis/highlights.ts     thuần: cửa sổ ứng viên + tín hiệu + lọc đa dạng
   ├─ src/analysis/captions.ts       thuần: chia nhóm caption, vùng an toàn
   ├─ src/analysis/sidecar.ts        tìm venv, chạy job, đọc JSON, báo thiếu cài đặt
   └─ dùng lại: readSequence, cached(), backup project, normalize_loudness, qa_sequence
   ▼
python/premiere_mcp_sidecar/          CLI: JSON vào stdin/file, JSON ra stdout, tiến độ ra stderr
   ├─ transcribe   faster-whisper large-v3, word_timestamps, initial_prompt = glossary
   ├─ faces        OpenCV YuNet, đếm khuôn mặt 1 lần/giây trên khoảng thời gian cho trước
   └─ captions     PIL → PNG frames → ffmpeg → .mov ProRes 4444 (yuva444p10le)
```

Quy ước bắt buộc (giống 1.4.0): mọi tool sửa sequence có `dryRun`, backup project trước khi sửa, đọc lại sau khi sửa và trả `verified`; phân tích lưu bằng `cached()`; logic quyết định nằm trong hàm thuần.

Thiếu Python chỉ ảnh hưởng 3 tool này; mọi tool khác chạy như cũ.

## 4. Tool

### 4.1 `transcribe_sequence`

Tham số: `sequenceId?`, `dialogueTracks?` (tên track, cùng quy ước `auto_duck_music`; mặc định mọi track audio không mute), `glossary?: string[]`, `page?`, `pageSize?` (mặc định 200 câu).

1. `readSequence` → các clip audio trên track thoại.
2. Mỗi file nguồn transcribe **một lần cho toàn file**, cache theo (đường dẫn, mtime, size, model, glossary).
3. Quy đổi: `tTimeline = clip.start + (tFile − clip.inPoint)`; bỏ từ có tâm nằm ngoài `[inPoint, outPoint)`.
4. Loại trùng nhiều mic: hai từ khác track chồng nhau > 50% thời lượng và cùng text chuẩn hoá → giữ từ có `probability` cao hơn; khác text → giữ cả hai (nói chồng).
5. Từ có `end ≤ start` → nội suy từ hàng xóm, đếm vào `warnings`.
6. Tách câu theo `. ? !` của Whisper, hoặc khoảng ngừng > 1,0 s.

Chạy nền: nếu có file chưa có cache, tool khởi động job rồi trả ngay `{status: "running", jobId, progress, etaSec}`. Gọi lại cùng tham số → trạng thái mới hoặc kết quả. Một job mỗi file; job đang chạy không bị khởi động lại.

Kết quả: `{status: "done", sentences: [{id, start, end, text}], totalSentences, page, wordsFile, warnings}`. `wordsFile` là JSON đầy đủ từng từ trong thư mục cache.

### 4.2 `find_highlight_candidates`

Tham số: `sequenceId?`, `minSec=20`, `maxSec=90`, `limit=20`. Yêu cầu transcript đã xong (nếu chưa, trả `status: "running"` giống 4.1).

1. Ứng viên = cửa sổ từ đầu một câu đến cuối một câu, dài trong `[minSec, maxSec]`.
2. Tín hiệu mỗi ứng viên:
   - `wordsPerSec`
   - `loudnessRel`: LUFS ngắn hạn so với trung vị cả tập (ffmpeg ebur128, cache)
   - `hasQuestion`, `hasExclaim`
   - `fillerRate`: mật độ “ờ, à, ừ, kiểu, thì là” trên số từ
   - `maxPauseSec`
   - `multiFaceRatio`: tỉ lệ giây có ≥ 2 khuôn mặt trên track video trên cùng (sidecar `faces`, cache)
3. Lọc: điểm thô = chuẩn hoá của (loudnessRel, wordsPerSec, hasQuestion) trừ (fillerRate, maxPauseSec, multiFaceRatio); chọn tham lam không chồng nhau, mỗi phần mười của tập tối đa `ceil(limit/5)` ứng viên.
4. Trả `[{startSentenceId, endSentenceId, start, end, text, signals}]`. Điểm thô chỉ để lọc, **Agent quyết định** theo rubric trong skill.

### 4.3 `build_short`

Tham số: `sequenceId?`, `startSentenceId`, `endSentenceId`, `name`, `captionStyle = "clean" | "pop" | "karaoke"`, `captions?: {start, end, text}[]`, `font?`, `targetLufs = -14`, `dryRun = false`, `backup = true`.

`dryRun: true` trả kế hoạch: khoảng thời gian, tên sequence, **nhóm caption** (≤ 3 từ hoặc ≤ 18 ký tự mỗi nhóm, ngắt ở dấu câu, thời gian theo từ, tính từ 0 của short). Người dùng duyệt/sửa chữ; lần chạy thật truyền lại qua `captions`.

Chạy thật, theo thứ tự:
1. **Render caption trước** qua sidecar → `.mov` 1080×1920, đúng fps sequence, trong vùng an toàn (chừa 15% dưới, 10% trên, 6% hai bên). Lỗi ở đây → dừng, project không đổi.
2. Backup project.
3. Đặt in/out trên sequence gốc → `createSubsequence` → `autoReframeSequence(9, 16)` → đổi tên thành `name` → xoá subsequence trung gian.
4. Import `.mov` vào bin `Shorts/<name>`, thêm track video trên cùng, đặt caption tại 0.
5. `normalize_loudness` về `targetLufs` trên short.
6. `qa_sequence` trên short.
7. Marker cảnh báo cho mỗi khoảng có `multiFaceRatio` > 0 (“Cảnh nhiều người — kiểm tra khung reframe”).
8. Đọc lại: thời lượng khớp ± 1 frame, có clip caption, kích thước 1080×1920 → `verified`.

Lỗi ở bước 3–7 → dừng, giữ những gì đã tạo để người dùng xem, trả `verified: false`, `failedStep`, đường dẫn backup.

## 5. Caption

- Font mặc định **Be Vietnam Pro** (OFL), đóng gói trong sidecar; `font` nhận đường dẫn `.ttf` khác.
- `clean`: trắng, viền đen 6 px, từ đang nói màu vàng `#FFD400`.
- `pop`: CHỮ HOA, từ đang nói scale 1,0 → 1,15 → 1,0 trong 120 ms.
- `karaoke`: cả nhóm hiện sẵn, màu chạy theo từng từ.
- Ba preset là tạm thời; sub-project B thay bằng thư viện template có xem trước.

## 6. Cài đặt

- `python/` nằm trong npm package. Lệnh `premiere-pro-mcp --setup-asr`: dùng `uv` nếu có, không thì `python -m venv`; venv và model ở `~/.premiere-mcp/` (Windows: `%USERPROFILE%\.premiere-mcp\`).
- Ghim phiên bản: `faster-whisper`, `av` (bản mới làm faster-whisper lỗi `metadata_errors`; sidecar vẫn tự đọc audio PCM bằng ffmpeg để không phụ thuộc PyAV), `opencv-python-headless`, `pillow`, `numpy`. `nvidia-cublas-cu12`, `nvidia-cudnn-cu12` chỉ trên Windows/Linux.
- Không có CUDA → `device="cpu", compute_type="int8"` + cảnh báo thời gian.
- `setup:doctor` và `get_capabilities` báo: venv, model, CUDA.
- Thiếu cài đặt → `{success: false, retry: false, userActionRequired: true, command, nextStep}`, giống thông báo thiếu ffmpeg.

## 7. Skill `skills/podcast-to-shorts/SKILL.md`

- Thứ tự: `verify_premiere_connection` → `transcribe_sequence` (hỏi glossary tên riêng trước) → `find_highlight_candidates` → chấm điểm → **duyệt 1**: danh sách short đề xuất → `build_short dryRun` → **duyệt 2**: chữ caption → `build_short` → **duyệt 3**: xem các marker cảnh báo.
- Rubric: hook rõ trong 3 giây đầu; có payoff; nghe độc lập vẫn hiểu (không “như tôi nói lúc nãy”); không cụt ý ở cuối; ưu tiên `multiFaceRatio` thấp.
- Không tự export; export chỉ khi người dùng yêu cầu.

## 8. Kiểm thử

1. Jest cho hàm thuần: quy đổi thời gian (trim, nhiều clip cùng file), loại trùng mic, tách câu, cửa sổ ứng viên + lọc đa dạng, chia nhóm caption (dấu câu, giới hạn ký tự), vùng an toàn, nội suy timestamp.
2. Jest cho handler với fake bridge + fake sidecar: `dryRun` không gọi Premiere; caption render lỗi → không gọi Premiere; lỗi giữa chừng → `verified: false` + `failedStep`; job nền running/done.
3. pytest sidecar: `.mov` đúng số frame, có alpha, dấu tiếng Việt (“Trưng Trắc”, “Đinh, Lý, Trần”) render không vỡ.
4. Chạy thật trên Premiere 25.6.3 với một podcast có video (người dùng cung cấp khi tới bước này), ghi kết quả vào `KNOWN_ISSUES.md`/CHANGELOG như 1.3.0/1.4.0.

## 9. Kết quả spike ASR (9 phút 10 giây, Vietcetera Explained EP2)

| | Whisper large-v3 | PhoWhisper-large (CT2) | Zipformer-68M |
|---|---|---|---|
| Thời gian | 124 s (GPU 3070) | 139 s (GPU) | 22 s (CPU) |
| Dấu câu / hoa | Có | Không | TOÀN HOA, không dấu câu |
| Số | “năm 40” | “bốn mười” (sai), “bốn m” | “BỐN MƯƠI” |
| Tên riêng | Vietcetera Explained, Trưng Trắc | “việt ly sê ta ra ét pờ len” | VIETJETRAND, “TRƯƠNG TRẮC” |
| Từ dài 0 s | 2 | 23 | 0 |
| Lệch timestamp giữa engine | trung vị 0,06–0,1 s | | |

Đối chiếu tay trên phút 2:00–3:00, không phải WER chuẩn.

## 10. Rủi ro cần kiểm chứng ở bước đầu của plan

- `autoReframeSequence` có thể phân tích bất đồng bộ → đọc lại có thể thấy sequence chưa reframe xong. Kiểm thử trên máy thật trước khi viết bước 3.
- Premiere trên Windows đọc alpha của ProRes 4444 `.mov`. Phương án dự phòng: chuỗi PNG.
- Session phát hành 1.4.0 vẫn làm việc trên cùng thư mục → triển khai trong git worktree riêng.

### Kết quả dò trên Premiere 25.6.3 (Windows, 2026-11-01, Project-Temp)

- **Alpha:** Premiere đọc đúng alpha của ProRes 4444 (`prores_ks -profile:v 4 -pix_fmt yuva444p10le -alpha_bits 16`). Metadata `Column.Intrinsic.VideoInfo` là `1080 x 1920 (1,0), Straight Alpha`, giống ảnh PNG RGBA đối chứng; PNG-in-MOV và QuickTime Animation cũng vậy. `FootageInterpretation.alphaUsage` là `0` cho mọi file, kể cả PNG có alpha, nên không dùng được để kiểm tra. ffprobe báo file ProRes 4444 là `yuva444p12le` (phía giải mã). `export_frame` lỗi `Unknown error exception` trên bản này, nên không kiểm tra được bằng ảnh xuất.
- **Auto Reframe:** `Sequence.autoReframeSequence(9, 16, "default", name, false)` trả về sequence mới ngay (≈ 0,4 s). **Kích thước theo chiều cao nguồn**: nguồn 3840×2160 cho ra **1215×2160**, không phải 1080×1920. Khung đi theo chủ thể nằm trong effect **"Auto Reframe"** được thêm vào clip (`Generated Keyframes`, 42 keyframe cho 20 s), còn `Motion.Position` không đổi. Vài giây sau lần gọi đã có keyframe.
- **Hệ quả cho `build_short`:** render caption theo kích thước thật của sequence sau reframe (đọc `frameSizeHorizontal/Vertical`), vùng an toàn tính theo tỉ lệ; `verified` kiểm tra tỉ lệ 9:16 (±1 px) chứ không kiểm tra cứng 1080×1920; bước đọc lại chờ đến khi effect "Auto Reframe" có keyframe `Generated Keyframes` (tối đa 30 s, đọc mỗi 2 s), quá hạn thì cảnh báo, không fail.

## 11. Ngoài phạm vi

Zipformer, crop theo khuôn mặt, diarization, B-roll, nhạc nền (đã có `auto_duck_music`), export tự động, thư viện template motion (sub-project B).
