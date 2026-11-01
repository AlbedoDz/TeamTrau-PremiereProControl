/**
 * Transcript words on sequence time: map ASR words from source files onto the
 * timeline through the clips that use them, drop duplicates picked up by several
 * mics, repair broken timestamps and split the result into sentences. Plain data
 * in, plain data out; no I/O.
 */
import { createHash } from 'node:crypto';
import type { SequenceClip } from './cleanup.js';

/** A word as the ASR heard it; times are seconds in the source file. */
export interface AsrWord {
  w: string;
  start: number;
  end: number;
  p: number;
  /** True on the last word of a Whisper segment. */
  segEnd?: boolean;
}

/** A word on sequence time. */
export interface TimelineWord extends AsrWord {
  trackIndex: number;
  clipId: string;
}

export interface Sentence {
  id: number;
  start: number;
  end: number;
  text: string;
  firstWord: number;
  lastWord: number;
}

export interface SkippedClip {
  clipId: string;
  reason: 'speed_changed' | 'no_media';
}

/**
 * Words of each audio clip's trimmed range, moved to timeline time. A word belongs to
 * a clip when its centre lies in [inPoint, outPoint). Clips whose source span differs
 * from their timeline span (speed change) are skipped, as their words cannot be mapped
 * with a plain offset.
 */
export function mapWordsToTimeline(
  clips: SequenceClip[],
  wordsByMedia: Map<string, AsrWord[]>,
  frameDuration: number,
): { words: TimelineWord[]; skippedClips: SkippedClip[] } {
  const words: TimelineWord[] = [];
  const skippedClips: SkippedClip[] = [];
  for (const clip of clips) {
    if (clip.trackType !== 'audio') continue;
    if (!clip.mediaPath) {
      skippedClips.push({ clipId: clip.id, reason: 'no_media' });
      continue;
    }
    if (Math.abs((clip.outPoint - clip.inPoint) - (clip.end - clip.start)) > frameDuration) {
      skippedClips.push({ clipId: clip.id, reason: 'speed_changed' });
      continue;
    }
    for (const word of wordsByMedia.get(clip.mediaPath) ?? []) {
      const centre = (word.start + word.end) / 2;
      if (centre < clip.inPoint || centre >= clip.outPoint) continue;
      const shift = clip.start - clip.inPoint;
      words.push({
        ...word,
        start: word.start + shift,
        end: word.end + shift,
        trackIndex: clip.trackIndex,
        clipId: clip.id,
      });
    }
  }
  words.sort((a, b) => a.start - b.start || a.trackIndex - b.trackIndex);
  return { words, skippedClips };
}

const normalizeText = (s: string): string =>
  s.normalize('NFC').toLowerCase().replace(/[\p{P}\p{S}]/gu, '').trim();

function overlapRatio(a: TimelineWord, b: TimelineWord): number {
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  const inter = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (inter <= 0) return 0;
  return shorter > 0 ? inter / shorter : 1;
}

/**
 * One mic often hears another speaker. When the same word (case, accents kept, and
 * punctuation ignored) on different tracks overlaps by over half of the shorter one,
 * keep the one with the higher probability. Different words (crosstalk) all stay.
 */
export function dedupeOverlaps(words: TimelineWord[]): TimelineWord[] {
  const sorted = [...words].sort((a, b) => a.start - b.start || a.trackIndex - b.trackIndex);
  const kept: TimelineWord[] = [];
  for (const word of sorted) {
    const text = normalizeText(word.w);
    let dup = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      const other = kept[i]!;
      if (other.end <= word.start && other.start < word.start - 5) break;
      if (other.trackIndex !== word.trackIndex && normalizeText(other.w) === text && overlapRatio(other, word) > 0.5) {
        dup = i;
        break;
      }
    }
    if (dup < 0) kept.push(word);
    else {
      const segEnd = word.segEnd === true || kept[dup]!.segEnd === true;
      const winner = word.p > kept[dup]!.p ? word : kept[dup]!;
      kept[dup] = segEnd && winner.segEnd !== true ? { ...winner, segEnd: true } : winner;
    }
  }
  return kept.sort((a, b) => a.start - b.start || a.trackIndex - b.trackIndex);
}

/** Gives words with end <= start a real duration, up to the next word's start. */
export function repairTimestamps(words: TimelineWord[]): { words: TimelineWord[]; repaired: number } {
  let repaired = 0;
  const out = words.map((word, i) => {
    if (word.end > word.start) return word;
    repaired++;
    const next = words[i + 1];
    const end = next && next.start > word.start ? Math.min(word.start + 0.2, next.start) : word.start + 0.1;
    return { ...word, end };
  });
  return { words: out, repaired };
}

/** Splits after a word ending in . ? ! (or an ellipsis), after a segEnd word, or before a gap over `pauseSec`. */
export function splitSentences(words: TimelineWord[], pauseSec = 1.0): Sentence[] {
  const sentences: Sentence[] = [];
  let first = 0;
  const flush = (last: number): void => {
    const slice = words.slice(first, last + 1);
    sentences.push({
      id: sentences.length,
      start: slice[0]!.start,
      end: slice[slice.length - 1]!.end,
      text: slice.map((w) => w.w).join(' '),
      firstWord: first,
      lastWord: last,
    });
    first = last + 1;
  };
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1];
    const endsSentence = words[i]!.segEnd === true || /[.?!…]["')\]]*$/.test(words[i]!.w.trim());
    if (!next || endsSentence || next.start - words[i]!.end > pauseSec) flush(i);
  }
  return sentences;
}

/**
 * sha1 of the audio clips (sorted), so a cached transcript can tell when the edit changed. The
 * speech engine (and, for whisper, the glossary that biases it) is part of it: a different engine
 * gives different words, so a candidate list made with another engine is stale.
 */
export function clipFingerprint(clips: SequenceClip[], engine = '', glossary: string[] = []): string {
  const rows = clips
    .filter((c) => c.trackType === 'audio')
    .map((c) => [c.id, c.start, c.end, c.inPoint, c.outPoint, c.mediaPath ?? ''].join('|'))
    .sort();
  if (engine) rows.push(`engine|${engine}|${[...new Set(glossary)].sort().join(',')}`);
  return createHash('sha1').update(rows.join('\n')).digest('hex');
}
