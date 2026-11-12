# Panel GUI 1.5.0: chạy thật và hai bài thử

Nhánh `feature/panel-gui`, worktree `.worktrees/panel-gui`. Ghi kết quả thẳng vào file này. Chưa merge cho tới khi các mục dưới đây được kiểm.

## 0. Chuẩn bị
- [ ] Mở một project **nháp**, không dùng project đang làm thật. Project phải được lưu ít nhất một lần, vì tool sao lưu trước khi sửa.
- [ ] Lưu ý: cài panel từ worktree (`node dist/cli.js --install-cep` rồi `--register-panel-runner`) sẽ **ghi đè panel 1.4.0 đang cài**. Muốn quay về bản cũ thì chạy lại Setup.exe 1.4.0.
- [ ] Mở lại Premiere, mở `Window > Extensions > TeamTrau PremiereProControl`. Panel phải có hai tab **Quy trình** và **Kết nối**.

## 1. Spike 1: ASR có giữ "ờ/ừm" không (quyết định có cần phát hiện bằng âm thanh)
- [ ] Chọn một đoạn voice khoảng 2 phút có "ờ/ừm" thật. Chạy `transcribe_sequence`.
- [ ] Số từ ngập ngừng nghe được: ___ · Số có trong transcript: ___ · Tỉ lệ: ___
- [ ] Nếu tỉ lệ dưới 0,7 thì cần thêm cách phát hiện bằng âm thanh (spec §5.2), theo ruling R1.

## 2. Spike 2: J-cut
- [ ] Trên một sequence nháp có 2 clip liền nhau: bỏ liên kết clip thứ hai, kéo audio của nó sớm hơn 0,5 s, cắt đuôi audio clip trước, rồi đọc lại vị trí. Làm 5 lần.
- [ ] Kết quả: ___ / 5 lần lệch không quá 1 frame. Nếu đạt cả 5 lần thì bật J-cut trong `build_recap`, thay cho `JCUT_SUPPORTED = false`.

## 3. Năm quy trình chạy từ panel, không mở client AI nào
Với mỗi quy trình, ghi lại: Xem trước có đúng không, thời gian chạy, các số trong `summary`, cảnh báo, và kết quả có đúng không.
- [ ] **Dọn voice-over:**
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
