/**
 * Pure filler-word and retake detection on a transcript. Returns time ranges
 * (sequence seconds) that a later tool may cut. Wrongly cutting a meaningful
 * word is the worst failure, so every rule here errs toward keeping.
 */
import type { FillerLexicon } from './fillers-vi.js';
import type { FrameSample } from './roughcut.js';
import type { Sentence, TimelineWord } from './transcript.js';

export type { FillerLexicon } from './fillers-vi.js';

export interface FillerRange {
  start: number;
  end: number;
  reason: 'filler-A' | 'filler-B' | 'retake' | 'isolated';
  text: string;
}

type Tier = 'A' | 'B' | 'C';

const normalizeToken = (s: string): string =>
  s.normalize('NFC').toLowerCase().replace(/[\p{P}\p{S}]/gu, '').trim();

interface PhraseIndex {
  /** Normalized phrase (tokens joined by a space) to its tier. */
  tiers: Map<string, Tier>;
  maxTokens: number;
}

/** Each phrase keeps exactly one tier: A over B over C. */
function buildPhraseIndex(lexicon: FillerLexicon): PhraseIndex {
  const tiers = new Map<string, Tier>();
  let maxTokens = 1;
  for (const tier of ['A', 'B', 'C'] as const) {
    for (const phrase of lexicon[tier]) {
      const tokens = phrase.split(/\s+/).map(normalizeToken).filter(Boolean);
      if (tokens.length === 0) continue;
      const key = tokens.join(' ');
      if (!tiers.has(key)) tiers.set(key, tier);
      maxTokens = Math.max(maxTokens, tokens.length);
    }
  }
  return { tiers, maxTokens };
}

/** Longest lexicon phrase starting at tokens[i], across all tiers. */
function longestMatch(tokens: string[], i: number, index: PhraseIndex): { len: number; tier: Tier } | null {
  const max = Math.min(index.maxTokens, tokens.length - i);
  for (let len = max; len >= 1; len--) {
    if (tokens.slice(i, i + len).some((t) => t === '')) continue;
    const tier = index.tiers.get(tokens.slice(i, i + len).join(' '));
    if (tier) return { len, tier };
  }
  return null;
}

/**
 * Finds filler ranges. Matching is longest phrase first across all tiers; a
 * tier C phrase that is the longest at its position blocks its tokens from any
 * A/B range. A: cut when alone (a pause of at least `minPauseSec` on one side,
 * or at a sentence edge). B: cut only with a pause right after, or when
 * immediately repeated. A cut never leaves a sentence with fewer than 2 words.
 */
export function findFillerRanges(
  words: TimelineWord[],
  sentences: Sentence[],
  lexicon: FillerLexicon,
  opts: { tiers: Array<'A' | 'B'>; minPauseSec: number },
): FillerRange[] {
  const index = buildPhraseIndex(lexicon);
  const enabled = new Set<Tier>(opts.tiers);
  const ranges: FillerRange[] = [];

  for (const sentence of sentences) {
    const first = sentence.firstWord;
    const last = Math.min(sentence.lastWord, words.length - 1);
    if (first < 0 || last < first) continue;
    const tokens: string[] = [];
    for (let k = first; k <= last; k++) tokens.push(normalizeToken(words[k]!.w));
    const wordCount = tokens.length;
    let removed = 0;

    let i = 0;
    while (i < tokens.length) {
      const match = longestMatch(tokens, i, index);
      if (!match) { i += 1; continue; }
      const { len, tier } = match;
      if (tier === 'C' || !enabled.has(tier)) { i += len; continue; }

      const firstIdx = first + i;
      const lastIdx = firstIdx + len - 1;
      const firstWordObj = words[firstIdx]!;
      const lastWordObj = words[lastIdx]!;
      const gapBefore = i === 0 ? Infinity : firstWordObj.start - words[firstIdx - 1]!.end;
      // Past the last word of the transcript there is no neighbour: count it as a pause.
      const gapAfter = lastIdx + 1 < words.length ? words[lastIdx + 1]!.start - lastWordObj.end : Infinity;
      const atStart = i === 0;
      const atEnd = i + len === tokens.length;

      let cut: boolean;
      if (tier === 'A') {
        const questionParticle = atEnd && (tokens[i] === 'à' || tokens[i] === 'ư');
        // Sentence-final "à"/"ư" are question particles ("Anh đi à"): cut only when they stand alone.
        cut = questionParticle
          ? gapBefore >= opts.minPauseSec
          : atStart || atEnd || gapBefore >= opts.minPauseSec || gapAfter >= opts.minPauseSec;
      } else {
        const phrase = tokens.slice(i, i + len).join(' ');
        const repeated = i + 2 * len <= tokens.length && tokens.slice(i + len, i + 2 * len).join(' ') === phrase;
        // A sentence-final B phrase has the sentence boundary as its pause, which says nothing: only a repeat cuts it.
        cut = repeated || (!atEnd && gapAfter >= opts.minPauseSec);
      }
      // Cutting may empty a filler-only sentence, but must not leave a lone word.
      if (cut && wordCount - removed - len === 1) cut = false;
      if (cut) {
        removed += len;
        ranges.push({
          start: firstWordObj.start,
          end: lastWordObj.end,
          reason: tier === 'A' ? 'filler-A' : 'filler-B',
          text: words.slice(firstIdx, lastIdx + 1).map((w) => w.w).join(' '),
        });
      }
      i += len;
    }
  }
  return ranges;
}

function sentenceTokens(sentence: Sentence, words: TimelineWord[]): string[] {
  return sentenceTokenWords(sentence, words).map((x) => x.token);
}

/** Normalized tokens of a sentence, each with the index of the word it came from. */
function sentenceTokenWords(sentence: Sentence, words: TimelineWord[]): Array<{ token: string; word: number }> {
  const out: Array<{ token: string; word: number }> = [];
  const last = Math.min(sentence.lastWord, words.length - 1);
  for (let k = Math.max(sentence.firstWord, 0); k <= last; k++) {
    const t = normalizeToken(words[k]!.w);
    if (t) out.push({ token: t, word: k });
  }
  return out;
}

/** Fewest repeated words for a restart in the middle of a sentence to count. */
const MIN_RESTART_TOKENS = 3;
/** Share of the abandoned tail that the next sentence must repeat. */
const MIN_RESTART_SHARE = 0.6;

/**
 * Where S1 was abandoned mid-sentence and S2 restarts from that point: the earliest
 * token index p > 0 of S1 from which at least MIN_RESTART_TOKENS tokens repeat S2's
 * opening and cover at least MIN_RESTART_SHARE of S1's tail. Live: "… thiết thực, nhờ đó
 * chi hội đã đạt được nhiều thành tựu nổi bật như" followed by "Nhờ đó chi hội đã đạt
 * được …" — S1 is not a prefix of S2, but its tail is.
 */
function restartPoint(a: string[], b: string[]): number | null {
  for (let p = 1; p + MIN_RESTART_TOKENS <= a.length; p++) {
    let k = 0;
    while (p + k < a.length && k < b.length && a[p + k] === b[k]) k++;
    if (k >= MIN_RESTART_TOKENS && k / (a.length - p) >= MIN_RESTART_SHARE) return p;
  }
  return null;
}

function isRetake(a: string[], b: string[], jaccard: number): boolean {
  // One-word sentences ("Vâng") are too ambiguous to call a stumble.
  if (a.length < 2) return false;
  if (a.length <= b.length && a.every((t, k) => t === b[k])) return true;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union > 0 && inter / union >= jaccard;
}

/**
 * A sentence S1 is a retake when the next sentence S2 starts within `windowSec`
 * of S1's end and S1 is a prefix of S2 or their word sets overlap by at least
 * `jaccard`. Chains of stumbles drop every sentence but the last.
 */
export function findRetakeRanges(
  sentences: Sentence[],
  words: TimelineWord[],
  opts: { windowSec: number; jaccard: number },
): FillerRange[] {
  const ranges: FillerRange[] = [];
  for (let n = 0; n + 1 < sentences.length; n++) {
    const s1 = sentences[n]!;
    const s2 = sentences[n + 1]!;
    if (s2.start - s1.end > opts.windowSec) continue;
    const a = sentenceTokenWords(s1, words);
    const at = a.map((x) => x.token);
    const b = sentenceTokens(s2, words);
    // A restart in the middle is checked before the word-overlap rule: overlap alone would
    // drop the whole first sentence, including the words before the restart that the
    // speaker never repeated.
    const fullPrefix = at.length >= 2 && at.length <= b.length && at.every((t, k) => t === b[k]);
    const p = fullPrefix ? null : restartPoint(at, b);
    if (p === null && isRetake(at, b, opts.jaccard)) {
      ranges.push({ start: s1.start, end: s1.end, reason: 'retake', text: s1.text });
      continue;
    }
    if (p !== null) {
      const from = a[p]!.word;
      ranges.push({
        start: words[from]!.start,
        end: s1.end,
        reason: 'retake',
        text: words.slice(from, Math.min(s1.lastWord, words.length - 1) + 1).map((w) => w.w).join(' '),
      });
    }
  }
  return ranges;
}

/**
 * One-word utterances standing alone between long pauses: in a read voice-over these
 * are stray sounds, whatever the word (live, Zipformer heard a hesitation as "Này",
 * a tier C word that the lexicon never cuts). Only for narration: in dialogue a lone
 * "Vâng." is an answer, so the caller decides when to use this.
 */
export function findIsolatedUtterances(
  words: TimelineWord[],
  sentences: Sentence[],
  opts: { maxSec: number; minGapSec: number },
): FillerRange[] {
  const ranges: FillerRange[] = [];
  sentences.forEach((s, n) => {
    const toks = sentenceTokenWords(s, words);
    if (toks.length !== 1) return;
    const w = words[toks[0]!.word]!;
    if (w.end - w.start > opts.maxSec) return;
    const before = n > 0 ? w.start - sentences[n - 1]!.end : Infinity;
    const after = n + 1 < sentences.length ? sentences[n + 1]!.start - w.end : Infinity;
    if (before >= opts.minGapSec && after >= opts.minGapSec) {
      ranges.push({ start: w.start, end: w.end, reason: 'isolated', text: w.w });
    }
  });
  return ranges;
}

/**
 * Moves each edge of every range to the quietest RMS sample within
 * `windowSec`, so a cut lands in a gap instead of in a phoneme. An edge never
 * moves past the original edge of the range beside it, and a range never
 * shrinks to nothing. Ranges are returned in input order.
 */
export function snapEdges(
  ranges: FillerRange[],
  rms: FrameSample[],
  windowSec: number,
  /** Per range: `lo` is the end of the previous word kept in the audio, `hi` the start of the next one. */
  bounds?: Array<{ lo: number; hi: number }>,
): FillerRange[] {
  if (rms.length === 0) return ranges.map((r) => ({ ...r }));
  const order = ranges.map((_, i) => i).sort((a, b) => ranges[a]!.start - ranges[b]!.start);
  const quietest = (from: number, to: number, anchor: number): number => {
    let best = anchor;
    let bestV = Infinity;
    for (const s of rms) {
      if (s.t < from || s.t > to) continue;
      const better = s.v < bestV || (s.v === bestV && Math.abs(s.t - anchor) < Math.abs(best - anchor));
      if (better) { bestV = s.v; best = s.t; }
    }
    return best;
  };
  const out = ranges.map((r) => ({ ...r }));
  order.forEach((idx, pos) => {
    const r = ranges[idx]!;
    const prev = pos > 0 ? ranges[order[pos - 1]!]! : null;
    const next = pos + 1 < order.length ? ranges[order[pos + 1]!]! : null;
    const mid = (r.start + r.end) / 2;
    const startLo = Math.min(r.start, Math.max(r.start - windowSec, prev ? prev.end : -Infinity, bounds?.[idx]?.lo ?? -Infinity));
    const startHi = Math.max(r.start, Math.min(r.start + windowSec, mid));
    const endHi = Math.max(r.end, Math.min(r.end + windowSec, next ? next.start : Infinity, bounds?.[idx]?.hi ?? Infinity));
    const endLo = Math.min(r.end, Math.max(r.end - windowSec, mid));
    out[idx]!.start = quietest(startLo, startHi, r.start);
    out[idx]!.end = quietest(endLo, endHi, r.end);
  });
  return out;
}
