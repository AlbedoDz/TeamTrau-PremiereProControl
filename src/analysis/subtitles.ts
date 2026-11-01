/**
 * Subtitle cues for a full episode: word-level transcript in, readable SRT cues out.
 * Pure functions; the tool writes the file and places the caption track.
 */
export interface SubtitleCue {
  index: number;
  start: number;
  end: number;
  lines: string[];
}

export interface SubtitleOptions {
  maxCharsPerLine: number;
  maxLines: number;
  minDuration: number;
  maxDuration: number;
  maxCps: number;
  pauseBreak: number;
  gap: number;
}

export const DEFAULT_SUBTITLE_OPTIONS: SubtitleOptions = {
  maxCharsPerLine: 42,
  maxLines: 2,
  minDuration: 1.0,
  maxDuration: 7.0,
  maxCps: 20,
  pauseBreak: 0.6,
  gap: 0.08,
};

interface Word { w: string; start: number; end: number }

const ms = (n: number): number => Math.round(n * 1000) / 1000;
const SENTENCE_END = /[.?!…]$/;

/**
 * Splits words into at most maxLines lines of at most maxChars characters, using the fewest
 * lines that fit and, among those, the most balanced split. A single word longer than the
 * limit stays alone on its line. Returns null when no split fits.
 */
function wrap(words: string[], maxChars: number, maxLines: number): string[] | null {
  const n = words.length;
  const len = (i: number, j: number): number => words.slice(i, j).join(' ').length;
  for (let k = 1; k <= Math.min(maxLines, n); k++) {
    // best[l][j]: least sum of squared line lengths covering the first j words with l lines.
    const best: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(Infinity));
    const from: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(-1));
    best[0]![0] = 0;
    for (let l = 1; l <= k; l++) {
      for (let j = 1; j <= n; j++) {
        for (let i = l - 1; i < j; i++) {
          const prev = best[l - 1]![i]!;
          if (prev === Infinity) continue;
          const size = len(i, j);
          if (size > maxChars && j - i > 1) continue;
          const cost = prev + size * size;
          if (cost < best[l]![j]!) {
            best[l]![j] = cost;
            from[l]![j] = i;
          }
        }
      }
    }
    if (best[k]![n]! === Infinity) continue;
    const lines: string[] = [];
    for (let l = k, j = n; l >= 1; l--) {
      const i = from[l]![j]!;
      lines.unshift(words.slice(i, j).join(' '));
      j = i;
    }
    return lines;
  }
  return null;
}

export function buildSubtitleCues(words: Word[], opts: Partial<SubtitleOptions> = {}): SubtitleCue[] {
  const o = { ...DEFAULT_SUBTITLE_OPTIONS, ...opts };
  const clean: Word[] = [];
  for (const word of words) {
    const w = word.w.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (w) clean.push({ w, start: word.start, end: word.end });
  }

  const groups: Word[][] = [];
  let cur: Word[] = [];
  for (const word of clean) {
    if (cur.length > 0) {
      const last = cur[cur.length - 1]!;
      const pause = word.start - last.end > o.pauseBreak;
      const tooLong = word.end - cur[0]!.start > o.maxDuration;
      const tooWide = wrap([...cur, word].map((x) => x.w), o.maxCharsPerLine, o.maxLines) === null;
      if (pause || tooLong || tooWide) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(word);
    if (SENTENCE_END.test(word.w)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) groups.push(cur);

  const cues: SubtitleCue[] = groups.map((g, i) => {
    const texts = g.map((x) => x.w);
    return {
      index: i + 1,
      start: ms(g[0]!.start),
      end: ms(g[g.length - 1]!.end),
      lines: wrap(texts, o.maxCharsPerLine, o.maxLines) ?? [texts.join(' ')],
    };
  });

  cues.forEach((cue, i) => {
    const chars = cue.lines.join(' ').length;
    const wanted = Math.max(o.minDuration, chars / o.maxCps);
    const limit = i + 1 < cues.length ? cues[i + 1]!.start - o.gap : Infinity;
    cue.end = ms(Math.min(Math.max(cue.end, cue.start + wanted), limit));
  });
  return cues;
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

function srtTime(sec: number): string {
  const total = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(total % 1000, 3)}`;
}

/** SRT text with CRLF line endings and no BOM. */
export function toSrt(cues: SubtitleCue[]): string {
  return cues
    .map((c) => `${c.index}\r\n${srtTime(c.start)} --> ${srtTime(c.end)}\r\n${c.lines.join('\r\n')}\r\n\r\n`)
    .join('');
}
