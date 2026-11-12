# Panel GUI 1.5.0: chạy thật và hai bài thử

Nhánh `feature/panel-gui`, worktree `.worktrees/panel-gui`. Ghi kết quả thẳng vào file này. Chưa merge cho tới khi các mục dưới đây được kiểm.

## 0. Chuẩn bị
- [ ] Mở một project **nháp**, không dùng project đang làm thật. Project phải được lưu ít nhất một lần, vì tool sao lưu trước khi sửa.
- [ ] Lưu ý: cài panel từ worktree (`node dist/cli.js --install-cep` rồi `--register-panel-runner`) sẽ **ghi đè panel 1.4.0 đang cài**. Muốn quay về bản cũ thì chạy lại Setup.exe 1.4.0.
- [ ] Mở lại Premiere, mở `Window > Extensions > TeamTrau PremiereProControl`. Panel phải có hai tab **Quy trình** và **Kết nối**.

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
  - Việc còn lại cho Dọn voice-over:
  - Xem trước có liệt kê vết cắt kèm lý do và câu gốc không.
  - Sau khi chạy: crossfade **có thật trên từng vết cắt không** (ruling R4), và nghe có tiếng "tách" ở mối nối không.
  - Câu chứa "chẳng", "ạ", "nhé" có còn nguyên không.
- [ ] **Recap 16:9** và **Recap 9:16:**
  - Bản 9:16 có đủ độ dài không, kể cả khi sequence gốc có điểm In/Out.
  - Sequence trung gian "(16:9)" có bị xóa không.
  - Phụ đề có nằm trong vùng an toàn không.
- [ ] **Podcast → Shorts** (3 short):
  - Mỗi short có đúng khoảng thời gian không, và các short có chồng nhau không.
  - Bấm Hủy giữa chừng: các short đã xong phải giữ nguyên tên.
- [ ] **Phụ đề tiếng Việt:** thử cả hai kiểu xuất SRT và track caption trên bản sao.
- [ ] **Rough cut và Cắt theo nhạc:**
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
