import {
  duckingWindowsFor,
  punchInTargets,
  speechOnTimeline,
  structuralFindings,
} from '../../analysis/editing.js';
import type { SequenceClip } from '../../analysis/cleanup.js';

const iv = (start: number, end: number) => ({ start, end, duration: Math.round((end - start) * 1000) / 1000 });
const FRAME = 1 / 25;

const clip = (over: Partial<SequenceClip>): SequenceClip => ({
  id: 'c', trackType: 'audio', trackIndex: 0, start: 0, end: 20, inPoint: 0, outPoint: 20, mediaPath: 'talk.wav', ...over,
});

describe('speechOnTimeline', () => {
  const opts = { mergeGapSeconds: 0.6, minSpeechSeconds: 0.3 };

  it('is the clip minus its silences, on the timeline', () => {
    const { speech } = speechOnTimeline([clip({})], new Map([['talk.wav', [iv(0, 2), iv(10, 20)]]]), opts);
    expect(speech).toEqual([iv(2, 10)]);
  });

  it('shifts source time by the clip start and in-point', () => {
    const c = clip({ start: 100, end: 110, inPoint: 5, outPoint: 15 });
    const { speech } = speechOnTimeline([c], new Map([['talk.wav', [iv(5, 8)]]]), opts);
    expect(speech).toEqual([iv(103, 110)]);
  });

  it('merges phrases separated by a short pause and drops blips', () => {
    const { speech } = speechOnTimeline(
      [clip({ end: 10, outPoint: 10 })],
      new Map([['talk.wav', [iv(0, 1), iv(3, 3.4), iv(3.6, 8), iv(8.1, 10)]]]),
      opts,
    );
    // live: 1-3, 3.4-3.6, 8-8.1; the 0.4s pause merges the first two, 8-8.1 is under the minimum
    expect(speech).toEqual([iv(1, 3.6)]);
  });

  it('treats a retimed clip as speech for its whole length and says so', () => {
    const fast = clip({ id: 'fast', start: 0, end: 5, outPoint: 10 });
    const { speech, assumedSpeech } = speechOnTimeline([fast], new Map([['talk.wav', [iv(0, 10)]]]), opts);
    expect(speech).toEqual([iv(0, 5)]);
    expect(assumedSpeech).toEqual(['fast']);
  });
});

describe('duckingWindowsFor', () => {
  it('clips speech to the music clip and converts to its source time', () => {
    const music = clip({ start: 10, end: 30, inPoint: 40, outPoint: 60, mediaPath: 'music.wav' });
    const windows = duckingWindowsFor(music, [iv(5, 12), iv(20, 22), iv(35, 40)], -24);
    expect(windows).toEqual([
      { startTime: 40, endTime: 42, duckedDb: -24 },
      { startTime: 50, endTime: 52, duckedDb: -24 },
    ]);
  });
});

describe('structuralFindings', () => {
  const opts = { frameDuration: FRAME, minClipFrames: 6 };
  const v = (id: string, start: number, end: number, track = 0) =>
    clip({ id, trackType: 'video', trackIndex: track, start, end, inPoint: 0, outPoint: end - start });

  it('flags a flash frame but not a normal clip', () => {
    const codes = structuralFindings([v('a', 0, 5), v('b', 5, 5.08), v('c', 5.08, 9)], opts).map((f) => f.code);
    expect(codes).toEqual(['FLASH_FRAME']);
  });

  it('flags gaps and overlaps per track, not across tracks', () => {
    const findings = structuralFindings([v('a', 0, 5), v('b', 6, 9), v('c', 8.5, 12, 1), v('d', 11, 14, 1)], opts);
    expect(findings.map((f) => [f.code, f.trackIndex])).toEqual([['GAP', 0], ['OVERLAP', 1]]);
    expect(findings[0]).toMatchObject({ at: 5, duration: 1 });
  });

  it('ignores sub-frame rounding noise', () => {
    expect(structuralFindings([v('a', 0, 5), v('b', 5.01, 9)], opts)).toEqual([]);
  });
});

describe('punchInTargets', () => {
  const v = (id: string, start: number, end: number) =>
    clip({ id, trackType: 'video', trackIndex: 0, start, end, inPoint: 0, outPoint: end - start });
  const clips = [v('a', 0, 3), v('b', 3, 6), v('c', 6, 9), v('d', 9, 12), v('e', 12, 15)];

  it('alternates, leaving the opening shot wide', () => {
    expect(punchInTargets(clips, 0, { everyNth: 2, skip: 1, minClipSeconds: 1 })).toEqual(['c', 'e']);
  });

  it('skips clips that are too short', () => {
    const short = [v('a', 0, 3), v('b', 3, 3.5), v('c', 3.5, 8)];
    expect(punchInTargets(short, 0, { everyNth: 1, skip: 1, minClipSeconds: 1 })).toEqual(['c']);
  });

  it('only considers the requested track', () => {
    expect(punchInTargets(clips, 1, { everyNth: 1, skip: 0, minClipSeconds: 0 })).toEqual([]);
  });
});
