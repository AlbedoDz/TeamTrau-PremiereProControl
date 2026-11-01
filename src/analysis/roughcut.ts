/**
 * Choosing footage for a rough cut: score stretches of each file for exposure and
 * sharpness, pick the best non-overlapping ones, and lay them out to a target
 * duration. Everything here is plain data in, plain data out.
 *
 * Shake and motion are deliberately not scored. Metrics are sampled on keyframes
 * (or one frame per second), too far apart to tell camera shake from a pan.
 */
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export interface FrameSample {
  t: number;
  v: number;
}

/** Reads ffmpeg `metadata=print` output: "pts_time:T" then "key=value" for one frame. */
export function parseMetric(stdout: string, key = 'lavfi.signalstats.YAVG'): FrameSample[] {
  const samples: FrameSample[] = [];
  let t: number | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const time = /pts_time:([\d.eE+-]+)/.exec(line);
    if (time) {
      t = Number(time[1]);
      continue;
    }
    const value = new RegExp(`${key.replace(/\./g, '\\.')}=([\\d.eE+-]+)`).exec(line);
    if (value && t !== null) {
      samples.push({ t, v: Number(value[1]) });
      t = null;
    }
  }
  return samples;
}

export interface WindowScore {
  start: number;
  end: number;
  score: number;
  exposure: number;
  sharpness: number;
  flags: string[];
}

const MID_LUMA = 118;
const DARK_LUMA = 45;
const BRIGHT_LUMA = 205;
/** Mean edge-map brightness at 320 px wide at which a frame counts as fully sharp. */
const SHARP_EDGE_MEAN = 12;

const meanIn = (samples: FrameSample[], from: number, to: number): number | null => {
  const inside = samples.filter((s) => s.t >= from && s.t < to);
  if (inside.length > 0) return inside.reduce((sum, s) => sum + s.v, 0) / inside.length;
  // No sample inside a short window: use the nearest one so sparse keyframes still score.
  const centre = (from + to) / 2;
  let nearest: FrameSample | undefined;
  for (const s of samples) if (!nearest || Math.abs(s.t - centre) < Math.abs(nearest.t - centre)) nearest = s;
  return nearest ? nearest.v : null;
};

/** Overlapping windows (half a window apart) with exposure and sharpness scores. */
export function scoreWindows(luma: FrameSample[], edge: FrameSample[], duration: number, windowSeconds: number): WindowScore[] {
  if (luma.length === 0 || edge.length === 0 || duration < windowSeconds) return [];
  const windows: WindowScore[] = [];
  const step = windowSeconds / 2;
  for (let start = 0; start + windowSeconds <= duration + 1e-6; start += step) {
    const end = start + windowSeconds;
    const l = meanIn(luma, start, end);
    const e = meanIn(edge, start, end);
    if (l === null || e === null) continue;
    const exposure = clamp01(1 - Math.abs(l - MID_LUMA) / MID_LUMA);
    const sharpness = clamp01(e / SHARP_EDGE_MEAN);
    const flags: string[] = [];
    if (l < DARK_LUMA) flags.push('dark');
    if (l > BRIGHT_LUMA) flags.push('bright');
    if (sharpness < 0.25) flags.push('soft or flat');
    windows.push({ start: round3(start), end: round3(end), score: round3(0.45 * exposure + 0.55 * sharpness), exposure: round3(exposure), sharpness: round3(sharpness), flags });
  }
  return windows;
}

/** The highest-scoring windows that do not overlap and sit at least minGapSeconds apart. */
export function bestWindows(windows: WindowScore[], topN: number, minGapSeconds: number): WindowScore[] {
  const chosen: WindowScore[] = [];
  for (const w of [...windows].sort((a, b) => b.score - a.score || a.start - b.start)) {
    if (chosen.length >= topN) break;
    if (chosen.every((c) => w.start >= c.end + minGapSeconds || w.end <= c.start - minGapSeconds)) chosen.push(w);
  }
  return chosen.sort((a, b) => a.start - b.start);
}

export interface Candidate {
  mediaPath: string;
  sourceDuration: number;
  start: number;
  end: number;
  score: number;
}

export interface Shot {
  mediaPath: string;
  in: number;
  out: number;
  score: number;
  timelineStart: number;
}

export interface RoughCutOptions {
  targetSeconds: number;
  shotSeconds: number;
  frameDuration: number;
  maxPerFile: number;
  order: 'chronological' | 'score';
}

const floorToFrames = (seconds: number, frame: number): number => Math.floor(seconds / frame + 1e-6) * frame;

/**
 * Picks the best candidates (each used once, at most maxPerFile per file), gives
 * every shot an equal share of the target on the frame grid, and the remainder to
 * the last. Returns what it could build; shortfallSeconds is non-zero when the
 * footage ran out.
 */
export function planRoughCut(candidates: Candidate[], opts: RoughCutOptions): { shots: Shot[]; totalSeconds: number; shortfallSeconds: number } {
  const wanted = Math.max(1, Math.round(opts.targetSeconds / opts.shotSeconds));
  const perFile = new Map<string, number>();
  const picked: Candidate[] = [];
  for (const c of [...candidates].sort((a, b) => b.score - a.score || a.mediaPath.localeCompare(b.mediaPath) || a.start - b.start)) {
    if (picked.length >= wanted) break;
    if ((perFile.get(c.mediaPath) ?? 0) >= opts.maxPerFile) continue;
    perFile.set(c.mediaPath, (perFile.get(c.mediaPath) ?? 0) + 1);
    picked.push(c);
  }
  if (picked.length === 0) return { shots: [], totalSeconds: 0, shortfallSeconds: round3(opts.targetSeconds) };

  picked.sort(
    opts.order === 'score'
      ? (a, b) => b.score - a.score
      : (a, b) => a.mediaPath.localeCompare(b.mediaPath, undefined, { numeric: true }) || a.start - b.start,
  );

  const each = floorToFrames(opts.targetSeconds / picked.length, opts.frameDuration);
  const shots: Shot[] = [];
  let cursor = 0;
  picked.forEach((c, i) => {
    const isLast = i === picked.length - 1;
    const wantDuration = isLast ? floorToFrames(opts.targetSeconds - cursor, opts.frameDuration) : each;
    const duration = Math.min(wantDuration, floorToFrames(c.sourceDuration, opts.frameDuration));
    if (duration <= 0) return;
    // Keep the window's start, but slide earlier if the longer shot would run off the file.
    const start = Math.max(0, Math.min(c.start, c.sourceDuration - duration));
    shots.push({ mediaPath: c.mediaPath, in: round3(start), out: round3(start + duration), score: c.score, timelineStart: round3(cursor) });
    cursor += duration;
  });
  return { shots, totalSeconds: round3(cursor), shortfallSeconds: round3(Math.max(0, opts.targetSeconds - cursor)) };
}
