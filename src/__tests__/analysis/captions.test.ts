import { applyCaptionOverrides, groupCaptions, safeFileName, SAFE_AREA } from '../../analysis/captions.js';

const words = (text: string, start = 0, step = 0.3) =>
  text.split(' ').map((w, i) => ({ w, start: start + i * step, end: start + i * step + 0.25 }));

describe('groupCaptions', () => {
  it('groups at most 3 words and 18 characters', () => {
    const g = groupCaptions(words('Chào mừng các bạn đã đến với Vietcetera Explained'), 0);
    expect(g.map((x) => x.text)).toEqual(['Chào mừng các', 'bạn đã đến', 'với Vietcetera', 'Explained']);
  });

  it('breaks after punctuation', () => {
    const g = groupCaptions(words('Hai Bà Trưng, năm 40.'), 0);
    expect(g.map((x) => x.text)).toEqual(['Hai Bà Trưng,', 'năm 40.']);
  });

  it('times are relative to the short start', () => {
    const g = groupCaptions(words('xin chào', 100.4), 100);
    expect(g[0].start).toBe(0.4);
    expect(g[0].words[0].start).toBe(0.4);
  });

  it('exposes the safe area', () => {
    expect(SAFE_AREA).toEqual({ top: 0.1, bottom: 0.15, side: 0.06 });
  });
});

describe('applyCaptionOverrides', () => {
  const base = () => [{ start: 0, end: 0.9, text: 'a b c', words: [
    { w: 'a', start: 0, end: 0.2 }, { w: 'b', start: 0.3, end: 0.5 }, { w: 'c', start: 0.6, end: 0.9 }] }];

  it('override with the same word count keeps word timings', () => {
    const [g] = applyCaptionOverrides(base(), [{ start: 0, end: 0.9, text: 'x y z' }]);
    expect(g.text).toBe('x y z');
    expect(g.words).toEqual([
      { w: 'x', start: 0, end: 0.2 }, { w: 'y', start: 0.3, end: 0.5 }, { w: 'z', start: 0.6, end: 0.9 }]);
  });

  it('override with a different word count spreads words evenly', () => {
    const g0 = base();
    g0[0].words = g0[0].words.slice(0, 2);
    const [g] = applyCaptionOverrides(g0, [{ start: 0, end: 0.9, text: 'x y z' }]);
    expect(g.words).toEqual([
      { w: 'x', start: 0, end: 0.3 }, { w: 'y', start: 0.3, end: 0.6 }, { w: 'z', start: 0.6, end: 0.9 }]);
  });

  it('leaves unmatched groups untouched', () => {
    const [g] = applyCaptionOverrides(base(), [{ start: 5, end: 6, text: 'no' }]);
    expect(g.text).toBe('a b c');
  });
});

describe('safeFileName', () => {
  it('keeps Vietnamese letters and replaces path characters', () => {
    expect(safeFileName('Nữ quyền: 8/3?')).toBe('Nữ quyền- 8-3-');
    expect(safeFileName('')).toBe('short');
  });
});
