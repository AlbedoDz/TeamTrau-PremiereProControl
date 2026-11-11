/**
 * Pure filler-word and retake detection on a transcript. Returns time ranges
 * (sequence seconds) that a later tool may cut. Wrongly cutting a meaningful
 * word is the worst failure, so every rule here errs toward keeping.
 */
import type { FillerLexicon } from './fillers-vi.js';
import type { Sentence, TimelineWord } from './transcript.js';

export type { FillerLexicon } from './fillers-vi.js';

export interface FillerRange {
  start: number;
  end: number;
  reason: 'filler-A' | 'filler-B' | 'retake';
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
  const out: string[] = [];
  const last = Math.min(sentence.lastWord, words.length - 1);
  for (let k = Math.max(sentence.firstWord, 0); k <= last; k++) {
    const t = normalizeToken(words[k]!.w);
    if (t) out.push(t);
  }
  return out;
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
    if (isRetake(sentenceTokens(s1, words), sentenceTokens(s2, words), opts.jaccard)) {
      ranges.push({ start: s1.start, end: s1.end, reason: 'retake', text: s1.text });
    }
  }
  return ranges;
}
