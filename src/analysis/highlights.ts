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
 */
export function candidateWindows(sentences: Sentence[], minSec: number, maxSec: number): Window[] {
  const windows: Window[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const first = sentences[i]!;
    for (let j = i; j < sentences.length; j++) {
      const last = sentences[j]!;
      const duration = last.end - first.start;
      if (duration > maxSec) {
        if (last.end >= first.start) break;
      }
      if (duration >= minSec && duration <= maxSec) {
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

/**
 * Extracts acoustic, pacing, dialogue and visual signals for a single candidate window.
 */
export function signalsFor(
  w: Window,
  words: TimelineWord[],
  loudness: FrameSample[],
  medianLufs: number,
  faces: Array<{ t: number; count: number }>,
): CandidateSignals {
  const inWords = words
    .filter((word) => word.start >= w.start && word.start < w.end)
    .sort((a, b) => a.start - b.start);

  const duration = w.end - w.start;
  const wordsPerSec = duration > 0 ? inWords.length / duration : 0;

  const loudInWindow = loudness.filter((s) => s.t >= w.start && s.t < w.end);
  const loudnessRel =
    loudInWindow.length > 0
      ? loudInWindow.reduce((sum, s) => sum + s.v, 0) / loudInWindow.length - medianLufs
      : 0;

  const hasQuestion = inWords.some((word) => /\?[^\p{L}\p{N}]*$/u.test(word.w.trim()));
  const hasExclaim = inWords.some((word) => /![^\p{L}\p{N}]*$/u.test(word.w.trim()));

  // Filler detection: count words belonging to fillers
  const tokens = inWords.map((word) => normalizeText(word.w));
  let fillerWords = 0;
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
    }
    if (matchedLength > 0) {
      fillerWords += matchedLength;
      idx += matchedLength;
    } else {
      idx++;
    }
  }
  const fillerRate = inWords.length > 0 ? fillerWords / inWords.length : 0;

  let maxPauseSec = 0;
  for (let i = 0; i < inWords.length - 1; i++) {
    const gap = inWords[i + 1]!.start - inWords[i]!.end;
    if (gap > maxPauseSec) {
      maxPauseSec = gap;
    }
  }

  const facesInWindow = faces.filter((f) => f.t >= w.start && f.t < w.end);
  const multiFaceRatio =
    facesInWindow.length > 0
      ? facesInWindow.filter((f) => f.count >= 2).length / facesInWindow.length
      : 0;

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
  const bucketDuration = totalSeconds > 0 ? totalSeconds / 10 : 1;

  for (const cand of sorted) {
    if (chosen.length >= limit) break;
    const bucket = Math.max(0, Math.min(9, Math.floor(cand.start / bucketDuration)));
    if ((bucketCounts[bucket] ?? 0) >= maxPerBucket) continue;

    const overlaps = chosen.some((c) => cand.start < c.end && c.start < cand.end);
    if (overlaps) continue;

    chosen.push(cand);
    bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
  }

  return chosen.sort((a, b) => a.start - b.start);
}
