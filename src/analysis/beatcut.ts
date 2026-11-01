/**
 * Cutting footage to a song: turn the beat grid and section loudness into cut
 * points, then give each slot a stretch of footage, best shots to the loudest parts.
 */
import type { Rhythm, Section } from './music.js';
import type { Candidate, Shot } from './roughcut.js';

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export type Preset = 'calm' | 'balanced' | 'energetic';

/** Beats per shot in a low, mid and high energy section. */
const BEATS_PER_CUT: Record<Preset, Record<Section['label'], number>> = {
  calm: { low: 8, mid: 8, high: 4 },
  balanced: { low: 4, mid: 4, high: 2 },
  energetic: { low: 4, mid: 2, high: 1 },
};

export interface CutSlot {
  start: number;
  end: number;
  beats: number;
  label: Section['label'];
}

export interface SlotOptions {
  preset: Preset;
  /** Overrides the preset with a fixed number of beats per shot. */
  cutEveryBeats?: number | undefined;
  /** Music seconds to cover, from the start of the song. */
  durationSeconds: number;
  frameDuration: number;
}

const snap = (t: number, frame: number): number => Math.round(t / frame) * frame;

const labelAt = (sections: Section[], t: number): Section['label'] =>
  sections.find((s) => t >= s.start && t < s.end)?.label ?? 'mid';

/**
 * Cut points on the beat grid, starting at the first downbeat so a cut lands on the
 * one. The first slot runs from the start of the song to that downbeat and the last
 * ends at durationSeconds; a final sliver shorter than a beat joins the slot before it.
 */
export function cutSlots(rhythm: Rhythm, opts: SlotOptions): CutSlot[] {
  const beatLength = 60 / rhythm.bpm;
  const firstDown = rhythm.downbeats[0] ?? rhythm.beats[0] ?? 0;
  const firstIndex = Math.max(0, rhythm.beats.findIndex((b) => Math.abs(b - firstDown) < 1e-6));
  const slots: CutSlot[] = [];
  let cursor = 0;
  let beatIndex = firstIndex;
  const point = (): number => rhythm.beats[beatIndex] ?? firstDown + (beatIndex - firstIndex) * beatLength;

  // Anything before the first downbeat becomes one lead-in slot.
  if (firstDown > beatLength / 2) {
    slots.push({ start: 0, end: snap(firstDown, opts.frameDuration), beats: Math.round(firstDown / beatLength), label: labelAt(rhythm.sections, 0) });
    cursor = slots[0]!.end;
  }

  while (cursor < opts.durationSeconds - 1e-6) {
    const label = labelAt(rhythm.sections, point());
    const beats = opts.cutEveryBeats ?? BEATS_PER_CUT[opts.preset][label];
    beatIndex += beats;
    const end = Math.min(opts.durationSeconds, snap(point(), opts.frameDuration));
    if (end <= cursor) continue;
    slots.push({ start: round3(cursor), end: round3(end), beats, label });
    cursor = end;
  }

  const last = slots[slots.length - 1];
  const before = slots[slots.length - 2];
  if (last && before && last.end - last.start < beatLength - 1e-6) {
    before.end = last.end;
    before.beats += last.beats;
    slots.pop();
  }
  return slots;
}

const LABEL_RANK: Record<Section['label'], number> = { high: 0, mid: 1, low: 2 };

/**
 * Gives every slot a stretch of footage: the best-scored candidates go to the
 * highest-energy slots. When there are fewer candidates than slots the best ones are
 * reused (reused counts how many), because a repeat reads better than a short cut.
 */
export function assignShots(
  slots: CutSlot[],
  candidates: Candidate[],
  frameDuration: number,
): { shots: Shot[]; reused: number } {
  if (candidates.length === 0 || slots.length === 0) return { shots: [], reused: 0 };
  const ranked = [...candidates].sort((a, b) => b.score - a.score || a.mediaPath.localeCompare(b.mediaPath) || a.start - b.start);
  const order = slots
    .map((slot, index) => ({ slot, index }))
    .sort((a, b) => LABEL_RANK[a.slot.label] - LABEL_RANK[b.slot.label] || a.index - b.index);

  const byIndex = new Map<number, Shot>();
  order.forEach(({ slot, index }, n) => {
    const c = ranked[n % ranked.length]!;
    const wanted = slot.end - slot.start;
    const duration = Math.min(Math.floor(wanted / frameDuration + 1e-6) * frameDuration, Math.floor(c.sourceDuration / frameDuration) * frameDuration);
    // Reused windows start a little later each lap so a repeat is not the identical frames.
    const lap = Math.floor(n / ranked.length);
    const preferred = c.start + lap * (c.end - c.start);
    const start = Math.max(0, Math.min(preferred, c.sourceDuration - duration));
    byIndex.set(index, { mediaPath: c.mediaPath, in: round3(start), out: round3(start + duration), score: c.score, timelineStart: round3(slot.start) });
  });
  return {
    shots: slots.map((_, i) => byIndex.get(i)!).filter((s) => s.out > s.in),
    reused: Math.max(0, slots.length - ranked.length),
  };
}
