import { crossfadeFrames, normalizeRanges } from '../../analysis/cleanup.js';

const iv = (start: number, end: number) => ({ start, end, duration: Math.round((end - start) * 1000) / 1000 });
const base = { total: 12, frameDuration: 1 / 25, mergeGapSec: 0.4, minKeepSec: 0.4, invert: false };

describe('normalizeRanges', () => {
  it('merges two cuts 0.3 s apart into one', () => {
    expect(normalizeRanges([iv(2, 3), iv(3.28, 4)], base)).toEqual([iv(2, 4)]);
  });

  it('drops a 0.3 s keep between two cuts even when the merge gap is smaller', () => {
    expect(normalizeRanges([iv(2, 3), iv(3.28, 4)], { ...base, mergeGapSec: 0.1 })).toEqual([iv(2, 4)]);
  });

  it('keeps cuts that are far enough apart separate and sorts them', () => {
    expect(normalizeRanges([iv(6, 7), iv(2, 3)], base)).toEqual([iv(2, 3), iv(6, 7)]);
  });

  it('treats ranges as the keep set when invert is true', () => {
    expect(normalizeRanges([iv(2, 5), iv(8, 10)], { ...base, invert: true })).toEqual([iv(0, 2), iv(5, 8), iv(10, 12)]);
  });

  it('snaps edges onto the 1/25 frame grid', () => {
    const [cut] = normalizeRanges([iv(1.01, 2.03)], base);
    expect(cut!.start).toBeCloseTo(1.0, 6);
    expect(cut!.end).toBeCloseTo(2.04, 6);
  });

  it('cuts a sliver left at the start or end of the sequence', () => {
    expect(normalizeRanges([iv(0.2, 3), iv(11.8, 12)], base)).toEqual([iv(0, 3), iv(11.8, 12)]);
    expect(normalizeRanges([iv(3, 11.8)], base)).toEqual([iv(3, 12)]);
  });

  it('clamps to the sequence and ignores empty ranges', () => {
    expect(normalizeRanges([iv(-1, 0), iv(5, 5), iv(10, 20)], base)).toEqual([iv(10, 12)]);
  });

  it('returns nothing to cut when invert keeps everything', () => {
    expect(normalizeRanges([iv(0, 12)], { ...base, invert: true })).toEqual([]);
  });
});

describe('crossfadeFrames', () => {
  it('is 0 when off and at least one frame otherwise', () => {
    expect(crossfadeFrames(30, 1 / 25)).toBe(1);
    expect(crossfadeFrames(30, 1 / 30)).toBe(1);
    expect(crossfadeFrames(100, 1 / 25)).toBe(3);
    expect(crossfadeFrames(0, 1 / 25)).toBe(0);
  });
});
