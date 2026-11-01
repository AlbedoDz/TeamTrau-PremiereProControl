# TeamTrau PremiereProControl: cài đặt trên máy khác

Gói này cài một máy chủ MCP để Claude (hoặc Codex, VS Code Copilot) điều khiển Adobe Premiere Pro, cùng một bảng điều khiển cầu nối nằm trong Premiere. Cài trên **cùng một máy** với Premiere Pro và ứng dụng Claude.

## Cần chuẩn bị

| Thứ | Ghi chú |
|---|---|
| Adobe Premiere Pro 2020 trở lên | Đã thử trên 25.6.3 |
| Node.js 20 trở lên | https://nodejs.org (chọn bản LTS) |
| Windows 10/11 hoặc macOS | Linux không được hỗ trợ |
| ffmpeg và ffprobe (không bắt buộc) | Cần cho các tool cắt lặng, đo độ lớn, dựng thô, dựng theo nhạc. Các tool khác chạy không cần. Windows: `winget install --id Gyan.FFmpeg -e`. macOS: `brew install ffmpeg` |
| Kết nối mạng | Lúc cài, để tải thư viện |

## Cài đặt

### Windows

1. Giải nén gói này ra một thư mục (đừng chạy từ bên trong file zip).
2. Chuột phải **INSTALL-WINDOWS.cmd** và chọn Run as administrator nếu cửa sổ báo thiếu quyền, hoặc bấm đúp bình thường.
3. Đọc kết quả cuối cùng. Lệnh `--doctor` phải báo OK cho: server, cầu nối CEP, thư mục cầu nối, chế độ debug CEP.

### macOS

1. Giải nén gói, mở Terminal trong thư mục đó.
2. Chạy:

```bash
bash install-mac.command
```

Nếu `npm install -g` báo lỗi quyền, chạy lại phần cài với `sudo npm install -g ./*.tgz`, rồi `premiere-pro-mcp --install-cep`.

### Cài bằng tay (cả hai hệ điều hành)

```bash
npm install -g ./TeamTrau-PremiereProControl-1.4.0.tgz
premiere-pro-mcp --install-cep
premiere-pro-mcp --doctor
```

Bộ cài làm 3 việc: chép cầu nối vào thư mục extensions của Adobe, bật chế độ debug CEP (cần vì bảng cầu nối chưa ký số), và thêm mục `premiere-pro` vào cấu hình Claude Desktop (Windows: cả VS Code Copilot).

## Bật cầu nối trong Premiere (làm một lần)

1. **Khởi động lại Premiere Pro** nếu đang mở.
2. Mở `Window > Extensions > MCP Bridge (CEP)`.
3. Ô **Temp Directory** điền đúng đường dẫn bộ cài đã in ra (Windows mặc định: `%TEMP%\premiere-mcp-bridge`, macOS: `/tmp/premiere-mcp-bridge`).
4. Bấm **Save Configuration**, rồi **Start Bridge**, rồi **Test Connection**.

Phải mở một project trong Premiere thì các tool mới chạy được.

## Nối với ứng dụng Claude

### Claude Desktop

Bộ cài đã tự thêm cấu hình. Chỉ cần **thoát hẳn và mở lại Claude Desktop**, rồi hỏi:

> Chạy verify_premiere_connection. Không thay đổi gì.

### Claude Code

Bộ cài không cấu hình Claude Code. Thêm một lần, thay hai chỗ trong dấu `<>` bằng giá trị trên máy bạn (đường dẫn gốc npm lấy bằng `npm root -g`):

```bash
claude mcp add premiere-pro --scope user -e PREMIERE_TEMP_DIR="<Temp Directory ở bước trên>" -- node "<npm root -g>/adobe-premiere-pro-mcp/dist/index.js"
```

Sau đó mở phiên Claude Code mới. Dùng `search_tools` để tìm tool, ví dụ "beat" hay "rough cut".

### VS Code Copilot (Windows)

Bộ cài đã thêm mục vào `%APPDATA%\Code\User\mcp.json`. Khởi động lại VS Code.

## Các tool dựng video có trong bản này

Thêm so với bản gốc: `preflight_media`, `find_dead_segments`, `remove_silence_from_sequence`, `normalize_loudness`, `auto_duck_music`, `qa_sequence`, `apply_dialogue_chain`, `auto_punch_in`, `score_clips`, `assemble_rough_cut`, `analyze_music`, `assemble_beat_cut`.

- Mọi tool ghi vào timeline đều có `dryRun` (chỉ xem trước) và mặc định **tự sao lưu project** vào thư mục `premiere-mcp-backups` cạnh file project.
- Nên thử trên **bản sao** của sequence trước khi chạy trên bản thật.

## Kiểm tra sau khi cài

```bash
premiere-pro-mcp --version
premiere-pro-mcp --doctor
```

Hỏi Claude: *"Chạy get_capabilities rồi verify_premiere_connection"*. Kỳ vọng: 295 tool, `ffmpeg: true` nếu đã cài ffmpeg, và Premiere báo kết nối.

## Gỡ cài đặt

```bash
npm uninstall -g adobe-premiere-pro-mcp
```

Rồi xóa thư mục `MCPBridgeCEP` trong:
- Windows: `%APPDATA%\Adobe\CEP\extensions`
- macOS: `~/Library/Application Support/Adobe/CEP/extensions`

và xóa mục `premiere-pro` khỏi cấu hình Claude Desktop / VS Code / Claude Code (`claude mcp remove premiere-pro`).

## Sự cố thường gặp

| Triệu chứng | Cách xử lý |
|---|---|
| Không thấy `MCP Bridge (CEP)` trong menu Extensions | Khởi động lại Premiere. Chạy lại `premiere-pro-mcp --install-cep`. `--doctor` phải báo chế độ debug CEP là OK |
| Claude thấy server nhưng tool báo lỗi | Premiere chưa mở, chưa mở project, chưa bấm Start Bridge, hoặc Temp Directory trong bảng khác với `PREMIERE_TEMP_DIR` trong cấu hình |
| Chỉ thấy 283 tool, không thấy tool mới | Đang chạy bản cũ. Kiểm tra `premiere-pro-mcp --version` phải là 1.4.0. Đảm bảo không cài gói `adobe-premiere-pro-mcp` từ npm registry (đó là dự án gốc, không có các tool này). Mở phiên Claude mới |
| Tool báo `ffmpeg.not_found` | Cài ffmpeg (xem bảng chuẩn bị), mở lại cửa sổ terminal và ứng dụng Claude |
| `npm install -g` báo lỗi quyền (macOS/Linux) | Dùng `sudo`, hoặc cấu hình thư mục npm toàn cục theo hướng dẫn của npm |
| Sau khi sửa tool thấy kết quả cũ | Xóa cache: thư mục `.premiere-mcp/analysis` trong thư mục người dùng |

## Lưu ý

- Gói này **chưa ký số**: bảng cầu nối CEP chạy được nhờ bật chế độ debug. Chỉ cài từ nguồn bạn tin cậy.
- Mã nguồn: https://github.com/AlbedoDz/TeamTrau-PremiereProControl (giấy phép MIT, xây trên dự án Adobe_Premiere_Pro_MCP của hetpatel-11).
- Dữ liệu sử dụng ẩn danh được gửi mặc định. Tắt bằng cách bỏ chọn **Share anonymous usage data** trong bảng cầu nối, hoặc đặt `PREMIERE_MCP_TELEMETRY=0`.
