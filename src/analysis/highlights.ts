/**
 * Highlight candidate selection: sentence-bounded windows scored on acoustic,
 * pacing, linguistic and visual cues, then greedily picked to avoid overlap
 * and maintain diversity across the episode. Everything here is plain data
 * in, plain data out; no I/O.
 */
import type { FrameSample } from './roughcut.js';
import type { Sentence, TimelineWord } from './transcript.js';

export const FILLERS = ['ờ', 'à', 'ừ', 'kiểu', 'thì là'];

export interface Window {
  startSentenceId: number;
  endSentenceId: number;
  start: number;
  end: number;
}

export interface CandidateSignals {
  wordsPerSec: number;
  loudnessRel: number;
  hasQuestion: boolean;
  hasExclaim: boolean;
  fillerRate: number;
  maxPauseSec: number;
  multiFaceRatio: number;
}

export interface Candidate extends Window {
  text: string;
  signals: CandidateSignals;
  rawScore: number;
}

/**
 * Generates all candidate windows of consecutive sentences whose total duration
 * (last.end - first.start) falls within [minSec, maxSec].
 * Sentences must be sorted ascending by time (`start` / `end`).
 */
export function candidateWindows(sentences: Sentence[], minSec: number, maxSec: number): Window[] {
  const windows: Window[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const first = sentences[i]!;
    for (let j = i; j < sentences.length; j++) {
      const last = sentences[j]!;
      const duration = last.end - first.start;
      if (duration > maxSec) break;
      if (duration >= minSec) {
        windows.push({
          startSentenceId: first.id,
          endSentenceId: last.id,
          start: first.start,
          end: last.end,
        });
      }
    }
  }
  return windows;
}

const normalizeText = (s: string): string =>
  s.normalize('NFC').toLowerCase().replace(/[\p{P}\p{S}]/gu, '').trim();

// Pre-split fillers into normalized word tokens, ordered by token count desc
const PARSED_FILLERS = FILLERS.map((f) =>
  normalizeText(f).split(/\s+/).filter(Boolean),
).sort((a, b) => b.length - a.length);

function lowerBound<T>(arr: readonly T[], target: number, getKey: (item: T) => number): number {
  let low = 0;
  let high = arr.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (getKey(arr[mid]!) < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

const loudnessPrefixMap = new WeakMap<readonly FrameSample[], Float64Array>();
const facesPrefixMap = new WeakMap<readonly { t: number; count: number }[], Float64Array>();

function getLoudnessPrefix(loudness: readonly FrameSample[]): Float64Array {
  let prefix = loudnessPrefixMap.get(loudness);
  if (!prefix) {
    prefix = new Float64Array(loudness.length + 1);
    for (let i = 0; i < loudness.length; i++) {
      prefix[i + 1] = prefix[i]! + loudness[i]!.v;
    }
    loudnessPrefixMap.set(loudness, prefix);
  }
  return prefix;
}

function getFacesPrefix(faces: readonly { t: number; count: number }[]): Float64Array {
  let prefix = facesPrefixMap.get(faces);
  if (!prefix) {
    prefix = new Float64Array(faces.length + 1);
    for (let i = 0; i < faces.length; i++) {
      prefix[i + 1] = prefix[i]! + (faces[i]!.count >= 2 ? 1 : 0);
    }
    facesPrefixMap.set(faces, prefix);
  }
  return prefix;
}

const wordNormCache = new WeakMap<TimelineWord, string>();

/**
 * Extracts acoustic, pacing, dialogue and visual signals for a single candidate window.
 *
 * Preconditions:
 * - `words` must be sorted ascending by `start`.
 * - `loudness` must be sorted ascending by `t`.
 * - `faces` must be sorted ascending by `t`.
 * (The transcript and ffmpeg outputs already are).
 */
export function signalsFor(
  w: Window,
  words: TimelineWord[],
  loudness: FrameSample[],
  medianLufs: number,
  faces: Array<{ t: number; count: number }>,
): CandidateSignals {
  const wordStart = lowerBound(words, w.start, (item) => item.start);
  const wordEnd = lowerBound(words, w.end, (item) => item.start);
  const wordCount = wordEnd > wordStart ? wordEnd - wordStart : 0;

  const duration = w.end - w.start;
  const wordsPerSec = duration > 0 ? wordCount / duration : 0;

  let loudnessRel = 0;
  if (loudness.length > 0) {
    const loudStart = lowerBound(loudness, w.start, (s) => s.t);
    const loudEnd = lowerBound(loudness, w.end, (s) => s.t);
    const loudCount = loudEnd > loudStart ? loudEnd - loudStart : 0;
    if (loudCount > 0) {
      const prefix = getLoudnessPrefix(loudness);
      const sum = prefix[loudEnd]! - prefix[loudStart]!;
      loudnessRel = sum / loudCount - medianLufs;
    }
  }

  let hasQuestion = false;
  let hasExclaim = false;
  for (let i = wordStart; i < wordEnd; i++) {
    const text = words[i]!.w.trim();
    if (!hasQuestion && /\?[^\p{L}\p{N}]*$/u.test(text)) {
      hasQuestion = true;
    }
    if (!hasExclaim && /![^\p{L}\p{N}]*$/u.test(text)) {
      hasExclaim = true;
    }
    if (hasQuestion && hasExclaim) break;
  }

  let fillerWords = 0;
  if (wordCount > 0) {
    const tokens = new Array<string>(wordCount);
    for (let i = 0; i < wordCount; i++) {
      const tw = words[wordStart + i]!;
      let norm = wordNormCache.get(tw);
      if (norm === undefined) {
        norm = normalizeText(tw.w);
        wordNormCache.set(tw, norm);
      }
      tokens[i] = norm;
    }

    let idx = 0;
    while (idx < tokens.length) {
      let matchedLength = 0;
      for (const filler of PARSED_FILLERS) {
        if (idx + filler.length <= tokens.length) {
          let match = true;
          for (let k = 0; k < filler.length; k++) {
            if (tokens[idx + k] !== filler[k]) {
              match = false;
              break;
            }
          }
          if (match) {
            matchedLength = filler.length;
            break;
          }
        }
        if (filler.length > 1 && tokens[idx] === filler.join(' ')) {
          matchedLength = 1;
          break;
        }
      }
      if (matchedLength > 0) {
        fillerWords += matchedLength;
        idx += matchedLength;
      } else {
        idx++;
      }
    }
  }
  const fillerRate = wordCount > 0 ? fillerWords / wordCount : 0;

  let maxPauseSec = 0;
  for (let i = wordStart; i < wordEnd - 1; i++) {
    const gap = words[i + 1]!.start - words[i]!.end;
    if (gap > maxPauseSec) {
      maxPauseSec = gap;
    }
  }

  let multiFaceRatio = 0;
  if (faces.length > 0) {
    const faceStart = lowerBound(faces, w.start, (f) => f.t);
    const faceEnd = lowerBound(faces, w.end, (f) => f.t);
    const faceCount = faceEnd > faceStart ? faceEnd - faceStart : 0;
    if (faceCount > 0) {
      const prefix = getFacesPrefix(faces);
      const multiCount = prefix[faceEnd]! - prefix[faceStart]!;
      multiFaceRatio = multiCount / faceCount;
    }
  }

  return {
    wordsPerSec,
    loudnessRel,
    hasQuestion,
    hasExclaim,
    fillerRate,
    maxPauseSec,
    multiFaceRatio,
  };
}

function zScore(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  if (std === 0 || !Number.isFinite(std)) {
    return new Array<number>(n).fill(0);
  }
  return values.map((v) => (v - mean) / std);
}

/**
 * Scores candidates by computing z-scores of signals across the candidate pool.
 * rawScore = mean(z of loudnessRel, wordsPerSec, hasQuestion) - mean(z of fillerRate, maxPauseSec, multiFaceRatio)
 */
export function scoreCandidates(cands: Array<Omit<Candidate, 'rawScore'>>): Candidate[] {
  if (cands.length === 0) return [];

  const zLoudness = zScore(cands.map((c) => c.signals.loudnessRel));
  const zWordsPerSec = zScore(cands.map((c) => c.signals.wordsPerSec));
  const zHasQuestion = zScore(cands.map((c) => (c.signals.hasQuestion ? 1 : 0)));
  const zFillerRate = zScore(cands.map((c) => c.signals.fillerRate));
  const zMaxPauseSec = zScore(cands.map((c) => c.signals.maxPauseSec));
  const zMultiFaceRatio = zScore(cands.map((c) => c.signals.multiFaceRatio));

  return cands.map((cand, i) => {
    const posMean = (zLoudness[i]! + zWordsPerSec[i]! + zHasQuestion[i]!) / 3;
    const negMean = (zFillerRate[i]! + zMaxPauseSec[i]! + zMultiFaceRatio[i]!) / 3;
    return {
      ...cand,
      rawScore: posMean - negMean,
    };
  });
}

/**
 * Greedily selects top candidates by rawScore, ensuring non-overlapping windows
 * and capping each 10% bucket of the timeline at ceil(limit / 5) items.
 */
export function pickDiverse(cands: Candidate[], limit: number, totalSeconds: number): Candidate[] {
  if (limit <= 0 || cands.length === 0) return [];

  const sorted = [...cands].sort((a, b) => b.rawScore - a.rawScore || a.start - b.start);
  const chosen: Candidate[] = [];
  const bucketCounts = new Array<number>(10).fill(0);
  const maxPerBucket = Math.ceil(limit / 5);

  for (const cand of sorted) {
    if (chosen.length >= limit) break;
    const bucket =
      totalSeconds > 0
        ? Math.max(0, Math.min(9, Math.floor(cand.start / (totalSeconds / 10))))
        : 0;
    if ((bucketCounts[bucket] ?? 0) >= maxPerBucket) continue;

    const overlaps = chosen.some((c) => cand.start < c.end && c.start < cand.end);
    if (overlaps) continue;

    chosen.push(cand);
    bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
  }

  return chosen.sort((a, b) => a.start - b.start);
}
