import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FILLER_LEXICON, loadFillerLexicon } from '../../analysis/fillers-vi.js';
import { findFillerRanges, findIsolatedUtterances, findRetakeRanges, snapEdges } from '../../analysis/fillers.js';
import type { Sentence, TimelineWord } from '../../analysis/transcript.js';

type Spec = Array<string | [string, number]>;

/** Builds one sentence from words or [word, gapBefore] pairs; each word lasts 0.3 s. */
function build(spec: Spec, t0 = 0, firstIndex = 0) {
  const words: TimelineWord[] = [];
  let t = t0;
  for (const item of spec) {
    const [w, gap] = typeof item === 'string' ? [item, 0.02] : item;
    t += gap;
    words.push({ w, start: t, end: t + 0.3, p: 1, trackIndex: 0, clipId: 'c' });
    t += 0.3;
  }
  const sentence: Sentence = {
    id: 0,
    start: words[0].start,
    end: words[words.length - 1].end,
    text: words.map((x) => x.w).join(' '),
    firstWord: firstIndex,
    lastWord: firstIndex + words.length - 1,
  };
  return { words, sentences: [sentence] };
}

const LEX = DEFAULT_FILLER_LEXICON;
const run = (spec: Spec, tiers: Array<'A' | 'B'> = ['A', 'B']) => {
  const { words, sentences } = build(spec);
  return findFillerRanges(words, sentences, LEX, { tiers, minPauseSec: 0.15 });
};

describe('DEFAULT_FILLER_LEXICON', () => {
  it('has each phrase in exactly one tier', () => {
    const all = [...LEX.A, ...LEX.B, ...LEX.C];
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps A as in the spec and puts meaning-bearing words in C', () => {
    expect(LEX.A).toEqual(['à', 'ờ', 'ừm', 'ơ', 'ư', 'hừm', 'ừm hứm', 'ờ thì', 'à mà']);
    expect(LEX.B).toContain('cái gì nhỉ');
    for (const w of ['chẳng', 'ạ', 'thì', 'mà', 'là', 'rứa', 'nghen', 'á', 'ối', 'nhỉ']) {
      expect(LEX.C).toContain(w);
    }
  });
});

describe('findFillerRanges', () => {
  it('cuts "ờ" after a 200 ms pause', () => {
    const r = run(['tôi', 'nghĩ', ['ờ', 0.2], 'rằng', 'được']);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ reason: 'filler-A', text: 'ờ' });
  });

  it('keeps "ờ" glued on both sides mid-sentence', () => {
    expect(run(['tôi', 'nghĩ', 'ờ', 'rằng', 'được'])).toEqual([]);
  });

  it('cuts "ờ" at a sentence edge', () => {
    expect(run(['ờ', 'tôi', 'nghĩ', 'vậy'])).toHaveLength(1);
    expect(run(['tôi', 'nghĩ', 'vậy', 'ờ'])).toHaveLength(1);
  });

  it('cuts "kiểu như" followed by a 200 ms pause when tier B is on', () => {
    const { words, sentences } = build(['tôi', 'thấy', 'kiểu', 'như', ['hay', 0.2], 'lắm']);
    const r = findFillerRanges(words, sentences, LEX, { tiers: ['A', 'B'], minPauseSec: 0.15 });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ reason: 'filler-B', text: 'kiểu như' });
    expect(r[0].start).toBeCloseTo(words[2].start);
    expect(r[0].end).toBeCloseTo(words[3].end);
  });

  it('keeps "kiểu như" without a pause, and when tiers is A only', () => {
    expect(run(['tôi', 'thấy', 'kiểu', 'như', 'hay', 'lắm'])).toEqual([]);
    expect(run(['tôi', 'thấy', 'kiểu', 'như', ['hay', 0.2], 'lắm'], ['A'])).toEqual([]);
  });

  it('cuts a longer B phrase as one range', () => {
    const r = run(['tôi', 'thấy', 'đại', 'loại', 'là', ['hay', 0.2], 'lắm']);
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe('đại loại là');
  });

  it('cuts an immediate B repeat', () => {
    const r = run(['tôi', 'thấy', 'kiểu', 'kiểu', 'hay', 'lắm']);
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe('kiểu');
  });

  it('never cuts negations, politeness or connectives, even beside pauses', () => {
    for (const w of ['thì', 'mà', 'là', 'rứa', 'nghen']) {
      expect(run(['tôi', 'chẳng', ['đồng', 0.5], 'ý', ['ạ', 0.5], ['nhé', 0.5], w])).toEqual([]);
      expect(run(['tôi', 'chẳng', 'đồng', 'ý', 'ạ', 'nhé', w])).toEqual([]);
      expect(run([w, 'tôi', 'chẳng', 'đồng', 'ý'])).toEqual([]);
    }
  });

  it('does not cut when fewer than 2 words would remain', () => {
    expect(run(['ờ', 'thôi'])).toEqual([]);
    expect(run(['ờ', 'tôi', 'à'])).toHaveLength(1); // only one of the two fillers may go
  });

  it('cuts a sentence made only of a filler', () => {
    const a = build(['tôi', 'nghĩ', 'vậy']);
    const b = build([['ờ', 0.5]], 3, 3);
    const c = build(['được', 'rồi', 'nhé'], 5, 4);
    const sentences = [a.sentences[0]!, { ...b.sentences[0]!, id: 1 }, { ...c.sentences[0]!, id: 2 }];
    const r = findFillerRanges([...a.words, ...b.words, ...c.words], sentences, LEX, { tiers: ['A'], minPauseSec: 0.15 });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ reason: 'filler-A', text: 'ờ' });
  });

  it('keeps a sentence-final B phrase followed by a 2 s gap', () => {
    for (const tail of [['xong', 'rồi'], ['kiểu']]) {
      const a = build(['em', 'làm', ...tail]);
      const b = build(['sau', 'đó', 'đi', 'ngủ'], a.words[a.words.length - 1]!.end + 2, a.words.length);
      const sentences = [a.sentences[0]!, { ...b.sentences[0]!, id: 1 }];
      expect(findFillerRanges([...a.words, ...b.words], sentences, LEX, { tiers: ['A', 'B'], minPauseSec: 0.15 })).toEqual([]);
    }
    expect(run(['tôi', 'thích', 'kiểu'])).toEqual([]);
  });

  it('still cuts a repeated sentence-final B phrase', () => {
    const r = run(['tôi', 'thích', 'kiểu', 'kiểu']);
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe('kiểu');
  });

  it('keeps sentence-final question particles "à" and "ư" unless they stand alone', () => {
    expect(run(['anh', 'đi', 'à'])).toEqual([]);
    expect(run(['thật', 'ư'])).toEqual([]);
    const r = run(['anh', 'đi', ['à', 0.3]]);
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe('à');
  });

  it('still cuts sentence-final "ờ" (not a question particle)', () => {
    expect(run(['anh', 'đi', 'ờ'])).toHaveLength(1);
  });

  it('matches the longest phrase: "ừm hứm" is one range', () => {
    const r = run(['ừm', 'hứm', 'tôi', 'nghĩ', 'vậy']);
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe('ừm hứm');
  });

  it('longest match across tiers: "ờ thì" (A) beats "thì" (C); "à cơ" (C) blocks "à" (A)', () => {
    expect(run(['tôi', 'nghĩ', 'ờ', 'thì', 'được'])).toEqual([]);
    const edge = run(['ờ', 'thì', 'tôi', 'nghĩ', 'vậy']);
    expect(edge).toHaveLength(1);
    expect(edge[0].text).toBe('ờ thì');
    expect(run(['à', 'cơ', 'tôi', 'nghĩ', 'vậy'])).toEqual([]);
  });

  it('is case-insensitive and NFC/NFD tolerant', () => {
    const nfd = 'ờ'.normalize('NFD');
    expect(nfd).not.toBe('ờ');
    expect(run([nfd.toUpperCase(), 'tôi', 'nghĩ', 'vậy'])).toHaveLength(1);
    expect(run(['Ờ,', 'tôi', 'nghĩ', 'vậy'])).toHaveLength(1);
  });

  it('judges each sentence on its own words', () => {
    const a = build(['tôi', 'nghĩ', 'vậy']);
    const b = build(['ờ', 'được', 'thôi'], 5, 3);
    const sentences = [a.sentences[0], { ...b.sentences[0], id: 1 }];
    const r = findFillerRanges([...a.words, ...b.words], sentences, LEX, { tiers: ['A'], minPauseSec: 0.15 });
    expect(r).toHaveLength(1);
    expect(r[0].start).toBeCloseTo(5.02);
  });
});

function sent(id: number, text: string, start: number, end: number, firstWord: number): Sentence {
  const n = text.split(' ').length;
  return { id, start, end, text, firstWord, lastWord: firstWord + n - 1 };
}
function wordsFor(sentences: Sentence[]): TimelineWord[] {
  const out: TimelineWord[] = [];
  for (const s of sentences) {
    for (const w of s.text.split(' ')) out.push({ w, start: s.start, end: s.end, p: 1, trackIndex: 0, clipId: 'c' });
  }
  return out;
}
const OPTS = { windowSec: 10, jaccard: 0.6 };

describe('findRetakeRanges', () => {
  it('drops a sentence that is a prefix of the next', () => {
    const s = [sent(0, 'Hôm nay chúng ta', 0, 2, 0), sent(1, 'Hôm nay chúng ta sẽ nói về X', 2.5, 6, 4)];
    expect(findRetakeRanges(s, wordsFor(s), OPTS)).toEqual([
      { start: 0, end: 2, reason: 'retake', text: 'Hôm nay chúng ta' },
    ]);
  });

  it('keeps only the last of a chain of three', () => {
    const s = [
      sent(0, 'Hôm nay chúng ta', 0, 2, 0),
      sent(1, 'Hôm nay chúng ta sẽ', 2.5, 4.5, 4),
      sent(2, 'Hôm nay chúng ta sẽ nói về X', 5, 8, 9),
    ];
    expect(findRetakeRanges(s, wordsFor(s), OPTS).map((x) => x.start)).toEqual([0, 2.5]);
  });

  it('keeps two identical sentences 12 s apart', () => {
    const s = [sent(0, 'Hôm nay chúng ta', 0, 2, 0), sent(1, 'Hôm nay chúng ta', 14, 16, 4)];
    expect(findRetakeRanges(s, wordsFor(s), OPTS)).toEqual([]);
  });

  it('uses Jaccard when not a prefix', () => {
    const s = [sent(0, 'tôi nghĩ rằng nó rất hay', 0, 3, 0), sent(1, 'tôi nghĩ nó rất hay', 3.5, 6, 6)];
    expect(findRetakeRanges(s, wordsFor(s), OPTS)).toHaveLength(1);
    const t = [sent(0, 'tôi nghĩ rằng nó rất hay', 0, 3, 0), sent(1, 'hoàn toàn khác biệt luôn', 3.5, 6, 6)];
    expect(findRetakeRanges(t, wordsFor(t), OPTS)).toEqual([]);
  });

  it('cuts the abandoned tail when the next sentence restarts in the middle (live case)', () => {
    // Live, Zipformer: three readings of the same point; the first trails into the restart.
    const texts = [
      'đã đa dạng hóa tuyên truyền thiết thực nhờ đó chi hội đã đạt được nhiều thành tựu nổi bật như',
      'Nhờ đó chi hội đã đạt được nhiều thành tựu nổi bật',
      'Nhờ đó chi hội đã đạt được nhiều thành tựu nổi bật như tám mươi phần trăm',
    ];
    const words: TimelineWord[] = [];
    const sentences: Sentence[] = [];
    let t = 0;
    texts.forEach((text, id) => {
      const first = words.length;
      for (const w of text.split(' ')) { words.push({ w, start: t, end: t + 0.3, p: 1, trackIndex: 0, clipId: 'c' }); t += 0.35; }
      sentences.push({ id, start: words[first]!.start, end: words[words.length - 1]!.end, text, firstWord: first, lastWord: words.length - 1 });
      t += 1;
    });
    const r = findRetakeRanges(sentences, words, OPTS);
    expect(r).toHaveLength(2);
    // The tail of reading 1 goes from its "nhờ" (word 8), not from the sentence start.
    expect(r[0]).toMatchObject({ reason: 'retake', start: words[8]!.start, end: sentences[0]!.end });
    expect(r[0]!.text.startsWith('nhờ đó chi hội')).toBe(true);
    expect(r[1]).toMatchObject({ start: sentences[1]!.start, end: sentences[1]!.end });
  });

  it('does not treat a short shared phrase as a restart', () => {
    const s = [sent(0, 'hôm qua tôi đi chợ mua rau', 0, 3, 0), sent(1, 'mua rau xong tôi về nhà nấu cơm', 4, 8, 6)];
    expect(findRetakeRanges(s, wordsFor(s), OPTS)).toEqual([]);
  });

  it('never calls a one-word sentence a retake', () => {
    const s = [sent(0, 'Vâng', 0, 1, 0), sent(1, 'Vâng tôi đồng ý', 1.5, 3, 1)];
    expect(findRetakeRanges(s, wordsFor(s), OPTS)).toEqual([]);
  });
});

describe('loadFillerLexicon', () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'fillers-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('returns defaults without a warning when no file exists', async () => {
    const lex = await loadFillerLexicon(home);
    expect(lex.A).toEqual(LEX.A);
    expect(lex.warning).toBeUndefined();
  });

  it('overrides only the tiers present in the file', async () => {
    await writeFile(join(home, 'fillers-vi.json'), JSON.stringify({ B: ['kiểu gì'] }));
    const lex = await loadFillerLexicon(home);
    expect(lex.B).toEqual(['kiểu gì']);
    expect(lex.A).toEqual(LEX.A);
    expect(lex.C).toEqual(LEX.C);
    expect(lex.warning).toBeUndefined();
  });

  it('returns defaults with a warning for a corrupt file', async () => {
    await writeFile(join(home, 'fillers-vi.json'), '{not json');
    const lex = await loadFillerLexicon(home);
    expect(lex.A).toEqual(LEX.A);
    expect(lex.B).toEqual(LEX.B);
    expect(lex.warning).toMatch(/fillers-vi\.json/);
  });

  it('ignores a tier of the wrong type with a warning', async () => {
    await writeFile(join(home, 'fillers-vi.json'), JSON.stringify({ A: 'ờ', B: ['x y'] }));
    const lex = await loadFillerLexicon(home);
    expect(lex.A).toEqual(LEX.A);
    expect(lex.B).toEqual(['x y']);
    expect(lex.warning).toBeDefined();
  });
});

describe('snapEdges', () => {
  // RMS every 10 ms from 0 to 2 s, loud (-20 dB) except for the given quiet points.
  const rms = (quiet: Record<number, number>) =>
    Array.from({ length: 200 }, (_, i) => ({ t: i / 100, v: quiet[i] ?? -20 }));

  it('moves an edge to the quietest sample within the window (60 ms away)', () => {
    // start edge at 1.00 s; the quiet sample is at 0.94 s
    const out = snapEdges([{ start: 1.0, end: 1.5, reason: 'filler-A', text: 'ờ' }], rms({ 94: -60 }), 0.08);
    expect(out[0]!.start).toBeCloseTo(0.94, 5);
    expect(out[0]!.end).toBe(1.5);
  });

  it('leaves an edge alone when the quiet sample is 120 ms away', () => {
    const out = snapEdges([{ start: 1.0, end: 1.5, reason: 'filler-A', text: 'ờ' }], rms({ 88: -60 }), 0.08);
    expect(out[0]!.start).toBe(1.0);
  });

  it('never crosses the edge of a neighbouring range', () => {
    const out = snapEdges(
      [
        { start: 0.5, end: 1.0, reason: 'filler-A', text: 'a' },
        { start: 1.03, end: 1.5, reason: 'filler-A', text: 'b' },
      ],
      rms({ 100: -60 }),
      0.08,
    );
    // the quiet sample at 1.00 s lies before the second range's start edge but not past the first range's end
    expect(out[1]!.start).toBeGreaterThanOrEqual(out[0]!.end);
    expect(out[0]!.end).toBeLessThanOrEqual(out[1]!.start);
  });

  it('keeps the start edge out of a previous kept word (quietest sample lies inside it)', () => {
    // previous word ends at 0.98 s, filler starts at 1.00 s, quietest sample at 0.94 s (inside the word)
    const out = snapEdges([{ start: 1.0, end: 1.5, reason: 'filler-A', text: 'ờ' }], rms({ 94: -60 }), 0.08, [{ lo: 0.98, hi: 9 }]);
    expect(out[0]!.start).toBeGreaterThanOrEqual(0.98);
  });

  it('keeps the end edge out of the next kept word (quietest sample lies inside it)', () => {
    // next word starts at 1.52 s, filler ends at 1.50 s, quietest sample at 1.56 s (inside the word)
    const out = snapEdges([{ start: 1.0, end: 1.5, reason: 'filler-A', text: 'ờ' }], rms({ 156: -60 }), 0.08, [{ lo: 0, hi: 1.52 }]);
    expect(out[0]!.end).toBeLessThanOrEqual(1.52);
  });

  it('still moves the end edge to a quiet sample inside the window and bounds', () => {
    const out = snapEdges([{ start: 1.0, end: 1.5, reason: 'filler-A', text: 'ờ' }], rms({ 154: -60 }), 0.08, [{ lo: 0, hi: 1.6 }]);
    expect(out[0]!.end).toBeCloseTo(1.54, 5);
  });

  it('keeps an edge when there are no samples near it', () => {
    const out = snapEdges([{ start: 1.0, end: 1.5, reason: 'retake', text: 'x' }], [], 0.08);
    expect(out[0]).toEqual({ start: 1.0, end: 1.5, reason: 'retake', text: 'x' });
  });
});

describe('findIsolatedUtterances', () => {
  const w = (text: string, start: number, end: number): TimelineWord => ({ w: text, start, end, p: 1, trackIndex: 0, clipId: 'c' });
  const s = (id: number, first: number, last: number, words: TimelineWord[]): Sentence => ({
    id, start: words[first]!.start, end: words[last]!.end, text: words.slice(first, last + 1).map((x) => x.w).join(' '), firstWord: first, lastWord: last,
  });
  const OPT = { maxSec: 0.6, minGapSec: 0.5 };

  it('finds a lone short word between long pauses (live: "Này" at 17.1 s)', () => {
    const words = [w('cộng', 15.9, 16.1), w('đồng.', 16.1, 16.35), w('Này', 17.1, 17.5), w('Tại', 19.8, 20.1), w('tổ', 20.1, 20.3)];
    const sentences = [s(0, 0, 1, words), s(1, 2, 2, words), s(2, 3, 4, words)];
    expect(findIsolatedUtterances(words, sentences, OPT)).toEqual([{ start: 17.1, end: 17.5, reason: 'isolated', text: 'Này' }]);
  });

  it('keeps a lone word that is long or close to its neighbours, and multi-word sentences', () => {
    const long = [w('a', 0, 1), w('Vânggg', 2, 2.9), w('b', 4, 4.2)];
    expect(findIsolatedUtterances(long, [s(0, 0, 0, long), s(1, 1, 1, long), s(2, 2, 2, long)].slice(0, 3), OPT)
      .filter((r) => r.text === 'Vânggg')).toEqual([]);
    const close = [w('a', 0, 1), w('này', 1.2, 1.5), w('b', 2.5, 2.8)];
    expect(findIsolatedUtterances(close, [s(0, 0, 0, close), s(1, 1, 1, close), s(2, 2, 2, close)], OPT)
      .filter((r) => r.text === 'này')).toEqual([]);
    const two = [w('a', 0, 1), w('ờ', 2, 2.2), w('thì', 2.2, 2.4), w('b', 4, 4.2)];
    expect(findIsolatedUtterances(two, [s(0, 0, 0, two), s(1, 1, 2, two), s(2, 3, 3, two)], OPT)
      .filter((r) => r.start === 2)).toEqual([]);
  });
});
