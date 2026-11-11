/**
 * Recap planning: picks the segments of a recap from scored speech windows or scored shots.
 * Plain data in, plain data out; no I/O. A speech segment is always a run of whole sentences
 * (it comes straight from a candidate window); a shot segment never leaves its shot.
 */
import type { Candidate } from './highlights.js';
import type { Sentence } from './transcript.js';

export interface RecapOpts {
  targetSec: number;
  minSegmentSec: number;
  maxSegmentSec: number;
  /** Frame length in seconds: shots closer than this are time-adjacent. Default 1/24. */
  frameSec?: number;
}

export interface RecapSegment {
  id: string;
  start: number;
  end: number;
  text?: string;
  score: number;
}

/** Shot already reduced to its best stretch, on sequence time. */
export interface ScoredShot {
  start: number;
  end: number;
  score: number;
}

/** One chapter per this many seconds of the target. */
export const CHAPTER_SEC = 12;
/** The recap total may miss the target by this fraction either way. */
export const TARGET_TOLERANCE = 0.1;
const JACCARD_DUPLICATE = 0.6;
const EPS = 1e-6;

/** Share of the sequence (0-1) covered by the sentences. */
export function speechCoverage(sentences: Sentence[], total: number): number {
  if (!(total > 0)) return 0;
  let covered = 0;
  let end = -Infinity;
  for (const s of [...sentences].sort((a, b) => a.start - b.start)) {
    const from = Math.max(s.start, end);
    if (s.end > from) covered += s.end - from;
    end = Math.max(end, s.end);
  }
  return Math.min(1, covered / total);
}

const tokens = (text: string | undefined): Set<string> =>
  new Set((text ?? '').normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

const overlaps = (a: RecapSegment, b: RecapSegment): boolean => a.start < b.end - EPS && b.start < a.end - EPS;
const byScore = (a: RecapSegment, b: RecapSegment): number => b.score - a.score || a.start - b.start;
const byStart = (a: RecapSegment, b: RecapSegment): number => a.start - b.start || a.end - b.end;
const duration = (s: RecapSegment): number => s.end - s.start;

export const chapterCount = (targetSec: number): number => Math.max(1, Math.ceil(targetSec / CHAPTER_SEC));

/** Speech windows as segments: the window edges are sentence edges. */
export function speechPool(scored: Candidate[]): RecapSegment[] {
  return scored.map((c) => ({
    id: `s${c.startSentenceId}-${c.endSentenceId}`,
    start: c.start,
    end: c.end,
    text: c.text,
    score: c.rawScore,
  }));
}

/**
 * Shots as segments. A segment is a run of time-adjacent shots (gap at most one frame) whose
 * length is between minSegmentSec and maxSegmentSec, scored by the mean of its shots; a single shot
 * of at least minSegmentSec is a run of one, cut down to maxSegmentSec from its start when longer.
 * Isolated shots shorter than minSegmentSec cannot form a run and are not offered.
 */
export function shotPool(shots: ScoredShot[], opts: RecapOpts): RecapSegment[] {
  const sorted = [...shots].filter((s) => s.end - s.start > EPS).sort((a, b) => a.start - b.start);
  const gap = (opts.frameSec ?? 1 / 24) + EPS;
  const pool: RecapSegment[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let scoreSum = 0;
    for (let j = i; j < sorted.length; j++) {
      if (j > i && sorted[j]!.start - sorted[j - 1]!.end > gap) break;
      const first = sorted[i]!;
      const last = sorted[j]!;
      scoreSum += last.score;
      const span = last.end - first.start;
      if (j === i) {
        if (span >= opts.minSegmentSec - EPS) {
          pool.push({ id: `shot-${i}`, start: first.start, end: Math.min(first.end, first.start + opts.maxSegmentSec), score: first.score });
        }
        if (span > opts.maxSegmentSec + EPS) break; // a long shot is only ever alone
        continue;
      }
      if (span > opts.maxSegmentSec + EPS) break;
      if (span >= opts.minSegmentSec - EPS) pool.push({ id: `shot-${i}-${j}`, start: first.start, end: last.end, score: scoreSum / (j - i + 1) });
    }
  }
  return pool;
}

/**
 * Greedy by chapter (the best fitting segment of each), then by score until the total reaches the
 * target. Never overlaps, never keeps two near-identical texts, never exceeds target + 10%.
 * `trimmable` lets the last segment be cut short to land inside the tolerance (shots only).
 */
function select(pool: RecapSegment[], total: number, opts: RecapOpts, trimmable: boolean): RecapSegment[] {
  const k = chapterCount(opts.targetSec);
  const hi = opts.targetSec * (1 + TARGET_TOLERANCE);
  const eligible = pool
    .filter((p) => duration(p) > EPS && (trimmable || (duration(p) >= opts.minSegmentSec - EPS && duration(p) <= opts.maxSegmentSec + EPS)))
    .sort(byScore);
  const toks = new Map(eligible.map((p) => [p.id, tokens(p.text)]));
  const chosen: RecapSegment[] = [];
  let sum = 0;

  const conflicts = (p: RecapSegment): boolean =>
    chosen.some((c) => c.id === p.id || overlaps(c, p) || jaccard(toks.get(c.id) ?? tokens(c.text), toks.get(p.id)!) >= JACCARD_DUPLICATE);
  const fit = (p: RecapSegment, reserve: number): RecapSegment | null => {
    const len = duration(p);
    if (sum + len + reserve <= hi + EPS) return p;
    if (!trimmable) return null;
    const room = hi - sum - reserve;
    return room >= Math.min(opts.minSegmentSec, len) - EPS && room > EPS ? { ...p, end: p.start + room } : null;
  };
  const chapterOf = (p: RecapSegment): number =>
    total > 0 ? Math.max(0, Math.min(k - 1, Math.floor(((p.start + p.end) / 2) / (total / k)))) : 0;

  for (let chapter = 0; chapter < k; chapter++) {
    const reserve = (k - 1 - chapter) * opts.minSegmentSec;
    for (const p of eligible) {
      if (chapterOf(p) !== chapter || conflicts(p)) continue;
      const fitted = fit(p, reserve);
      if (!fitted) continue;
      chosen.push(fitted);
      sum += duration(fitted);
      break;
    }
  }

  while (sum < opts.targetSec - EPS && chosen.length < k * 3) {
    let added = false;
    for (const p of eligible) {
      if (conflicts(p)) continue;
      const fitted = fit(p, 0);
      if (!fitted) continue;
      chosen.push(fitted);
      sum += duration(fitted);
      added = true;
      break;
    }
    if (!added) break;
  }

  while (sum > hi + EPS && chosen.length > 1) {
    const worst = [...chosen].sort((a, b) => a.score - b.score || duration(b) - duration(a))[0]!;
    chosen.splice(chosen.indexOf(worst), 1);
    sum -= duration(worst);
  }
  return chosen.sort(byStart);
}

export function planSpeechRecap(scored: Candidate[], total: number, opts: RecapOpts): RecapSegment[] {
  return select(speechPool(scored), total, opts, false);
}

export function planShotRecap(shots: ScoredShot[], total: number, opts: RecapOpts): RecapSegment[] {
  return select(shotPool(shots, opts), total, opts, true);
}

/** The chosen segments plus the best other non-overlapping, non-duplicate ones, at most 3 per chapter. */
export function recapCandidates(pool: RecapSegment[], chosen: RecapSegment[], opts: RecapOpts): RecapSegment[] {
  const limit = chapterCount(opts.targetSec) * 3;
  const list = [...chosen];
  const toks = new Map<string, Set<string>>();
  const tok = (s: RecapSegment): Set<string> => {
    let t = toks.get(s.id);
    if (!t) toks.set(s.id, (t = tokens(s.text)));
    return t;
  };
  for (const p of [...pool].sort(byScore)) {
    if (list.length >= limit) break;
    if (duration(p) <= EPS) continue;
    if (list.some((c) => c.id === p.id || overlaps(c, p) || jaccard(tok(c), tok(p)) >= JACCARD_DUPLICATE)) continue;
    list.push(p);
  }
  return list.sort(byStart);
}

export interface ScoredWindow {
  start: number;
  end: number;
  score: number;
}

/**
 * Best run of consecutive windows inside [from, to] (a shot, source time) whose span is at most
 * maxSec: the run with the highest mean score, longer on a tie. A run is at least
 * min(minSec, shot length) long when one exists. Windows are those inside the shot, or, when
 * none is, those whose middle is inside it. The returned span is cut to the shot.
 */
export function bestShotRun(windows: ScoredWindow[], from: number, to: number, minSec: number, maxSec: number): ScoredShot | null {
  if (!(to - from > EPS)) return null;
  let inside = windows.filter((w) => w.start >= from - EPS && w.end <= to + EPS);
  if (inside.length === 0) inside = windows.filter((w) => (w.start + w.end) / 2 >= from && (w.start + w.end) / 2 <= to);
  inside = [...inside].sort((a, b) => a.start - b.start);
  if (inside.length === 0) return null;

  const wantSec = Math.min(minSec, to - from);
  const runs: Array<ScoredShot & { span: number }> = [];
  for (let i = 0; i < inside.length; i++) {
    let sum = 0;
    for (let j = i; j < inside.length; j++) {
      if (j > i && inside[j]!.start > inside[j - 1]!.end + EPS) break; // a gap ends the run
      sum += inside[j]!.score;
      const start = Math.max(from, inside[i]!.start);
      const end = Math.min(to, inside[j]!.end);
      const span = end - start;
      if (span > maxSec + EPS) break;
      runs.push({ start, end, span, score: sum / (j - i + 1) });
    }
  }
  const long = runs.filter((r) => r.span >= wantSec - EPS);
  const pool = long.length > 0 ? long : runs;
  if (pool.length === 0) return null;
  const best = pool.reduce((a, b) => (b.score > a.score + EPS || (Math.abs(b.score - a.score) <= EPS && b.span > a.span) ? b : a));
  return { start: best.start, end: best.end, score: best.score };
}
