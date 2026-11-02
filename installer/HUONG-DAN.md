# TeamTrau PremiereProControl: bộ cài Windows

Bộ cài này đã gồm sẵn mọi thứ: máy chủ MCP, Node, ffmpeg bản đầy đủ, Python, các thư viện phân tích, model Zipformer-68M, VAD, nhận diện khuôn mặt và cầu nối cho Premiere Pro. Không cần cài Node, ffmpeg hay Python riêng, và cài đặt không cần Internet.

## Cài đặt

1. Chạy `TeamTrau-PremiereProControl-<phiên bản>-Setup.exe`. Không cần quyền quản trị.
2. Nếu Windows SmartScreen báo "Unknown publisher", bấm **More info**, rồi **Run anyway** (bộ cài chưa ký mã số).
3. Muốn dùng Whisper large-v3-turbo thì tích ô **Tải thêm Whisper** (khoảng 1,6 GB, cần Internet; máy có GPU NVIDIA sẽ tải thêm CUDA khoảng 2 GB). Có thể tải sau.
4. Sau khi cài xong, **khởi động lại Premiere Pro và các ứng dụng AI** đang mở.

Bộ cài tự thêm mục `premiere-pro` vào những ứng dụng tìm thấy trên máy: Claude Desktop, Claude Code, Codex, VS Code Copilot, Antigravity (desktop, CLI, IDE), opencode (CLI, desktop) và DeepSeek Harness. Mỗi file cấu hình được sao lưu một lần thành `*.bak-premiere` trước khi sửa.

Cách dùng với Claude Code, Antigravity và các ví dụ dựng (highlight, nhiều phiên bản) nằm trong `HUONG-DAN-SU-DUNG.md`.

## Bật cầu nối trong Premiere (một lần)

1. Mở `Window > Extensions > TeamTrau PremiereProControl`.
2. Bấm **Save Configuration**, **Start Bridge**, rồi **Test Connection**. Ô **Temp Directory** để mặc định.
3. Phải mở một project trong Premiere thì các tool mới chạy.

Hỏi AI: *"Chạy verify_premiere_connection, không thay đổi gì."*

## Tải thêm sau này

- Start Menu > TeamTrau > **Tải thêm Whisper và CUDA**, hoặc chạy trong terminal mới:

```bash
premiere-pro-mcp --setup-asr --engine whisper-turbo
premiere-pro-mcp --setup-asr --engine zipformer-30m
```

Lệnh luôn hỏi trước khi tải và cho biết dung lượng. CUDA chỉ được cài khi máy có GPU NVIDIA. Danh sách engine: `premiere-pro-mcp --help`.

## Kiểm tra và đăng ký lại

```bash
premiere-pro-mcp --clients-status
premiere-pro-mcp --register-clients
premiere-pro-mcp asr-status
```

Cài thêm một ứng dụng AI sau này thì chạy lại `premiere-pro-mcp --register-clients`.

## Gỡ cài đặt

Settings > Apps > TeamTrau PremiereProControl > Uninstall. Việc này gỡ mục `premiere-pro` khỏi các ứng dụng AI, xóa cầu nối khỏi Premiere và xóa môi trường Python. Model đã tải ở `%USERPROFILE%\.premiere-mcp\models` được giữ lại.

## Sự cố thường gặp

| Triệu chứng | Cách xử lý |
|---|---|
| Không thấy panel trong Premiere | Khởi động lại Premiere. Xem `install.log` trong thư mục cài (`%LOCALAPPDATA%\TeamTrau\PremiereProControl`) |
| Bộ cài báo một bước lỗi | Mở `install.log`, sửa theo thông báo, rồi chạy lại `post-install.cmd` trong thư mục cài |
| Tool báo thiếu engine | Chạy lệnh `--setup-asr --engine ...` ở trên |
| Ứng dụng AI không thấy tool | Thoát hẳn rồi mở lại ứng dụng. Chạy `premiere-pro-mcp --clients-status` |

## Lưu ý

- Gói chỉ dùng cho mục đích **phi thương mại**. Giấy phép các thành phần nằm trong `THIRD-PARTY-NOTICES.txt`.
- Cầu nối CEP chưa ký số: bộ cài bật chế độ debug CEP cho người dùng hiện tại. Chỉ cài từ nguồn bạn tin cậy.
- Dữ liệu sử dụng ẩn danh được gửi mặc định. Tắt bằng biến môi trường `PREMIERE_MCP_TELEMETRY=0`.
