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
- [ ] Trên một sequence nháp có 2 clip liền nhau: bỏ liên kết clip thứ hai, kéo audio của nó sớm hơn 0,5 s, cắt đuôi audio clip trước, rồi đọc lại vị trí. Làm 5 lần.
- [ ] Kết quả: ___ / 5 lần lệch không quá 1 frame. Nếu đạt cả 5 lần thì bật J-cut trong `build_recap`, thay cho `JCUT_SUPPORTED = false`.

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
  - Chất lượng: short 1 dừng ở "Xin được mời… bác sĩ giải đáp", tức là hết trước câu trả lời. Cần nối câu hỏi với câu trả lời (để làm sau).
  - Một cảnh báo tiếng Anh vẫn lọt qua panel: "Captions were rendered at 608×1080…".
  - Còn lại cho Shorts:
  - Mỗi short có đúng khoảng thời gian không, và các short có chồng nhau không.
  - Bấm Hủy giữa chừng: các short đã xong phải giữ nguyên tên.
- [x] **Phụ đề tiếng Việt** (SRT): 3069 cue, mất 2 s, dòng ≤ 42 ký tự. File mặc định nằm trong `~/.premiere-mcp/renders`.
  - Còn lại: thử cả hai kiểu xuất SRT và track caption trên bản sao.
- [x] **Rough cut** (thư mục "1. Giải mã nỗi sợ mang tên Zona…", 2 video, mẫu thông số FINAL_01, đích 30 s, nhịp balanced):
  - Lỗi (đã sửa): Xem trước luôn thất bại vì chạy thử trên sequence mẫu đang có clip, và bước kiểm tra track V1 từ chối. Giờ chỉ khi chạy thử mới truyền `overwrite: true`; khi chạy thật vẫn là `false`, có test giữ điều này.
  - Chạy thật: tạo "… - rough cut" từ bản sao xóa trống của FINAL_01, 4 shot × 7,5 s = 30 s, đã xác minh, mất 13 s.
  - Chưa thử: chế độ có nhạc (cắt theo nhạc và hạ nhạc dưới thoại).
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
