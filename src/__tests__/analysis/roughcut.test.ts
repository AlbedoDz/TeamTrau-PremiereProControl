import { bestWindows, parseMetric, planRoughCut, scoreWindows, type Candidate } from '../../analysis/roughcut.js';

const FRAME = 1 / 25;
const samples = (pairs: Array<[number, number]>) => pairs.map(([t, v]) => ({ t, v }));

describe('parseMetric', () => {
  it('pairs each pts_time with the value that follows', () => {
    const out = 'frame:0    pts:0       pts_time:0\nlavfi.signalstats.YAVG=125.97\nframe:1    pts:128000  pts_time:10\nlavfi.signalstats.YAVG=90.5\n';
    expect(parseMetric(out)).toEqual([{ t: 0, v: 125.97 }, { t: 10, v: 90.5 }]);
  });

  it('returns nothing for unrelated output', () => {
    expect(parseMetric('no metrics here')).toEqual([]);
  });
});

describe('scoreWindows', () => {
  const dense = (luma: number, edge: number) => ({
    luma: samples([0, 1, 2, 3, 4, 5, 6, 7].map((t) => [t, luma])),
    edge: samples([0, 1, 2, 3, 4, 5, 6, 7].map((t) => [t, edge])),
  });

  it('scores a well-exposed sharp stretch near 1 with no flags', () => {
    const { luma, edge } = dense(118, 12);
    const [first] = scoreWindows(luma, edge, 8, 3);
    expect(first).toMatchObject({ start: 0, end: 3, score: 1, flags: [] });
  });

  it('flags dark and soft stretches and scores them low', () => {
    const { luma, edge } = dense(20, 1);
    const [first] = scoreWindows(luma, edge, 8, 3);
    expect(first!.flags).toEqual(['dark', 'soft or flat']);
    expect(first!.score).toBeLessThan(0.2);
  });

  it('overlaps windows by half and stops before the end of the file', () => {
    const { luma, edge } = dense(118, 12);
    expect(scoreWindows(luma, edge, 8, 3).map((w) => w.start)).toEqual([0, 1.5, 3, 4.5]);
  });

  it('falls back to the nearest sample when keyframes are sparse', () => {
    const windows = scoreWindows(samples([[0, 118], [10, 118]]), samples([[0, 12], [10, 12]]), 12, 3);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.every((w) => w.score === 1)).toBe(true);
  });

  it('returns nothing when the file is shorter than a window or has no samples', () => {
    expect(scoreWindows(samples([[0, 100]]), samples([[0, 5]]), 2, 3)).toEqual([]);
    expect(scoreWindows([], [], 10, 3)).toEqual([]);
  });
});

describe('bestWindows', () => {
  const w = (start: number, score: number) => ({ start, end: start + 3, score, exposure: 1, sharpness: 1, flags: [] });

  it('takes the best non-overlapping windows in time order', () => {
    const picked = bestWindows([w(0, 0.9), w(1.5, 1), w(3, 0.8), w(9, 0.7)], 2, 0);
    expect(picked.map((p) => p.start)).toEqual([1.5, 9]);
  });

  it('keeps a minimum gap between picks', () => {
    const picked = bestWindows([w(0, 1), w(3, 0.9), w(10, 0.5)], 3, 2);
    expect(picked.map((p) => p.start)).toEqual([0, 10]);
  });
});

describe('planRoughCut', () => {
  const cand = (mediaPath: string, start: number, score: number, sourceDuration = 60): Candidate => ({
    mediaPath, sourceDuration, start, end: start + 3, score,
  });
  const base = { targetSeconds: 12, shotSeconds: 3, frameDuration: FRAME, maxPerFile: 2, order: 'chronological' as const };

  it('fills the target to within a frame, laid back to back', () => {
    const plan = planRoughCut([cand('a.mp4', 0, 0.9), cand('b.mp4', 5, 0.8), cand('c.mp4', 9, 0.7), cand('d.mp4', 2, 0.6), cand('e.mp4', 1, 0.1)], base);
    expect(plan.shots).toHaveLength(4);
    expect(Math.abs(plan.totalSeconds - 12)).toBeLessThanOrEqual(FRAME);
    plan.shots.forEach((s, i) => {
      if (i > 0) expect(s.timelineStart).toBeCloseTo(plan.shots[i - 1]!.timelineStart + (plan.shots[i - 1]!.out - plan.shots[i - 1]!.in), 3);
    });
  });

  it('uses each candidate once and respects maxPerFile', () => {
    const plan = planRoughCut([cand('a.mp4', 0, 0.9), cand('a.mp4', 10, 0.8), cand('a.mp4', 20, 0.7), cand('b.mp4', 0, 0.1), cand('c.mp4', 0, 0.05)], { ...base, targetSeconds: 15 });
    expect(plan.shots.filter((s) => s.mediaPath === 'a.mp4')).toHaveLength(2);
    expect(plan.shots).toHaveLength(4);
  });

  it('orders by file name and time, or by score', () => {
    const list = [cand('b.mp4', 0, 0.9), cand('a.mp4', 8, 0.5), cand('a.mp4', 2, 0.4)];
    expect(planRoughCut(list, { ...base, targetSeconds: 9 }).shots.map((s) => `${s.mediaPath}@${s.in}`)).toEqual(['a.mp4@2', 'a.mp4@8', 'b.mp4@0']);
    expect(planRoughCut(list, { ...base, targetSeconds: 9, order: 'score' }).shots.map((s) => s.mediaPath)).toEqual(['b.mp4', 'a.mp4', 'a.mp4']);
  });

  it('slides a shot earlier rather than running off the end of its file', () => {
    const plan = planRoughCut([cand('a.mp4', 8, 1, 10)], { ...base, targetSeconds: 6, maxPerFile: 1 });
    expect(plan.shots[0]).toMatchObject({ in: 4, out: 10 });
  });

  it('reports a shortfall when the footage runs out', () => {
    const plan = planRoughCut([cand('a.mp4', 0, 1, 4)], { ...base, targetSeconds: 12, maxPerFile: 1 });
    expect(plan.totalSeconds).toBe(4);
    expect(plan.shortfallSeconds).toBe(8);
  });

  it('returns an empty plan with no candidates', () => {
    expect(planRoughCut([], base)).toEqual({ shots: [], totalSeconds: 0, shortfallSeconds: 12 });
  });
});
