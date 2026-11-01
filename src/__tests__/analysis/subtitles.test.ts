import { buildSubtitleCues, toSrt } from '../../analysis/subtitles.js';

const seq = (text: string, start = 0, step = 0.3, dur = 0.25) =>
  text.split(' ').map((w, i) => ({ w, start: start + i * step, end: start + i * step + dur }));

describe('buildSubtitleCues', () => {
  it('ends a cue at sentence punctuation', () => {
    const cues = buildSubtitleCues(seq('Xin chào các bạn. Hôm nay'));
    expect(cues[0]!.lines.join(' ')).toBe('Xin chào các bạn.');
    expect(cues[1]!.lines.join(' ')).toBe('Hôm nay');
  });

  it('ends a cue at a pause longer than 0.6 s', () => {
    const a = seq('Xin chào');
    const b = seq('các bạn', 0.55 + 0.7);
    const cues = buildSubtitleCues([...a, ...b]);
    expect(cues.map((c) => c.lines.join(' '))).toEqual(['Xin chào', 'các bạn']);
    const short = buildSubtitleCues([...a, ...seq('các bạn', 0.55 + 0.5)]);
    expect(short).toHaveLength(1);
  });

  it('wraps into two balanced lines of at most 42 characters', () => {
    const text = 'Hôm nay chúng ta sẽ nói về lịch sử Việt Nam thời kỳ Hai Bà Trưng';
    const cues = buildSubtitleCues(seq(text, 0, 0.3, 0.3), { maxCps: 100 });
    expect(cues).toHaveLength(1);
    const lines = cues[0]!.lines;
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.length <= 42)).toBe(true);
    const ws = text.split(' ');
    let best = Infinity;
    for (let i = 1; i < ws.length; i++) {
      const a = ws.slice(0, i).join(' ').length;
      const b = ws.slice(i).join(' ').length;
      if (a <= 42 && b <= 42) best = Math.min(best, Math.abs(a - b));
    }
    expect(Math.abs(lines[0]!.length - lines[1]!.length)).toBe(best);
  });

  it('extends short cues to 1 s without overlapping the next cue', () => {
    const cues = buildSubtitleCues([
      { w: 'Dạ.', start: 0, end: 0.3 },
      { w: 'Vâng', start: 1.5, end: 1.8 },
      { w: 'ạ.', start: 1.8, end: 2.0 },
    ]);
    expect(cues[0]!.end).toBeCloseTo(1.0, 3);
    const tight = buildSubtitleCues([
      { w: 'Dạ.', start: 0, end: 0.3 },
      { w: 'Vâng.', start: 0.5, end: 0.9 },
    ]);
    expect(tight[0]!.end).toBeCloseTo(0.42, 3);
    expect(tight[0]!.end).toBeLessThanOrEqual(tight[1]!.start);
  });

  it('splits a cue longer than 7 s', () => {
    const cues = buildSubtitleCues(seq('một hai ba bốn năm sáu bảy tám chín mười', 0, 0.9, 0.8));
    expect(cues.length).toBeGreaterThan(1);
    for (const c of cues) expect(c.end - c.start).toBeLessThanOrEqual(7.0001);
  });

  it('keeps Vietnamese diacritics in NFC', () => {
    const decomposed = 'Tru\u031Bng Tra\u0306\u0301c'.normalize('NFD');
    const cues = buildSubtitleCues([
      { w: 'Trưng'.normalize('NFD'), start: 0, end: 0.4 },
      { w: 'Trắc'.normalize('NFD'), start: 0.4, end: 0.8 },
    ]);
    expect(decomposed.length).toBeGreaterThan(0);
    expect(cues[0]!.lines.join(' ')).toBe('Trưng Trắc'.normalize('NFC'));
    expect(cues[0]!.lines.join(' ')).toBe(cues[0]!.lines.join(' ').normalize('NFC'));
  });
});

describe('cue timing guarantees', () => {
  it('keeps every cue positive and ordered when words touch', () => {
    const cues = buildSubtitleCues([
      { w: 'a.', start: 0, end: 0.05 },
      { w: 'b.', start: 0.05, end: 0.05 },
      { w: 'c.', start: 0.05, end: 0.1 },
    ]);
    expect(cues).toHaveLength(3);
    cues.forEach((c, i) => {
      expect(c.end).toBeGreaterThan(c.start);
      if (i > 0) expect(c.start).toBeGreaterThanOrEqual(cues[i - 1]!.end + 0.08 - 1e-9);
    });
  });

  it('keeps a gap between cues in a dense run', () => {
    const dense = Array.from({ length: 200 }, (_, i) => ({ w: 'từ.', start: i * 0.1, end: i * 0.1 + 0.1 }));
    const cues = buildSubtitleCues(dense);
    expect(cues).toHaveLength(200);
    cues.forEach((c, i) => {
      expect(c.end - c.start).toBeGreaterThanOrEqual(0.04 - 1e-9);
      if (i > 0) expect(c.start).toBeGreaterThanOrEqual(cues[i - 1]!.end + 0.08 - 1e-9);
    });
  });

  it('cuts mid-sentence at maxDuration with the exact text of both cues', () => {
    const cues = buildSubtitleCues(seq('một hai ba bốn năm sáu bảy tám chín mười', 0, 0.9, 0.8));
    expect(cues.map((c) => c.lines.join(' '))).toEqual(['một hai ba bốn năm sáu bảy', 'tám chín mười']);
  });

  it('never extends a cue beyond maxDuration for reading speed', () => {
    const cues = buildSubtitleCues(seq('một hai ba bốn năm sáu', 0, 0.1, 0.1), { maxCps: 1, maxDuration: 3 });
    expect(cues[0]!.end - cues[0]!.start).toBeLessThanOrEqual(3 + 1e-9);
  });
});

describe('toSrt', () => {
  it('rounds 0.9995 s to 00:00:01,000', () => {
    expect(toSrt([{ index: 1, start: 0.9995, end: 2, lines: ['x'] }])).toContain('00:00:01,000 --> 00:00:02,000');
  });

  it('formats times and CRLF', () => {
    const srt = toSrt([{ index: 3, start: 3725.5, end: 3727.25, lines: ['Xin chào'] }]);
    expect(srt).toContain('01:02:05,500 --> 01:02:07,250');
    expect(srt).toBe('3\r\n01:02:05,500 --> 01:02:07,250\r\nXin chào\r\n\r\n');
    expect(srt.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(srt.charCodeAt(0)).not.toBe(0xfeff);
  });
});
