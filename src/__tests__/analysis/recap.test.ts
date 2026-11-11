import {
  bestShotRun,
  chapterCount,
  jaccard,
  planShotRecap,
  planSpeechRecap,
  recapCandidates,
  shotPool,
  speechCoverage,
  speechPool,
  type RecapOpts,
  type ScoredShot,
} from '../../analysis/recap.js';
import type { Candidate } from '../../analysis/highlights.js';
import type { Sentence } from '../../analysis/transcript.js';

const OPTS: RecapOpts = { targetSec: 90, minSegmentSec: 4, maxSegmentSec: 20 };
const TOTAL = 600;
const K = chapterCount(OPTS.targetSec);

/** One 10 s sentence every 10 s; a candidate per sentence, plus 2-sentence windows. */
const sentences: Sentence[] = Array.from({ length: 60 }, (_, i) => ({
  id: i, start: i * 10, end: i * 10 + 9.5, text: `một${i} hai${i} ba${i} bốn${i} chung`, firstWord: i, lastWord: i,
}));
const cand = (i: number, j: number, score: number): Candidate => ({
  startSentenceId: i,
  endSentenceId: j,
  start: sentences[i]!.start,
  end: sentences[j]!.end,
  text: sentences.slice(i, j + 1).map((s) => s.text).join(' '),
  signals: { wordsPerSec: 0, loudnessRel: 0, hasQuestion: false, hasExclaim: false, fillerRate: 0, maxPauseSec: 0, multiFaceRatio: 0 },
  rawScore: score,
});
// Score varies pseudo-randomly but deterministically.
const scored: Candidate[] = sentences.map((_, i) => cand(i, i, ((i * 37) % 11) / 10));

describe('speechCoverage', () => {
  it('is the unioned sentence time over the total', () => {
    expect(speechCoverage(sentences, TOTAL)).toBeCloseTo(570 / 600, 5);
    expect(speechCoverage([{ id: 0, start: 0, end: 10, text: '', firstWord: 0, lastWord: 0 }, { id: 1, start: 5, end: 15, text: '', firstWord: 0, lastWord: 0 }], 100)).toBeCloseTo(0.15, 5);
  });
  it('is 0 for no sentences or no length', () => {
    expect(speechCoverage([], 100)).toBe(0);
    expect(speechCoverage(sentences, 0)).toBe(0);
  });
});

describe('planSpeechRecap', () => {
  const segments = planSpeechRecap(scored, TOTAL, OPTS);
  const total = segments.reduce((s, x) => s + (x.end - x.start), 0);

  it('lands within the target tolerance', () => {
    expect(total).toBeGreaterThanOrEqual(81);
    expect(total).toBeLessThanOrEqual(99);
  });

  it('covers at least K-1 of the K chapters', () => {
    const chapters = new Set(segments.map((s) => Math.min(K - 1, Math.floor(((s.start + s.end) / 2) / (TOTAL / K)))));
    expect(chapters.size).toBeGreaterThanOrEqual(K - 1);
  });

  it('returns whole sentences in time order without overlap or duplicates', () => {
    for (const s of segments) {
      expect(sentences.some((x) => x.start === s.start)).toBe(true);
      expect(sentences.some((x) => x.end === s.end)).toBe(true);
    }
    for (let i = 1; i < segments.length; i++) expect(segments[i]!.start).toBeGreaterThanOrEqual(segments[i - 1]!.end);
    expect(segments.map((s) => s.start)).toEqual([...segments.map((s) => s.start)].sort((a, b) => a - b));
    const tok = (t: string) => new Set(t.split(/\s+/));
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) expect(jaccard(tok(segments[i]!.text!), tok(segments[j]!.text!))).toBeLessThan(0.6);
    }
  });

  it('gives stable ids from the sentence ids', () => {
    expect(segments[0]!.id).toMatch(/^s\d+-\d+$/);
    expect(speechPool([cand(3, 4, 1)])[0]!.id).toBe('s3-4');
  });

  it('keeps only one of two near-identical passages', () => {
    const a = cand(0, 0, 5);
    const b = { ...cand(30, 30, 9), text: a.text }; // the same words said again later
    const out = planSpeechRecap([a, b, cand(15, 15, 1), cand(45, 45, 1)], TOTAL, { ...OPTS, targetSec: 30 });
    expect(out.filter((s) => s.id === 's0-0' || s.id === 's30-30')).toHaveLength(1);
  });

  it('never exceeds the tolerance when long windows are offered', () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ ...cand(i * 2, i * 2 + 1, i / 30) }));
    const out = planSpeechRecap(long, TOTAL, OPTS);
    const sum = out.reduce((s, x) => s + (x.end - x.start), 0);
    expect(sum).toBeLessThanOrEqual(99);
    expect(sum).toBeGreaterThanOrEqual(81);
  });

  it('returns nothing without candidates', () => {
    expect(planSpeechRecap([], TOTAL, OPTS)).toEqual([]);
  });

  it('keeps candidates to 3 per chapter, always including the segments', () => {
    const candidates = recapCandidates(speechPool(scored), segments, OPTS);
    expect(candidates.length).toBeLessThanOrEqual(3 * K);
    for (const s of segments) expect(candidates.some((c) => c.id === s.id)).toBe(true);
    expect(candidates.length).toBeGreaterThan(segments.length);
  });
});

describe('shot recap', () => {
  // 100 shots of 6 s, the score cycling.
  const shots: ScoredShot[] = Array.from({ length: 100 }, (_, i) => ({ start: i * 6, end: i * 6 + 6, score: ((i * 13) % 17) / 17 }));
  const shotOpts: RecapOpts = { targetSec: 90, minSegmentSec: 4, maxSegmentSec: 6 };

  it('keeps every segment within 6 s and the total within 10%', () => {
    const segments = planShotRecap(shots, TOTAL, shotOpts);
    for (const s of segments) expect(s.end - s.start).toBeLessThanOrEqual(6 + 1e-9);
    const total = segments.reduce((sum, x) => sum + (x.end - x.start), 0);
    expect(total).toBeGreaterThanOrEqual(81);
    expect(total).toBeLessThanOrEqual(99);
  });

  it('spreads over the chapters and stays in time order', () => {
    const segments = planShotRecap(shots, TOTAL, shotOpts);
    const chapters = new Set(segments.map((s) => Math.min(K - 1, Math.floor(((s.start + s.end) / 2) / (TOTAL / K)))));
    expect(chapters.size).toBeGreaterThanOrEqual(K - 1);
    for (let i = 1; i < segments.length; i++) expect(segments[i]!.start).toBeGreaterThanOrEqual(segments[i - 1]!.end);
    expect(segments[0]!.id).toMatch(/^shot-\d+$/);
  });

  it('cuts a long shot down to the maximum and the last segment to fit the target', () => {
    const long: ScoredShot[] = [{ start: 0, end: 30, score: 1 }, { start: 100, end: 130, score: 0.9 }];
    const [first] = shotPool(long, shotOpts);
    expect(first!.end - first!.start).toBe(6);
    const small = planShotRecap(long, TOTAL, { targetSec: 10, minSegmentSec: 4, maxSegmentSec: 6 });
    const sum = small.reduce((s, x) => s + (x.end - x.start), 0);
    expect(sum).toBeLessThanOrEqual(11);
    expect(sum).toBeGreaterThanOrEqual(9);
  });
});

describe('bestShotRun', () => {
  const windows = [0, 1, 2, 3, 4, 5].map((s) => ({ start: s, end: s + 2, score: s === 3 || s === 4 ? 0.9 : 0.2 }));
  it('takes the best consecutive run within the maximum', () => {
    const run = bestShotRun(windows, 0, 7, 3, 6)!;
    expect(run).toMatchObject({ start: 3, end: 6 });
    expect(run.score).toBeCloseTo(0.9, 5);
    // a longer minimum forces the run to take a weaker neighbour
    const longer = bestShotRun(windows, 0, 7, 4, 6)!;
    expect(longer.end - longer.start).toBeGreaterThanOrEqual(4);
    expect(longer.score).toBeCloseTo((0.2 + 0.9 + 0.9) / 3, 5);
  });
  it('cuts a window that crosses the shot edge and falls back to windows by their middle', () => {
    const run = bestShotRun([{ start: 0, end: 2, score: 0.5 }], 0.5, 1.5, 4, 6)!;
    expect(run).toMatchObject({ start: 0.5, end: 1.5, score: 0.5 });
    expect(bestShotRun([], 0, 5, 4, 6)).toBeNull();
  });
});
