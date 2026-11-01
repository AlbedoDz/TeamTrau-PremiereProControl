import { analyseRhythm, ENVELOPE_FPS, envelopeFromSamples, parseRmsSamples } from '../../analysis/music.js';
import { assignShots, cutSlots } from '../../analysis/beatcut.js';
import type { Candidate } from '../../analysis/roughcut.js';

/** A loudness envelope with a pulse on every beat, a louder one on each downbeat, and a gain per second. */
function clickEnvelope(bpm: number, seconds: number, opts: { offset?: number; gain?: (t: number) => number; accentEvery?: number; accentAt?: number } = {}): number[] {
  const env = new Array<number>(Math.floor(seconds * ENVELOPE_FPS)).fill(0.01);
  const period = (60 / bpm) * ENVELOPE_FPS;
  const accentEvery = opts.accentEvery ?? 4;
  let n = 0;
  for (let p = (opts.offset ?? 0.2) * ENVELOPE_FPS; p < env.length; p += period, n++) {
    const accent = n % accentEvery === (opts.accentAt ?? 0) ? 1 : 0.55;
    for (let k = 0; k < 10; k++) {
      const i = Math.round(p) + k;
      if (i < env.length) env[i] = Math.max(env[i]!, accent * (opts.gain?.(i / ENVELOPE_FPS) ?? 1) * Math.exp(-k / 3));
    }
  }
  return env;
}

const opts = { beatsPerBar: 4, minBpm: 70, maxBpm: 180 };

describe('parseRmsSamples and envelopeFromSamples', () => {
  it('reads RMS lines including -inf, and buckets them to 10 ms', () => {
    const out = 'frame:0 pts:0 pts_time:0\nlavfi.astats.Overall.RMS_level=-20\nframe:1 pts:1 pts_time:0.005\nlavfi.astats.Overall.RMS_level=-inf\nframe:2 pts:2 pts_time:0.02\nlavfi.astats.Overall.RMS_level=-6\n';
    const samples = parseRmsSamples(out);
    expect(samples).toEqual([{ t: 0, db: -20 }, { t: 0.005, db: -120 }, { t: 0.02, db: -6 }]);
    const env = envelopeFromSamples(samples);
    expect(env).toHaveLength(3);
    expect(env[0]).toBeCloseTo((0.1 + 1e-6) / 2, 4);
    expect(env[2]).toBeCloseTo(0.501, 2);
  });
});

describe('analyseRhythm', () => {
  it.each([90, 120, 140])('finds %i BPM and puts the beats on the pulses', (bpm) => {
    const r = analyseRhythm(clickEnvelope(bpm, 60), opts)!;
    expect(r.bpm).toBeGreaterThan(bpm - 1);
    expect(r.bpm).toBeLessThan(bpm + 1);
    expect(r.confidence).toBeGreaterThan(0.3);
    const period = 60 / bpm;
    // beats[k] should sit on 0.2 + k*period, within 30 ms, across the whole minute (no drift)
    for (const k of [0, 10, r.beats.length - 3]) {
      const expected = 0.2 + Math.round((r.beats[k]! - 0.2) / period) * period;
      expect(Math.abs(r.beats[k]! - expected)).toBeLessThan(0.03);
    }
  });

  it('picks the accented beat as the downbeat', () => {
    const r = analyseRhythm(clickEnvelope(120, 40, { accentAt: 2 }), opts)!;
    const accentTimes = [0.2 + 2 * 0.5, 0.2 + 6 * 0.5];
    expect(Math.abs(r.downbeats.find((d) => Math.abs(d - accentTimes[0]!) < 0.1)! - accentTimes[0]!)).toBeLessThan(0.03);
    expect(r.downbeats[1]! - r.downbeats[0]!).toBeCloseTo(2, 1);
  });

  it('splits a quiet half from a loud half and labels them', () => {
    const r = analyseRhythm(clickEnvelope(120, 64, { gain: (t) => (t < 32 ? 0.3 : 1) }), opts)!;
    expect(r.sections.length).toBeGreaterThanOrEqual(2);
    const boundary = r.sections[1]!.start;
    expect(Math.abs(boundary - 32)).toBeLessThan(4);
    expect(r.sections[0]!.label).toBe('low');
    expect(r.sections[r.sections.length - 1]!.label).toBe('high');
  });

  it('gives up on silence and on clips too short to judge', () => {
    expect(analyseRhythm(new Array(2000).fill(0), opts)).toBeNull();
    expect(analyseRhythm(clickEnvelope(120, 4), opts)).toBeNull();
  });
});

describe('cutSlots', () => {
  const FRAME = 1 / 25;
  const rhythm = analyseRhythm(clickEnvelope(120, 40, { gain: (t) => (t < 20 ? 0.3 : 1) }), opts)!;
  const base = { frameDuration: FRAME, durationSeconds: 40 };

  it('covers the song from 0 to the end with no gaps, on the frame grid', () => {
    const slots = cutSlots(rhythm, { ...base, preset: 'balanced' });
    expect(slots[0]!.start).toBe(0);
    expect(slots[slots.length - 1]!.end).toBe(40);
    slots.forEach((s, i) => {
      if (i > 0) expect(s.start).toBeCloseTo(slots[i - 1]!.end, 3);
      expect(Math.abs(s.end / FRAME - Math.round(s.end / FRAME))).toBeLessThan(1e-3);
    });
  });

  it('cuts faster in loud sections than quiet ones', () => {
    const slots = cutSlots(rhythm, { ...base, preset: 'energetic' });
    const quiet = slots.filter((s) => s.label === 'low').map((s) => s.beats);
    const loud = slots.filter((s) => s.label === 'high').map((s) => s.beats);
    expect(Math.min(...quiet)).toBeGreaterThan(Math.max(...loud));
  });

  it('honours a fixed beats-per-cut and is repeatable', () => {
    const a = cutSlots(rhythm, { ...base, preset: 'calm', cutEveryBeats: 4 });
    const b = cutSlots(rhythm, { ...base, preset: 'calm', cutEveryBeats: 4 });
    expect(a).toEqual(b);
    expect(a.slice(1, -1).every((s) => s.beats === 4)).toBe(true);
  });
});

describe('assignShots', () => {
  const FRAME = 1 / 25;
  const cand = (name: string, score: number): Candidate => ({ mediaPath: name, sourceDuration: 20, start: 4, end: 7, score });
  const slots = [
    { start: 0, end: 2, beats: 4, label: 'low' as const },
    { start: 2, end: 3, beats: 2, label: 'high' as const },
    { start: 3, end: 5, beats: 4, label: 'mid' as const },
  ];

  it('gives the best footage to the loudest slot and keeps timeline order', () => {
    const { shots, reused } = assignShots(slots, [cand('weak', 0.1), cand('best', 0.9), cand('ok', 0.5)], FRAME);
    expect(reused).toBe(0);
    expect(shots.map((s) => s.mediaPath)).toEqual(['weak', 'best', 'ok']);
    expect(shots.map((s) => s.timelineStart)).toEqual([0, 2, 3]);
    expect(shots.map((s) => +(s.out - s.in).toFixed(2))).toEqual([2, 1, 2]);
  });

  it('reuses the best footage, from a later point, when it runs out', () => {
    const { shots, reused } = assignShots(slots, [cand('only', 0.9)], FRAME);
    expect(reused).toBe(2);
    expect(new Set(shots.map((s) => s.in)).size).toBe(3);
  });

  it('returns nothing without footage', () => {
    expect(assignShots(slots, [], FRAME)).toEqual({ shots: [], reused: 0 });
  });
});
