import { layoutFor, resolveLook, subtitleLineLimits, ACCENT_SWATCHES, CAPTION_STYLE_IDS, ASPECT_RATIOS } from '../../analysis/caption-looks.js';

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
    expect(r.layout).toBe('16:9');
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
  it('rejects an unknown style and bad sizes', () => {
    expect(() => resolveLook({ style: 'neon' as never }, 1080, 1920)).toThrow(/style/i);
    expect(() => resolveLook({ style: 'clean' }, 0, 1920)).toThrow();
  });
  it('exposes the constants', () => {
    expect(CAPTION_STYLE_IDS).toHaveLength(5);
    expect(ACCENT_SWATCHES).toHaveLength(5);
    expect(ASPECT_RATIOS['4:5']).toEqual({ num: 4, den: 5 });
  });
});

describe('subtitleLineLimits', () => {
  it.each([[1080, 1920, 22], [1080, 1350, 28], [1080, 1080, 30], [1440, 1080, 37], [1920, 1080, 42]])(
    '%ix%i -> %i x 2', (w, h, n) => expect(subtitleLineLimits(w, h)).toMatchObject({ maxCharsPerLine: n, maxLines: 2 }));
});
