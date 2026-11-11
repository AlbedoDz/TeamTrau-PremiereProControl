# Panel GUI cho editor — Design

Ngày: 2026-11-11 · Trạng thái: chờ duyệt · Nền: `clean-main` (`679d220`), 1.4.0 với 299 tool

## 1. Mục tiêu

Hiện panel **TeamTrau PremiereProControl** chỉ là cầu nối cho Agent: hiện trạng thái, nút Start/Stop Bridge và log. Gần 300 tool chỉ dùng được qua một client AI. Spec này biến panel thành **giao diện cho editor tầm trung**, để chạy các quy trình dựng phổ biến bằng vài cú bấm, không cần Agent.

Thành công khi:
- Có Premiere mà không mở client AI nào, editor vẫn chạy được trọn 5 quy trình (mục 4) từ panel, trên bản sao của sequence.
- Mọi quy trình có Xem trước (không sửa gì), báo tiến độ theo bước, hủy được, và lỗi hiện bằng tiếng Việt kèm việc cần làm.
- Agent và GUI dùng cùng lúc mà không làm hỏng lệnh của nhau.
- Mọi tool backend mới cũng dùng được qua MCP như các tool khác.

## 2. Quyết định đã chốt

| Chủ đề | Quyết định | Lý do |
|---|---|---|
| Người dùng | Editor tầm trung: thạo Premiere, không đọc tên tool hay tham số kỹ thuật | Do người dùng chốt |
| Bố cục | Tab **Quy trình** (chính), tab **Công cụ** (khoảng 30–40 tool chia nhóm, có ô tìm cả catalog thu gọn ở cuối), tab **Kết nối** (panel cũ) | Quy trình là việc hằng ngày; tool lẻ để khi cần |
| Quy trình v1 | Recap dài → ngắn (16:9/9:16), Dọn voice-over, Podcast → Shorts, Phụ đề tiếng Việt, Rough cut / Cắt theo nhạc | Do người dùng chọn |
| Chọn đoạn (Recap/Shorts) | **Tự động hoàn toàn**; editor sửa trên timeline sau | Do người dùng chọn |
| Bộ chọn | Heuristic offline mặc định; AI (Claude/DeepSeek) chỉ khi có API key | Miễn phí và riêng tư theo mặc định, chất lượng tốt hơn khi muốn |
| Kiến trúc | **Panel tự khởi động một runner Node** qua `child_process`; hai bên trao đổi JSON từng dòng qua stdio | Dùng lại 100% tool, chạy không cần Agent, lỗi được cô lập (mục 3) |
| Từ đệm | Từ điển 3 tầng A/B/C trong file dữ liệu; tầng C không bao giờ cắt | Danh sách gốc có từ phủ định, từ lịch sự, phương ngữ: xóa đi là hỏng nghĩa |

**Loại khỏi phạm vi.** Danh sách dưới đây rút từ việc đối chiếu cẩm nang biên tập 160 nguồn với code ngày 2026-11-11:
- **Đã có sẵn:**
  - silencedetect −35 dB / 0,5 s và đệm 0,1 s (`remove_silence_from_sequence`)
  - karaoke `#FFD400`
  - thời gian theo từng từ
  - chia pha probe→QC
  - lọc tiếng thở (`apply_dialogue_chain` nhận effect tùy ý)
  - nhịp B-roll (`assemble_rough_cut.shotSeconds`, preset của `assemble_beat_cut`)
- **Sai hoặc xung đột:**
  - cắt lossless bằng `-c copy` (tool dựng không phá hủy trong Premiere, không render file trung gian)
  - Kokoro dùng để lấy timing (Kokoro là TTS)
  - prompt mẫu cho Agent (GUI thay thế)
- **Không tích hợp:** lật hình, tăng tốc 1.02–1.05x, crop 1.05x để né nhận diện bản quyền.
- **Hoãn:**
  - chọn cỡ cảnh và cắt trên hành động → spec Vision
  - đồng bộ mic rời, tự chuyển góc theo người nói, gợi ý LUT cho footage Log → phase 2
  - SFX theo chuyển động, payoff timing, hold ≥ 1 s, easing → spec Motion

## 3. Kiến trúc runner

```
Panel CEP (index.html + gui.js, Node bật sẵn qua --enable-nodejs)
  │  child_process.spawn(nodePath, [cliPath, "--panel-runner"])
  ▼
Runner (tiến trình Node riêng)
  ├─ PremiereProTools                  ← cùng catalog với server MCP
  ├─ PanelChannelBridge extends PremiereProBridge
  │     executeScript(script) → stdout {type:"eval", id, script, timeoutMs}
  ├─ workflows/*.ts                    ← 5 quy trình = chuỗi lời gọi tool
  └─ ai-selector.ts                    ← chỉ GUI dùng (mục 5.5)
```

**Giao thức:** mỗi dòng là một JSON.
- Panel gửi runner:
  - `{type:"run", id, workflow, params}`, `{type:"call", id, tool, args}`
  - `{type:"cancel", id}`, `{type:"evalResult", id, ok, result|error}`
  - `{type:"settings", aiProvider?, aiKeyPresent}`
- Runner gửi panel:
  - `{type:"eval", id, script, timeoutMs}`
  - `{type:"progress", id, step, stepCount, label}`
  - `{type:"result", id, success, summary, data}`, `{type:"error", id, message, nextStep?}`
  - `{type:"ready", version}`

**`PanelChannelBridge`:**
- Chỉ ghi đè `executeScript`. Mọi method khác của `PremiereProBridge` (`importMedia`, `addToTimelineBatch`, `renderSequence`…) đều dựng script rồi gọi `executeScript`, nên không cần đổi.
- Không dùng thư mục temp và không cần Start Bridge.
- `ensureHost` trả về sẵn sàng khi panel đã gửi `ready`.

**Hàng đợi chung:**
- Lệnh `eval` từ runner đi vào **cùng hàng đợi `evalScript`** của `bridge-cep.js` mà bridge file (Agent) đang dùng, nên ExtendScript không bao giờ chạy chồng nhau.
- Mỗi lần GUI chỉ chạy một quy trình; quy trình bấm sau được xếp hàng.

**Tìm runner:**
1. Đọc `runner.nodePath`/`runner.cliPath` trong config của panel. Setup.exe ghi hai giá trị này: `node\node.exe` và `dist\cli.js` trong thư mục cài.
2. Nếu không có, dùng `node` trên PATH với `cli.js` của gói npm toàn cục.
3. Nếu vẫn không thấy, báo lỗi kèm hướng dẫn chạy `premiere-pro-mcp --doctor`.

**Vòng đời:**
- Panel khởi động runner ở lần chạy đầu và giữ nó chạy.
- Runner thoát khi stdin đóng, tức là khi panel đóng.
- Runner crash: tác vụ đang chạy thất bại, stderr cuối hiện trong tab Kết nối, và lần chạy sau khởi động lại runner.

## 4. Panel và 5 quy trình

**Khung:**
- Kích thước mặc định 420×760, tối thiểu 320×480 (sửa `manifest.xml`).
- Thanh trên: tên panel và ⚙ Cài đặt.
- Ô **Sequence** dùng chung: mặc định là sequence đang mở, có nút làm mới.
- Mỗi quy trình là một thẻ thu gọn được, có hai nút **Xem trước** và **Chạy trên bản sao**.
- Dưới cùng là thanh tiến độ dùng chung, nút Hủy, và vùng kết quả: tóm tắt bằng số kèm nút **Mở sequence**.

| Quy trình | Người dùng nhập | Chuỗi tool |
|---|---|---|
| **Recap dài → ngắn** | Thời lượng đích (60/90/180 s/tùy), 16:9 hoặc 9:16, phụ đề (tắt/clean/pop/karaoke), J-cut bật/tắt | `transcribe_sequence` → `plan_recap` (hoặc bộ chọn AI) → `build_recap` |
| **Dọn voice-over** | Cắt khoảng lặng · Cắt từ đệm · Cắt cả tầng B · Lọc thoại và chuẩn −16 LUFS | `duplicate_sequence` → `remove_silence_from_sequence` (crossfade) → `remove_fillers_and_retakes` → `apply_dialogue_chain` → `qa_sequence` |
| **Podcast → Shorts** | Số short (1–5), độ dài (30–60 / 60–90 s), style caption | `transcribe_sequence` → `find_highlight_candidates` → chọn N đoạn không chồng nhau (heuristic hoặc AI) → `build_short` × N |
| **Phụ đề tiếng Việt** | Xuất SRT hoặc track caption Premiere, số ký tự/dòng (42), tên riêng | `create_captions_from_transcript` |
| **Rough cut / Cắt theo nhạc** | Thư mục footage; thời lượng hoặc file nhạc; nhịp (calm/balanced/energetic hoặc giây/shot); có voice-over hay không | Không nhạc: `score_clips` → `assemble_rough_cut`. Có nhạc: `assemble_beat_cut`. Có voice-over: thêm `auto_duck_music` |

Chọn N đoạn Shorts bằng heuristic: lấy theo điểm từ cao xuống trong danh sách ứng viên, bỏ đoạn chồng thời gian với đoạn đã chọn.

**Tab Công cụ:**
- Nhóm Âm thanh · Cắt dựng · Phụ đề · Màu · Xuất · Dự án, mỗi tool có nhãn và mô tả tiếng Việt.
- Danh sách tool, nhãn và tham số chính nằm trong `cep-plugin/gui/tool-groups.json`.
- Form sinh từ JSON Schema mà runner trả qua `get_tool_schema`. Tham số chính hiện ra, phần còn lại thu vào "Tùy chọn khác".
- Ô tìm kiếm cuối tab gọi `search_tools`.

**⚙ Cài đặt:**
- Nhà cung cấp AI và API key (mặc định tắt)
- Mở file từ điển từ đệm
- Engine nhận dạng giọng
- Thư mục xuất
- Đường dẫn runner

Lưu tại `~/.premiere-mcp/gui-settings.json`.

**Tab Kết nối:** toàn bộ panel cũ (Status, Configuration, Start/Stop Bridge, Diagnostics, Command Queue, Activity Log), không đổi hành vi.

## 5. Tool backend mới

### 5.1 `remove_ranges`
Tách lõi cắt của `remove_silence_from_sequence` ra thành tool riêng (hạng mục 3 trong roadmap hiệu suất).
- **Input:** `sequenceId?`, `ranges: [{start, end}]` theo giây sequence, `crossfadeMs` (mặc định 30, 0 là tắt), `dryRun`, `backup`.
- **Crossfade:** đặt transition âm thanh Constant Power tại mỗi vết cắt mới. Premiere không cho transition ngắn hơn 1 frame, nên độ dài thật là `max(crossfadeMs, 1 frame)`, làm tròn theo frame. Kết quả trả về `crossfadeFrames` và `crossfadeMsActual`.
- **Output:** `removed: [{start, end}]`, `durationBefore`, `durationAfter`, `verified`.
- `remove_silence_from_sequence` gọi lõi này và có thêm tham số `crossfadeMs`.

### 5.2 `remove_fillers_and_retakes`
- **Input:** `sequenceId?`, `dialogueTrackIndices?`, `tiers` (mặc định `["A","B"]`), `retakes` (mặc định true), `minPauseMs` (150), `crossfadeMs` (30), `dryRun`, `backup`.
- **Từ điển:** `data/fillers-vi.json` có dạng `{A: string[], B: string[], C: string[]}`. Người dùng đặt `~/.premiere-mcp/fillers-vi.json` để ghi đè từng tầng. `FILLERS` trong `src/analysis/highlights.ts` chuyển sang đọc A ∪ B từ cùng file.
  - **A (ngập ngừng):** à, ờ, ừm, ơ, ư, hừm, ừm hứm, ờ thì, à mà.
  - **B (câu giờ):** kiểu, kiểu như, kiểu như là, cái kiểu, dạng như, đại loại là, đại khái là, nói chung là, nôm na là, tạm gọi là, thực ra thì, thật ra là, với lại, xong rồi, cái gì nhỉ, cái đó đó, cái kia kìa, làm sao nhỉ, thế nào nhỉ, nói sao ta.
  - **C (không bao giờ cắt):**
    - tiểu từ tình thái và lịch sự: nhé, nhỉ, nha, ạ, vâng, dạ, thưa, xin phép…
    - phủ định: chả, chẳng, đâu, đâu có
    - cảm thán
    - từ nối: thì, mà, là, tức là, nghĩa là, tóm lại là, vấn đề là, cái chính là
    - toàn bộ từ phương ngữ Bắc, Trung, Nam trong danh sách người dùng cung cấp

    Tầng C chỉ dùng để đếm cho điểm trôi chảy.
- **Quy tắc cắt:**
  - **A:** cắt khi cụm từ đứng riêng, tức là có ngừng ≥ `minPauseMs` ở ít nhất một phía, hoặc ở đầu hay cuối câu.
  - **B:** chỉ cắt khi có ngừng ≥ `minPauseMs` ngay sau, khi lặp lại liền nhau, hoặc khi đứng đầu câu rồi ngừng.
  - Không cắt khi việc cắt khiến câu còn lại ít hơn 2 từ.
  - Khớp theo cụm dài nhất trước, sau khi chuẩn hóa Unicode NFC và chữ thường.
- **Câu vấp:** câu S1 bị bỏ khi câu liền sau S2 bắt đầu trong vòng 10 s sau khi S1 kết thúc, và thỏa một trong hai điều kiện:
  - các từ của S1 là tiền tố các từ của S2;
  - S1 và S2 trùng ≥ 60% từ (Jaccard).

  Chuỗi vấp dài thì giữ câu cuối cùng.
- **Output:** `cuts: [{start, end, reason: "filler-A"|"filler-B"|"retake", text}]`, `removedSeconds`, cùng kết quả của `remove_ranges`.
- **Bài thử bắt buộc trước khi làm tầng A (mục 8):** nếu ASR mặc định bỏ mất "ờ/ừm" khỏi transcript, tầng A dùng thêm cách phát hiện bằng âm thanh: đoạn có tiếng dài < 0,6 s, nằm giữa hai khoảng lặng (đo bằng ffmpeg `silencedetect`) và không chồng với từ nào trong transcript.

### 5.3 `detect_scenes`
- **Input:** `mediaPath` hoặc `projectItemId`, `threshold` (0,3), `minShotSec` (0,5).
- **Cách làm:** chạy ffmpeg `select='gt(scene,threshold)',showinfo`, gộp các shot ngắn hơn `minShotSec`.
- **Output:** `shots: [{start, end}]`, `cutTimes: number[]`.
- Cache trong thư mục analysis cache hiện có, khóa theo file, mtime, kích thước và tham số.
- Code ở `src/analysis/scenes.ts`; spec Vision dùng lại module này. `detect_scene_edits` (API Premiere) giữ nguyên.

### 5.4 `plan_recap` và `build_recap`
**`plan_recap`** (offline, chỉ đọc):
- **Input:** `sequenceId?`, `dialogueTrackIndices?`, `glossary?`, `targetSec`, `minSegmentSec` (4), `maxSegmentSec` (20).
- **Cách chọn:**
  1. Chia timeline thành K chương bằng nhau, với K = `ceil(targetSec / 12)`.
  2. Mỗi chương chấm điểm các cụm câu liền nhau dài `minSegmentSec`–`maxSegmentSec` bằng bộ chấm của `highlights.ts`.
  3. Bỏ cụm trùng ≥ 60% từ với cụm đã chọn, rồi chọn cụm điểm cao nhất mỗi chương.
  4. Thêm hoặc bớt cụm theo điểm cho tới khi tổng thời lượng nằm trong `targetSec ±10%`.
  5. Xếp lại theo thời gian.
- Luôn cắt trọn câu.
- **Output:**
  - `segments: [{start, end, sentenceIds, text, score}]` là các đoạn được chọn.
  - `candidates` gồm tối đa 3K cụm điểm cao nhất (kể cả cụm chưa chọn) kèm `id`. Bộ chọn AI ở mục 5.5 chọn trong danh sách này.
  - `totalSec`, `fingerprint`.

**`build_recap`:**
- **Input:**
  - `sequenceId?`, `segments: [{start, end}]`, `name`
  - `aspect: "16:9"|"9:16"`, `captionStyle: "none"|"clean"|"pop"|"karaoke"`
  - `audioLeadSec` (0), `crossfadeMs` (30), `targetLufs` (−14)
  - `expectedFingerprint?`, `dryRun`, `backup`
- **Các bước:**
  1. Tạo sequence mới cùng thông số với nguồn (`duplicate_sequence` với `clearContents`).
  2. Đặt các đoạn liền nhau bằng một lần `add_to_timeline_batch`, dùng in/out lấy từ sequence nguồn.
  3. Đặt crossfade âm thanh ở các mối nối.
  4. Với 9:16: reframe và đặt caption theo đúng pipeline của `build_short`.
  5. Chuẩn hóa loudness, rồi chạy `qa_sequence`.
- Fingerprint lệch thì từ chối dựng, giống `build_short`.
- **J-cut:** khi `audioLeadSec > 0`, audio của đoạn n+1 bắt đầu sớm hơn hình `audioLeadSec`, và audio của đoạn n bị cắt đuôi tương ứng. Đây là rủi ro cần thử trước (mục 8). Nếu làm không ổn định, v1 trả `audioLeadSupported: false`, dựng cắt thẳng kèm crossfade, và GUI ẩn công tắc J-cut.

### 5.5 Bộ chọn AI (module runner, không phải tool)
- Agent dùng qua MCP đã là AI nên không cần module này; chỉ GUI gọi nó.
- **Input:** transcript đã có và danh sách ứng viên (`candidates` của `plan_recap`, hoặc kết quả `find_highlight_candidates`). **Output:** id các ứng viên được chọn, dạng JSON.
- Runner kiểm tra kết quả: id phải có thật, không chồng thời gian, tổng thời lượng trong đích ±10%. Không đạt thì lùi về heuristic.
- Hỗ trợ Claude (Messages API) và DeepSeek (API tương thích OpenAI). Model mặc định đọc từ cài đặt.
- Chỉ gửi chữ, không bao giờ gửi audio hay hình. Lần đầu bật AI, panel hỏi xác nhận "Transcript sẽ được gửi tới …".
- Mạng lỗi, key sai hoặc hết hạn mức: lùi về heuristic và ghi `selector: "heuristic (AI lỗi: …)"` trong kết quả.

### 5.6 Safe zone 9:16
`python/premiere_mcp_sidecar/captions.py` chuyển từ top 10% / bottom 15% / side 6% sang **top 250 px, bottom 350 px, side 80 px ở chiều cao 1920**, quy theo tỉ lệ khung. Thay đổi áp dụng cho cả `build_short` và `build_recap`.

## 6. Tiến độ, hủy, lỗi, an toàn

**Tiến độ:**
- Runner gửi `progress` ở đầu mỗi bước. Trong một bước, thanh chạy dạng không xác định.
- Nếu sidecar Python có in tiến độ, runner chuyển tiếp lên thanh. Việc kiểm tra sidecar có in hay không nằm trong kế hoạch.

**Hủy:**
- Giữa hai bước: dừng ngay.
- Trong bước ffmpeg hoặc Python: runner kill tiến trình con.
- Trong một lệnh ExtendScript: có hiệu lực ngay khi script trả về, vì Premiere không ngắt được giữa chừng. Panel hiện "Đang hủy… chờ Premiere xong thao tác hiện tại".
- Bản sao dở dang được đổi tên thêm " (đã hủy)" và có nút Xóa bản sao; chỉ xóa khi người dùng bấm.

**Lỗi:**

| Trường hợp | Panel làm gì |
|---|---|
| Tool `success:false` | Dừng quy trình, giữ các bước đã xong, hiện lỗi tiếng Việt kèm `nextStep` |
| `userActionRequired` | Hiện việc cần làm và nút Thử lại |
| Không tìm thấy runner | Hướng dẫn `--doctor` hoặc cài lại bằng Setup.exe |
| Runner crash | Tác vụ thất bại, stderr cuối hiện trong tab Kết nối, khởi động lại ở lần sau |
| AI lỗi | Lùi về heuristic, ghi chú trong kết quả |

**An toàn:**
- Không sửa sequence gốc, không xóa hay ghi đè media, `backup` mặc định bật.
- File SRT trùng tên mặc định bị từ chối ghi đè.
- API key chỉ nằm trong `gui-settings.json`: không có trong tham số tool, log, telemetry hay lỗi trả về.

## 7. Kiểm thử

| Lớp | Kiểm gì |
|---|---|
| Từ điển 3 tầng | Câu chứa chẳng/ạ/nhé/thì/rứa giữ nguyên; "ờ" đứng riêng bị cắt; tầng B chỉ bị cắt khi có ngừng hoặc lặp; câu còn < 2 từ thì không cắt; file ghi đè của người dùng có hiệu lực |
| Câu vấp | Vấp nhắc lại, vấp đổi ý, chuỗi 3 lần vấp giữ câu cuối; hai câu giống nhau cách nhau > 10 s thì giữ cả hai |
| `remove_ranges` | Script sinh ra đúng; crossfade làm tròn theo frame ở 25/29.97/30 fps; `dryRun` không gọi bridge sửa |
| `detect_scenes` | Video `lavfi` có cắt cảnh biết trước; cache trúng ở lần chạy hai |
| `plan_recap` | Đoạn rải đủ K chương, trọn câu, không trùng ý, tổng trong ±10% |
| `build_recap` | Bridge giả lập: một lần batch, fingerprint lệch thì từ chối, 9:16 gọi reframe và caption |
| Runner | Panel giả qua stdio: `run`/`call`/`eval` khứ hồi, hủy giữa bước, crash rồi khởi động lại, key không lọt ra stdout, stderr hay kết quả |
| GUI | `gui.js` qua helper `loadPanel`: form sinh từ schema, nút bị khóa khi đang chạy, hiển thị lỗi và kết quả, tab Kết nối giữ hành vi cũ |
| Catalog | Cập nhật số tool trong `index.test.ts`, `search-tools.test.ts`, `catalog-structure.test.ts` |

## 8. Rủi ro cần thử trước (spike, trên audio và Premiere thật)

1. **ASR có giữ từ ngập ngừng không:** chạy engine mặc định trên 2 phút voice có "ờ/ừm" thật, đếm số từ ngập ngừng nghe được và số có trong transcript. Nếu thấp hơn 70%, làm thêm cách phát hiện bằng âm thanh ở mục 5.2.
2. **J-cut:** thử bỏ liên kết, trượt audio và cắt đuôi audio trên Premiere 25. Không ổn định thì dùng phương án lùi ở mục 5.4.
3. **Hàng đợi `evalScript` dùng chung:** cho Agent (bridge file) và runner gửi script xen kẽ 100 lần, không lệnh nào được chạy chồng.

## 9. Thứ tự triển khai

1. **Tool backend:** `remove_ranges` → `remove_fillers_and_retakes` (sau spike 1) → `detect_scenes` → `plan_recap`/`build_recap` (sau spike 2) → safe zone. Mỗi tool dùng được qua Agent ngay khi xong.
2. **Runner:** `--panel-runner`, `PanelChannelBridge`, 5 module quy trình, bộ chọn AI. Setup.exe ghi đường dẫn runner. Chạy spike 3.
3. **GUI:** khung 3 tab → 5 thẻ quy trình → tab Công cụ → Cài đặt/AI. Nâng lên **1.5.0** ở `package.json`, `src/version.ts`, `cep-plugin/mcp-version.json`, `manifest.xml` (`ExtensionBundleVersion`), `package-lock.json`, `.claude-plugin/marketplace.json` và `website/index.html`.

## 10. Ngoài phạm vi

- Panel UXP (đang hỏng), GUI cho macOS ngoài những gì CEP đã chạy sẵn.
- Editor tự tích chọn đoạn trước khi dựng (người dùng chọn tự động hoàn toàn).
- Phase 2: đồng bộ mic rời, tự chuyển góc theo người nói, gợi ý LUT cho Log/HDR.
- Spec riêng: Motion/HyperFrames (gồm SFX theo chuyển động), Vision.
