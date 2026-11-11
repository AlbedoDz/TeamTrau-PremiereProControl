# Panel GUI cho editor — Design

Ngày: 2026-11-11 · Bản 2 (sau tự phản biện) · Trạng thái: chờ duyệt · Nền: `clean-main` (`679d220`), 1.4.0 với 299 tool

## 1. Mục tiêu

Hiện panel **TeamTrau PremiereProControl** chỉ là cầu nối cho Agent: hiện trạng thái, nút Start/Stop Bridge và log. Gần 300 tool chỉ dùng được qua một client AI. Spec này làm hai việc:

1. Thêm **5 tool quy trình** vào catalog. Mỗi tool chạy trọn một quy trình dựng, có báo tiến độ và hủy được. Agent gọi một lệnh là xong cả quy trình.
2. Biến panel thành **giao diện cho editor tầm trung**, chạy chính 5 tool đó bằng vài cú bấm, không cần Agent.

Thành công khi:
- Có Premiere mà không mở client AI nào, editor vẫn chạy được trọn 5 quy trình từ panel, trên bản sao của sequence.
- Agent chạy được cùng 5 quy trình đó, mỗi quy trình bằng một lời gọi, và thấy tiến độ qua MCP progress.
- Mọi quy trình có Xem trước (không sửa gì), báo tiến độ theo bước, hủy được, và lỗi hiện bằng tiếng Việt kèm việc cần làm.
- Mỗi quy trình chỉ sửa timeline **một lượt** trên bản sao. Bản gốc không bao giờ bị đụng tới.

## 2. Quyết định đã chốt

| Chủ đề | Quyết định | Lý do |
|---|---|---|
| Người dùng | Editor tầm trung: thạo Premiere, không đọc tên tool hay tham số kỹ thuật | Do người dùng chốt |
| Quy trình | Recap dài → ngắn (16:9/9:16), Dọn voice-over, Podcast → Shorts, Phụ đề tiếng Việt, Rough cut / Cắt theo nhạc | Do người dùng chọn |
| Nơi đặt logic quy trình | **Tool trong catalog** (`workflow_*`); GUI và Agent dùng chung | Một bản code; Agent cũng giảm số lần gọi |
| Panel gọi tool bằng cách nào | Panel tự khởi động runner Node; runner dùng `PremiereProBridge` **gốc** (bridge file) | Không phải viết đường ống mới, không thể chạy chồng với Agent |
| Cách sửa timeline | Tính mọi khoảng cần bỏ trên bản gốc → gộp → **một lần `remove_ranges`** trên bản sao | Timestamp không lệch, dùng được cache transcript, giữ nguyên mọi track |
| Chọn đoạn (Recap/Shorts) | **Tự động hoàn toàn**; editor sửa trên timeline sau | Do người dùng chọn |
| Bộ chọn | Heuristic offline mặc định. **AI chỉ thêm sau khi đo chất lượng heuristic** trên video thật | Không làm khi chưa có dữ liệu cho thấy cần |
| Từ đệm | Từ điển 3 tầng A/B/C trong file dữ liệu; tầng C không bao giờ cắt | Danh sách gốc có từ phủ định, từ lịch sự, phương ngữ: xóa đi là hỏng nghĩa |
| GUI v1 | Tab **Quy trình**, tab **Kết nối** (panel cũ), ⚙ Cài đặt | Tab Công cụ (form cho từng tool) hoãn sang v1.1: ít giá trị với editor tầm trung |

**Loại khỏi phạm vi.** Danh sách dưới đây rút từ việc đối chiếu cẩm nang biên tập 160 nguồn với code ngày 2026-11-11:
- **Đã có sẵn:**
  - silencedetect −35 dB / 0,5 s và đệm 0,1 s (`remove_silence_from_sequence`)
  - karaoke `#FFD400`
  - thời gian theo từng từ
  - chia pha probe→QC
  - lọc tiếng thở (`apply_dialogue_chain` nhận effect tùy ý)
  - nhịp B-roll (`assemble_rough_cut.shotSeconds`, preset của `assemble_beat_cut`)
- **Sai hoặc xung đột:**
  - cắt lossless bằng `-c copy` (tool dựng không phá hủy trong Premiere)
  - Kokoro dùng để lấy timing (Kokoro là TTS)
  - prompt mẫu cho Agent (thay bằng tool quy trình)
- **Không tích hợp:** lật hình, tăng tốc 1.02–1.05x, crop 1.05x để né nhận diện bản quyền.
- **Hoãn:**
  - chọn cỡ cảnh và cắt trên hành động → spec Vision
  - đồng bộ mic rời, tự chuyển góc theo người nói, gợi ý LUT cho footage Log → phase 2
  - SFX theo chuyển động, payoff timing, hold ≥ 1 s, easing → spec Motion
  - tab Công cụ, bộ chọn AI thứ hai (DeepSeek) → v1.1

## 3. Kiến trúc

```
Agent (MCP client) ──stdio MCP──► server MCP ─┐
                                              │  PremiereProBridge (bridge file, temp dir)
Panel GUI ──spawn──► runner (--panel-runner) ─┤
                                              ▼
                     Panel CEP: quét temp dir mỗi 250 ms → một hàng đợi evalScript → Premiere
```

**Thêm vào `ToolContext`** hai trường tùy chọn: `progress?(step, stepCount, label)` và `signal?: AbortSignal`.
- **Server MCP:**
  - Nếu request có `progressToken`, `progress` được nối vào thông báo `notifications/progress`.
  - `signal` bị hủy khi client gửi `notifications/cancelled`.
- **Runner:** `progress` ghi ra stdout cho panel; `signal` bị hủy khi panel gửi `cancel`.
- **Tool cũ:** bỏ qua hai trường này, không đổi gì.

**Runner** (`cli.js --panel-runner`):
- Dựng `PremiereProTools(new PremiereProBridge())`. Thư mục temp nhận qua biến `PREMIERE_TEMP_DIR` do panel truyền vào, nên không thể lệch với panel.
- **Giao thức stdio, mỗi dòng một JSON:**
  - panel gửi: `{type:"run", id, tool, args}`, `{type:"cancel", id}`
  - runner gửi: `{type:"ready", version}`, `{type:"progress", id, step, stepCount, label}`, `{type:"result", id, result}`, `{type:"log", level, message}`
- **Tìm runner:**
  1. Đọc `runner.nodePath`/`runner.cliPath` trong config của panel. Setup.exe ghi hai giá trị này: `node\node.exe` và `dist\cli.js`.
  2. Nếu không có, dùng `node` trên PATH với `cli.js` của gói npm toàn cục.
  3. Nếu vẫn không thấy, báo lỗi kèm hướng dẫn `premiere-pro-mcp --doctor`.
- **Vòng đời:**
  - Khởi động ở lần chạy đầu và giữ chạy.
  - Khi stdin đóng (panel bị đóng), runner hủy tác vụ ở ranh giới bước kế tiếp rồi thoát.
  - Runner crash: tác vụ thất bại, stderr cuối hiện trong tab Kết nối, và lần chạy sau khởi động lại runner.
  - Nếu bridge chưa chạy, panel tự bật trước khi khởi động runner, vì panel vốn đã tự bật bridge khi mở.
- Mỗi lần GUI chỉ chạy một quy trình; quy trình bấm sau được xếp hàng. Agent và GUI cùng đi qua bridge file, nên ExtendScript luôn chạy tuần tự.
- Chi phí: mỗi script chậm thêm tối đa khoảng 250 ms do chu kỳ quét. Một quy trình chừng vài chục script thì chậm thêm vài giây.

## 4. Tool quy trình (`workflow_*`)

Quy tắc chung:
- Mọi tool quy trình đều có `sequenceId?` (mặc định sequence đang mở), `dryRun`, `backup` (mặc định true) và `name?` cho sequence kết quả.
- Mỗi tool **luôn tạo sequence mới hoặc bản sao**, không sửa bản gốc.
- **Kết quả trả về:**
  - `steps: [{label, ok, detail}]`
  - `summary` với số liệu: vết cắt, thời lượng trước/sau, LUFS…
  - `outputSequenceIds`, `warnings`
- **Khi `dryRun`:** chỉ phân tích và trả kế hoạch, không tạo hay sửa sequence nào.

| Tool | Tham số riêng | Các bước |
|---|---|---|
| `workflow_clean_voiceover` | `cutSilence` (true), `cutFillers` (true), `fillerTiers` (mặc định xem 5.2), `cutRetakes` (true), `dialogueChain` (true), `targetLufs` (−16), `crossfadeMs` (30) | 1. Phân tích khoảng lặng, từ đệm và câu vấp trên **bản gốc**, dùng cache transcript. 2. Gộp các khoảng. 3. Nhân bản sequence. 4. Một lần `remove_ranges`. 5. `apply_dialogue_chain` + chuẩn loudness. 6. `qa_sequence` |
| `workflow_recap` | `targetSec`, `aspect` ("16:9"\|"9:16"), `captionStyle` ("none"\|"clean"\|"pop"\|"karaoke"), `audioLeadSec` (0) | 1. `plan_recap`. 2. `build_recap`. 3. `qa_sequence` |
| `workflow_shorts` | `count` (1–5), `minSec`/`maxSec` (30/60), `captionStyle` | 1. `transcribe_sequence`. 2. `find_highlight_candidates`. 3. Chọn N đoạn điểm cao nhất, không chồng thời gian. 4. `build_short` × N |
| `workflow_subtitles` | `output` ("srt"\|"caption_track"), `maxCharsPerLine` (42), `glossary?`, `outputPath?` | `create_captions_from_transcript`; khi chọn `caption_track` thì import SRT vào track caption |
| `workflow_rough_cut` | `folderPath`, `targetSec?` hoặc `musicPath?`, `pace` ("calm"\|"balanced"\|"energetic") hoặc `shotSeconds?`, `hasVoiceover` (false) | Không nhạc: `score_clips` → `assemble_rough_cut`. Có nhạc: `assemble_beat_cut`. `hasVoiceover`: thêm `auto_duck_music` |

Mỗi bước gọi `ctx.progress` và kiểm tra `ctx.signal` trước khi bắt đầu.

## 5. Tool nền mới

### 5.1 `remove_ranges`: lõi cắt dùng chung
Tách lõi cắt của `remove_silence_from_sequence` ra thành tool riêng (hạng mục 3 trong roadmap hiệu suất).
- **Input:** `sequenceId?`, `ranges: [{start, end}]` theo giây sequence, `invert` (false; true là **giữ** các khoảng này và bỏ phần còn lại), `crossfadeMs` (30, 0 là tắt), `dryRun`, `backup`.
- **Chuẩn hóa khoảng:** sắp xếp, gộp các khoảng chồng nhau hoặc cách nhau dưới `mergeGapSec` (0,4). Phần giữ lại ngắn hơn `minKeepSec` (0,4) cũng bị bỏ, để không sinh mẩu vụn.
- **Crossfade:** đặt transition âm thanh Constant Power tại mỗi vết cắt mới. Premiere không cho transition ngắn hơn 1 frame, nên độ dài thật là `max(crossfadeMs, 1 frame)`, làm tròn theo frame. Kết quả trả về `crossfadeFrames` và `crossfadeMsActual`.
- **Output:** `removed: [{start, end}]`, `durationBefore`, `durationAfter`, `verified`.
- `remove_silence_from_sequence` gọi lõi này và có thêm tham số `crossfadeMs`.

### 5.2 `find_fillers_and_retakes` (chỉ đọc)
Tool này chỉ phân tích và trả về các khoảng cần bỏ, không sửa timeline. Việc cắt do `remove_ranges` hoặc `workflow_clean_voiceover` làm.
- **Input:** `sequenceId?`, `dialogueTrackIndices?`, `glossary?`, `tiers?`, `retakes` (true), `minPauseMs` (150).
- **`tiers` mặc định:** `["A"]` nếu sequence có clip video trên track video thấp nhất, vì người nói trước máy quay thì nhiều vết cắt nhỏ sẽ thành jump cut. Còn lại mặc định `["A","B"]`.
- **Từ điển:** `data/fillers-vi.json` có dạng `{A: string[], B: string[], C: string[]}`. Người dùng đặt `~/.premiere-mcp/fillers-vi.json` để ghi đè từng tầng. `FILLERS` trong `src/analysis/highlights.ts` chuyển sang đọc A ∪ B từ cùng file.
  - **A (ngập ngừng):** à, ờ, ừm, ơ, ư, hừm, ừm hứm, ờ thì, à mà.
  - **B (câu giờ):** kiểu, kiểu như, kiểu như là, cái kiểu, dạng như, đại loại là, đại khái là, nói chung là, nôm na là, tạm gọi là, thực ra thì, thật ra là, với lại, xong rồi, cái gì nhỉ, cái đó đó, cái kia kìa, làm sao nhỉ, thế nào nhỉ, nói sao ta.
  - **C (không bao giờ cắt):**
    - toàn bộ tiểu từ tình thái và lịch sự, phủ định, cảm thán trong danh sách người dùng cung cấp
    - từ nối: thì, mà, là, tức là, nghĩa là, tóm lại là, vấn đề là, cái chính là
    - toàn bộ từ phương ngữ Bắc, Trung, Nam

    Tầng C chỉ dùng để đếm cho điểm trôi chảy.
- **Quy tắc cắt:**
  - **A:** cắt khi cụm từ đứng riêng, tức là có ngừng ≥ `minPauseMs` ở ít nhất một phía, hoặc ở đầu hay cuối câu.
  - **B:** chỉ cắt khi có ngừng ≥ `minPauseMs` ngay sau, khi lặp lại liền nhau, hoặc khi đứng đầu câu rồi ngừng.
  - Không cắt khi việc cắt khiến câu còn lại ít hơn 2 từ.
  - Khớp theo cụm dài nhất trước, sau khi chuẩn hóa Unicode NFC và chữ thường.
- **Chỉnh mép vết cắt:** mép do ASR đưa ra lệch khoảng ±50–100 ms. Mỗi mép được dời tới điểm năng lượng thấp nhất trong khoảng ±80 ms, đo bằng mức RMS 10 ms từ ffmpeg, để không xén mất đầu hay đuôi chữ kế bên.
- **Câu vấp:** câu S1 bị bỏ khi câu liền sau S2 bắt đầu trong vòng 10 s sau khi S1 kết thúc, và thỏa một trong hai điều kiện:
  - các từ của S1 là tiền tố các từ của S2;
  - S1 và S2 trùng ≥ 60% từ (Jaccard).

  Chuỗi vấp dài thì giữ câu cuối cùng.
- **Output:** `ranges: [{start, end, reason: "filler-A"|"filler-B"|"retake", text}]`, `removedSeconds`, `fingerprint`.
- **Phát hiện bằng âm thanh**, chỉ bật nếu spike 1 cho thấy cần: đoạn có tiếng dài < 0,6 s, nằm giữa hai khoảng lặng và không chồng với từ nào trong transcript, được tính là tầng A.

### 5.3 `detect_scenes`
- **Input:** `mediaPath` hoặc `projectItemId`, `threshold` (0,3), `minShotSec` (0,5).
- **Cách làm:** chạy ffmpeg `select='gt(scene,threshold)',showinfo`, gộp các shot ngắn hơn `minShotSec`.
- **Output:** `shots: [{start, end}]`, `cutTimes: number[]`.
- Cache trong thư mục analysis cache hiện có, khóa theo file, mtime, kích thước và tham số.
- Code ở `src/analysis/scenes.ts`; spec Vision dùng lại module này. `detect_scene_edits` (API Premiere) giữ nguyên.
- Dùng trong `plan_recap` ở chế độ shot (5.4).

### 5.4 `plan_recap` (chỉ đọc) và `build_recap`
**`plan_recap`:**
- **Input:** `sequenceId?`, `dialogueTrackIndices?`, `glossary?`, `targetSec`, `minSegmentSec` (4), `maxSegmentSec` (20), `mode` ("auto"\|"speech"\|"shots").
- **Chọn chế độ:** `auto` chọn `speech` khi lời thoại phủ ≥ 30% thời lượng sequence, còn lại chọn `shots`.
- **Chế độ speech:**
  1. Chia timeline thành K chương bằng nhau, với K = `ceil(targetSec / 12)`.
  2. Mỗi chương chấm điểm các cụm câu liền nhau dài `minSegmentSec`–`maxSegmentSec` bằng bộ chấm của `highlights.ts`.
  3. Bỏ cụm trùng ≥ 60% từ với cụm đã chọn, rồi chọn cụm điểm cao nhất mỗi chương.
  4. Thêm hoặc bớt cụm theo điểm cho tới khi tổng thời lượng nằm trong `targetSec ±10%`.
  5. Luôn cắt trọn câu.
- **Chế độ shots**, dành cho vlog, sự kiện, phim không lời:
  1. `detect_scenes` trên media của các clip trên track video thấp nhất, rồi đổi ra thời gian sequence.
  2. Chấm điểm từng shot theo độ nét, độ ổn định và độ sáng (dùng lại bộ chấm của `score_clips`).
  3. Mỗi shot lấy tối đa 4–6 s ở phần điểm cao nhất.
  4. Rải đều qua K chương và lấp tới đích ±10%.
- **Output:**
  - `mode`, `segments: [{start, end, text?, score}]` (xếp theo thời gian)
  - `candidates` gồm tối đa 3K đoạn điểm cao nhất, có `id`, dành cho bộ chọn AI sau này
  - `totalSec`, `fingerprint`

**`build_recap`:**
- **Input:** `sequenceId?`, `segments`, `name`, `aspect`, `captionStyle`, `audioLeadSec` (0), `crossfadeMs` (30), `targetLufs` (−14), `expectedFingerprint?`, `dryRun`, `backup`.
- **Các bước:**
  1. Kiểm tra fingerprint; lệch thì từ chối dựng, giống `build_short`.
  2. Nhân bản sequence nguồn, rồi chạy `remove_ranges` với `invert: true` trên các `segments`. Cách này giữ nguyên mọi track, effect, B-roll và lớp đồ họa nằm trong các đoạn được giữ.
  3. Với 9:16: reframe cả sequence theo đúng cách `build_short` đang làm (`autoReframeSequence`). Phụ đề dùng pipeline caption alpha của `build_short`.
  4. Chuẩn hóa loudness, rồi chạy `qa_sequence`.
- **Lưu ý về nhạc nền:** nhạc trải dài trên sequence nguồn cũng bị cắt theo các đoạn, nên sẽ nghe đứt quãng. Kết quả trả về `warnings: ["music-chopped"]` khi có clip audio dài hơn 30 s bị cắt từ 3 chỗ trở lên.
- **J-cut:** khi `audioLeadSec > 0`, audio của đoạn n+1 bắt đầu sớm hơn hình `audioLeadSec`. Đây là rủi ro cần thử trước (spike 2). Nếu làm không ổn định, v1 trả `audioLeadSupported: false`, dựng cắt thẳng kèm crossfade, và GUI ẩn công tắc J-cut.

### 5.5 Safe zone 9:16
`python/premiere_mcp_sidecar/captions.py` chuyển từ top 10% / bottom 15% / side 6% sang **top 250 px, bottom 350 px, side 80 px ở chiều cao 1920**, quy theo tỉ lệ khung. Áp dụng cho `build_short` và `build_recap`. **Đây là thay đổi hành vi**, cần ghi vào changelog 1.5.0: caption của short dựng mới sẽ nằm cao hơn trước.

### 5.6 Bộ chọn AI (bước cuối, có điều kiện)
- **Điều kiện để làm:** chỉ sau khi chạy `workflow_recap` và `workflow_shorts` bằng heuristic trên 3 video thật và người dùng chấm điểm. Nếu người dùng chấm heuristic đạt thì hoãn.
- **Thiết kế:**
  - Module của runner, chỉ GUI dùng: `select(transcript, candidates, targetSec) → ids`.
  - Bản đầu chỉ có Claude. Thêm nhà cung cấp khác chỉ cần viết thêm một hàm.
  - Chỉ gửi chữ. Lần đầu bật, panel hỏi xác nhận việc gửi transcript.
  - Runner kiểm tra kết quả AI: id phải có thật, không chồng thời gian, tổng trong đích ±10%. Không đạt thì lùi về heuristic.
  - API key lưu trong `~/.premiere-mcp/gui-settings.json` và không bao giờ có trong tham số tool, log, telemetry hay kết quả trả về.

## 6. Panel v1

**Khung:**
- Kích thước mặc định 420×760, tối thiểu 320×480 (sửa `manifest.xml`).
- Thanh trên: tên panel, tab **Quy trình** / **Kết nối**, và ⚙.
- **Tab Quy trình:**
  - Ô **Sequence** dùng chung, có nút làm mới.
  - 5 thẻ thu gọn được, ứng với 5 tool `workflow_*`. Mỗi thẻ chỉ hiện các tham số riêng trong bảng mục 4, với nhãn tiếng Việt và giá trị mặc định đã điền sẵn.
  - Mỗi thẻ có nút **Xem trước** (`dryRun`) và **Chạy trên bản sao**.
  - Dưới cùng là thanh tiến độ ("Bước 3/5: …", thời gian đã chạy), nút Hủy, và vùng kết quả: tóm tắt số liệu, cảnh báo, nút **Mở sequence**.
  - Xem trước của Dọn voice-over liệt kê từng vết cắt kèm câu gốc và lý do.
- **Tab Kết nối:** toàn bộ panel cũ (Status, Configuration, Start/Stop Bridge, Diagnostics, Command Queue, Activity Log), không đổi hành vi. Thêm dòng trạng thái runner.
- **⚙ Cài đặt:**
  - Mở file từ điển từ đệm
  - Engine nhận dạng giọng
  - Thư mục xuất
  - Đường dẫn runner
  - (Sau 5.6) Nhà cung cấp AI và API key

  Lưu tại `~/.premiere-mcp/gui-settings.json`.
- **Đóng panel khi đang chạy:**
  - Panel cảnh báo trước khi đóng (`beforeunload`).
  - Nếu vẫn đóng, runner dừng ở ranh giới bước và bản sao được đổi tên thêm " (dang dở)".
  - Bản gốc không bị ảnh hưởng.

## 7. Tiến độ, hủy, lỗi, an toàn

**Tiến độ:**
- Báo theo bước qua `ctx.progress`. Trong một bước, thanh chạy dạng không xác định.
- Nếu sidecar Python in tiến độ, `transcribe_sequence` chuyển tiếp qua `ctx.progress`. Việc kiểm tra sidecar có in hay không nằm trong kế hoạch.

**Hủy:**
- Giữa hai bước: dừng ngay.
- Trong bước ffmpeg hoặc Python: kill tiến trình con theo `ctx.signal`.
- Trong một lệnh ExtendScript: có hiệu lực ngay khi script trả về, vì Premiere không ngắt được giữa chừng. Panel hiện "Đang hủy… chờ Premiere xong thao tác hiện tại".
- Bản sao dở dang được đổi tên thêm " (đã hủy)" và có nút Xóa bản sao; chỉ xóa khi người dùng bấm.

**Lỗi:**

| Trường hợp | Xử lý |
|---|---|
| Một bước `success:false` | Tool quy trình dừng, trả `steps` đến bước lỗi kèm `nextStep`; panel hiện bằng tiếng Việt |
| `userActionRequired` | Hiện việc cần làm và nút Thử lại |
| Không tìm thấy runner | Hướng dẫn `--doctor` hoặc cài lại bằng Setup.exe |
| Runner crash | Tác vụ thất bại, stderr cuối hiện trong tab Kết nối, khởi động lại ở lần sau |
| Fingerprint lệch (sequence bị sửa giữa phân tích và dựng) | Từ chối dựng, yêu cầu chạy lại |

**An toàn:**
- Không sửa sequence gốc, không xóa hay ghi đè media, `backup` mặc định bật.
- File SRT trùng tên mặc định bị từ chối ghi đè.

## 8. Kiểm thử

| Lớp | Kiểm gì |
|---|---|
| Từ điển 3 tầng | Câu chứa chẳng/ạ/nhé/thì/rứa giữ nguyên; "ờ" đứng riêng bị cắt; tầng B chỉ bị cắt khi có ngừng hoặc lặp; câu còn < 2 từ thì không cắt; file ghi đè của người dùng có hiệu lực; có video trên V1 thì mặc định chỉ tầng A |
| Chỉnh mép | Với chuỗi RMS giả lập, mép được dời tới điểm thấp nhất trong ±80 ms và không vượt ra ngoài |
| Câu vấp | Vấp nhắc lại, vấp đổi ý, chuỗi 3 lần vấp giữ câu cuối; hai câu giống nhau cách nhau > 10 s thì giữ cả hai |
| `remove_ranges` | Gộp và chuẩn hóa khoảng, `minKeepSec`, `invert`; crossfade làm tròn theo frame ở 25/29.97/30 fps; `dryRun` không gọi bridge sửa |
| `detect_scenes` | Video `lavfi` có cắt cảnh biết trước; cache trúng ở lần chạy hai |
| `plan_recap` | Speech: rải đủ K chương, trọn câu, không trùng ý, tổng trong ±10%. Shots: kích hoạt khi lời thoại < 30%, mỗi shot ≤ 6 s |
| `build_recap` | Bridge giả lập: nhân bản rồi một lần `remove_ranges` với `invert`; fingerprint lệch thì từ chối; cảnh báo `music-chopped`; 9:16 gọi reframe và caption |
| Tool quy trình | Thứ tự bước, `dryRun` không sửa gì, dừng đúng chỗ khi một bước lỗi, `ctx.signal` hủy giữa hai bước, `ctx.progress` được gọi đủ |
| Clean voice-over | Mọi khoảng được tính trên bản gốc và chỉ gọi **một** lần `remove_ranges` |
| MCP progress/cancel | Có `progressToken` thì sinh `notifications/progress`; `notifications/cancelled` hủy được tác vụ |
| Runner | Panel giả qua stdio: `run` khứ hồi, `cancel`, stdin đóng thì dừng ở ranh giới bước, crash rồi khởi động lại, `PREMIERE_TEMP_DIR` được truyền đúng |
| GUI | `gui.js` qua helper `loadPanel`: thẻ sinh đúng tham số, nút bị khóa khi đang chạy, hiển thị tiến độ, lỗi, kết quả; tab Kết nối giữ hành vi cũ |
| Catalog | Cập nhật số tool trong `index.test.ts`, `search-tools.test.ts`, `catalog-structure.test.ts` |

## 9. Spike trước khi code phần liên quan (trên audio và Premiere thật)

1. **ASR có giữ từ ngập ngừng không:** chạy engine mặc định trên 2 phút voice có "ờ/ừm" thật, đếm số từ ngập ngừng nghe được và số có trong transcript. Nếu thấp hơn 70%, bật cách phát hiện bằng âm thanh ở mục 5.2.
2. **J-cut:** thử bỏ liên kết, trượt audio và cắt đuôi audio trên Premiere 25. Không ổn định thì dùng phương án lùi ở mục 5.4.

## 10. Thứ tự triển khai

1. **Nền:** `ToolContext.progress/signal` + nối vào MCP → `remove_ranges` (refactor `remove_silence_from_sequence` sang dùng nó).
2. **Phân tích:** spike 1 → `find_fillers_and_retakes` (từ điển, chỉnh mép, câu vấp) → `detect_scenes` → `plan_recap`.
3. **Dựng:** spike 2 → `build_recap` → safe zone.
4. **Tool quy trình:** 5 tool `workflow_*`. Từ đây Agent đã dùng được trọn các quy trình.
5. **Runner + GUI:** `--panel-runner` → Setup.exe ghi đường dẫn runner → panel 2 tab + Cài đặt → nâng lên **1.5.0** ở `package.json`, `package-lock.json`, `src/version.ts`, `cep-plugin/mcp-version.json`, `manifest.xml` (`ExtensionBundleVersion`), `.claude-plugin/marketplace.json`, `website/index.html`, kèm changelog (gồm thay đổi safe zone).
6. **Có điều kiện:** đo heuristic trên 3 video thật → bộ chọn AI (5.6) nếu cần.

## 11. Ngoài phạm vi

- Panel UXP (đang hỏng).
- Tab Công cụ và nhà cung cấp AI thứ hai: để v1.1.
- Editor tự tích chọn đoạn trước khi dựng (người dùng chọn tự động hoàn toàn).
- Phase 2: đồng bộ mic rời, tự chuyển góc theo người nói, gợi ý LUT cho Log/HDR.
- Spec riêng: Motion/HyperFrames (gồm SFX theo chuyển động), Vision.
