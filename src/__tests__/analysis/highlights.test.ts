import {
  candidateWindows,
  FILLERS,
  pickDiverse,
  scoreCandidates,
  signalsFor,
  type Candidate,
  type CandidateSignals,
  type Window,
} from '../../analysis/highlights.js';
import { parseShortTermLoudness } from '../../analysis/ffmpeg.js';
import type { FrameSample } from '../../analysis/roughcut.js';
import type { Sentence, TimelineWord } from '../../analysis/transcript.js';

const tw = (w: string, start: number, end: number, trackIndex = 0, p = 0.9): TimelineWord => ({
  w,
  start,
  end,
  p,
  trackIndex,
  clipId: `c${trackIndex}`,
});

describe('candidateWindows', () => {
  it('windows start and end on sentence boundaries within min/max', () => {
    // câu dài 10 s × 6, min 20, max 30 → mọi cửa sổ gồm 2–3 câu
    const sentences: Sentence[] = [
      { id: 0, start: 0, end: 10, text: 'Câu 0.', firstWord: 0, lastWord: 1 },
      { id: 1, start: 10, end: 20, text: 'Câu 1.', firstWord: 2, lastWord: 3 },
      { id: 2, start: 20, end: 30, text: 'Câu 2.', firstWord: 4, lastWord: 5 },
      { id: 3, start: 30, end: 40, text: 'Câu 3.', firstWord: 6, lastWord: 7 },
      { id: 4, start: 40, end: 50, text: 'Câu 4.', firstWord: 8, lastWord: 9 },
      { id: 5, start: 50, end: 60, text: 'Câu 5.', firstWord: 10, lastWord: 11 },
    ];

    const windows = candidateWindows(sentences, 20, 30);
    expect(windows.length).toBeGreaterThan(0);

    for (const w of windows) {
      const sentenceCount = w.endSentenceId - w.startSentenceId + 1;
      expect(sentenceCount).toBeGreaterThanOrEqual(2);
      expect(sentenceCount).toBeLessThanOrEqual(3);
      const duration = w.end - w.start;
      expect(duration).toBeGreaterThanOrEqual(20);
      expect(duration).toBeLessThanOrEqual(30);
    }

    // 2-sentence windows (dur=20): (0,1), (1,2), (2,3), (3,4), (4,5) = 5
    // 3-sentence windows (dur=30): (0,2), (1,3), (2,4), (3,5) = 4
    expect(windows).toHaveLength(9);
  });

  it('returns empty array when no combination fits within min/max', () => {
    const sentences: Sentence[] = [
      { id: 0, start: 0, end: 5, text: 'Ngắn.', firstWord: 0, lastWord: 1 },
    ];
    expect(candidateWindows(sentences, 20, 30)).toEqual([]);
  });
});

describe('signalsFor', () => {
  it('filler rate counts the two-word filler "thì là"', () => {
    // 10 từ có "ờ" và "thì là" → fillerRate === 0.3
    const words: TimelineWord[] = [
      tw('Tôi', 0.0, 0.5),
      tw('ờ', 0.5, 1.0),
      tw('nghĩ', 1.0, 1.5),
      tw('rằng', 1.5, 2.0),
      tw('chúng', 2.0, 2.5),
      tw('ta', 2.5, 3.0),
      tw('thì', 3.0, 3.5),
      tw('là', 3.5, 4.0),
      tw('nên', 4.0, 4.5),
      tw('đi', 4.5, 5.0),
    ];
    const w: Window = { startSentenceId: 0, endSentenceId: 0, start: 0.0, end: 5.0 };
    const signals = signalsFor(w, words, [], -14, []);
    expect(signals.fillerRate).toBeCloseTo(0.3, 5);
  });

  it('fillers are matched after NFC/lowercase/punctuation stripping ("Ờ," and "Thì là." count)', () => {
    const words: TimelineWord[] = [
      tw('Tôi', 0.0, 1.0),
      tw('Ờ,', 1.0, 2.0),
      tw('nghĩ', 2.0, 3.0),
      tw('Thì', 3.0, 4.0),
      tw('là.', 4.0, 5.0),
      tw('đúng.', 5.0, 6.0),
    ];
    const w: Window = { startSentenceId: 0, endSentenceId: 0, start: 0.0, end: 6.0 };
    const signals = signalsFor(w, words, [], -14, []);
    // 6 words total, 3 filler words ("Ờ,", "Thì", "là.") -> fillerRate = 3 / 6 = 0.5
    expect(signals.fillerRate).toBeCloseTo(0.5, 5);
  });

  it('multiFaceRatio is the share of seconds with two or more faces', () => {
    const w: Window = { startSentenceId: 0, endSentenceId: 0, start: 0, end: 4 };
    const faces = [
      { t: 0.5, count: 1 },
      { t: 1.5, count: 2 },
      { t: 2.5, count: 3 },
      { t: 3.5, count: 1 },
    ];
    const signals = signalsFor(w, [], [], -14, faces);
    expect(signals.multiFaceRatio).toBeCloseTo(0.5);
  });

  it('calculates pace, loudnessRel, question/exclaim, and maxPauseSec accurately', () => {
    const w: Window = { startSentenceId: 0, endSentenceId: 0, start: 0, end: 10 };
    const words: TimelineWord[] = [
      tw('Bạn', 0.0, 1.0),
      tw('có', 1.0, 2.0),
      tw('khỏe', 2.0, 3.0),
      tw('không?', 5.0, 6.0), // pause between 3.0 and 5.0 is 2.0 s
    ];
    const loudness: FrameSample[] = [
      { t: 2.0, v: -10 },
      { t: 6.0, v: -12 },
    ];
    const signals = signalsFor(w, words, loudness, -14, []);
    expect(signals.wordsPerSec).toBeCloseTo(4 / 10);
    // mean loudness = (-10 + -12) / 2 = -11; loudnessRel = -11 - (-14) = 3
    expect(signals.loudnessRel).toBeCloseTo(3);
    expect(signals.hasQuestion).toBe(true);
    expect(signals.hasExclaim).toBe(false);
    expect(signals.maxPauseSec).toBeCloseTo(2.0);
  });

  it('FILLERS export includes required filler phrases', () => {
    expect(FILLERS).toEqual(['ờ', 'à', 'ừ', 'kiểu', 'thì là']);
  });
});

describe('scoreCandidates', () => {
  it('scoreCandidates prefers louder, faster, question windows and penalises fillers, long pauses and multi-face', () => {
    // trong tập 3 ứng viên tự dựng, ứng viên có tín hiệu tốt nhất có rawScore cao nhất,
    // ứng viên nhiều từ đệm và nhiều mặt có rawScore thấp nhất.
    const baseWindow: Window = { startSentenceId: 0, endSentenceId: 1, start: 0, end: 30 };
    const bestCand: Omit<Candidate, 'rawScore'> = {
      ...baseWindow,
      text: 'Ứng viên tốt nhất',
      signals: {
        loudnessRel: 5.0,
        wordsPerSec: 3.5,
        hasQuestion: true,
        hasExclaim: false,
        fillerRate: 0.0,
        maxPauseSec: 0.2,
        multiFaceRatio: 0.0,
      },
    };
    const midCand: Omit<Candidate, 'rawScore'> = {
      ...baseWindow,
      text: 'Ứng viên trung bình',
      signals: {
        loudnessRel: 0.0,
        wordsPerSec: 2.5,
        hasQuestion: false,
        hasExclaim: false,
        fillerRate: 0.1,
        maxPauseSec: 0.6,
        multiFaceRatio: 0.2,
      },
    };
    const worstCand: Omit<Candidate, 'rawScore'> = {
      ...baseWindow,
      text: 'Ứng viên kém nhất',
      signals: {
        loudnessRel: -5.0,
        wordsPerSec: 1.2,
        hasQuestion: false,
        hasExclaim: false,
        fillerRate: 0.4,
        maxPauseSec: 2.5,
        multiFaceRatio: 0.8,
      },
    };

    const scored = scoreCandidates([bestCand, midCand, worstCand]);
    expect(scored).toHaveLength(3);
    expect(scored[0]!.rawScore).toBeGreaterThan(scored[1]!.rawScore);
    expect(scored[1]!.rawScore).toBeGreaterThan(scored[2]!.rawScore);
  });

  it('handles zero variance (std = 0) with rawScore = 0', () => {
    const cand: Omit<Candidate, 'rawScore'> = {
      startSentenceId: 0,
      endSentenceId: 0,
      start: 0,
      end: 20,
      text: 'Một ứng viên',
      signals: {
        loudnessRel: 0,
        wordsPerSec: 2,
        hasQuestion: false,
        hasExclaim: false,
        fillerRate: 0,
        maxPauseSec: 0,
        multiFaceRatio: 0,
      },
    };
    const scored = scoreCandidates([cand]);
    expect(scored[0]!.rawScore).toBe(0);
  });
});

describe('pickDiverse', () => {
  const makeCand = (start: number, end: number, rawScore: number): Candidate => ({
    startSentenceId: 0,
    endSentenceId: 0,
    start,
    end,
    text: `Cand ${start}-${end}`,
    signals: {
      loudnessRel: 0,
      wordsPerSec: 2,
      hasQuestion: false,
      hasExclaim: false,
      fillerRate: 0,
      maxPauseSec: 0,
      multiFaceRatio: 0,
    },
    rawScore,
  });

  it('pickDiverse never overlaps and caps each tenth of the episode at ceil(limit/5)', () => {
    // 100 ứng viên dồn vào 10% đầu, limit 10 → tối đa 2 ứng viên ở 10% đầu
    const totalSeconds = 100; // 10% đầu là [0, 10)
    const cands: Candidate[] = [];
    for (let i = 0; i < 100; i++) {
      cands.push(makeCand(i * 0.09, i * 0.09 + 0.08, 100 - i));
    }

    const picked = pickDiverse(cands, 10, totalSeconds);
    // limit = 10 → ceil(10 / 5) = 2. Mọi ứng viên đều ở bucket 0 (< 10s), nên tối đa 2 được chọn
    expect(picked.length).toBeLessThanOrEqual(2);
    expect(picked.length).toBe(2);

    // Không ứng viên nào chồng chéo
    for (let i = 0; i < picked.length; i++) {
      for (let j = i + 1; j < picked.length; j++) {
        const a = picked[i]!;
        const b = picked[j]!;
        expect(a.end <= b.start || b.end <= a.start).toBe(true);
      }
    }
  });

  it('returns chosen candidates sorted by start time', () => {
    const totalSeconds = 100;
    const c1 = makeCand(80, 90, 50); // higher score
    const c2 = makeCand(10, 20, 20); // lower score
    const picked = pickDiverse([c1, c2], 10, totalSeconds);
    expect(picked).toHaveLength(2);
    expect(picked[0]!.start).toBe(10);
    expect(picked[1]!.start).toBe(80);
  });

  it('pickDiverse with totalSeconds <= 0 puts everything in bucket 0 without throwing', () => {
    const c1 = makeCand(10, 20, 100);
    const c2 = makeCand(30, 40, 90);
    const c3 = makeCand(50, 60, 80);
    const c4 = makeCand(70, 80, 70);

    const pickedZero = pickDiverse([c1, c2, c3, c4], 10, 0);
    expect(pickedZero).toHaveLength(2);
    expect(pickedZero[0]!.start).toBe(10);
    expect(pickedZero[1]!.start).toBe(30);

    const pickedNegative = pickDiverse([c1, c2, c3, c4], 10, -50);
    expect(pickedNegative).toHaveLength(2);
  });
});

describe('parseShortTermLoudness', () => {
  it('parses a real ffmpeg 8.1 verbose line (S has no space)', () => {
    const line = '[Parsed_ebur128_0 @ 000001a81418e440] t: 0.0999773  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU';
    expect(parseShortTermLoudness(line)).toEqual([{ t: 0.0999773, v: -120.7 }]);
  });

  it('parseShortTermLoudness reads t and S', () => {
    // với một dòng ebur128 thật có S: -18.3 → { t, v: -18.3 }
    const realStderr = `
[Parsed_ebur128_0 @ 000001] t: 1.2      TARGET:-23 LUFS    M: -20.1 S: -18.3     I: -19.0 LUFS    LRA:   4.2 LU
`;
    const samples = parseShortTermLoudness(realStderr);
    expect(samples).toEqual([{ t: 1.2, v: -18.3 }]);
  });

  it('skips lines with S: -inf, nan, or missing t: or S:', () => {
    const stderr = `
[Parsed_ebur128_0 @ 000001] t: 0.1      TARGET:-23 LUFS    M: -120.0 S: -inf     I: -120.0 LUFS
[Parsed_ebur128_0 @ 000002] t: 0.2      TARGET:-23 LUFS    M: -120.0 S: nan      I: -120.0 LUFS
[Parsed_ebur128_0 @ 000003] TARGET:-23 LUFS    M: -20.1 S: -15.0
[Parsed_ebur128_0 @ 000004] t: 0.4      TARGET:-23 LUFS    M: -20.1
[Parsed_ebur128_0 @ 000005] t: 0.5      TARGET:-23 LUFS    M: -20.1 S: -14.2     I: -18.0 LUFS
`;
    const samples = parseShortTermLoudness(stderr);
    expect(samples).toEqual([{ t: 0.5, v: -14.2 }]);
  });
});

function naiveSignalsFor(
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

  const tokens = inWords.map((word) =>
    word.w.normalize('NFC').toLowerCase().replace(/[\p{P}\p{S}]/gu, '').trim(),
  );
  let fillerWords = 0;
  let idx = 0;
  const fillers = [['thì', 'là'], ['kiểu'], ['ờ'], ['à'], ['ừ']];
  while (idx < tokens.length) {
    let matchedLength = 0;
    for (const filler of fillers) {
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

describe('performance guard', () => {
  it('signalsFor across 60-minute candidate windows runs in under 1000ms and matches naive reference', () => {
    // 600 sentences, one every 6 s
    const sentences: Sentence[] = [];
    for (let i = 0; i < 600; i++) {
      sentences.push({
        id: i,
        start: i * 6,
        end: (i + 1) * 6,
        text: `Câu ${i}.`,
        firstWord: i * 15,
        lastWord: i * 15 + 14,
      });
    }

    // 9,000 sorted words: 2.5 words/s (each 0.4s), sentence end every 15 words
    const words: TimelineWord[] = [];
    for (let k = 0; k < 9000; k++) {
      const isSentenceEnd = k % 15 === 14;
      let wText = 'từ';
      if (isSentenceEnd) {
        wText = k % 60 === 59 ? 'hết?' : 'hết.';
      } else if (k % 45 === 0) {
        wText = 'ờ';
      } else if (k % 45 === 10) {
        wText = 'thì';
      } else if (k % 45 === 11) {
        wText = 'là';
      }
      words.push(tw(wText, k * 0.4, (k + 1) * 0.4));
    }

    // 36,000 loudness samples (every 0.1 s)
    const loudness: FrameSample[] = [];
    for (let m = 0; m < 36000; m++) {
      loudness.push({
        t: Math.round(m * 0.1 * 10) / 10,
        v: -24 + (m % 10) * 0.5,
      });
    }

    // 3,600 faces (every 1 s)
    const faces: Array<{ t: number; count: number }> = [];
    for (let p = 0; p < 3600; p++) {
      faces.push({
        t: p,
        count: p % 4 === 0 ? 2 : 1,
      });
    }

    const windows = candidateWindows(sentences, 20, 90);
    expect(windows.length).toBeGreaterThan(0);

    const medianLufs = -20;
    const t0 = performance.now();
    for (const w of windows) {
      signalsFor(w, words, loudness, medianLufs, faces);
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1000);

    // Verify against naive reference for ~50 sampled windows
    const step = Math.max(1, Math.floor(windows.length / 50));
    const sampleWindows = windows.filter((_, idx) => idx % step === 0).slice(0, 50);
    expect(sampleWindows.length).toBeGreaterThanOrEqual(40);

    for (const w of sampleWindows) {
      const actual = signalsFor(w, words, loudness, medianLufs, faces);
      const expected = naiveSignalsFor(w, words, loudness, medianLufs, faces);
      expect(actual.wordsPerSec).toBeCloseTo(expected.wordsPerSec, 5);
      expect(actual.loudnessRel).toBeCloseTo(expected.loudnessRel, 5);
      expect(actual.hasQuestion).toBe(expected.hasQuestion);
      expect(actual.hasExclaim).toBe(expected.hasExclaim);
      expect(actual.fillerRate).toBeCloseTo(expected.fillerRate, 5);
      expect(actual.maxPauseSec).toBeCloseTo(expected.maxPauseSec, 5);
      expect(actual.multiFaceRatio).toBeCloseTo(expected.multiFaceRatio, 5);
    }
  });
});
