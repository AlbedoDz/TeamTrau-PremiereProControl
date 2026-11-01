# Kế hoạch bổ sung tính năng edit video (sau bản 1.3.0)

Bổ sung cho [2026-11-01-full-edit-upgrade.md](2026-11-01-full-edit-upgrade.md). Tài liệu đó trả lời "lấy gì từ TeamTrau"; tài liệu này trả lời "còn thiếu gì để một editor đi từ footage thô tới file giao hàng", dựa trên catalog thật (287 tool) và những gì quan sát được khi chạy trên project thật.

## 1. Hiện trạng

**Đã có, tái sử dụng được (không viết lại):** dựng cơ bản (`create_sequence_from_clips`, `add_to_timeline_batch`, `insert_from_source`, `overwrite_clip`), cắt và chỉnh (`razor_all_tracks`, `ripple_delete`, `roll_edit`, `slip_edit`, `slide_edit`, `trim_clip`), tốc độ (`set_clip_speed_qe`, `freeze_frame`, `reverse_clip`), hiệu ứng và màu (`apply_effect`, `apply_lut`, `color_correct`, `copy_effects_between_clips`), transition hàng loạt (`batch_add_transitions`), chữ và mogrt (`add_text_overlay`, `import_mogrt`, `create_caption_track`), âm thanh (`setup_ducking`, `apply_audio_effect`, `set_clip_volume`), reframe và ổn định (`auto_reframe_sequence`, `stabilize_clip`), export (`export_sequence`, `encode_file`, `add_to_render_queue`), kiểm tra (`get_timeline_gaps`, `validate_project_for_export`, `get_used_media_report`).

**Mới ở 1.3.0:** `preflight_media`, `find_dead_segments`, `remove_silence_from_sequence`, `normalize_loudness`.

**Quan sát từ lần chạy live trên project thật (Yéno2026, sequence 836 s, 146 file):**
- Bridge hoạt động, `preflight_media` đọc đúng 146 file.
- Phân tích 146 file bằng ffmpeg sẽ chậm; cache hiện chỉ nằm trong bộ nhớ nên mất khi server khởi động lại.
- `preflight_media` liệt kê cả file sạch, đầu ra quá dài.
- Tool ghi (`remove_silence_from_sequence`) chưa từng chạy trên Premiere thật; thử trên project thật là rủi ro không cần thiết.
- Catalog đã có `ripple_delete` (xóa clip kèm audio liên kết, khép khoảng trống, tự kiểm tra). Cách "nhấc hết trừ một clip rồi ripple clip cuối" trong `remove_silence_from_sequence` có thể thay bằng tool này nếu thử live thấy ổn hơn.

## 2. Khoảng trống thật sự (không có tool nào trong 287)

| # | Khả năng | Vì sao cần |
|---|---|---|
| G1 | Môi trường thử an toàn: project nháp sinh tự động, sao lưu trước khi ghi | Không thể xác minh tool ghi mà không chạm project thật |
| G2 | Phiên âm, nhập SRT/ASS thành caption, sửa theo lời | Phỏng vấn, vlog, short đều cần |
| G3 | Phát hiện giọng nói để tự hạ nhạc nền (auto-ducking) | `setup_ducking` có nhưng phải truyền cửa sổ bằng tay |
| G4 | Phân tích nhạc: tempo, beat, bar, section | Dựng theo nhạc |
| G5 | Chấm điểm và chọn clip, chọn đoạn đẹp nhất của shot dài | Dựng thô từ thư mục footage |
| G6 | Đồng bộ nhiều nguồn bằng sóng âm (multicam, quay đôi âm thanh) | Sự kiện, phỏng vấn nhiều máy |
| G7 | Punch-in tự động, speed ramp theo nhịp | Làm talking head và clip nhạc bớt tĩnh |
| G8 | Cân màu tự động giữa các clip (khớp phơi sáng và cân bằng trắng) | Footage nhiều máy hoặc nhiều giờ quay |
| G9 | Chuỗi xử lý thoại dựng sẵn (khử ồn, EQ, nén, chuẩn LUFS) | Hiện phải gọi từng effect |
| G10 | QA timeline: flash-frame, click/pop, clip offline, tổng loudness | `validate_project_for_export` chưa kiểm nội dung |
| G11 | Giao hàng nhiều tỷ lệ + kiểm tra file xuất (độ dài, LUFS, codec) | Một lệnh ra 16:9, 9:16, 1:1 |
| G12 | Job dài có tiến độ, hủy, cache bền trên đĩa, chạy song song có giới hạn | Phân tích hàng trăm file |
| G13 | `EditPlan`: xem trước, áp dụng, hoàn tác theo điểm kiểm tra | Một lệnh "dựng cho tôi" phải duyệt được trước khi ghi |

## 3. Lộ trình

Ước lượng: S ≤ 2 ngày, M ≈ 3-5 ngày, L ≈ 1-2 tuần. Mỗi mục "xong khi" phải được chứng minh trên project nháp, không phải project thật.

### Giai đoạn A: Nền an toàn và xác minh (M) — làm đầu tiên, chặn mọi giai đoạn sau
- **G1** `scripts/live-fixture.mjs`: sinh media bằng ffmpeg `lavfi` (thoại giả có lặng, đen, đứng hình, 25 và 29.97 fps), tạo project nháp qua `create_project`/`import_media`/`create_sequence_from_clips`. Mở rộng `live-tool-sweep.mjs` chạy các tool ghi trên project nháp này.
- Tool `backup_project`: `save_project_as` một bản `.bak` cạnh project trước khi tool ghi hàng loạt chạy; `remove_silence_from_sequence` và `normalize_loudness` tự gọi khi `dryRun=false`, có cờ `backup=false` để tắt.
- Thử live `remove_silence_from_sequence` trên fixture ở 25 fps và 29.97 fps; so sánh phương án ripple hiện tại với `ripple_delete`; chọn một, ghi lại.
- **G12 (phần cache):** cache bền trên đĩa (`~/.premiere-mcp/analysis/`), khóa theo đường dẫn + kích thước + mtime, giới hạn dung lượng.
- Gọn đầu ra `preflight_media`: chỉ trả file có vấn đề, kèm số file sạch.
- **Xong khi:** sweep chạy xanh trên fixture, có bằng chứng ripple đúng ở cả hai fps, và khởi động lại server không phải phân tích lại.

### Giai đoạn B: Thắng nhanh bằng tool có sẵn (M)
- **G3** `auto_duck_music`: phát hiện lời nói (ffmpeg `silencedetect` đảo ngược trên track thoại) rồi gọi `setup_ducking`.
- **G10** `qa_sequence`: flash-frame (< 6 frame), khoảng trống (`get_timeline_gaps`), clip offline, click/pop ở điểm cắt, loudness từng clip; tùy chọn tự thêm crossfade ngắn. Gộp kết quả vào `validate_project_for_export`.
- **G9** `apply_dialogue_chain`: khử ồn, EQ, nén bằng `apply_audio_effect`, sau đó `normalize_loudness`.
- **G7** `auto_punch_in`: keyframe `set_clip_scale` xen kẽ 100 và 110-115% tại điểm cắt hoặc ngắt câu; `speed_ramp` bằng keyframe tốc độ.
- **Xong khi:** mỗi tool có test thuần cho phần quyết định và một lần chạy xanh trên fixture.

### Giai đoạn C: Dựng theo lời thoại (L)
- **G2** `transcribe_media` (sidecar faster-whisper khi có, whisper CLI khi có; nếu không có thì trả `nextStep` cài đặt), word-level, cache theo file.
- `import_captions` (SRT/ASS thành caption track hàng loạt, có kiểu chữ an toàn cho 9:16).
- `edit_by_transcript`: xóa câu hoặc từ đệm theo văn bản, sinh `EditPlan`.
- **Xong khi:** phỏng vấn mẫu, bỏ từ đệm, caption khớp lời sau khi cắt.

### Giai đoạn D: Dựng theo nhạc (L)
- **G4** `analyze_music` (beat/bar/section, thuật toán thuần TS trên PCM từ ffmpeg; librosa qua sidecar nếu có), `generate_cadence_cuts`, preset thể loại, `build_variants` (port từ AutoEdit theo kế hoạch cũ).
- **Xong khi:** mọi điểm cắt trong ±1 frame của bar, cùng seed cho cùng kết quả.

### Giai đoạn E: Chọn và dựng thô (L)
- **G5** `score_clips` (độ nét, rung, phơi sáng bằng ffmpeg `signalstats`/`scdet`), `select_golden_windows`, `pack_to_duration`, `assemble_rough_cut`.
- **G8** `match_clip_exposure`: đo `signalstats`, bù phơi sáng và nhiệt màu qua Lumetri.
- **Xong khi:** thư mục footage + 60 giây thành sequence đúng thời lượng ±1 frame, mỗi clip dùng tối đa một lần.

### Giai đoạn F: Đồng bộ nhiều nguồn và giao hàng (M-L)
- **G6** `sync_by_audio`: tương quan chéo trên PCM giải mã bằng ffmpeg, trả độ lệch cho từng nguồn rồi đặt clip theo độ lệch.
- **G11** `deliver_all`: xuất 16:9, 9:16, 1:1 bằng `auto_reframe_sequence` + preset sẵn có; `verify_export` đo độ dài, LUFS, codec bằng ffprobe/ebur128 trên file đã xuất.
- **Xong khi:** hai nguồn quay lệch nhau vài giây được đặt khớp trong ±1 frame; một sequence ra ba bản kèm báo cáo kiểm tra.

### Giai đoạn G: Điều phối (M)
- **G13** `EditPlan` + `preview_edit_plan` (dry-run, diff, thời lượng dự kiến) + `apply_edit_plan` (backup, checkpoint, xác minh sau áp dụng) + `autoedit_run` một lệnh; **G12 (phần job)**: job nền, tiến độ, hủy, song song có giới hạn.
- Prompt và skill mới cho ba quy trình: phỏng vấn, video nhạc, short dọc.

## 4. Thứ tự và phụ thuộc

```
A ──► B ──► C ──┐
 │          D ──┼──► G
 └────────► E ──┤
            F ──┘
```
A chặn mọi thứ vì không có môi trường thử thì mọi tool ghi mới đều chưa được kiểm chứng. B cho giá trị lớn nhất trên chi phí thấp nhất. C, D, E độc lập nhau; G cần ít nhất một trong ba.

## 5. Rủi ro và ràng buộc

- **Premiere không đọc được âm thanh hay điểm ảnh:** mọi phân tích ở ngoài (ffmpeg/sidecar). Đây là thiết kế, không phải lỗi.
- **Tool ghi hàng loạt trên project thật:** luôn có `dryRun`, backup tự động, và `verified` sau khi áp dụng; không chạy ghi trên project người dùng khi chưa có bản sao.
- **fps lẻ (23.976, 29.97, 59.94):** timecode razor hiện tính bằng fps thực; phải kiểm chứng trên fixture trước khi tin.
- **Catalog phình:** thêm khoảng 15-20 tool; giữ nguyên cơ chế `search_tools`/`invoke_tool`, không đẩy vào danh sách luôn bật.
- **Sidecar ML:** tùy chọn, có fallback hoặc `nextStep`; không bắt cài để dùng A, B, E, F.
- **Giấy phép:** kiểm tra phụ thuộc (ultralytics AGPL, model whisper) trước khi đóng gói cùng bản MIT.

## 6. Cần bạn quyết định

1. Làm **giai đoạn A trước** (khuyến nghị) hay đi thẳng vào một quy trình sản phẩm?
2. Sau B, ưu tiên quy trình nào: **phỏng vấn/thoại (C)**, **video nhạc (D)** hay **dựng thô từ footage (E)**? Project hiện tại (DJI, picnic, cảnh quay không lời) cho thấy **E và D** hợp hơn **C**.
3. Có cho phép tạo project nháp và file media giả trên đĩa E: để chạy kiểm thử live không?

## 7. Tiến độ giai đoạn A (2026-11-01)

Xong, đã kiểm thử bằng jest (không chạm Premiere):
- Cache phân tích bền trên đĩa (`~/.premiere-mcp/analysis`, đổi bằng `PREMIERE_MCP_CACHE_DIR`), giới hạn 5000 mục.
- `preflight_media` chỉ trả file có vấn đề, kèm `cleanFiles`.
- Sao lưu trước khi ghi: `remove_silence_from_sequence` và `normalize_loudness` (cờ `backup`, mặc định bật) lưu project rồi sao chép `.prproj` vào `premiere-mcp-backups/`. Cố ý không dùng `saveAs`, vì nó đổi project đang mở sang bản sao.
- Phân tích chạy song song có giới hạn (một nửa số lõi, tối đa 8; `PREMIERE_MCP_ANALYSIS_JOBS`).
- `scripts/live-fixture.mjs` sinh media giả 25 và 29,97 fps với khoảng lặng đã biết.

Chưa xong: chạy `remove_silence_from_sequence` trên project nháp trong Premiere thật (cần mở project nháp, sẽ rời project đang mở), và so sánh với `ripple_delete`.

### Hiệu năng đo được (CPU, không GPU, máy 16 luồng)
| Phân tích | Chi phí |
|---|---|
| silencedetect, ebur128 | 0,3-0,6 s cho 10 phút, chỉ đọc luồng âm thanh |
| ffprobe | ~0,45 s mỗi file (phần lớn là khởi động tiến trình trên Windows) |
| blackdetect, freezedetect | ~6 s cho 5 phút 1080p H.264, gấp ~50 lần thời gian thực; giải mã video chiếm gần hết, giảm độ phân giải không nhanh hơn |
| Nạp server + 287 tool | 150 ms, 77 MB RAM |
Không tool nào cần GPU. Lần chạy thứ hai trên cùng file gần như tức thì nhờ cache.

### Kiểm chứng live (2026-11-01, Premiere 25.6.3, project nháp Project-Temp)
Fixture 12 s, hai khoảng lặng 3-6 s và 9-11 s, cắt bằng `remove_silence_from_sequence` với mặc định:
| fps | kế hoạch bỏ | thực tế bỏ | độ dài sau | khoảng trống | verified |
|---|---|---|---|---|---|
| 29,97 | 4,537 s | 4,538 s | 7,441 s | 0 | true |
| 25 | 4,520 s | 4,520 s | 7,480 s | 0 | true |
Chạy lại dry-run sau khi cắt: 0 khoảng lặng còn lại. Sao lưu tự động tạo `premiere-mcp-backups/Project-Temp-*.prproj`. `normalize_loudness` ghi gain +7,8..+8 dB lên 3 clip, `applied: true`.
Giữ nguyên cách ripple hiện tại (razor, nhấc, ripple clip cuối); chưa cần đổi sang `ripple_delete`. Chưa đo bằng mắt việc audio và video còn thẳng hàng sau cắt; không có khoảng trống nào.

## 8. Tiến độ giai đoạn B (2026-11-01)

Xong 4 tool (catalog 291): `auto_duck_music`, `qa_sequence`, `apply_dialogue_chain`, `auto_punch_in`. Phần quyết định nằm ở `src/analysis/editing.ts` (có test thuần), phần ghi dùng lại `setup_ducking`, `apply_audio_effect`, `normalize_loudness`.

Kiểm chứng live trên Project-Temp (Premiere 25.6.3):
- `auto_duck_music`: tìm đúng 3 đoạn lời (0-3, 6-9, 11-12 s), ghi 10 keyframe; đọc lại: -24 dB = 0,01122 và -12 dB = 0,04467 đúng thang hiệu chuẩn.
- `apply_dialogue_chain`: clip có đủ Volume, DeNoise, Dynamics sau khi chạy.
- `auto_punch_in`: Motion Scale đọc lại đúng 112.
- `qa_sequence`: sequence sau khi cắt lặng báo sạch, không khoảng trống.

Chưa kiểm chứng: thời gian keyframe khi clip nhạc không bắt đầu ở 0 hoặc có in-point khác 0 (tài liệu `setup_ducking` nói thời gian nguồn tuyệt đối, đã truyền theo quy ước đó); tên hiệu ứng trên Premiere không phải tiếng Anh (truyền qua `effects`); `speed_ramp` chưa làm.

## 9. Tiến độ giai đoạn E (2026-11-01)

Xong `score_clips` và `assemble_rough_cut` (catalog 293). Logic chọn nằm ở `src/analysis/roughcut.ts` (có test thuần). Đo bằng ffmpeg trên keyframe thu nhỏ 320 px (hai lượt: độ sáng và mật độ cạnh), tự chuyển sang 1 khung hình/giây nếu keyframe quá thưa.

Kiểm chứng live (Project-Temp, Premiere 25.6.3), thư mục 4 clip giả (rõ nét, tối, mờ, rõ nét 2):
- Xếp hạng đúng: rõ nét 0,632 > mờ 0,49 > tối 0,083.
- `assemble_rough_cut` 9 s: chọn 3 cảnh tốt nhất, bỏ clip tối, đặt liền nhau, track video kết thúc đúng 9 s, `verified: true`, `qa_sequence` báo sạch, sao lưu tự động.

Giới hạn đã biết: chưa đo rung và chuyển động (mẫu quá thưa); ngưỡng độ nét (cạnh trung bình 12 ở 320 px) hiệu chỉnh trên ảnh giả, nên cần chỉnh lại trên footage DJI thật; `select_golden_windows`, `match_clip_exposure` chưa làm. `pack_to_duration` đã gộp vào `assemble_rough_cut`.

## 10. Tiến độ giai đoạn D (2026-11-01)

Xong `analyze_music` và `assemble_beat_cut` (catalog 295). Thuật toán thuần TypeScript, không cần Python hay GPU: ffmpeg đo độ lớn mỗi 10 ms, tự tương quan để tìm tempo (tinh chỉnh tới phần trăm khung hình để không trôi nhịp trong cả bài), tìm pha beat, ô nhịp mạnh làm downbeat, chia đoạn nơi độ lớn đổi từ 25% trở lên. Logic ở `src/analysis/music.ts` và `src/analysis/beatcut.ts`.

Kiểm chứng:
- Test thuần trên đường bao tổng hợp: 90/120/140 BPM sai dưới 1 BPM và beat không trôi sau 1 phút; chọn đúng downbeat; tách đoạn nhỏ/to; cùng đầu vào cho cùng kết quả.
- Live (Project-Temp, Premiere 25.6.3), bài 24 s 120 BPM, nửa sau to hơn: 120,07 BPM, độ tin cậy 1, 12 ô nhịp, ranh giới đoạn ở 12,19 s (thật 12,0; lệch nửa ô nhịp vì lưới ô nhịp bắt đầu ở 0,2 s). `assemble_beat_cut` kiểu energetic: 29 cảnh + nhạc, track video kết thúc đúng 24 s, `verified: true`, `qa_sequence` sạch.

Giới hạn: giả định tempo đều (bài live hoặc đổi nhịp sẽ cho độ tin cậy thấp); chỉ thử trên nhạc tổng hợp, chưa thử trên bài thật có giọng hát; chưa có `build_variants` và các preset thể loại ngoài ba mức tốc độ.
