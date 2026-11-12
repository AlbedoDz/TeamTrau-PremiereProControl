# Caption Looks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Có 5 mẫu phụ đề chữ cháy vào hình, mỗi mẫu có 3 tuỳ chỉnh. Số từ, số ký tự và cỡ chữ tự khớp theo khung hình. SRT tự chọn số ký tự mỗi dòng theo khung. Recap và Shorts xuất thêm khung 1:1 và 4:5. Panel có ảnh xem trước thật của mẫu.

**Architecture:**
- **Định nghĩa mẫu.** Mẫu và bảng khung chỉ nằm ở `src/analysis/caption-looks.ts` (hàm thuần). Hàm `resolveLook` tính ra một object `look` gồm toàn bộ thông số vẽ, đã đổi sang pixel.
- **Bộ vẽ Python.** `captions.py` vẽ theo `look` khi spec có `look`. Spec cũ chỉ có `style` thì dựng `look` cũ, để kết quả y như trước.
- **Tool xem trước.** `preview_caption_style` vẽ một PNG qua lệnh sidecar `caption_preview`. Panel hiển thị ảnh này.
- **Đường dựng.** Cách gom cụm, việc vẽ phụ đề, Auto Reframe theo tỉ lệ và bước kiểm tra khung đều đi qua cùng `CaptionOptions` và `{ num, den }`.

**Tech Stack:** TypeScript (zod 4, jest), Python sidecar (Pillow, pytest), ExtendScript (`autoReframeSequence`), CEP panel (ES5 JS).

**Spec:** `docs/superpowers/specs/2026-11-12-caption-looks-design.md`

## Global Constraints

- **Mẫu:** đúng 5 mẫu, `'clean' | 'pop' | 'karaoke' | 'highlight' | 'minimal'`. Recap có thêm `'none'`.
- **Tuỳ chỉnh:**
  - `captionAccent` khớp `^#[0-9A-Fa-f]{6}$`;
  - `captionPosition` là `'bottom' | 'middle'`, mặc định `bottom`;
  - `captionSize` là `'small' | 'medium' | 'large'`, ứng với 0.85 / 1 / 1.2, mặc định `medium`.
- **Màu nhấn mặc định:** `#FFD400` cho clean, pop, karaoke; `#FF3B5C` cho highlight. Năm ô màu: `#FFD400`, `#FF3B5C`, `#22D3EE`, `#4ADE80`, `#A855F7`.
- **Bảng khung:** chép đúng spec mục 3.3, kể cả vùng an toàn. Hàng được chọn theo tỉ lệ gần nhất trên thang log.
- **Thông số vẽ cũ (clean/pop/karaoke):**
  - viền 6 px cố định, không co giãn theo khung;
  - khoảng cách đáy `round(height × 40 / 1920)`;
  - ở khung 9:16, cỡ chữ = `round(height × 72 / 1920)` và vùng an toàn 250/1920, 350/1920, 80/1080.
- **Tương thích:**
  - spec Python chỉ có `style` vẽ ra cùng pixel như trước;
  - `groupCaptions` gọi không truyền giới hạn vẫn dùng 3 / 18;
  - recap 16:9 cố ý đổi sang hàng 16:9 của bảng, vì đó là mục đích của tính năng.
- **Khung xuất:**
  - Shorts: `'9:16' | '1:1' | '4:5'`, mặc định `9:16`;
  - Recap: `'16:9' | '9:16' | '1:1' | '4:5'`. Riêng `16:9` không reframe.
- **SRT:** bỏ trống `maxCharsPerLine` thì lấy theo khung. Không đọc được khung thì dùng 42 × 2 kèm cảnh báo.
- **Ngôn ngữ thông báo:** schema và tool báo lỗi bằng tiếng Anh, như các tool khác. Câu hiển thị trên panel và cảnh báo của workflow bằng tiếng Việt.
- **Commit:** trên `feature/panel-gui`, kết thúc bằng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Không push.

## Review Focus

1. **Khung không có trong bảng** (2.39:1 cinemascope, 9:19.5 điện thoại) phải lấy hàng gần nhất mà không lỗi: 2.39 lấy 16:9, 0.46 lấy 9:16. Test nằm ở Task 1.
2. **Một từ dài hơn giới hạn ký tự của cụm ở cỡ `large`**, ví dụ URL 30 ký tự ở 9:16, phải đứng riêng một cụm, và bộ vẽ không được vẽ chữ ra ngoài khung. Test ở Task 1 (gom cụm) và Task 2 (`text_inside_safe_area` với look large).
3. **Highlight khi từ đang đọc là từ đầu hoặc cuối dòng:** nền bo góc không được tràn ra ngoài vùng an toàn bên. Test ở Task 2.
4. **Màu hex viết thường** (`#ff3b5c`) phải được nhận. **Hex 3 ký tự** (`#f00`) phải bị từ chối với thông báo rõ. Test ở Task 1 và Task 6.
5. **Xem trước gọi khi runner đang chạy một quy trình** thì không được xếp hàng chồng nhiều lần. Chỉ gọi một lần, sau khi quy trình xong, và dùng giá trị mới nhất. Test ở Task 6 (hàm thuần `previewRequest` trong `gui-core.js`).

---

### Task 1: `caption-looks.ts`, gồm bảng khung, mẫu và resolver

**Files:**
- Create: `src/analysis/caption-looks.ts`
- Test: `src/__tests__/analysis/caption-looks.test.ts`

**Interfaces:**
- Produces:
  - `type CaptionStyleId = 'clean' | 'pop' | 'karaoke' | 'highlight' | 'minimal'`
  - `const CAPTION_STYLE_IDS: readonly CaptionStyleId[]`
  - `type CaptionPosition = 'bottom' | 'middle'`, `type CaptionSize = 'small' | 'medium' | 'large'`
  - `interface CaptionOptions { style: CaptionStyleId; accent?: string; position?: CaptionPosition; size?: CaptionSize }`
  - `const ACCENT_SWATCHES: readonly string[]`, `const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/`
  - `interface CaptionLayout { id: '9:16' | '4:5' | '1:1' | '5:4' | '16:9'; ratio: number; fontPct: number; maxWords: number; maxChars: number; minimalWords: number; minimalChars: number; srtChars: number; srtLines: number; safeArea: { top: number; bottom: number; side: number } }`
  - `layoutFor(width: number, height: number): CaptionLayout`
  - `interface CaptionLook { font: string; sizePx: number; uppercase: boolean; textColor: string; accentColor: string; stroke: { widthPx: number; color: string } | null; shadow: { dxPx: number; dyPx: number; blurPx: number; color: string } | null; active: 'color' | 'pop' | 'pill' | 'none'; pill: { padXPx: number; padYPx: number; radiusPx: number } | null; position: CaptionPosition; safeArea: { top: number; bottom: number; side: number }; bottomGapPx: number }`
  - `resolveLook(opts: CaptionOptions, width: number, height: number): { look: CaptionLook; grouping: { maxWords: number; maxChars: number }; layout: CaptionLayout['id'] }`. Ném `Error` khi accent sai dạng hoặc style lạ.
  - `subtitleLineLimits(width: number, height: number): { maxCharsPerLine: number; maxLines: number; layout: CaptionLayout['id'] }`
  - `ASPECT_RATIOS: Record<'16:9' | '9:16' | '1:1' | '4:5', { num: number; den: number }>`

- [ ] **Step 1: Write the failing tests**

```ts
describe('layoutFor', () => {
  it.each([
    [1920, 1080, '16:9'], [1080, 1920, '9:16'], [1080, 1080, '1:1'], [1080, 1350, '4:5'],
    [1440, 1080, '5:4'], [1280, 1024, '5:4'], [2048, 858, '16:9'], [1080, 2340, '9:16'],
  ])('%ix%i -> %s', (w, h, id) => expect(layoutFor(w, h).id).toBe(id));
});

describe('resolveLook', () => {
  it('reproduces the current 9:16 look for clean', () => {
    const { look, grouping } = resolveLook({ style: 'clean' }, 1080, 1920);
    expect(look).toMatchObject({ font: 'BeVietnamPro-Bold.ttf', sizePx: 72, uppercase: false, textColor: '#FFFFFF',
      accentColor: '#FFD400', stroke: { widthPx: 6, color: '#000000' }, shadow: null, active: 'color', pill: null,
      position: 'bottom', bottomGapPx: 40 });
    expect(look.safeArea).toEqual({ top: 250 / 1920, bottom: 350 / 1920, side: 80 / 1080 });
    expect(grouping).toEqual({ maxWords: 3, maxChars: 18 });
  });
  it('keeps the 6 px stroke at any height and scales size with height', () => {
    expect(resolveLook({ style: 'pop' }, 608, 1080).look).toMatchObject({ sizePx: 40, stroke: { widthPx: 6 }, active: 'pop', uppercase: true });
  });
  it('uses the 16:9 row: 5% size, 5 words / 32 chars', () => {
    const r = resolveLook({ style: 'clean' }, 1920, 1080);
    expect(r.look.sizePx).toBe(54);
    expect(r.grouping).toEqual({ maxWords: 5, maxChars: 32 });
  });
  it('highlight: ExtraBold, pill in #FF3B5C, 0.04 em stroke', () => {
    const { look } = resolveLook({ style: 'highlight' }, 1080, 1920);
    expect(look).toMatchObject({ font: 'BeVietnamPro-ExtraBold.ttf', accentColor: '#FF3B5C', active: 'pill',
      stroke: { widthPx: 3 }, pill: { padXPx: 13, padYPx: 6, radiusPx: 16 } });
  });
  it('minimal: 0.85 size, shadow, no stroke, longer groups; 16:9 = 14 words / 84 chars', () => {
    const v = resolveLook({ style: 'minimal' }, 1080, 1920);
    expect(v.look).toMatchObject({ sizePx: 61, stroke: null, active: 'none', shadow: { color: '#000000B3' } });
    expect(v.grouping).toEqual({ maxWords: 6, maxChars: 32 });
    expect(resolveLook({ style: 'minimal' }, 1920, 1080).grouping).toEqual({ maxWords: 14, maxChars: 84 });
  });
  it('large divides chars by 1.2 (floor) and keeps words', () => {
    expect(resolveLook({ style: 'clean', size: 'large' }, 1080, 1920).grouping).toEqual({ maxWords: 3, maxChars: 15 });
    expect(resolveLook({ style: 'clean', size: 'small' }, 1080, 1920).grouping).toEqual({ maxWords: 3, maxChars: 21 });
  });
  it('takes accent in any case, rejects malformed hex', () => {
    expect(resolveLook({ style: 'clean', accent: '#ff3b5c' }, 1080, 1920).look.accentColor).toBe('#FF3B5C');
    expect(() => resolveLook({ style: 'clean', accent: '#f00' }, 1080, 1920)).toThrow(/#RRGGBB/);
  });
});

describe('subtitleLineLimits', () => {
  it.each([[1080, 1920, 22], [1080, 1350, 28], [1080, 1080, 30], [1440, 1080, 37], [1920, 1080, 42]])(
    '%ix%i -> %i x 2', (w, h, n) => expect(subtitleLineLimits(w, h)).toMatchObject({ maxCharsPerLine: n, maxLines: 2 }));
});
```

- [ ] **Step 2: Run** `npx jest src/__tests__/analysis/caption-looks.test.ts`. Expected: FAIL, vì module chưa có.

- [ ] **Step 3: Implement** theo spec mục 3.1–3.3.
  - Đổi `em` sang px bằng `Math.round(em × sizePx)`:
    - highlight: viền 0.04 em, đệm 0.18 / 0.08 em, bo góc 0.22 em;
    - minimal: bóng lệch 0.06 em, mờ 0.12 em, màu `#000000B3`.
  - `sizePx = roundHalfEven(height × fontPct × styleScale × sizeScale)`. Làm tròn nửa về số chẵn, như `round()` của Python, để khớp `font_size_for`: ví dụ 1080 × 72 / 1920 = 40.5 ra 40. Mọi giá trị px khác cũng dùng cách làm tròn này. `styleScale` của minimal là 0.85.
  - `maxChars = floor(base / sizeScale)`, trong đó `base` lấy cột Cụm, hoặc cột minimal với mẫu minimal.
  - Hàng 9:16 dùng đúng `250/1920, 350/1920, 80/1080` để khớp `SAFE_AREA` hiện tại.
  - Lời thoại lỗi accent: `Caption accent must look like #RRGGBB, got "<v>".`

- [ ] **Step 4: Run** lại lệnh ở Step 2. Expected: PASS.

- [ ] **Step 5: Commit** `feat: caption looks and per-aspect caption layouts`

---

### Task 2: bộ vẽ Python theo `look`, kèm lệnh `caption_preview`

**Files:**
- Modify: `python/premiere_mcp_sidecar/captions.py`
- Modify: `python/premiere_mcp_sidecar/__main__.py` (thêm `"caption_preview": run_caption_preview` vào `COMMANDS`)
- Test: `python/tests/test_captions.py`

**Interfaces:**
- Consumes: object `look` theo đúng tên khoá camelCase của `CaptionLook` (Task 1).
- Produces:
  - `legacy_look(style: str, width: int, height: int) -> dict`
  - `render(spec)` nhận thêm `spec["look"]`
  - `preview(spec) -> {"path": str, "width": int, "height": int}`, với spec `{look, width, height, text, maxWords, maxChars, activeIndex, outPath}`
  - Lệnh CLI `caption_preview`

- [ ] **Step 1: Write the failing tests**
  - `test_legacy_spec_matches_explicit_legacy_look`: render một frame với `style="clean"`, rồi render frame đó với `look=legacy_look("clean", w, h)`. Hai ảnh phải giống nhau từng byte (`ImageChops.difference(...).getbbox() is None`). Lặp lại cho `pop` ở frame giữa ramp.
  - `test_highlight_draws_accent_pill_behind_active_word_only`: look highlight, accent `#22D3EE`. Bbox các pixel có màu gần `#22D3EE` (sai số ≤ 12 mỗi kênh) phải chứa bbox của từ đang đọc, và không giao với bbox của từ kế tiếp.
  - `test_highlight_pill_stays_inside_side_margin`: từ đầu dòng là từ đang đọc, cụm dài 18 ký tự. `min x` của pill phải ≥ `width × safe.side − 1`.
  - `test_minimal_has_soft_shadow_and_no_hard_stroke`: look minimal. Có pixel alpha nằm giữa 1 và 200 bên dưới-phải chữ (bóng mờ). Không có pixel đen alpha 255 tiếp giáp chữ (không có viền).
  - `test_middle_position_centres_block_at_60_percent`: tâm dọc của bbox alpha nằm trong `0.60 × h ± 0.02 × h`.
  - `test_large_look_keeps_long_word_inside_frame`: look 9:16 cỡ large, một từ 30 ký tự. Bbox alpha phải nằm trong khung.
  - `test_caption_preview_writes_png_of_requested_size`: gọi `preview(...)` với 540×960. Kết quả là PNG 540×960, nền không trong suốt, và có pixel màu nhấn ở từ thứ hai.

- [ ] **Step 2: Run** `cd python && python -m pytest tests/test_captions.py -q`. Expected: các test mới FAIL.

- [ ] **Step 3: Implement**
  - Dời các hằng số đang có vào `legacy_look`: `#FFFFFF`, viền 6 `#000000`, `#FFD400`, `active` (`pop` hoặc `color`), vùng an toàn, `bottom_gap_for`.
  - `render` lấy `look = spec.get("look") or legacy_look(style, w, h)`. Khi đã có `look`, bỏ qua `spec["safeArea"]`.
  - `_draw(image, font, pieces, active, scale, width, height, look)`:
    - đổi màu `#RRGGBB(AA)` sang tuple RGBA;
    - viền là `stroke` hoặc 0;
    - bóng: vẽ chữ màu bóng lên lớp riêng, dịch theo `dx, dy`, rồi `GaussianBlur(blurPx)` và ghép dưới chữ;
    - pill: `rounded_rectangle` trên lớp riêng, nằm dưới chữ của từ đang đọc. Chữ của từ đang đọc lấy `textColor`. Khung pill kẹp vào `[side, width − side]`;
    - `active == 'none'`: không tô từ đang đọc;
    - `middle`: `top_y = round(0.60 × h − block_h / 2)`, kẹp trong `[top_limit, bottom_y − block_h]`.
  - Font của `look` mở qua `caption_font(look["font"], look["sizePx"])`.
  - Viết hoa khi `look["uppercase"]`, thay cho điều kiện `style == "pop"`.
  - `wrap_words` dùng `side_safe_width(width, safe["side"])` như cũ.
  - `preview`: ảnh nền chuyển màu dọc từ `#3a3f47` tới `#9aa3ad`, vẽ cụm đầu tiên với từ đang đọc là `activeIndex`, rồi lưu PNG.
  - Hàm gom cụm của `preview` làm giống `groupCaptions`: dừng khi đủ `maxWords`, dừng khi vượt `maxChars`, ngắt sau dấu câu.

- [ ] **Step 4: Run** lại lệnh ở Step 2. Expected: tất cả PASS, kể cả test cũ.

- [ ] **Step 5: Commit** `feat: caption renderer draws from a look (pill, shadow, middle) and previews`

---

### Task 3: tool `preview_caption_style`

**Files:**
- Create: `src/tools/domains/caption-preview.ts`
- Modify: `src/tools/domains/index.ts` (đăng ký `captionPreviewTools`)
- Modify: `src/__tests__/tools/catalog-structure.test.ts` (139 → 140), `src/__tests__/tools/index.test.ts` và `src/__tests__/tools/search-tools.test.ts` (310 → 311)
- Test: `src/__tests__/tools/caption-preview.test.ts`

**Interfaces:**
- Consumes: `resolveLook`, `CAPTION_STYLE_IDS`, `HEX_COLOR`, `ASPECT_RATIOS` (Task 1); lệnh sidecar `caption_preview` (Task 2); `runSidecar` và `sidecarMissingResult` (`src/analysis/sidecar.ts`); `premiereMcpHome()`.
- Produces: tool `preview_caption_style`.
  - Args: `{ style, captionAccent?, captionPosition?, captionSize?, aspect?: '16:9'|'9:16'|'1:1'|'4:5' (default '9:16'), width?, height?, text? }`. `width` và `height` phải đi cùng nhau, và khi có chúng thì bỏ qua `aspect`.
  - Trả về `{ success: true, path, width, height, grouping, layout }`.
- Produces: `captionOptionFields` (zod shape `{ captionAccent, captionPosition, captionSize }`, có mô tả). Task 4 dùng lại.

- [ ] **Step 1: Write the failing tests**, mock `runSidecar`, `fs` dùng thư mục tạm:
  - `renders a 540x960 preview for 9:16`: `runSidecar` được gọi với `'caption_preview'`. Input có `width: 540, height: 960`, có `look.accentColor`, và `outPath` kết thúc bằng `.png` nằm trong `renders/previews/`.
  - `16:9 gives 960x540, 4:5 gives 768x960, 1:1 gives 960x960`.
  - `reuses a cached preview`: gọi hai lần với cùng args, lần hai khi file đã tồn tại. `runSidecar` chỉ được gọi 1 lần.
  - `rejects a bad accent`: schema ném lỗi khớp `/#RRGGBB/` với `#f00`.
  - `reports a missing sidecar`: `runSidecar` ném lỗi sidecar-missing. Kết quả là `success: false` theo kiểu `sidecarMissingResult`.

- [ ] **Step 2: Run** `npx jest src/__tests__/tools/caption-preview.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - Cạnh dài 960 px.
  - Khoá cache là `sha1(JSON.stringify({ look, width, height, text, grouping }))`.
  - Câu mặc định là `Xin chào các bạn, hôm nay mình kể chuyện`, với `activeIndex: 1`.
  - Bắt lỗi sidecar thiếu theo đúng cách `renderCaptionFile` và `build_short` đang làm.

- [ ] **Step 4: Run** test của Task này cùng các test đếm tool. Expected: PASS.

- [ ] **Step 5: Commit** `feat: preview_caption_style renders a caption look to a cached PNG`

---

### Task 4: đưa `CaptionOptions` vào đường dựng shorts và recap

**Files:**
- Modify: `src/tools/domains/shorts.ts`:
  - `CaptionStyle` (dòng 671) đổi thành alias của `CaptionStyleId`;
  - `renderCaptionFile` (674);
  - `addAlphaCaptions` (727);
  - `BuildShortArgs` (448) và chỗ gom cụm cùng vẽ phụ đề trong `buildShort` (810–840);
  - schema `build_short`.
- Modify: `src/tools/domains/recap.ts`: lời gọi `addAlphaCaptions` (574), `BuildRecapArgs`, schema `build_recap`.
- Modify: `src/tools/workflows/shorts.ts`, `src/tools/workflows/recap.ts`, `src/tools/domains/workflow-tools.ts`: thêm các field caption và truyền xuống.
- Test: `src/__tests__/tools/shorts.test.ts`, `src/__tests__/tools/build-recap.test.ts`, `src/__tests__/tools/workflows.test.ts`

**Interfaces:**
- Consumes: `resolveLook`, `CaptionOptions` (Task 1), `captionOptionFields` (Task 3).
- Produces:
  - `renderCaptionFile(opts: { groups; caption: CaptionOptions; width; height; fps; duration; name; font? })` gửi spec có `look`. Nếu có `font` thì `font` thay `look.font`.
  - `addAlphaCaptions(ctx, sequenceId, words, caption: CaptionOptions, timeMap)`.
  - Args mới của `build_short`, `build_recap`, `workflow_shorts`, `workflow_recap`: `captionAccent?`, `captionPosition?`, `captionSize?`. `captionStyle` được nới thêm `highlight` và `minimal`.

- [ ] **Step 1: Write the failing tests**
  - `build_short dryRun groups with the look's limits`: `captionStyle: 'minimal'`. Sau dryRun, cụm dài nhất có tới 6 từ, trong khi trước đây tối đa 3.
  - `build_short sends a highlight look to the sidecar`: input của `runSidecar('captions', …)` có `look.active === 'pill'` và `look.accentColor === '#22D3EE'` khi `captionAccent: '#22d3ee'`. Không có khoá `style` cũ.
  - `build_recap passes caption options to addAlphaCaptions`: tham số thứ 4 bằng `{ style: 'minimal', size: 'large', position: 'middle' }`.
  - `workflow_shorts and workflow_recap forward caption options`.

- [ ] **Step 2: Run** các file test trên. Expected: các test mới FAIL.

- [ ] **Step 3: Implement**
  - Lúc gom cụm, `resolveLook(...).grouping` cần kích thước khung:
    - `addAlphaCaptions` lấy kích thước từ probe;
    - `buildShort` dùng `width`/`height` mà nó đã tính. Ở dryRun chưa probe nên dùng tạm `num × 120` / `den × 120` của khung đích (lúc này là 9:16), vì cách gom chỉ phụ thuộc tỉ lệ.
  - Lỗi accent ném từ `resolveLook` được schema chặn trước bằng `HEX_COLOR`.
  - Field `captionStyle` của workflow giữ nguyên mặc định: shorts `clean`, recap `none`.

- [ ] **Step 4: Run** lại các test, kèm `npx jest src/__tests__/analysis/captions.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: shorts and recap burn captions with the chosen look`

---

### Task 5: khung xuất 1:1 và 4:5 (`reframeTo`)

**Files:**
- Modify: `src/tools/domains/shorts.ts`:
  - `reframeScript` (497) nhận `num, den`;
  - `reframeToVertical` (653) đổi thành `reframeTo(ctx, sequenceId, name, ratio: { num: number; den: number }, range?)`;
  - `buildShort` dùng `width = round(height × num / den)` và kiểm tra khung ở dòng 931;
  - schema `build_short` thêm `aspect`.
- Modify: `src/tools/domains/recap.ts`: `aspect` thêm `'1:1' | '4:5'`. Biến `vertical` đổi thành `aspect !== '16:9'`, rồi gọi `reframeTo` với `ASPECT_RATIOS[aspect]`.
- Modify: `src/tools/workflows/shorts.ts`, `src/tools/domains/workflow-tools.ts`: `workflow_shorts` thêm `aspect`, mặc định `'9:16'`. Cập nhật mô tả tool.
- Test: các file test build_short, build_recap, workflows.

**Interfaces:**
- Consumes: `ASPECT_RATIOS` (Task 1).
- Produces: `reframeTo(ctx, sequenceId, name, ratio, range?)`. Tên cũ `reframeToVertical` bị xoá, mọi chỗ gọi đổi sang tên mới.

- [ ] **Step 1: Write the failing tests**
  - `build_short 1:1 calls autoReframeSequence(1, 1, …) and renders captions at height × height`: script gửi bridge có chứa `autoReframeSequence(1, 1,`, và sidecar `captions` nhận `width === height`.
  - `build_short verifies 4:5`: readback 864×1080 cho `verified: true`. Readback 608×1080 cho cảnh báo `The short is 608×1080, not 4:5.`
  - `build_recap 4:5 reframes, 16:9 does not`.
  - `workflow_shorts forwards aspect`.

- [ ] **Step 2: Run** các test. Expected: FAIL.

- [ ] **Step 3: Implement** theo phần Files.
  - Các comment đang ghi cứng "9 / 16" đổi thành tỉ lệ đã chọn.
  - Kích thước tạm khi dryRun ở Task 4 (`num × 120` / `den × 120`) đổi sang khung của `args.aspect`.

- [ ] **Step 4: Run** các test. Expected: PASS.

- [ ] **Step 5: Commit** `feat: recap and shorts export 1:1 and 4:5 through Auto Reframe`

---

### Task 6: SRT tự động theo khung, và panel

**Files:**
- Modify: `src/tools/domains/subtitles.ts`:
  - `maxCharsPerLine` (dòng 129) đổi thành `.optional()`, bỏ mặc định 42;
  - đọc khung bằng `probeScript` (export từ shorts.ts nếu chưa export);
  - truyền `maxLines` vào `buildSubtitleCues`;
  - trả về `lineLimits`.
- Modify: `src/tools/workflows/subtitles.ts`, `src/tools/domains/workflow-tools.ts` (`workflow_subtitles` thôi mặc định 42; summary có `lineLimits`).
- Modify: `cep-plugin/gui/gui-core.js`, `cep-plugin/gui/gui.js`, `cep-plugin/gui/gui.css`, `cep-plugin/gui/workflows.json`.
- Test: `src/__tests__/tools/subtitles.test.ts`, `src/__tests__/tools/workflows.test.ts`, `src/__tests__/panel/gui-core.test.ts`

**Interfaces:**
- Consumes: `subtitleLineLimits`, `ACCENT_SWATCHES` (Task 1); tool `preview_caption_style` (Task 3); các args caption và `aspect` (Task 4, 5).
- Produces (`gui-core.js`, ES5):
  - `CAPTION_STYLE_LABELS`: `{ clean: 'Gọn', pop: 'Nổi bật', karaoke: 'Karaoke', highlight: 'Tô nền từ', minimal: 'Tối giản', none: 'Không phụ đề' }`
  - `ACCENT_SWATCHES`: chép 5 màu, vì panel ES5 không import được TS
  - `captionArgs(value)`: đổi `{ style, accent, position, size }` sang `{ captionStyle, captionAccent?, captionPosition?, captionSize? }`. Bỏ các giá trị mặc định và chuỗi rỗng.
  - `isHexColor(v)`
  - `previewRequest(state, cardId, aspect, caption)`: trả về `{ tool: 'preview_caption_style', args }`, hoặc `null` khi style là `none`
  - `nextPreview(pending, busy, request)`: logic chống gọi chồng (Review Focus 5). Trả về `{ send: request | null, pending }`. Khi runner bận thì chỉ giữ request mới nhất; khi rảnh thì gửi ngay.
  - `missingRequired` thêm câu `Màu phải có dạng #RRGGBB.`

- [ ] **Step 1: Write the failing tests**
  - SRT:
    - `create_captions_from_transcript picks 22 x 2 for a 1080x1920 sequence and reports lineLimits` (`{ maxCharsPerLine: 22, maxLines: 2, layout: '9:16' }`);
    - `an explicit maxCharsPerLine wins`;
    - `an unreadable frame size falls back to 42 x 2 with a warning`.
  - Panel:
    - `captionArgs drops defaults` (`{style:'clean', accent:'', position:'bottom', size:'medium'}` cho ra `{ captionStyle: 'clean' }`);
    - `isHexColor accepts #ff3b5c and rejects #f00`;
    - `nextPreview keeps only the latest request while busy and sends it when free`;
    - `previewRequest returns null for none`;
    - `missingRequired flags a bad hex`;
    - `recap and shorts cards offer 1:1 and 4:5`;
    - `subtitles card sends no maxCharsPerLine when left empty`.

- [ ] **Step 2: Run** các test. Expected: FAIL.

- [ ] **Step 3: Implement**
  - Trong `workflows.json`:
    - field mới `{ "key": "caption", "type": "caption", "label": "Phụ đề", "default": { "style": "clean" } }` cho thẻ shorts, và `"none"` cho thẻ recap;
    - field `aspect` có 4 lựa chọn cho recap và 3 cho shorts;
    - `maxCharsPerLine` để `"default": ""` với placeholder `Tự động theo khung`.
  - Trong `buildArgs`: field kiểu `caption` gộp `captionArgs(...)` vào args.
  - `gui.js` (`fieldNode`) dựng khối caption gồm:
    - `<select>` mẫu;
    - `<img class="gui-caption-preview">`;
    - 5 nút màu và một `<input>` hex;
    - hai `<select>` Vị trí và Cỡ chữ.
  - Mỗi lần thay đổi đặt timer 400 ms rồi gọi `nextPreview`, sau đó `callTool`. Ảnh hiện bằng `file:///` + đường dẫn + `?t=` mtime.
  - Gọi lỗi thì hiện `vi(result)` dưới ảnh.
  - Panel hiện `lineLimits` thành dòng `22 ký tự/dòng (khung 9:16)` trong `describeSummary`.

- [ ] **Step 4: Run** `npx jest src/__tests__/panel src/__tests__/tools/workflows.test.ts` cùng file test SRT. Expected: PASS.

- [ ] **Step 5: Commit** `feat: per-aspect SRT limits and caption look picker with live preview`

---

### Task 7: kiểm tra toàn bộ và chạy thật trong Premiere

**Files:** không sửa code, trừ khi phát hiện lỗi. Lỗi nào sửa cũng phải có test, theo cách các task trên làm.

- [ ] **Step 1:** Chạy `npm run build` và `npx jest`. Expected: build sạch, mọi test qua.
- [ ] **Step 2:** Chạy `cd python && python -m pytest -q`. Expected: mọi test qua.
- [ ] **Step 3: Chạy thật** qua runner của worktree, trên bản sao (theo quy tắc test trên bản sao):
  - `workflow_shorts` với `count: 1, aspect: '1:1', captionStyle: 'highlight', captionAccent: '#22D3EE', captionPosition: 'middle'`;
  - `workflow_recap` với `aspect: '4:5', captionStyle: 'minimal', captionSize: 'large', minSec: 30, maxSec: 45`;
  - `workflow_subtitles` để trống `maxCharsPerLine` trên sequence 9:16.
  - Expected:
    - hai workflow đầu trả `verified: true`, khung đọc lại đúng 1:1 và 4:5;
    - SRT có dòng dài nhất ≤ 22 ký tự và `lineLimits.layout === '9:16'`.
- [ ] **Step 4: So ảnh.** Gọi `preview_caption_style` với cùng tuỳ chỉnh, rồi xuất một frame của short (tool `export_frame`). Đặt hai ảnh cạnh nhau, gửi cho người dùng xem bằng `SendUserFile`.
- [ ] **Step 5: Commit** nếu có sửa. Ghi kết quả chạy thật vào `docs/` theo cách các lần trước (commit `0b022f9`).
