import {
  candidateWindows,
  FILLERS,
  pickDiverse,
  scoreCandidates,
  signalsFor,
  type Candidate,
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
});

describe('parseShortTermLoudness', () => {
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
