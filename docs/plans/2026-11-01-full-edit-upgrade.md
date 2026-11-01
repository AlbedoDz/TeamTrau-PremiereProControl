# Kế hoạch nâng cấp Premiere MCP để edit được video hoàn chỉnh

Nguồn tham khảo: `E:\antigravity\TeamTrau-AutoEdit` (engine Python) và `E:\antigravity\teamtrau-studio` (editor Electron/React + AutoEdit sidecar).
Hiện trạng Premiere MCP v1.2.11: 283 tool, mạnh ở **thao tác cấp thấp** (trim, razor, effect, marker, export…) nhưng thiếu **tầng "biên tập thông minh"**: không có phân tích media, không có logic chọn cảnh/cắt theo nhạc/theo lời, không có QA trước khi export, không có quy trình một-lệnh từ footage thô → video xong.

## 1. Phân tích khoảng trống (gap)

| Khả năng edit hoàn chỉnh | Premiere MCP hiện có | TeamTrau có (nguồn) | Gap |
|---|---|---|---|
| Kiểm tra media trước khi dựng | `check_offline_media` | `core/nle_preflight.py`: MEDIA_MISSING, VFR_SOURCE, FPS_MISMATCH, AUDIO_MONO/MULTICHANNEL, AUDIO_RATE_MISMATCH | Thiếu VFR/FPS/audio-layout |
| Loại bỏ khoảng chết | `detect_silence` (chỉ phát hiện) | `rough_cut_cleaner.py`: rung/whip-pan, ngậm máy xuống đất, mất nét, che ống kính, cháy sáng, flicker, ồn gió | Không có bước **áp dụng** cắt; thiếu defect video |
| Phát hiện cảnh | `detect_scene_edits` (trên sequence) | PySceneDetect + `visual_scorer.py` (độ nét, bố cục) | Không phân tích file nguồn, không chấm điểm |
| Phân loại A-roll/B-roll | không | `media_classifier.py` (giọng nói + khuôn mặt YuNet) | Thiếu hoàn toàn |
| Chọn đoạn đẹp nhất của shot dài | không | `shot_windows.py` + `golden_takes.py` (đường cong chất lượng, cửa sổ tối ưu) | Thiếu |
| Dựng theo nhạc | không | `audio_analyzer.py`, `cadence.py` (lưới bar, cắt theo bar/nửa bar, đường cong cảm xúc theo section), `genre_presets.py` (4 thể loại / 23 sub-genre) | Thiếu hoàn toàn |
| Dựng theo thời lượng đích | không | `duration_packer.py` (knapsack câu thoại + B-roll) | Thiếu |
| Nhiều biến thể | không | `variant_synthesizer.py` (Beat / Cinematic / Social teaser 30-45s) | Thiếu |
| Phiên âm / sửa theo lời | `read_sequence_captions` | `transcription_engine.py` (faster-whisper, word-level), Studio Parakeet/Whisper | Không có transcribe, không sửa theo transcript |
| Phụ đề động | `create_caption_track`, `add_text_overlay` | `subtitle_formatter.py` (ASS word-highlight, safe-zone) | Thiếu nhập SRT hàng loạt + style động |
| Reframe dọc 9:16 | `auto_reframe_sequence` | `smart_reframer.py` (YOLO track + EMA chống rung) | Reframe của Premiere, không kiểm soát chủ thể |
| Liên tục hình ảnh | không | `visual_flow.py` (Bhattacharyya, Ken Burns) | Thiếu |
| Chuẩn hóa âm thanh | `adjust_audio_levels`, `setup_ducking` (chỉ ghi) | `audio_normalizer.py` | Chưa đo loudness (LUFS) rồi set gain |
| QA trước export | `validate_project_for_export` | `timeline_qa.py` (flash-frame <6 frame, click/pop, crossfade), `deliver_check.py` | Thiếu QA nội dung timeline |
| Điều phối agent | prompts/resources | `agent_controller.py`, Studio `headless/` (edit-operations có schema + contract test), jobs/sessions của `engine_api` | Không có job dài + tiến độ, không có edit-plan khai báo |
| Bài học XML | `import_fcp_xml` | `premiere_xml_fix.py` (channelcount, sourcetrack, audio rate) | Cần khi nhận timeline từ engine ngoài |

## 2. Quyết định kiến trúc

Premiere MCP là Node/TS; AutoEdit là Python (YOLO, faster-whisper, librosa, OpenCV, CUDA). Không nhúng Python vào lõi MCP.

**Kiến trúc lai, ba lớp:**

1. **Lớp phân tích TS thuần + ffmpeg/ffprobe** (luôn chạy, không cần Python). `detect_silence` đã chứng minh mô hình này. ffmpeg có sẵn `silencedetect`, `blackdetect`, `freezedetect`, `scdet`, `signalstats`, `loudnorm`, `ebur128`.
2. **Logic quyết định port sang TS** (hàm thuần, dễ test): cadence/bar grid, golden-take window, duration packer, timeline QA, preflight, genre presets. Port từ các file Python nguồn, giữ nguyên thuật toán.
3. **Sidecar Python tùy chọn** (`TeamTrau engine_api`, HTTP) cho phần cần ML nặng: transcribe, phân loại face/speech, YOLO reframe, chấm điểm hình ảnh CUDA. MCP dò sidecar lúc chạy, **không có thì tool trả `nextStep` rõ ràng hoặc dùng fallback ffmpeg**, giống cách `detect_silence` xử lý thiếu ffmpeg.

**Hợp đồng trung tâm: `EditPlan` JSON.** Mượn ý tưởng `editOpSchema` của Studio headless: mọi tool "thông minh" chỉ **sinh plan** (danh sách clip, in/out, track, transition, caption, audio gain) và `apply_edit_plan` mới chạm Premiere, kèm xác minh sau khi áp dụng. Lợi ích: có thể xem trước/duyệt plan, chạy dry-run, test không cần Premiere, và khớp nguyên tắc đã làm ở 2b3a158/c8477b4 (không báo thành công khi Premiere chưa làm thật).

Dựng timeline **native** qua `add_to_timeline_batch` thay vì đi đường FCP XML (tránh lỗi relink/kênh âm mà `premiere_xml_fix.py` phải vá). `import_fcp_xml` chỉ giữ làm đường phụ.

## 3. Lộ trình theo giai đoạn

Ước lượng: S ≤ 2 ngày, M ≈ 3-5 ngày, L ≈ 1-2 tuần.

### P0: Nền tảng phân tích (M)
- `src/analysis/ffmpeg.ts`: tách `resolveFfmpegBinary`/spawn từ `domains/audio.ts` thành module dùng chung (thêm ffprobe).
- `src/analysis/cache.ts`: cache theo `path + mtime + size` (học `analysis_cache.py`), lưu trong thư mục dự án/bridge dir.
- `src/analysis/sidecar.ts`: client HTTP tới AutoEdit engine_api, dò health, timeout, hủy.
- `src/jobs/`: mô hình job dài (id, tiến độ, hủy) học `engine_api/jobs.py`; tool `get_job_status`, `cancel_job`.
- Mở rộng `get_capabilities`: báo ffmpeg/ffprobe/sidecar/GPU có hay không.
- **Xong khi:** unit test cache + job; `get_capabilities` phản ánh đúng môi trường.

### P1: Chuẩn bị và dọn footage (M)
- `preflight_media` (port `nle_preflight.py`): mã lỗi VFR, FPS mismatch, mono/đa kênh, sample rate, offline. Chạy ffprobe, không cần Premiere.
- `find_dead_segments`: ffmpeg `silencedetect` + `blackdetect` + `freezedetect` (thay thế phần thực dụng của `rough_cut_cleaner`). Defect optical-flow (rung, whip-pan) để dành cho sidecar.
- `remove_silence_from_sequence`: **áp dụng** cắt (razor + ripple delete) với padding, ngưỡng, giữ nhịp; dùng kết quả ở trên. Đây là tính năng "edit xong" đầu tiên mà hiện chưa có.
- `normalize_loudness`: `ebur128` đo LUFS từng clip, đặt gain qua `adjust_audio_levels`; đích -14 LUFS (social) / -23 (broadcast).
- **Xong khi:** chạy trên footage mẫu có khoảng lặng, thấy sequence ngắn đi đúng và không làm lệch sync A/V (test bằng `list_sequence_tracks` trước/sau).

### P2: Dựng theo lời thoại (L)
- `transcribe_media` qua sidecar (faster-whisper) hoặc whisper CLI nếu có; trả word-level timecode, cache theo file.
- `build_transcript_edit`: chọn/xóa câu, loại từ đệm ("ờ", "um") → sinh EditPlan.
- `import_captions`: SRT/ASS → caption track hàng loạt (hiện chỉ có `create_caption_track` + `read_sequence_captions`); style theo `subtitle_formatter` (word-highlight, safe-zone 9:16).
- **Xong khi:** phỏng vấn mẫu → bỏ từ đệm → caption khớp lời sau khi cắt.

### P3: Tuyển chọn và dựng thô (L)
- `classify_media_roles` (A-roll / B-roll / ambient) qua sidecar, fallback heuristic theo mức âm thanh.
- `score_clips`: độ nét, rung, phơi sáng (ffmpeg `signalstats` + `scdet`; CUDA qua sidecar).
- `select_golden_windows` (port `shot_windows.py`/`golden_takes.py`): với shot dài, chọn cửa sổ mượt/nét nhất chưa dùng.
- `pack_to_duration` (port `duration_packer.py`): knapsack câu thoại + B-roll vào thời lượng đích.
- `assemble_rough_cut`: sinh EditPlan rồi áp dụng. Thay cho `assemble_product_spot` chuyên biệt hiện có.
- **Xong khi:** thư mục footage + thời lượng 60s → sequence đúng 60s ±1 frame, mỗi clip dùng ≤ 1 lần.

### P4: Dựng theo nhạc và thể loại (L)
- `analyze_music`: tempo, beat, bar grid, section. Thuật toán thuần TS trên PCM giải mã bằng ffmpeg (năng lượng flux + tự tương quan) hoặc librosa qua sidecar khi cần độ chính xác cao.
- `generate_cadence_cuts` (port `cadence.py`): cắt chỉ ở bar/nửa bar, độ dài theo đường cong cảm xúc từng section, seed cố định, snap vào lưới frame.
- `list_genre_presets` / áp dụng preset (port `genre_presets.py`): nhịp cắt, transition, speed ramp theo 4 thể loại.
- `build_variants`: Beat-driven / Cinematic / Social teaser (port `variant_synthesizer.py`) thành 1-3 sequence.
- **Xong khi:** bài hát 120 BPM → mọi điểm cắt nằm trong ±1 frame của bar; chạy lại cùng seed ra cùng kết quả.

### P5: Hoàn thiện và giao hàng (M)
- `qa_sequence` (port `timeline_qa.py` + `deliver_check.py`): flash-frame < 6 frame, khoảng trống, clip offline, audio pop; tùy chọn tự sửa (crossfade tham số hóa). Gộp vào `validate_project_for_export`.
- `reframe_to_vertical`: giữ `auto_reframe_sequence` làm mặc định; thêm đường sidecar YOLO + EMA, ghi keyframe Motion qua `add_keyframe`.
- `check_visual_continuity` (port `visual_flow.py`): cảnh báo nhảy phơi sáng tại điểm cắt; Ken Burns cho shot tĩnh.
- `deliver_all`: export một lần ra nhiều tỷ lệ (16:9, 9:16, 1:1) bằng preset sẵn có, kiểm tra file đầu ra.
- **Xong khi:** từ một sequence 16:9 ra được bản 9:16 + báo cáo QA sạch.

### P6: Điều phối một lệnh và trải nghiệm agent (M)
- `autoedit_run`: pipeline `preflight → dọn → tuyển chọn → dựng → QA → deliver`, chạy như job, báo tiến độ từng bước, dừng được, mỗi bước tạo checkpoint (học checkpoint ops của Studio headless) để `undo` về điểm an toàn.
- `apply_edit_plan` + `preview_edit_plan` (dry-run, trả diff và thời lượng dự kiến).
- 3 prompt mới trong `src/prompts` (rough-cut theo lời, music video, social short) và cập nhật `skills/premiere-pro-mcp` để agent biết quy trình.
- Tài nguyên mới: `premiere://analysis/*` (kết quả phân tích đã cache).

### P7: Kiểm thử, tài liệu, phát hành (M, chạy song song từ P1)
- Test đơn vị cho mọi hàm port (đầu vào tổng hợp, như test cadence của AutoEdit); test hợp đồng EditPlan không cần Premiere.
- Fixture footage ngắn trong repo (hoặc sinh bằng ffmpeg `lavfi`); không commit file lớn.
- Mở rộng `scripts/live-tool-sweep.mjs` cho tool mới; chạy trên dự án Premiere nháp trước khi tuyên bố "đã kiểm chứng".
- `catalog-structure.test.ts` và `search-tools.test.ts` phải vẫn qua; cập nhật số tool trong README/KNOWN_ISSUES đếm từ build.
- Cập nhật `CHANGELOG.md`, bản dịch README quan trọng (vi trước).

## 4. Thứ tự và phụ thuộc

```
P0 ──► P1 ──► P3 ──► P4 ──► P5 ──► P6
        └──► P2 ──────┘
P7 chạy suốt
```
Giá trị lớn nhất với chi phí thấp nhất là **P0 + P1** (không cần Python, đã có "edit thật" đầu tiên). P2 và P4 là hai quy trình sản phẩm khác nhau, có thể làm độc lập sau P1/P3.

## 5. Rủi ro

- **ExtendScript không đọc được âm thanh/pixel**: mọi phân tích phải nằm ngoài Premiere (ffmpeg/sidecar), đây là thiết kế chứ không phải lỗi (đã ghi trong KNOWN_ISSUES).
- **Độ chính xác cắt**: sai lệch frame khi ripple delete nhiều điểm; cắt từ cuối về đầu, snap theo frame rate của sequence, kiểm tra lại bằng `get_clip_properties` sau khi áp dụng.
- **Sidecar nặng**: Python + CUDA + model lớn; phải tùy chọn, có fallback, và không bắt người dùng cài để dùng P1/P5.
- **Phình catalog**: thêm ~25 tool; tiếp tục dùng `search_tools`/`invoke_tool`, không đẩy vào danh sách luôn bật.
- **Giấy phép**: TeamTrau-AutoEdit/Studio là mã của bạn (AlbedoDz); kiểm tra phụ thuộc bên thứ ba (YOLO/ultralytics AGPL) trước khi đóng gói sidecar vào bản phát hành MIT.
- **Thuật toán beat bằng TS**: có thể kém librosa; chấp nhận cho P4 bản đầu, sidecar là đường nâng cấp.

## 6. Việc cần bạn quyết định

1. Sidecar Python: **bắt buộc đi kèm**, **tùy chọn tự phát hiện** (khuyến nghị), hay **bỏ hẳn** và chỉ dùng TS + ffmpeg?
2. Thứ tự ưu tiên: quy trình **thoại/phỏng vấn (P2)** hay **dựng theo nhạc (P4)** làm trước sau P1?
3. Có đóng gói bản phát hành chung với repo này hay tách thành plugin/repo riêng cho phần sidecar?
