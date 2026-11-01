import {
  clipFingerprint, dedupeOverlaps, mapWordsToTimeline, repairTimestamps, splitSentences,
  type AsrWord, type TimelineWord,
} from '../../analysis/transcript.js';
import type { SequenceClip } from '../../analysis/cleanup.js';

const FRAME = 1 / 25;
const clip = (o: Partial<SequenceClip>): SequenceClip => ({
  id: 'c1', trackType: 'audio', trackIndex: 0, start: 0, end: 10, inPoint: 0, outPoint: 10, mediaPath: 'a.wav', ...o,
});
const aw = (w: string, start: number, end: number, p = 0.9): AsrWord => ({ w, start, end, p });
const tw = (w: string, start: number, end: number, trackIndex = 0, p = 0.9): TimelineWord =>
  ({ w, start, end, p, trackIndex, clipId: `c${trackIndex}` });

describe('mapWordsToTimeline', () => {
  it('maps file time to timeline time', () => {
    const c = clip({ start: 100, inPoint: 30, outPoint: 40, end: 110 });
    const r = mapWordsToTimeline([c], new Map([['a.wav', [aw('x', 35.0, 35.2)]]]), FRAME);
    expect(r.words).toHaveLength(1);
    expect(r.words[0]!.start).toBeCloseTo(105.0);
    expect(r.words[0]!.trackIndex).toBe(0);
    expect(r.words[0]!.clipId).toBe('c1');
  });

  it('drops words whose centre is outside the trimmed range', () => {
    const c = clip({ start: 100, inPoint: 30, outPoint: 40, end: 110 });
    const words = [aw('a', 29.9, 30.05), aw('b', 39.9, 40.2)];
    expect(mapWordsToTimeline([c], new Map([['a.wav', words]]), FRAME).words).toHaveLength(0);
  });

  it('one source cut into two clips keeps each part once', () => {
    const a = clip({ id: 'A', start: 0, end: 10, inPoint: 0, outPoint: 10 });
    const b = clip({ id: 'B', start: 10, end: 20, inPoint: 20, outPoint: 30 });
    const words = [aw('five', 5, 5.2), aw('fifteen', 15, 15.2), aw('twentyfive', 25, 25.2)];
    const r = mapWordsToTimeline([a, b], new Map([['a.wav', words]]), FRAME);
    expect(r.words.map((w) => w.w)).toEqual(['five', 'twentyfive']);
    expect(r.words[0]!.start).toBeCloseTo(5);
    expect(r.words[1]!.start).toBeCloseTo(15);
  });

  it('skips speed-changed clips', () => {
    const c = clip({ start: 0, end: 10, inPoint: 0, outPoint: 20 });
    const r = mapWordsToTimeline([c], new Map([['a.wav', [aw('x', 1, 1.2)]]]), FRAME);
    expect(r.words).toHaveLength(0);
    expect(r.skippedClips[0]).toEqual({ clipId: 'c1', reason: 'speed_changed' });
  });

  it('skips clips with no media and ignores video clips', () => {
    const r = mapWordsToTimeline(
      [clip({ id: 'n', mediaPath: null }), clip({ id: 'v', trackType: 'video' })],
      new Map([['a.wav', [aw('x', 1, 1.2)]]]), FRAME);
    expect(r.words).toHaveLength(0);
    expect(r.skippedClips).toEqual([{ clipId: 'n', reason: 'no_media' }]);
  });
});

describe('dedupeOverlaps', () => {
  it('keeps the higher probability for the same word on two mics', () => {
    const out = dedupeOverlaps([tw('chào', 1.0, 1.5, 0, 0.6), tw('Chào', 1.1, 1.5, 1, 0.9)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.trackIndex).toBe(1);
  });

  it('keeps both words when the text differs', () => {
    expect(dedupeOverlaps([tw('chào', 1.0, 1.5, 0), tw('ừ', 1.0, 1.5, 1)])).toHaveLength(2);
  });
});

describe('repairTimestamps', () => {
  it('interpolates zero-length words', () => {
    const r = repairTimestamps([tw('a', 1.0, 1.2), tw('b', 1.2, 1.2), tw('c', 1.4, 1.6)]);
    expect(r.repaired).toBe(1);
    expect(r.words[1]!.end).toBeGreaterThan(r.words[1]!.start);
    expect(r.words[1]!.end).toBeLessThanOrEqual(1.4);
  });
});

describe('splitSentences', () => {
  it('splits sentences on punctuation and on pauses over 1 s', () => {
    const s = splitSentences([
      tw('Xin', 0, 0.3), tw('chào.', 0.3, 0.6), tw('Hôm', 0.7, 1.0), tw('nay', 1.0, 1.3),
      tw('trời', 2.5, 2.8), tw('đẹp', 2.8, 3.1),
    ]);
    expect(s.map((x) => x.id)).toEqual([0, 1, 2]);
    expect(s[0]).toMatchObject({ text: 'Xin chào.', firstWord: 0, lastWord: 1, start: 0, end: 0.6 });
    expect(s[1]!.text).toBe('Hôm nay');
    expect(s[2]!.text).toBe('trời đẹp');
  });
});

describe('clipFingerprint', () => {
  it('is stable under order and ignores video clips', () => {
    const a = clip({ id: 'A' }), b = clip({ id: 'B', start: 10, end: 20 });
    expect(clipFingerprint([a, b])).toBe(clipFingerprint([b, a, clip({ id: 'v', trackType: 'video' })]));
    expect(clipFingerprint([a])).not.toBe(clipFingerprint([b]));
  });
});
