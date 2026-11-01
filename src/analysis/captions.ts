/**
 * Pure caption grouping for vertical shorts: split timed words into short
 * on-screen groups, apply user text overrides, and make safe file names.
 * No I/O, so every rule is testable with plain data.
 */

/** Minimal word shape needed here; the transcript's TimelineWord is assignable to it. */
export type CaptionWord = { w: string; start: number; end: number };

/** Fractions of the 1080x1920 frame kept clear of captions. */
export const SAFE_AREA = { top: 0.10, bottom: 0.15, side: 0.06 } as const;

export interface CaptionGroup {
  start: number;
  end: number;
  text: string;
  words: Array<{ w: string; start: number; end: number }>;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const BREAK_AFTER = /[.,;:!?…]["')\]”’]*$/;
const TIME_TOLERANCE = 0.001;

/**
 * Group words into captions of at most maxWords words and maxChars characters,
 * breaking after punctuation. A single word longer than maxChars stands alone.
 * Times are made relative to `offset` (the short's start on the timeline).
 */
export function groupCaptions(words: CaptionWord[], offset: number, maxWords = 3, maxChars = 18): CaptionGroup[] {
  const groups: CaptionGroup[] = [];
  let cur: CaptionWord[] = [];
  const flush = (): void => {
    const first = cur[0];
    const last = cur[cur.length - 1];
    if (!first || !last) return;
    groups.push({
      start: round3(first.start - offset),
      end: round3(last.end - offset),
      text: cur.map((x) => x.w).join(' '),
      words: cur.map((x) => ({ w: x.w, start: round3(x.start - offset), end: round3(x.end - offset) })),
    });
    cur = [];
  };
  for (const word of words) {
    if (cur.length > 0) {
      const chars = cur.map((x) => x.w).join(' ').length + 1 + word.w.length;
      if (cur.length >= maxWords || chars > maxChars) flush();
    }
    cur.push(word);
    if (BREAK_AFTER.test(word.w)) flush();
  }
  flush();
  return groups;
}

/**
 * Replace the text of groups whose start/end match an override. Same word count
 * keeps each word's timing; otherwise the new words are spread evenly.
 */
export function applyCaptionOverrides(
  groups: CaptionGroup[],
  overrides: Array<{ start: number; end: number; text: string }>,
): CaptionGroup[] {
  return groups.map((g) => {
    const o = overrides.find((x) => Math.abs(x.start - g.start) <= TIME_TOLERANCE && Math.abs(x.end - g.end) <= TIME_TOLERANCE);
    if (!o) return g;
    const tokens = o.text.split(/\s+/).filter(Boolean);
    let newWords: CaptionGroup['words'];
    if (tokens.length === g.words.length) {
      newWords = tokens.map((w, i) => ({ w, start: g.words[i]?.start ?? g.start, end: g.words[i]?.end ?? g.end }));
    } else {
      const step = (g.end - g.start) / Math.max(1, tokens.length);
      newWords = tokens.map((w, i) => ({
        w,
        start: round3(g.start + i * step),
        end: round3(i === tokens.length - 1 ? g.end : g.start + (i + 1) * step),
      }));
    }
    return { start: g.start, end: g.end, text: tokens.join(' '), words: newWords };
  });
}

/** Keep letters (including Vietnamese) and replace path-hostile characters with "-". */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\/:*?"<>|\u0000-\u001f]/g, '-').trim();
  return cleaned === '' ? 'short' : cleaned;
}
