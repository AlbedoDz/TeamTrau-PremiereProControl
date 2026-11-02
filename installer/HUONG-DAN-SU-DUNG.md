# TeamTrau PremiereProControl: hướng dẫn sử dụng

Tài liệu này đi từ lúc kết nối Claude Code hoặc Antigravity với Premiere Pro, đến các ví dụ dựng thật: cắt video dài thành highlight, và tạo nhiều phiên bản (variation) từ cùng một nguồn. Cách cài đặt nằm trong `HUONG-DAN.md`.

## 1. Mô hình hoạt động

```
Agent (Claude Code / Antigravity)  ──MCP──>  premiere-pro (máy chủ MCP)  ──file──>  Cầu nối CEP trong Premiere Pro
                                                    │
                                                    └── ffmpeg + Python (nhận dạng giọng nói, phân tích) chạy trên máy bạn
```

- Agent không điều khiển Premiere trực tiếp. Nó gọi tool của máy chủ MCP; máy chủ gửi lệnh qua thư mục tạm `PREMIERE_TEMP_DIR` cho panel **TeamTrau PremiereProControl** trong Premiere.
- Vì vậy cần đủ ba thứ cùng lúc: Premiere đang mở **với một project**, panel đã bấm **Start Bridge**, và agent đã nạp máy chủ `premiere-pro`.
- Mọi phân tích (nhận giọng, im lặng, độ to, khuôn mặt) chạy cục bộ. Không có video nào bị gửi lên mạng, trừ nội dung hội thoại bạn nhắn cho agent.

## 2. Kết nối lần đầu

### 2.1. Bật cầu nối trong Premiere (làm một lần)

1. Mở Premiere Pro và một project (project trống cũng được).
2. `Window > Extensions > TeamTrau PremiereProControl`.
3. Bấm **Save Configuration**, **Start Bridge**, rồi **Test Connection**. Để nguyên ô Temp Directory.
4. Từ các lần sau, panel tự bật cầu nối khi Premiere mở panel đó. Để panel luôn mở: kéo nó vào một vùng làm việc cố định.

### 2.2. Kiểm tra agent đã được đăng ký

Bộ cài tự ghi mục `premiere-pro` vào các ứng dụng tìm thấy. Xem kết quả:

```bash
premiere-pro-mcp --clients-status
```

Mỗi dòng báo `unchanged` (đã có sẵn), `not-installed` (máy không có ứng dụng đó) hoặc `would-change` (chưa đăng ký). Gặp `would-change` thì chạy `premiere-pro-mcp --register-clients`. Sau đó **thoát hẳn rồi mở lại** ứng dụng AI, vì chúng chỉ đọc cấu hình lúc khởi động.

### 2.3. Claude Code

1. Mở terminal ở thư mục làm việc bất kỳ và chạy `claude`.
2. Gõ `/mcp`. Trong danh sách phải có `premiere-pro` ở trạng thái connected. Hoặc chạy ngoài phiên: `claude mcp get premiere-pro`.
3. Hỏi thử:

```text
Chạy verify_premiere_connection. Chỉ kiểm tra, không đổi gì trong project.
```

Kết quả đúng: báo Premiere đang chạy, cầu nối nối được, kèm tên project và sequence đang mở.

Mục được ghi ở phạm vi người dùng (`--scope user`), nên dùng được ở mọi thư mục.

### 2.4. Antigravity (desktop, CLI, IDE)

1. Bộ cài ghi vào `~\.gemini\config\mcp_config.json`. Tệp này dùng chung cho cả ba dạng Antigravity trên máy.
2. Thoát hẳn Antigravity rồi mở lại, mở phiên agent mới.
3. Trong phần quản lý MCP/tools của Antigravity, xác nhận có `premiere-pro`. Nếu giao diện không liệt kê, hỏi thẳng:

```text
Chạy verify_premiere_connection. Chỉ kiểm tra, không đổi gì trong project.
```

Nếu agent trả lời rằng không có tool này, mở `mcp_config.json` và kiểm tra có khối `premiere-pro` với `command` trỏ đến `...\node\node.exe`, rồi chạy lại `premiere-pro-mcp --register-clients`.

### 2.4b. Các ứng dụng khác

Codex, VS Code Copilot, Claude Desktop, opencode và DeepSeek Harness cũng được đăng ký tự động và dùng cùng quy trình bên dưới.

### 2.5. Khi `verify_premiere_connection` thất bại

Agent sẽ dừng và đọc cho bạn `nextStep`. Theo thứ tự:

| Triệu chứng | Việc cần làm |
|---|---|
| Premiere chưa chạy | Mở Premiere. Tool này có thể tự mở giúp nếu Premiere đã cài |
| Chưa thấy cầu nối | Mở panel TeamTrau PremiereProControl, bấm **Start Bridge** |
| Không có project nào mở | Mở hoặc tạo project |
| Vẫn lỗi | Bấm **Run Diagnostics** trong panel, gửi file `premiere-mcp-diagnostics-latest.json` trong thư mục tạm |

Đừng bảo agent "thử lại liên tục". Lỗi cầu nối phải được sửa ở phía Premiere.

## 3. Cách ra lệnh hiệu quả

Máy chủ chỉ liệt kê vài tool cố định; còn hơn 280 tool nằm trong danh mục tìm kiếm. Agent tự gọi `search_tools` rồi `invoke_tool`, bạn không cần nhớ tên. Bạn chỉ cần:

- **Nói kết quả mong muốn và ràng buộc**, không nói tên tool. Ví dụ: "Cắt 5 đoạn highlight 30–60 giây, mỗi đoạn một sequence riêng", chứ không phải "gọi build_short".
- **Yêu cầu bản xem trước trước khi sửa**: "Cho tôi xem kế hoạch trước, chưa thay đổi gì." Nhiều tool có chế độ `dryRun`.
- **Luôn làm việc trên bản sao.** Sequence gốc giữ nguyên làm chuẩn; agent tạo sequence mới có tên rõ ràng. Với thao tác lớn, tool tự lưu và sao lưu project vào thư mục `premiere-mcp-backups` cạnh file project.
- **Xuất file chỉ khi bạn bảo.** Agent không tự export. Bạn xem kết quả ngay trong Premiere rồi mới ra lệnh xuất.
- **Khi lỗi, yêu cầu báo nguyên văn.** Tool trả `success: false` kèm lý do; agent phải đưa lý do đó cho bạn, không đoán.

## 4. Chuẩn bị nguồn

Mọi ví dụ dưới đây bắt đầu bằng một sequence chứa video nguồn.

```text
Import file D:\Podcast\Tap12.mp4 vào project, rồi tạo một sequence tên "Tap12_Master"
từ clip đó. Sau đó cho tôi biết độ dài, khung hình và số track âm thanh.
```

Agent sẽ dùng `import_media` và `create_sequence_from_clips` (cách này tránh hộp thoại tạo sequence của Premiere, thứ làm treo cầu nối). Nếu video nhiều máy quay đã dựng thành một timeline thì dùng thẳng sequence đó.

Với phần nhận dạng giọng nói, máy cần bản cài mặc định (Zipformer-68M, đã đóng sẵn). Kiểm tra: `premiere-pro-mcp asr-status`. Muốn có dấu câu và độ chính xác cao hơn thì tải Whisper (mục 8).

## 5. Ví dụ A: cắt video dài thành các highlight dọc 9:16

Phù hợp: podcast, phỏng vấn, talkshow 20–90 phút đã dựng xong, có hội thoại. Quy trình có **ba điểm duyệt**, bạn quyết định ở từng điểm.

### Bước 1. Nhận dạng giọng nói

```text
Tôi muốn cắt highlight từ sequence "Tap12_Master". Trước hết hãy phiên âm.
Từ riêng cần viết đúng: Trưng Trắc, Vietcetera, TeamTrau, AI.
Âm thanh thoại nằm ở track âm thanh 1 và 2.
```

- Agent hỏi hoặc nhận danh sách từ riêng (tên người, thương hiệu, thuật ngữ) để chép đúng chính tả.
- Chạy nền: lần gọi đầu trả `status: running` kèm tiến độ; agent hỏi lại cho đến khi `done`. Tập 9 phút mất khoảng 22 giây trên CPU với Zipformer-68M.
- Phiên âm được lưu đệm theo từng file nguồn. Chạy lại cho cùng nguồn gần như tức thì.

### Bước 2. Tìm ứng viên và duyệt lần 1

```text
Tìm các đoạn highlight dài 30–75 giây, lấy tối đa 12 ứng viên.
Chấm điểm theo: mở đầu gây tò mò trong 3 giây đầu, có kết luận rõ,
nghe độc lập không cần ngữ cảnh trước đó, kết thúc trọn câu.
Liệt kê cho tôi xem kèm thời điểm, thời lượng, trích đoạn lời và lý do chọn.
Chưa tạo gì cả.
```

Agent lấy ứng viên từ `find_highlight_candidates`, mỗi cái kèm tín hiệu: tốc độ nói, độ to tương đối, có câu hỏi/cảm thán, tỉ lệ từ đệm ("ờ", "à", "kiểu"), khoảng lặng dài nhất. Việc **chấm điểm theo tiêu chí biên tập là của agent**; điểm thô của máy chủ chỉ dùng để lọc.

Nếu cảnh quay có hai người chung khung rộng, thêm: "Bật phát hiện khuôn mặt" để máy đánh dấu các cảnh nhiều người. Tính năng này tốn thêm thời gian vì phải giải mã hình.

Bạn chọn bằng cách trả lời, ví dụ: "Lấy số 2, 5, 7. Đặt tên Short_01_..., theo thứ tự đó. Kiểu phụ đề pop."

### Bước 3. Xem kế hoạch phụ đề (duyệt lần 2)

```text
Chạy thử (dryRun) cho đoạn số 2 và cho tôi xem cách chia phụ đề.
```

Mỗi nhóm phụ đề tối đa 3 từ hoặc 18 ký tự, ngắt theo dấu câu hoặc khoảng lặng. Bạn sửa chính tả, viết hoa, bỏ cụm không muốn. Ví dụ: *"Nhóm 4 sửa thành 'GPT-5', xóa nhóm 9."* Agent đưa danh sách đã sửa vào lệnh thật.

Ba kiểu phụ đề:

| Kiểu | Hiệu ứng |
|---|---|
| `clean` (mặc định) | Chữ trắng viền đen, từ đang nói tô vàng |
| `pop` | Chữ in hoa, từ đang nói phóng to nhẹ |
| `karaoke` | Cả cụm hiện sẵn, màu quét theo từng từ |

### Bước 4. Dựng thật

```text
Dựng Short_01_AI_va_cong_viec với phụ đề pop, âm lượng chuẩn -14 LUFS.
```

Với mỗi short, công cụ làm lần lượt:

1. Dựng sẵn video phụ đề nền trong suốt (ProRes 4444) đúng kích thước khung dọc. Lỗi ở bước này thì dừng trước khi đụng vào project.
2. Lưu project và sao lưu.
3. Cắt đúng đoạn khỏi sequence gốc, chạy Auto Reframe sang 9:16, đặt tên sequence.
4. Nhập phụ đề vào bin `Shorts/<tên>` và đặt lên track trên cùng.
5. Chuẩn hoá âm lượng, chạy kiểm tra chất lượng (khung hình chớp, khoảng trống, media offline).
6. Đọc lại để xác nhận: tỉ lệ 9:16, độ dài khớp trong ±1 khung, có phụ đề (`verified: true`).

### Bước 5. Duyệt lần 3

Mở các sequence mới trong Premiere. Nơi nào máy đánh dấu "Cảnh nhiều người — kiểm tra khung reframe" thì kiểm tra xem người nói có bị cắt khỏi khung không và chỉnh tay Auto Reframe nếu cần.

Nếu một bước trong Premiere lỗi, agent phải báo bước nào lỗi (`failedStep`), sequence dở dang được giữ để bạn xem, và đường dẫn bản sao lưu để quay lại.

### Gợi ý một lệnh gọn

Khi đã quen, ra lệnh cả chuỗi mà vẫn giữ ba điểm duyệt:

```text
Với "Tap12_Master": phiên âm (từ riêng: Trưng Trắc, TeamTrau), tìm 8 highlight 30–60 giây,
chấm điểm rồi dừng lại cho tôi chọn. Sau khi tôi chọn, chạy thử phụ đề và dừng để tôi sửa,
rồi mới dựng thật.
```

## 6. Ví dụ B: cắt thành nhiều phiên bản (variation)

Một nguồn, nhiều đầu ra. Bốn kiểu hay dùng; kiểu nào cũng nên bắt đầu bằng: *"Làm việc trên bản sao, giữ nguyên sequence gốc."*

### B1. Nhiều short từ cùng một tập (khác đoạn)

Đây là ví dụ A, lặp cho nhiều ứng viên. Lệnh mẫu:

```text
Dựng cả 5 đoạn đã chọn thành 5 sequence riêng: Short_01 đến Short_05, cùng phụ đề clean,
cùng -14 LUFS. Chạy lần lượt; sau mỗi cái báo verified hay không rồi mới làm cái tiếp theo.
```

Phiên âm và danh sách ứng viên dùng lại cho cả lô. Nếu bạn sửa sequence gốc giữa chừng, dấu vân sequence đổi và lệnh dựng sẽ từ chối với thông báo phải phiên âm lại: đó là chủ ý, để tránh cắt sai thời điểm.

### B2. Cùng một đoạn, nhiều phong cách

Thử cùng một nội dung với các kiểu phụ đề khác nhau để chọn bản hợp kênh:

```text
Đoạn số 2 tạo thành ba bản: Short_02_clean, Short_02_pop, Short_02_karaoke.
Giữ nguyên mọi thứ khác.
```

### B3. Nhiều độ dài cho nhiều nền tảng

```text
Từ "Tap12_Master", làm ba bản của cùng một ý chính:
- bản 30 giây cho Reels (chọn đoạn ngắn nhất vẫn trọn ý),
- bản 60 giây cho TikTok và Shorts,
- bản 90 giây cho Facebook.
Nếu không có ứng viên vừa đủ độ dài, nói rõ thay vì cắt cụt giữa câu.
```

Agent dùng `minSec`/`maxSec` khác nhau cho từng lần tìm ứng viên rồi dựng từng bản. Quy tắc cố định: không bao giờ cắt giữa câu.

### B4. Bản ngang 16:9 dựng lại (teaser, bản rút gọn)

Khi muốn giữ khung ngang, không cần Auto Reframe. Đây là dựng lại trên sequence mới thay vì cắt đi cắt lại:

```text
Làm bản rút gọn 3 phút của "Tap12_Master" giữ khung 16:9:
1. Tạo sequence rỗng "Tap12_Rut_gon" cùng thiết lập với bản gốc.
2. Chọn các đoạn hay nhất theo phiên âm sao cho tổng khoảng 3 phút,
   giữ nguyên thứ tự thời gian, mỗi đoạn kết trọn câu.
3. Đặt tất cả vào sequence mới bằng một lần gọi, rồi kiểm tra chất lượng.
Cho tôi xem danh sách đoạn sẽ dùng trước khi đặt.
```

Phía sau, agent dùng `duplicate_sequence` (đặt `clearContents`) để có sequence rỗng cùng khung hình và frame rate, rồi `add_to_timeline_batch` đặt mọi đoạn bằng một lần gọi với `sourceInPoint`/`sourceOutPoint`, rồi `qa_sequence`. Cách này nhanh hơn nhiều so với razor và xóa gợn từng chỗ: một phiên thực tế từng tốn 96 lệnh cho việc chỉ cần khoảng 7.

Ra các phiên bản khác nhau bằng cách đổi tiêu chí chọn: "bản tập trung câu chuyện", "bản tập trung tranh luận", "bản chỉ có tiếng cười và phản ứng".

### B5. Cắt tiếng im và từ đệm cho bản làm sạch

```text
Nhân bản "Tap12_Master" thành "Tap12_Sach". Trên bản sao, cắt các khoảng lặng dài hơn 0,6 giây
(giữ 0,15 giây ở mỗi đầu để không cụt chữ). Chạy thử và cho tôi xem số đoạn bị cắt và tổng
thời gian bớt đi trước khi áp dụng.
```

`remove_silence_from_sequence` chỉ cắt chỗ mọi track thoại đều im, không cắt đoạn chỉ có hình, rồi kiểm tra độ dài mới và báo nếu các track bị lệch. Tool bỏ qua clip có đổi tốc độ.

## 7. Một số việc dựng thường dùng khác

| Mục tiêu | Câu lệnh mẫu |
|---|---|
| Dựng rough cut từ nhiều clip | "Từ bin Footage dựng bản 60 giây, mỗi cảnh khoảng 3 giây, tối đa 2 cảnh một file, ưu tiên cảnh đẹp nhất. Cho xem kế hoạch trước." |
| Phụ đề cho cả tập | "Tạo track phụ đề gốc cho toàn bộ Tap12_Master từ bản phiên âm, chạy thử xem số dòng rồi mới tạo." |
| Chuẩn âm lượng | "Chuẩn âm lượng sequence này về -14 LUFS cho mạng xã hội. Đo trước, chưa áp dụng." |
| Làm sạch tiếng | "Khử ồn và nén động âm thanh thoại, chuẩn về -16 LUFS." |
| Nhạc nền hạ khi có thoại | "Đặt nhạc nền và tự hạ nhỏ khi có người nói ở track 1 và 2." |
| B-roll phủ lời | "Phủ B-roll lên đoạn kể chuyện: mỗi cảnh tối đa 6 giây, tránh clip đã dùng, bỏ 0,6 giây đầu và cuối mỗi cảnh, sau đó xuất một khung giữa từng cảnh để kiểm tra mờ hoặc bị che." |
| Kiểm tra trước khi giao | "Chạy kiểm tra chất lượng cho sequence này: khung chớp, khoảng trống, media mất." |

## 8. Tải thêm công cụ khi cần

Agent không bao giờ tự tải model. Khi cần engine khác, nó báo dung lượng và giấy phép rồi đưa lệnh cho bạn chạy:

| Engine | Dung lượng | Khi nào dùng |
|---|---|---|
| `zipformer-68m` (đã có) | khoảng 80 MB | Mặc định. Nhanh trên CPU, không có dấu câu |
| `whisper-turbo` | 1,6 GB (+ khoảng 2 GB CUDA nếu có GPU NVIDIA) | Cần dấu câu, chính xác hơn. Nên có GPU |
| `zipformer-30m` | khoảng 30 MB | Nhỏ hơn, chất lượng thấp hơn. Chỉ phi thương mại |

```bash
premiere-pro-mcp --setup-asr --engine whisper-turbo
```

Chọn engine cho mỗi phiên làm việc: "Dùng whisper-turbo để phiên âm", và dùng cùng engine cho mọi bước (phiên âm, tìm highlight, dựng).

## 9. Xử lý sự cố khi dựng

| Triệu chứng | Nguyên nhân và cách xử lý |
|---|---|
| `asr.not_installed` | Môi trường Python chưa dựng. Chạy `premiere-pro-mcp --setup-asr` |
| `asr.engine_not_installed` | Engine được chọn chưa tải. Chạy lệnh mà thông báo đưa ra |
| "The sequence changed since it was transcribed" | Sequence đã đổi sau khi phiên âm. Phiên âm và tìm ứng viên lại, rồi chọn lại |
| `ffmpeg.not_found` | Bộ cài đã kèm ffmpeg ở thư mục `ffmpeg\bin`. Nếu vẫn báo, chạy `premiere-pro-mcp asr-status` xem trường `ffmpeg` |
| Tool timeout hoặc lỗi cầu nối | Panel đã dừng hoặc Premiere đang hiện hộp thoại. Đóng hộp thoại, bấm Start Bridge lại, rồi chạy `verify_premiere_connection` |
| Khung dọc cắt mất mặt người | Bật phát hiện khuôn mặt, kiểm tra các marker "Cảnh nhiều người", chỉnh tay Auto Reframe |
| Kết quả xong trong Premiere nhưng tool báo lỗi | Đừng chạy lại ngay: nhờ agent liệt kê sequence để kiểm tra trạng thái thật rồi mới quyết định |

## 10. Ghi nhớ

- Mở Premiere và một project, bật cầu nối, rồi `verify_premiere_connection`.
- Làm trên bản sao. Xem kế hoạch (`dryRun`) trước khi áp dụng.
- Quyết định xong rồi mới ghi: tính hết đoạn cần giữ rồi đặt một lần, đừng cắt từng nhát.
- Dựng highlight có ba điểm duyệt: chọn đoạn, sửa phụ đề, kiểm tra khung dọc.
- Agent không tự xuất file và không tự tải model.
