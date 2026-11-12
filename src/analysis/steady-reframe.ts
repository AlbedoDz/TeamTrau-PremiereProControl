/**
 * Auto Reframe follows the subject with a path that glides 1-2 s after every camera cut in the
 * source (live on FINAL_01: 0.50 -> 0.38 over a second). Editors want a still frame per shot
 * that jumps on the cut. This turns the generated path into one held position per shot.
 */

export interface PathKey {
  /** Media (source) time in seconds, as Premiere keys the Auto Reframe path. */
  t: number;
  x: number;
  y: number;
}

/** Held positions closer than this (fraction of the frame, ~38 px of 1920) count as one framing. */
const SAME_FRAMING = 0.02;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Linear interpolation of the path at `t`, held flat before the first and after the last key. */
function valueAt(keys: PathKey[], t: number): { x: number; y: number } {
  if (t <= keys[0]!.t) return keys[0]!;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (t <= b.t) {
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
  }
  return keys[keys.length - 1]!;
}

/**
 * One held position per shot of [inPoint, outPoint]: the median of the path inside the shot
 * (the interpolated value at its middle when no key falls inside). Each shot gets a key at its
 * start and one frame before its end, so the frame is still within a shot and jumps on the cut.
 * Returns [] when the path has no keys.
 */
export function steadyPath(keys: PathKey[], cuts: number[], inPoint: number, outPoint: number, frameSec: number): PathKey[] {
  if (keys.length === 0 || outPoint <= inPoint) return [];
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const inner = [...new Set(cuts)].filter((c) => c > inPoint + frameSec && c < outPoint - frameSec).sort((a, b) => a - b);
  const held = (start: number, end: number) => {
    const inside = sorted.filter((k) => k.t >= start && k.t < end);
    return inside.length > 0
      ? { x: median(inside.map((k) => k.x)), y: median(inside.map((k) => k.y)) }
      : valueAt(sorted, (start + end) / 2);
  };
  // Neighbouring shots that would hold nearly the same position are one framing: a jump of a
  // few pixels on a false cut (a light change) reads as the slight move this exists to remove.
  const shots: Array<{ start: number; end: number; at: { x: number; y: number } }> = [];
  const bounds = [inPoint, ...inner, outPoint];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]!;
    const end = bounds[i + 1]!;
    const at = held(start, end);
    const prev = shots[shots.length - 1];
    if (prev && Math.abs(prev.at.x - at.x) < SAME_FRAMING && Math.abs(prev.at.y - at.y) < SAME_FRAMING) {
      prev.end = end;
      prev.at = held(prev.start, end);
    } else {
      shots.push({ start, end, at });
    }
  }
  const out: PathKey[] = [];
  shots.forEach((s, i) => {
    out.push({ t: s.start, x: s.at.x, y: s.at.y });
    const last = i === shots.length - 1 ? s.end : s.end - frameSec;
    if (last > s.start) out.push({ t: last, x: s.at.x, y: s.at.y });
  });
  return out;
}
