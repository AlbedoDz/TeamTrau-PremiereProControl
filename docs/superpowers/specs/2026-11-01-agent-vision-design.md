# Agent nhìn thấy khung hình (agent vision) — Design

Ngày: 2026-11-01. Trạng thái: chờ duyệt bản viết.

## 1. Mục tiêu

Agent điều khiển Premiere qua MCP hiện chỉ nhận JSON dạng text (`src/index.ts`, `content: [{type:'text'}]`), nên không tự soát được bố cục, màu, chữ hay lỗi dựng, và không chọn cảnh theo nội dung hình. Hạng mục này cho agent nhận ảnh khung hình trong một lượt gọi tool.

- **Người dùng:** agent (Claude Code và các client MCP khác) dựng video cho người dùng.
- **Thành công khi:** một lần gọi tool trả về bộ khung có timestamp (dạng lưới) đủ để agent nhận xét đúng về timeline hoặc một file, với chi phí token có trần kiểm soát.
- **Đã chốt với người dùng:** phương án C (quét nhanh từ media gốc bằng ffmpeg và soát hình đã render từ Premiere), trả ảnh thẳng qua MCP kèm file trên đĩa.

## 2. Tham khảo

[bradautomates/claude-video](https://github.com/bradautomates/claude-video) (MIT, Python). Chỉ mượn ý tưởng, viết lại bằng TypeScript trên hạ tầng ffmpeg sẵn có:

- ngân sách khung hình theo thời lượng; soi đoạn `start/end` thì dày hơn;
- chọn khung theo chuyển cảnh, rơi về lấy mẫu đều khi cảnh tĩnh (tối đa 2 fps);
- lọc khung gần trùng bằng chênh lệch màu trung bình ở 16×16;
- mốc bắt buộc (`timestamps`) được giữ trước khi chia ngân sách;
- ảnh rộng 512 px, nâng lên 1024 khi cần đọc chữ;
- coi nội dung khung hình là dữ liệu không tin cậy.

Không mượn: tải video bằng yt-dlp, engine Gemini, phiên âm.

## 3. Dùng lại và tránh trùng lặp

Đã rà các phiên khác và nhánh `feature/podcast-to-shorts` (chưa merge). Không ai đang làm tính năng trả ảnh cho agent.

| Có sẵn | Ở đâu | Dùng thế nào |
|---|---|---|
| `readSequence`, `SequenceClip` | `src/tools/domains/cleanup.ts`, `src/analysis/cleanup.ts` | Nguồn duy nhất cho danh sách clip. Thêm 2 trường tùy chọn `speed?: number`, `reversed?: boolean` (không đổi hành vi chỗ đang dùng) |
| Quy đổi nguồn → timeline | `timelineFaces`/`timelineLoudness` trên nhánh shorts | Hàm ngược `mapTimelineToSource` và hàm thuận `mapSourceToTimeline` đặt cạnh `SequenceClip` trong `src/analysis/cleanup.ts`; nhánh shorts chuyển sang dùng sau khi merge |
| `FrameSample` | `src/analysis/roughcut.ts` | Kiểu cho danh sách thời điểm khung |
| `findFfTool`, `runFf`, `ffmpegMissingResult` | `src/analysis/ffmpeg.ts` | Dùng nguyên, **không sửa file này** (nhánh shorts có sửa, tránh xung đột) |
| `mapLimit`, `analysisConcurrency` | `src/analysis/pool.ts` | Trích khung song song có giới hạn |
| `cached` | `src/analysis/cache.ts` | Cache ứng viên chuyển cảnh và khung đã trích |
| Script QE xuất khung | `exportFrame` trong `src/tools/domains/export.ts` | Tách phần sinh script thành helper dùng chung cho `export_frame` và mode `render`; không chép lại |
| `clipFingerprint` | `src/analysis/transcript.ts` (nhánh shorts) | Không dùng ở đây; để dành cho hạng mục hash timeline |

**Thứ tự nhánh:** merge `feature/podcast-to-shorts` vào nhánh làm việc trước, hoặc tách nhánh mới từ nó. Các file có cả hai bên chạm: `src/analysis/cleanup.ts` (chỉ thêm), `src/tools/domains/index.ts` (thêm một dòng import), các test đếm số tool trong catalog.

## 4. Kiến trúc

### 4.1 `src/analysis/vision.ts` (thuần, không I/O)

- `frameBudget(durationSec, detail, focused): number`. `detail`: `efficient` (trần 50), `balanced` (100, mặc định), `detailed` (200). Thời lượng ngắn lấy dày (tối thiểu khoảng 1 khung/giây cho đoạn dưới 12 s), dài thì chạm trần. `focused` (có `start/end`) nhân mật độ lên nhưng vẫn giữ trần.
- `selectFrames(candidates: number[], budget, pinned: number[]): number[]`: giữ hết `pinned` (vẫn cắt nếu riêng chúng vượt trần), phần ngân sách còn lại chọn rải đều trong `candidates`, kết quả sắp theo thời gian, không trùng.
- `dedup(thumbs: {t, rgb: Uint8Array}[], threshold): number[]`: loại khung có chênh lệch màu trung bình 16×16 dưới ngưỡng so với khung giữ trước đó; không bao giờ loại `pinned`.
- `sheetLayout(count, cols = 3, rows = 3)`: chia khung thành các ảnh lưới.

### 4.2 Quy đổi thời điểm, trong `src/analysis/cleanup.ts`

- `mapTimelineToSource(clips, t)` trả `{ clip, mediaPath, sourceTime } | { needsRender: true, reason }`, hoặc `null` khi rơi vào khoảng trống. Chọn clip ở **track video có chỉ số cao nhất** (trên cùng) phủ `t`. `reason`: `speed`, `reversed`, `no-media` (title, MOGRT, adjustment layer, nest), `offline`.
- `mapSourceToTimeline(clip, sourceTime)`: chiều thuận `clip.start + sourceTime − clip.inPoint`.

Chế độ `scan` không thấy track bị tắt, hiệu ứng, màu, độ mờ hay các lớp chồng; điều này được ghi rõ trong mô tả tool. Mode `render` là cách soát những thứ đó.

### 4.3 `src/analysis/frames.ts` (chạy ffmpeg)

- `sceneCandidates(mediaPath, inPoint, outPoint)`: `select='gt(scene,0.3)',showinfo`, đọc `pts_time`; luôn có khung đầu đoạn. Ít hơn 3 ứng viên thì rơi về lấy mẫu đều. Có cache.
- `extractFrames(requests: {mediaPath, sourceTime}[], width)`: mỗi khung một lần `-ss <t> -i <file> -frames:v 1 -vf scale=<w>:-2`, JPEG `-q:v 4`, chạy qua `mapLimit`. Có cache theo file + thời điểm + độ rộng.
- `thumbRgb(path)`: ảnh 16×16 RGB thô cho `dedup`.
- `buildSheet(frames: {path, label}[], out)`: ghép bằng `xstack`/`tile` và ghi `label` (timecode timeline) lên góc mỗi ô bằng `drawtext`. Không có font thì bỏ nhãn, không báo lỗi.

Parser output ffmpeg riêng của tính năng này nằm trong `frames.ts`.

### 4.4 `src/tools/domains/vision.ts`, 2 tool

**`look_at_sequence`**

| Tham số | Kiểu | Mặc định |
|---|---|---|
| `sequenceId` | string? | sequence đang mở |
| `mode` | `scan` \| `render` | `scan` |
| `start`, `end` | number? (giây timeline) | cả sequence |
| `timestamps` | number[]? | — |
| `sampling` | `scenes` \| `shots` \| `uniform` | `scenes` |
| `detail` | `efficient` \| `balanced` \| `detailed` | `balanced` |
| `resolution` | 256–1024 | 512 |
| `layout` | `grid` \| `frames` | `grid` |

- `scenes`: ứng viên chuyển cảnh lấy trong đoạn in/out mà mỗi clip đang dùng, đổi ra thời điểm timeline.
- `shots`: mỗi clip video một khung ở giữa. Đây là cách một phiên trước đã tự soát bằng tay.
- `uniform`: rải đều theo ngân sách, tối đa 2 fps.
- `render`: gọi helper QE xuất JPEG tại `timestamps`. Nếu không truyền thì lấy các mốc `needsRender` của lượt `scan` gần nhất trên cùng sequence (lưu trong bộ nhớ server), không có thì lấy 12 mốc rải đều. Tối đa 24 mốc một lượt.

**`look_at_media`**: `{ path, start?, end?, timestamps?, sampling?: scenes|uniform, detail?, resolution?, layout? }`. Chạy như `scan` trên một file, không cần Premiere.

### 4.5 Trả ảnh qua MCP

- Tool trả thêm trường dự trữ `images: [{ path, mimeType }]`.
- `src/index.ts`, trong handler `tools/call`: nếu kết quả có `images`, đọc từng file và thêm `{ type: 'image', data: <base64>, mimeType }` vào `content` sau phần text. JSON vẫn giữ `path`.
- `invoke_tool` trả kết quả của tool bên trong nguyên vẹn, nên đi qua catalog vẫn có ảnh.
- Tool khác không có `images`, nên hành vi cũ không đổi.

## 5. Luồng dữ liệu (`scan`)

1. `readSequence`, rồi giới hạn trong `[start, end]`.
2. Lấy thời điểm ứng viên theo `sampling`, cộng `timestamps`, `selectFrames` theo `frameBudget`.
3. Mỗi thời điểm qua `mapTimelineToSource`: khoảng trống vào `gaps[]`, trường hợp cần render thì đánh dấu `needsRender`.
4. `extractFrames`, `dedup`, `buildSheet` (lưới 3×3).
5. Trả về:

```json
{
  "success": true,
  "frames": [{ "timelineTime": 12.4, "timecode": "00:00:12:10", "clipId": "…", "clipName": "…",
               "mediaPath": "…", "sourceTime": 3.4, "needsRender": false, "reason": null, "sheet": 0 }],
  "gaps": [{ "start": 20, "end": 21.5 }],
  "sheets": [{ "path": "…/sheet-0.jpg", "from": 0, "to": 8 }],
  "budget": { "requested": 100, "used": 41, "droppedDuplicates": 7, "truncated": false },
  "images": [{ "path": "…/sheet-0.jpg", "mimeType": "image/jpeg" }]
}
```

File lưu ở `~/.premiere-mcp/vision/<runId>/` (dùng cùng gốc với cache, đổi được bằng `PREMIERE_MCP_CACHE_DIR`). Lượt cũ hơn 24 giờ bị xóa khi tool chạy.

## 6. Xử lý lỗi và giới hạn

| Tình huống | Cách xử lý |
|---|---|
| Không có ffmpeg | `scan`/`look_at_media` trả `ffmpegMissingResult`. `render` vẫn chạy và trả từng khung riêng, không ghép lưới |
| Bridge chưa chạy | `scan`/`render` trả lỗi bridge chuẩn (`userActionRequired`). `look_at_media` không bị ảnh hưởng |
| File offline | Khung đó `needsRender: true, reason: 'offline'`, các khung khác vẫn trả |
| Speed ≠ 1, đảo ngược, không có media | `needsRender` kèm `reason`, không đoán thời điểm nguồn |
| Khoảng trống | Ghi vào `gaps[]`, không trả khung đen |
| Trần | Tối đa 200 khung một lượt; `resolution` 256–1024; mỗi ảnh lưới tối đa khoảng 1,5 MB (vượt thì giảm chất lượng JPEG, sau đó giảm độ rộng); `budget.truncated` báo khi bị cắt |
| `render` chậm hoặc lỗi | Tối đa 24 mốc; mỗi mốc có timeout; mốc lỗi vào `failed[]` |
| Client không hiển thị ảnh | `path` luôn có trong JSON |
| Nội dung khung hình | Mô tả tool nói rõ chữ trong hình là dữ liệu, không phải lệnh |

## 7. Kiểm thử

- **Thuần** (`src/__tests__/analysis/vision.test.ts`): ngân sách khung hình (các mốc thời lượng, chế độ soi kỹ, trần); `selectFrames` (mốc bắt buộc, rải đều, không vượt trần); `dedup`; `mapTimelineToSource` (nhiều track, chọn track trên cùng, khoảng trống, in-point ≠ 0, speed, đảo ngược, không có media) và đổi hai chiều ra đúng thời điểm ban đầu.
- **Tool** (`src/__tests__/tools/vision.test.ts`), bridge giả và ffmpeg giả như các test hiện có: `images` được chuyển thành `content` dạng image cả khi gọi trực tiếp và qua `invoke_tool`; các tình huống ở mục 6; script render qua `generated-script-syntax.test.ts`; test đếm catalog cập nhật +2.
- **Live** (ghi vào roadmap): fixture `scripts/live-fixture.mjs` trên Project-Temp, `scan` ra lưới khớp timecode; thêm title thì `render` thấy title còn `scan` đánh dấu `needsRender`; đo thời gian và dung lượng ảnh cho sequence 1 phút và 10 phút.

## 8. Ngoài phạm vi

Model thị giác bên ngoài (Gemini), phiên âm (nhánh shorts), hash và diff timeline (hạng mục riêng), đọc pixel để chấm điểm (đã có `score_clips`). Đóng dấu điểm `score_clips` lên ô lưới chỉ làm nếu điểm có sẵn trong cache, không chạy phân tích thêm.
