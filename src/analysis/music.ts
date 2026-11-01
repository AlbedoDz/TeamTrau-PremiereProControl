/**
 * Tempo, beats, bars and sections from a loudness envelope. The envelope comes from
 * ffmpeg (RMS per 10 ms), so this stays plain arithmetic with no audio decoding.
 *
 * It assumes a steady tempo, as in produced or electronic music. A live recording
 * whose tempo drifts will get a grid that fits the average, and a low confidence.
 */
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export const ENVELOPE_FPS = 100;

export interface DbSample {
  t: number;
  db: number;
}

/** Parses `ametadata=print:key=lavfi.astats.Overall.RMS_level` output, where silence is "-inf". */
export function parseRmsSamples(stdout: string): DbSample[] {
  const out: DbSample[] = [];
  let t: number | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const time = /pts_time:([\d.eE+-]+)/.exec(line);
    if (time) {
      t = Number(time[1]);
      continue;
    }
    const value = /lavfi\.astats\.Overall\.RMS_level=(-?inf|[\d.eE+-]+)/i.exec(line);
    if (value && t !== null) {
      out.push({ t, db: /inf/i.test(value[1]!) ? -120 : Number(value[1]) });
      t = null;
    }
  }
  return out;
}

/** Linear amplitude per 1/ENVELOPE_FPS second, averaged within each bucket. */
export function envelopeFromSamples(samples: DbSample[]): number[] {
  if (samples.length === 0) return [];
  const last = samples[samples.length - 1]!.t;
  const sums = new Array<number>(Math.floor(last * ENVELOPE_FPS) + 1).fill(0);
  const counts = new Array<number>(sums.length).fill(0);
  for (const s of samples) {
    const i = Math.min(sums.length - 1, Math.floor(s.t * ENVELOPE_FPS));
    sums[i]! += Math.pow(10, s.db / 20);
    counts[i]! += 1;
  }
  return sums.map((v, i) => (counts[i]! > 0 ? v / counts[i]! : 0));
}

/** Positive loudness jumps, with the slow average removed so steady loud passages do not count. */
function onsetStrength(env: number[]): number[] {
  const flux = env.map((v, i) => (i === 0 ? 0 : Math.max(0, v - env[i - 1]!)));
  const smooth = flux.map((_, i) => ((flux[i - 1] ?? 0) + 2 * flux[i]! + (flux[i + 1] ?? 0)) / 4);
  const half = ENVELOPE_FPS / 2;
  return smooth.map((v, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(smooth.length - 1, i + half); j++) {
      sum += smooth[j]!;
      n++;
    }
    return Math.max(0, v - sum / n);
  });
}

/** Sum of onset strength at k*period+phase, taking the strongest frame within one frame of each. */
function gridScore(onset: number[], period: number, phase: number): { score: number; hits: number } {
  let score = 0;
  let hits = 0;
  for (let p = phase; p < onset.length - 1; p += period) {
    const i = Math.round(p);
    score += Math.max(onset[i - 1] ?? 0, onset[i] ?? 0, onset[i + 1] ?? 0);
    hits++;
  }
  return { score, hits };
}

export interface RhythmOptions {
  beatsPerBar: number;
  minBpm: number;
  maxBpm: number;
}

export interface Section {
  start: number;
  end: number;
  bars: number;
  energy: number;
  label: 'low' | 'mid' | 'high';
}

export interface Rhythm {
  durationSeconds: number;
  bpm: number;
  /** 0-1: how much stronger the onsets are on the beat grid than elsewhere. Below about 0.3 the tempo is a guess. */
  confidence: number;
  beatsPerBar: number;
  beats: number[];
  downbeats: number[];
  sections: Section[];
}

export function analyseRhythm(env: number[], opts: RhythmOptions): Rhythm | null {
  const durationSeconds = round3(env.length / ENVELOPE_FPS);
  const onset = onsetStrength(env);
  const total = onset.reduce((s, v) => s + v, 0);
  if (env.length < ENVELOPE_FPS * 8 || total <= 0) return null;

  // Tempo: autocorrelation of the onsets, favouring tempi near 120 BPM so half and double time do not win.
  const minLag = Math.floor((ENVELOPE_FPS * 60) / opts.maxBpm);
  const maxLag = Math.ceil((ENVELOPE_FPS * 60) / opts.minBpm);
  const weighted: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let r = 0;
    for (let i = 0; i + lag < onset.length; i++) r += onset[i]! * onset[i + lag]!;
    const bpm = (ENVELOPE_FPS * 60) / lag;
    weighted[lag] = r * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.7, 2));
  }
  let bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if ((weighted[lag] ?? 0) > (weighted[bestLag] ?? 0)) bestLag = lag;

  // Refine to a fraction of a frame: a tiny period error would drift by whole beats over a song.
  let period = bestLag;
  let phase = 0;
  let best = -1;
  for (let p = bestLag - 0.6; p <= bestLag + 0.6; p += 0.01) {
    for (let f = 0; f < p; f += 1) {
      const { score } = gridScore(onset, p, f);
      if (score > best) {
        best = score;
        period = p;
        phase = f;
      }
    }
  }
  // Settle the phase to a tenth of a frame at the chosen period.
  for (let f = phase - 1; f <= phase + 1; f += 0.1) {
    const { score } = gridScore(onset, period, Math.max(0, f));
    if (score > best) {
      best = score;
      phase = Math.max(0, f);
    }
  }

  const beats: number[] = [];
  for (let p = phase; p < onset.length - 1; p += period) beats.push(round3(p / ENVELOPE_FPS));
  const grid = gridScore(onset, period, phase);
  const meanAtBeats = grid.score / Math.max(1, grid.hits);
  const meanOverall = total / onset.length;
  const confidence = round3(clamp01((meanAtBeats / meanOverall - 1) / 6));

  // Downbeat: the offset within a bar whose beats carry the most onset energy.
  const beatStrength = beats.map((t) => {
    const i = Math.round(t * ENVELOPE_FPS);
    return Math.max(onset[i - 1] ?? 0, onset[i] ?? 0, onset[i + 1] ?? 0);
  });
  let downOffset = 0;
  let downBest = -1;
  for (let o = 0; o < opts.beatsPerBar; o++) {
    let sum = 0;
    for (let b = o; b < beats.length; b += opts.beatsPerBar) sum += beatStrength[b]!;
    if (sum > downBest) {
      downBest = sum;
      downOffset = o;
    }
  }
  const downbeats = beats.filter((_, i) => i % opts.beatsPerBar === downOffset);

  return {
    durationSeconds,
    bpm: round3((ENVELOPE_FPS * 60) / period),
    confidence,
    beatsPerBar: opts.beatsPerBar,
    beats,
    downbeats,
    sections: findSections(env, downbeats, durationSeconds),
  };
}

const LOOKAROUND_BARS = 4;
const BOUNDARY_CHANGE = 0.25;
const MIN_SECTION_BARS = 4;

/** Splits the song where the bar loudness changes by a quarter or more, then labels sections by loudness. */
function findSections(env: number[], downbeats: number[], durationSeconds: number): Section[] {
  if (downbeats.length < MIN_SECTION_BARS * 2) {
    return [{ start: 0, end: durationSeconds, bars: downbeats.length, energy: 1, label: 'mid' }];
  }
  const edges = [...downbeats, durationSeconds];
  const barEnergy = downbeats.map((_, i) => {
    const a = Math.floor(edges[i]! * ENVELOPE_FPS);
    const b = Math.max(a + 1, Math.floor(edges[i + 1]! * ENVELOPE_FPS));
    let sum = 0;
    for (let j = a; j < b && j < env.length; j++) sum += env[j]!;
    return sum / (b - a);
  });
  const mean = (from: number, to: number): number => {
    const slice = barEnergy.slice(Math.max(0, from), Math.min(barEnergy.length, to));
    return slice.length ? slice.reduce((s, v) => s + v, 0) / slice.length : 0;
  };
  const change = barEnergy.map((_, i) => {
    const before = mean(i - LOOKAROUND_BARS, i);
    const after = mean(i, i + LOOKAROUND_BARS);
    const top = Math.max(before, after, 1e-9);
    return i < LOOKAROUND_BARS || i > barEnergy.length - LOOKAROUND_BARS ? 0 : Math.abs(after - before) / top;
  });

  const cuts = [0];
  for (let i = 1; i < barEnergy.length; i++) {
    if (change[i]! < BOUNDARY_CHANGE) continue;
    let peak = true;
    for (let j = Math.max(1, i - MIN_SECTION_BARS + 1); j <= Math.min(barEnergy.length - 1, i + MIN_SECTION_BARS - 1); j++) if (change[j]! > change[i]!) peak = false;
    if (peak && i - cuts[cuts.length - 1]! >= MIN_SECTION_BARS) cuts.push(i);
  }
  cuts.push(barEnergy.length);

  const sections = cuts.slice(0, -1).map((startBar, k) => {
    const endBar = cuts[k + 1]!;
    return { startBar, endBar, energy: mean(startBar, endBar) };
  });
  const maxEnergy = Math.max(...sections.map((s) => s.energy), 1e-9);
  const sorted = [...sections].map((s) => s.energy).sort((a, b) => a - b);
  const low = sorted[Math.floor((sorted.length - 1) / 3)]!;
  const high = sorted[Math.ceil(((sorted.length - 1) * 2) / 3)]!;
  return sections.map((s) => ({
    start: round3(s.startBar === 0 ? 0 : edges[s.startBar]!),
    end: round3(edges[s.endBar]!),
    bars: s.endBar - s.startBar,
    energy: round3(s.energy / maxEnergy),
    label: sections.length === 1 ? 'mid' : s.energy <= low ? 'low' : s.energy >= high ? 'high' : 'mid',
  }));
}
