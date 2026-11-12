# Mẫu phụ đề và thông số theo khung hình — Design

Ngày: 2026-11-12 · Trạng thái: chờ duyệt · Nền: `feature/panel-gui` (`ff70801`)

## 1. Mục tiêu

Phụ đề cháy vào hình (Shorts, Recap) hiện chỉ có 3 kiểu clean / pop / karaoke, cùng một font, và luôn gom 3 từ / 18 ký tự mỗi cụm, bất kể khung hình. SRT luôn 42 ký tự/dòng. Recap chỉ xuất 16:9 hoặc 9:16, Shorts chỉ 9:16.

Spec này làm bốn việc:

1. Thêm 2 mẫu mới: **highlight** và **minimal**. Tổng cộng 5 mẫu.
2. Thêm 3 tuỳ chỉnh dùng chung: **màu nhấn**, **vị trí** (dưới / giữa), **cỡ chữ** (nhỏ / vừa / lớn).
3. **Số từ, số ký tự và cỡ chữ tự khớp với khung thật của sequence**: chữ cháy vào hình theo bảng ở mục 3, SRT cũng vậy.
4. Recap và Shorts **xuất thêm khung 1:1 và 4:5** bằng Auto Reframe.

Panel có ảnh xem trước của mẫu, vẽ bằng chính bộ vẽ phụ đề, đúng khung và tuỳ chỉnh đang chọn.

Thành công khi:

- Trên panel, chọn mẫu, màu, vị trí, cỡ hoặc khung thì ảnh xem trước đổi theo, và short hoặc recap dựng ra trông đúng như ảnh đó.
- Phụ đề không bao giờ tràn ra ngoài vùng an toàn ở mọi khung: 9:16, 4:5, 1:1, 5:4, 4:3 và 16:9.
- SRT để "Tự động" thì số ký tự/dòng theo khung sequence, và kết quả có báo con số đã dùng.
- Mọi lời gọi cũ (clean / pop / karaoke, không truyền tuỳ chỉnh, shorts 9:16) cho ra kết quả giống hệt hiện nay.

## 2. Quyết định đã chốt

| Chủ đề | Quyết định | Lý do |
|---|---|---|
| Phạm vi | Chữ cháy vào hình: mẫu, tuỳ chỉnh và thông số theo khung. SRT / track phụ đề Premiere: chỉ ký tự/dòng và số dòng theo khung | Do người dùng chọn. Script Premiere không điều khiển được kiểu chữ của caption track |
| Mẫu mới | highlight, minimal | Do người dùng chọn |
| Xem trước | Ảnh thật vẽ bằng bộ vẽ phụ đề (hướng 1) | Khớp tuyệt đối với kết quả. Mẫu chỉ định nghĩa ở một chỗ |
| Nơi định nghĩa mẫu | Chỉ ở TypeScript (`caption-looks.ts`). Python nhận thông số đã tính sẵn | Không có hai bản sao lệch nhau |
| Khung xuất | Recap: 16:9, 9:16, 1:1, 4:5. Shorts: 9:16 (mặc định), 1:1, 4:5 | Do người dùng chọn. `autoReframeSequence(num, den, …)` nhận tỉ lệ bất kỳ |
| Khung 5:4 / 4:3 | Không thêm làm khung xuất; được phụ đề tự khớp khi sequence có khung đó | Thường là footage nguồn, không phải khung đăng mạng xã hội |
| Hướng loại bỏ | Caption style / MOGRT của Premiere | Không điều khiển được bằng script, không có hiệu ứng theo từng từ |

## 3. Mẫu, tuỳ chỉnh và bảng khung

### 3.1 Năm mẫu

Kích thước tính theo `em` (bằng cỡ chữ) để đúng ở mọi khung.

| Mẫu | Font | Chữ | Từ đang đọc | Màu nhấn mặc định |
|---|---|---|---|---|
| `clean` | Be Vietnam Pro Bold | trắng, viền đen (6 px ở 1920, như hiện nay) | đổi sang màu nhấn | `#FFD400` |
| `pop` | Bold, CHỮ HOA | như clean | màu nhấn, phóng 1.0 → 1.15 → 1.0 trong 120 ms | `#FFD400` |
| `karaoke` | Bold | như clean, cả cụm hiện | màu nhấn | `#FFD400` |
| `highlight` | Be Vietnam Pro ExtraBold | trắng, viền đen 0.04 em | chữ trắng trên nền bo góc màu nhấn (đệm 0.18 em ngang, 0.08 em dọc, bo 0.22 em) | `#FF3B5C` |
| `minimal` | Bold, cỡ 0.85 lần | trắng, không viền, bóng đen 70% (lệch 0.06 em, mờ 0.12 em) | không đổi | không dùng |

Ba mẫu `clean`, `pop`, `karaoke` giữ đúng hình vẽ hiện tại. Đây là điều kiện tương thích ở mục 1.

### 3.2 Tuỳ chỉnh

- **Màu nhấn** (`captionAccent`): mã hex `#RRGGBB`. Panel có 5 ô màu: `#FFD400` vàng, `#FF3B5C` đỏ hồng, `#22D3EE` xanh lơ, `#4ADE80` xanh lá, `#A855F7` tím. Ngoài ra có một ô để nhập hex. Bỏ trống thì dùng màu mặc định của mẫu.
- **Vị trí** (`captionPosition`): `bottom` (mặc định) hoặc `middle`.
  - `bottom`: dòng cuối nằm trên mép dưới vùng an toàn, như hiện nay.
  - `middle`: tâm khối chữ nằm ở 60% chiều cao khung, vẫn kẹp trong vùng an toàn.
- **Cỡ chữ** (`captionSize`): `small` 0.85 lần, `medium` 1 lần (mặc định), `large` 1.2 lần cỡ chữ của hàng khung. Giới hạn ký tự mỗi cụm chia cho cùng hệ số rồi làm tròn xuống. Giới hạn từ không đổi.

### 3.3 Bảng khung

`layoutFor(width, height)` lấy hàng có tỉ lệ `width / height` gần nhất (so trên thang log).

| Hàng | Tỉ lệ | Cỡ chữ (% chiều cao) | Cụm (từ / ký tự) | Cụm minimal | SRT ký tự × dòng | Vùng an toàn (trên / dưới / hai bên) |
|---|---|---|---|---|---|---|
| 9:16 | 0.5625 | 3.75% | 3 / 18 | 6 / 32 | 22 × 2 | 13.0% / 18.2% / 7.4% (như hiện nay) |
| 4:5 | 0.8 | 4.0% | 4 / 22 | 7 / 36 | 28 × 2 | 10% / 12% / 6% |
| 1:1 | 1.0 | 4.2% | 4 / 24 | 7 / 40 | 30 × 2 | 10% / 12% / 6% |
| 5:4, 4:3 | 1.29 | 4.5% | 5 / 28 | 8 / 46 | 37 × 2 | 8% / 8% / 5% |
| 16:9 | 1.78 | 5.0% | 5 / 32 | 2 dòng × 42 (cụm tối đa 84 ký tự, 14 từ) | 42 × 2 | 8% / 8% / 5% |

- Hàng 9:16 giữ nguyên thông số shorts đang dùng: 72 px ở 1920, 3 từ / 18 ký tự.
- Bộ vẽ vẫn ngắt dòng theo độ rộng pixel đo thật và tối đa 2 dòng. Bảng chỉ quyết định cách gom từ thành cụm, nên chữ không tràn lề kể cả với từ dài.

## 4. Thành phần

### 4.1 `src/analysis/caption-looks.ts` (mới, hàm thuần)

- `CAPTION_STYLES`: định nghĩa 5 mẫu như mục 3.1.
- `CAPTION_LAYOUTS`: bảng ở mục 3.3.
- `ACCENT_SWATCHES`: 5 màu ở mục 3.2.
- `layoutFor(width, height)` → một hàng của bảng.
- `resolveLook(style, { accent?, position?, size? }, width, height)` → `{ look, grouping }`:
  - `look`: thông số vẽ đã tính sẵn. Gồm `font` (tên file), `sizePx`, `uppercase`, `textColor`, `accentColor`, `stroke` `{ widthPx, color }` hoặc null, `shadow` `{ dxPx, dyPx, blurPx, color }` hoặc null, `active` (`'color' | 'pop' | 'pill' | 'none'`), `pill` `{ padXPx, padYPx, radiusPx }` hoặc null, `karaoke` (boolean), `position`, `safeArea`.
  - `grouping`: `{ maxWords, maxChars }`.
- `subtitleLineLimits(width, height)` → `{ maxCharsPerLine, maxLines }` cho SRT.
- Kiểm tra đầu vào: style không có trong danh sách, hoặc accent không khớp `^#[0-9A-Fa-f]{6}$`, thì báo lỗi bằng tiếng Anh, theo cách các tool khác đang làm. Panel dịch sang tiếng Việt.

### 4.2 Bộ vẽ Python `python/premiere_mcp_sidecar/captions.py`

- `render(spec)`: nếu spec có `look` thì vẽ theo `look`. Nếu không có, dựng `look` từ `style` theo đúng thông số hiện tại, để spec cũ cho ra cùng hình.
- Phần vẽ hỗ trợ thêm:
  - bóng đổ mờ: một lớp chữ đen, `GaussianBlur`, ghép dưới lớp chữ;
  - nền bo góc cho từ đang đọc: `rounded_rectangle` vẽ trên lớp riêng, dưới chữ;
  - vị trí giữa khung;
  - viền có thể bỏ (`stroke` null);
  - màu chữ và màu nhấn lấy từ `look`.
- Lệnh mới `caption_preview`: vào `{ look, width, height, text, activeIndex, outPath }`, ra một PNG.
  - Nền là ảnh xám chuyển màu từ `#3a3f47` tới `#9aa3ad`, để thấy rõ viền và bóng.
  - Câu mẫu mặc định: "Xin chào các bạn, hôm nay mình kể chuyện". Câu được gom cụm theo `grouping`, chỉ vẽ cụm đầu tiên, từ thứ hai là từ đang đọc.
  - Ghi vào `__main__.COMMANDS`.

### 4.3 Tool mới `preview_caption_style` (catalog, nhóm captions)

- Tham số:
  - `style`;
  - `captionAccent?`, `captionPosition?`, `captionSize?`;
  - `aspect?` (`'16:9' | '9:16' | '1:1' | '4:5'`, mặc định `'9:16'`) hoặc `width` và `height`;
  - `text?`.
- Kích thước ảnh: cạnh dài 960 px, cạnh ngắn theo tỉ lệ.
- Ảnh lưu ở `<premiere-mcp home>/renders/previews/<sha1 của tham số>.png`. Nếu file đã có thì trả về ngay, không gọi sidecar.
- Trả về `{ success, path, width, height, grouping }`.
- Thiếu sidecar: trả về `sidecarMissingResult` như các tool hiện có.
- Số tool: catalog +1. Cập nhật các test đếm số tool.

### 4.4 Đường dựng

- `groupCaptions(words, offset, maxWords, maxChars)`: giữ nguyên chữ ký hàm. Bên gọi truyền `grouping` từ `resolveLook` thay cho giá trị mặc định.
- `renderCaptionFile` và `addAlphaCaptions`: nhận `CaptionOptions = { style, accent?, position?, size? }`. Kích thước lấy từ khung sequence (probe như hiện nay), rồi gọi `resolveLook`. Spec gửi sidecar có `look`, còn `safeArea` lấy từ `look`.
- `build_short`, `build_recap`, `workflow_shorts`, `workflow_recap`:
  - `captionStyle` thêm `highlight` và `minimal`;
  - thêm `captionAccent`, `captionPosition`, `captionSize` (không bắt buộc);
  - `workflow_shorts` và `build_short` thêm `aspect` (`'9:16' | '1:1' | '4:5'`, mặc định `'9:16'`);
  - `workflow_recap` và `build_recap`: `aspect` thêm `'1:1'` và `'4:5'`. Riêng `'16:9'` giữ nguyên sequence gốc, không reframe, như hiện nay.
- `reframeToVertical(ctx, id, name, range?)` đổi thành `reframeTo(ctx, id, name, ratio, range?)`. Ratio là `{ num, den }`, script gọi `autoReframeSequence(num, den, …)`.
- Kiểm tra sau khi dựng: `|w − round(h × num / den)| ≤ 1` thay cho phép so cố định 9:16. Câu cảnh báo nêu khung đã chọn.

### 4.5 SRT (`workflow_subtitles`, `create_captions_from_transcript`)

- `maxCharsPerLine` không bắt buộc nữa và không còn mặc định 42.
  - Bỏ trống: tool đọc khung sequence, rồi `subtitleLineLimits` cho ra `maxCharsPerLine` và `maxLines`.
  - Nhập số: dùng đúng số đó, `maxLines` = 2.
  - Không đọc được khung: dùng 42 × 2, kèm cảnh báo.
- Kết quả có `lineLimits: { maxCharsPerLine, maxLines, layout }`. Panel hiện dòng "22 ký tự/dòng (khung 9:16)".

### 4.6 Panel (`cep-plugin/gui`)

- Kiểu field mới `caption` trong `workflows.json`, dùng cho thẻ Shorts và Recap. Một field gồm:
  - danh sách mẫu (5 tên tiếng Việt: Gọn, Nổi bật, Karaoke, Tô nền từ, Tối giản; Recap có thêm "Không phụ đề");
  - ảnh xem trước;
  - 5 ô màu và ô hex;
  - Vị trí (Dưới / Giữa);
  - Cỡ chữ (Nhỏ / Vừa / Lớn).
- Field này đổ ra các khoá `captionStyle`, `captionAccent`, `captionPosition`, `captionSize`.
- Ảnh xem trước:
  - Vẽ lại 400 ms sau lần đổi cuối của mẫu, màu, vị trí, cỡ hoặc khung của thẻ.
  - Gọi `preview_caption_style` qua runner như các tool khác. Ảnh hiện bằng `file:///` và thêm tham số chống cache.
  - Mẫu "Không phụ đề" ẩn ảnh và các tuỳ chỉnh.
  - Gọi lỗi: hiện dòng báo lỗi tiếng Việt dưới ảnh. Nút Chạy vẫn bấm được.
  - Nếu runner đang bận một quy trình, chờ quy trình xong rồi mới vẽ, không xếp hàng nhiều lần.
- Ô khung: Recap có 16:9, 9:16, 1:1, 4:5. Shorts có thêm ô khung 9:16, 1:1, 4:5.
- Thẻ Phụ đề: ô "Số ký tự tối đa mỗi dòng" mặc định để trống, placeholder "Tự động theo khung".
- Hex sai: panel chặn và báo "Màu phải có dạng #RRGGBB.", trước khi chạy.
- Logic thuần (gom khoá, kiểm tra hex, nhãn tiếng Việt) đặt trong `gui-core.js` để test được. DOM đặt trong `gui.js`.

## 5. Lỗi và tương thích

- Style lạ, accent sai dạng, aspect lạ: schema từ chối với thông báo rõ. Panel có bản dịch tiếng Việt trong `gui-core.js`.
- Spec Python cũ (chỉ `style`): vẽ như cũ. Có test so ảnh với bản vẽ trước khi sửa.
- `groupCaptions` gọi không truyền giới hạn vẫn dùng 3 / 18.
- Bỏ trống mọi tuỳ chỉnh và khung 9:16 thì `resolveLook('clean'|'pop'|'karaoke', …)` cho ra đúng thông số hiện tại: 72 px ở 1920, viền 6 px, `#FFD400`, vùng an toàn 250 / 350 / 80 px.

## 6. Kiểm thử

- **TS thuần** (`caption-looks.test.ts`):
  - `layoutFor` chọn đúng hàng cho 1920×1080, 1080×1920, 1080×1080, 1080×1350, 1440×1080 và 1280×1024;
  - `resolveLook` khớp mục 5 cho mẫu cũ;
  - cỡ `large` giảm ký tự đúng hệ số;
  - accent sai thì báo lỗi;
  - `subtitleLineLimits` theo bảng.
- **Python** (`test_captions.py`):
  - highlight: pixel màu nhấn nằm sau từ đang đọc, không nằm sau từ khác;
  - minimal: không có pixel viền đen cứng quanh chữ, có pixel bóng mờ;
  - `middle`: tâm khối chữ ở khoảng 60% chiều cao;
  - spec cũ: ảnh giống bản vẽ trước khi sửa;
  - `caption_preview` ghi ra PNG đúng kích thước.
- **Tool và workflow**:
  - `preview_caption_style` dùng lại ảnh đã lưu đệm;
  - `workflow_shorts` và `workflow_recap` truyền tuỳ chỉnh và aspect xuống;
  - `reframeTo` gọi đúng `num, den`;
  - kiểm tra khung 1:1 và 4:5;
  - SRT tự động 22 × 2 với sequence 1080×1920, có `lineLimits`.
- **Panel** (`gui-core.test.ts`): gom khoá caption, kiểm tra hex, nhãn và bản dịch.
- **Chạy thật**, trên bản sao, theo quy tắc test trong Premiere:
  - một short 1:1 dùng highlight màu xanh lơ, vị trí giữa;
  - một recap 4:5 dùng minimal cỡ lớn;
  - SRT tự động cho một sequence 9:16;
  - so ảnh xem trước với một frame của kết quả.

## 7. Ngoài phạm vi

- Kiểu chữ cho caption track của Premiere (script không điều khiển được).
- Font ngoài hai font Be Vietnam Pro đã đóng gói. Lưu mẫu do người dùng tự tạo.
- Vị trí trên cùng khung. Khung xuất 5:4 / 4:3.
- Chỉnh text phụ đề trong panel (`build_short` đã có `captions` override cho Agent).
