# Panel GUI 1.5.0: chạy thật và hai bài thử

Nhánh `feature/panel-gui`, worktree `.worktrees/panel-gui`. Ghi kết quả thẳng vào file này. Chưa merge cho tới khi các mục dưới đây được kiểm.

## 0. Chuẩn bị
- [ ] Mở một project **nháp**, không dùng project đang làm thật. Project phải được lưu ít nhất một lần, vì tool sao lưu trước khi sửa.
- [ ] Lưu ý: cài panel từ worktree (`node dist/cli.js --install-cep` rồi `--register-panel-runner`) sẽ **ghi đè panel 1.4.0 đang cài**. Muốn quay về bản cũ thì chạy lại Setup.exe 1.4.0.
- [x] Mở lại Premiere, mở `Window > Extensions > TeamTrau PremiereProControl`. Panel phải có hai tab **Quy trình** và **Kết nối**.
  - Lỗi tìm thấy và đã sửa (`3779fdd`): lúc đầu không nút nào bấm được. CEP chạy ở `--mixed-context` có sẵn biến `module`, nên `gui-core.js` chỉ xuất code ra `module.exports`, `gui.js` hỏng ngay khi khởi tạo. Sau khi sửa và nạp lại panel, người dùng xác nhận các nút đã hoạt động.

## 1. Spike 1: ASR có giữ "ờ/ừm" không (quyết định có cần phát hiện bằng âm thanh)
- [ ] Chọn một đoạn voice khoảng 2 phút có "ờ/ừm" thật. Chạy `transcribe_sequence`.
- [x] 2026-11-12, sequence "Ngách 41-2 Đông Tác 3" (voice-off 196 s, engine **whisper-turbo**): transcript có 546 từ, **0 từ ngập ngừng**. Có 25 đoạn tiếng ngắn (< 0,6 s, giữa hai khoảng lặng −35 dB); **24/25 khớp với một từ thật**, chỉ 1 đoạn không có từ (0:17.11–0:17.38, có thể là "ờ" hoặc tiếng lấy hơi).
- [x] Kết luận tạm: tỉ lệ ≥ 96%, nên **chưa cần** phát hiện bằng âm thanh. Bằng chứng còn yếu vì bản đọc này rất sạch; cần thử lại trên một bản nói tự nhiên có nhiều "ờ/ừm".
- [ ] Nếu tỉ lệ dưới 0,7 thì cần thêm cách phát hiện bằng âm thanh (spec §5.2), theo ruling R1.

## 2. Spike 2: J-cut
- [x] Trên một sequence nháp có 2 clip liền nhau: bỏ liên kết clip thứ hai, kéo audio của nó sớm hơn 0,5 s, cắt đuôi audio clip trước, rồi đọc lại vị trí. Làm 5 lần.
- [x] Kết quả (2026-11-12, sequence "TEST jcut"): **5/5** lần đúng vị trí, không khe hở, hình và tiếng vẫn khớp nhau. Đã bật J-cut (`92a285d`), độ sớm làm tròn theo frame. Chạy recap thật với J-cut: **9/9** mối nối áp J-cut, crossfade đặt đủ trên các mối nối mới. Ô J-cut trên panel không còn ẩn.

## 3. Năm quy trình chạy từ panel, không mở client AI nào
Với mỗi quy trình, ghi lại: Xem trước có đúng không, thời gian chạy, các số trong `summary`, cảnh báo, và kết quả có đúng không.
- [x] **Dọn voice-over** (chạy qua runner trên máy thật):
  - Xem trước: 22 khoảng lặng và 1 câu vấp. Câu vấp ở 148–158,7 s là câu đọc lại thật ("nhiều lượt" sửa thành "887 lượt"), tool giữ bản đọc sau. Đúng.
  - Chạy thật: tạo "… - clean", 196,0 s → 162,1 s, đã xác minh độ dài. DeNoise và Dynamics áp lên 19/19 clip, chuẩn −16 LUFS, QA sạch, có sao lưu.
  - **Lỗi tìm thấy và đã sửa:** tham số thứ hai của QE `addTransition` nghĩa là "đặt ở đầu clip" (`true`). Ruling R4 hiểu ngược, nên crossfade rơi vào cuối clip (mất ở mối nối đầu, thừa một cái ở cuối sequence), và bước xác minh qua QE báo nhầm "0/18".
  - Đã sửa: dùng `true` và xác minh qua `track.transitions.numItems` của DOM. Chạy lại trên máy thật: crossfade nằm ngay tại mối nối (99,967–100,000 s), không còn cảnh báo.
  - **Người dùng duyệt bản clean (2026-11-12) và báo 3 lỗi; phân tích tìm thêm 1 lỗi:**
    - 12:04, tiếng thừa: Whisper bỏ tiếng ngập ngừng. Zipformer có nghe ra, nhưng nhận thành "Này" (tầng C).
    - 50:04, thừa chữ: **do vết cắt thử của tôi trên bản clean**, không phải lỗi của tool. Bài học: không bao giờ thử nghiệm trên bản giao cho người dùng.
    - 1:34–1:40, trùng lặp: Whisper gộp các lần đọc lại; quy trình còn bỏ sót kiểu đọc lại bắt đầu từ giữa câu.
    - 1:50–2:09, trùng lặp (người dùng chưa báo): Whisper gộp mất lần đọc đầu.
  - **Đã sửa (`0b19bdb`):**
    - Dọn voice-over mặc định dùng Zipformer, kèm đường lùi.
    - Bắt câu vấp kiểu đuôi trùng đầu, xét trước luật độ trùng từ.
    - Cắt tiếng lẻ đứng riêng (chỉ voice-over).
    - Lưới an toàn: cắt mẩu tiếng ≤ 0,8 s không có từ nào.
    - Cảnh báo khi một từ kéo dài hơn 1,5 s.
  - **Kiểm lại:** bản Xem trước bắt đủ cả 4 vị trí lỗi.
  - **Lỗi crossfade phát sinh, đã sửa:** chỉ đặt được 7/14. Nguyên nhân là `move(-gap)` dịch theo số giây làm tròn 1 ms, khiến các clip lệch 0,01–0,02 frame. Chỗ nào hai clip chồng nhau, Premiere âm thầm từ chối transition. Đã sửa bằng cách dịch theo số frame nguyên.
  - **Bản "- clean (4)":** 146,83 s, 14/14 crossfade dài 1 frame, 0 clip lệch lưới, 0 khe hở hay chồng, QA sạch, không cảnh báo.
  - Người dùng duyệt bản (4) và báo lỗi: 0:00–1:28 là câu đọc thử "Khuyến học tổ dân 38" (ASR nghe là "Quyền học tổ dân ba tám"), sau đó lặng 1,7 s rồi mới vào bài.
  - Đã sửa (`5d630b4`): câu đầu tiên được cắt với lý do "câu đọc thử / xướng tên" khi đủ cả bốn điều kiện: ≤ 8 từ, ≤ 3 s, có khoảng lặng ≥ 1,2 s phía sau, câu kế tiếp dài hơn. Chỉ áp dụng cho voice-over. Xem trước lại: đã bắt được câu này, 0–6,5 s bị bỏ toàn bộ.
  - Việc còn lại cho Dọn voice-over: người dùng nghe lại bản (4).
  - Xem trước có liệt kê vết cắt kèm lý do và câu gốc không.
  - Sau khi chạy: crossfade **có thật trên từng vết cắt không** (ruling R4), và nghe có tiếng "tách" ở mối nối không.
  - Câu chứa "chẳng", "ạ", "nhé" có còn nguyên không.
- [x] **Recap** trên FINAL_01 (talk show 69,5 phút, transcript đã có sẵn trong cache):
  - Lỗi 1 (sửa ở `e047fcc`): bộ chấm điểm của Shorts cộng điểm cho câu hỏi, nên 11/16 đoạn là câu hỏi không có câu trả lời. Ngoài ra `totalSec` báo độ dài cả sequence.
  - Lỗi 2 (sửa ở `4288c34`): độ dài tối thiểu 4 s tạo ra 21 mẩu vụn. Nâng lên 8 s thì còn 10 ý trọn, mỗi ý 8–13 s, tổng 93,9 s. Vẫn nghiêng về lời người dẫn hơn câu trả lời của bác sĩ, đây là giới hạn của heuristic (xem mục 5).
  - Lỗi 3 (sửa ở `e5fecf4`): `removeRanges` chỉ ripple clip cuối, nên với video và audio liên kết, sequence chỉ ngắn đi 86 s và còn lại khoảng trống 700 s. Sau khi sửa: 16:9 dài 93,92 s, đã xác minh, QA sạch, mất 44 s.
  - 9:16 có phụ đề clean: 93,92 s, đã xác minh, QA sạch, mất 74 s. Sequence trung gian "(16:9)" đã bị xóa, phụ đề `.mov` nằm trên V4. **Khung là 607×1080** (Auto Reframe giữ chiều cao nguồn); muốn ra 1080×1920 thì phải đổi kích thước sequence, việc này để làm sau.
  - Còn lại cho Recap:
  - Bản 9:16 có đủ độ dài không, kể cả khi sequence gốc có điểm In/Out.
  - Sequence trung gian "(16:9)" có bị xóa không.
  - Phụ đề có nằm trong vùng an toàn không.
- [x] **Podcast → Shorts** (2 short, 30–60 s): 32,2 s và 36,0 s, cả hai đã xác minh, mất 34 s.
  - Chất lượng: short 1 dừng ở "Xin được mời… bác sĩ giải đáp", tức là hết trước câu trả lời.
  - Đã sửa (`52d7bb3`): loại các đoạn kết bằng câu hỏi, dấu phẩy, hoặc lời chuyển cho khách. Luật nhận ra cả "mời", "nhờ", "đề nghị", và lỗi ASR "dạy đáp". Đoạn kết bằng dấu chấm được ưu tiên; ASR chấm câu không đều (6/60 đoạn), nên đoạn không có dấu câu vẫn được chọn khi thiếu. Tập ứng viên tăng từ 20 lên 60.
  - Chạy thử lại trên FINAL_01: cả 2 short kết thúc trọn câu, ở 617,9–654,6 s và 3,0–35,9 s. Short thứ hai là đoạn mở đầu chương trình ("Kính chào quý vị…"): trọn ý nhưng không hấp dẫn, đây là giới hạn của heuristic (mục 5).
  - Một cảnh báo tiếng Anh vẫn lọt qua panel: "Captions were rendered at 608×1080…".
  - **Người dùng báo: ở mỗi điểm chuyển cảnh trong short và recap, khung hình dịch nhẹ.** Nguyên nhân là Auto Reframe lia khung theo chủ thể và trượt 1–2 s sau mỗi lần đổi máy quay trong nguồn (ví dụ 0,50→0,38).
  - Thử nghiệm trên bản sao "TEST steady":
    - Ghi đè "Generated Keyframes" không làm thay đổi hình.
    - Bật "Overwrite generated path" rồi ghi "Adjust Position" thì hình đổi đúng.
  - Đã sửa (`6d7a1ac`, `d5b72fd`): sau Auto Reframe, mỗi shot nguồn giữ một vị trí cố định (trung vị của đường lia) và chỉ nhảy đúng tại điểm chuyển cảnh. Điểm chuyển cảnh lấy từ `detectScenes`, chỉ quét trong đoạn của clip. Các shot liền nhau lệch nhau < 0,02 khung được gộp làm một.
  - Kết quả chạy thật:
    - Short "short 1 (3)": 3 shot đứng yên. Hai frame cách nhau 20 s có hậu cảnh ở cùng vị trí.
    - Recap 9:16 "recap (4)": 7/7 clip được giữ khung.
  - Còn lại cho Shorts:
  - Mỗi short có đúng khoảng thời gian không, và các short có chồng nhau không.
  - Bấm Hủy giữa chừng: các short đã xong phải giữ nguyên tên.
- [x] **Phụ đề tiếng Việt** (SRT): 3069 cue, mất 2 s, dòng ≤ 42 ký tự. File mặc định nằm trong `~/.premiere-mcp/renders`.
  - Còn lại: thử cả hai kiểu xuất SRT và track caption trên bản sao.
- [x] **Rough cut** (thư mục "1. Giải mã nỗi sợ mang tên Zona…", 2 video, mẫu thông số FINAL_01, đích 30 s, nhịp balanced):
  - Lỗi (đã sửa): Xem trước luôn thất bại vì chạy thử trên sequence mẫu đang có clip, và bước kiểm tra track V1 từ chối. Giờ chỉ khi chạy thử mới truyền `overwrite: true`; khi chạy thật vẫn là `false`, có test giữ điều này.
  - Chạy thật: tạo "… - rough cut" từ bản sao xóa trống của FINAL_01, 4 shot × 7,5 s = 30 s, đã xác minh, mất 13 s.
  - **Có nhạc** (`mfcc-teaser-trailer…mp3`, 45,8 s, 113 BPM): "… - rough cut (2)" có 40 shot cắt theo nhịp, nhạc nằm trên A2, đã xác minh, mất 18 s.
    - Lỗi tìm thấy và đã sửa (`ed37893`): còn 4 khe hở 1 frame (nháy đen). Nguồn quay 30 fps đặt trên timeline 25 fps nên Premiere làm tròn điểm kết thúc xuống. Giờ sau khi đặt clip, tool kéo dài clip trước cho khít các khe ≤ 2 frame. Chạy lại: 0 khe hở, 0 chỗ chồng.
    - Nhận xét: 21 shot đầu lấy từ một file, 19 shot sau từ file còn lại. Chưa xen kẽ hai nguồn.
    - Chưa thử: hạ nhạc dưới thoại (`hasVoiceover`).
  - Còn lại:
  - Có nhạc: nhạc nằm ở A2.
  - Nếu sequence chỉ có một track audio thì có báo lỗi rõ ràng không.

## 4. Hủy, đóng panel, và chạy cùng Agent
- [ ] Bấm Hủy lúc runner đang khởi động, và Hủy giữa bước transcribe: bản sao phải đổi tên thêm " (đã hủy)".
- [ ] Đóng panel khi đang chạy: `beforeunload` có cảnh báo không; bản sao có thành " (dang dở)" không.
- [ ] Gọi `workflow_clean_voiceover` qua Agent: Agent có nhận được tiến độ không.
- [ ] Trong lúc GUI đang chạy, gọi `list_sequences` từ Agent: cả hai đều phải xong.
- [ ] Đổi sang sequence khác trong lúc đang chờ transcript: quy trình vẫn phải dùng sequence ban đầu.

## 5. Chấm heuristic (quyết định có làm Task 14, bộ chọn AI, hay không)
- [ ] Chạy Recap và Shorts trên 3 video thật rồi chấm điểm: Đạt / Chưa đạt. Ghi chú: ___
