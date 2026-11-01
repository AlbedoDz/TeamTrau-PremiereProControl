/**
 * Casing for the Zipformer engines, which output lowercase words with no punctuation: capitalise
 * the first word of each sentence (transcript start and the word after a segment end) and apply
 * the glossary spelling to names and terms. Pure; the input is not mutated.
 */
import type { AsrWord } from './transcript.js';

const norm = (s: string): string => s.normalize('NFC').toLowerCase();

function capitalise(word: string): string {
  const chars = Array.from(word.normalize('NFC'));
  if (chars.length === 0) return word;
  return chars[0]!.toUpperCase() + chars.slice(1).join('');
}

export function restoreCasing(words: AsrWord[], glossary: string[]): AsrWord[] {
  const out = words.map((word) => ({ ...word }));
  out.forEach((word, i) => {
    if (i === 0 || words[i - 1]!.segEnd) word.w = capitalise(word.w);
  });

  const entries = glossary
    .map((entry) => entry.normalize('NFC').trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0)
    .sort((a, b) => b.length - a.length);
  const keys = words.map((word) => norm(word.w));
  const taken = new Array<boolean>(words.length).fill(false);
  for (const tokens of entries) {
    const wanted = tokens.map(norm);
    for (let i = 0; i + wanted.length <= words.length; i++) {
      if (taken.slice(i, i + wanted.length).some(Boolean)) continue;
      if (!wanted.every((token, j) => keys[i + j] === token)) continue;
      tokens.forEach((token, j) => {
        out[i + j]!.w = token;
        taken[i + j] = true;
      });
    }
  }
  return out;
}
