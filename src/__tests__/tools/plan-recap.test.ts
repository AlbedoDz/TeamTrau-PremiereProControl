import type { ToolContext } from '../../tools/context.js';

jest.mock('../../tools/domains/shorts.js', () => ({
  ...jest.requireActual('../../tools/domains/shorts.js'),
  loadTranscript: jest.fn(),
  timelineLoudness: jest.fn(),
}));
jest.mock('../../analysis/scenes.js', () => ({ detectScenes: jest.fn() }));
jest.mock('../../tools/domains/roughcut.js', () => ({
  ...jest.requireActual('../../tools/domains/roughcut.js'),
  scoreAll: jest.fn(),
}));
jest.mock('../../analysis/ffmpeg.js', () => ({
  ...jest.requireActual('../../analysis/ffmpeg.js'),
  findFfTool: jest.fn(),
}));

import * as shorts from '../../tools/domains/shorts.js';
import * as scenes from '../../analysis/scenes.js';
import * as roughcut from '../../tools/domains/roughcut.js';
import * as ffmpeg from '../../analysis/ffmpeg.js';
import { recapTools } from '../../tools/domains/recap.js';

const loadTranscript = shorts.loadTranscript as jest.Mock;
const timelineLoudness = shorts.timelineLoudness as jest.Mock;
const detectScenes = scenes.detectScenes as jest.Mock;
const scoreAll = roughcut.scoreAll as jest.Mock;
const findFfTool = ffmpeg.findFfTool as jest.Mock;

const tool = recapTools.find((t) => t.name === 'plan_recap')!;
const parse = (args: Record<string, unknown> = {}) => tool.inputSchema.parse(args);

const vclip = (over: Record<string, unknown> = {}) => ({
  id: 'v1', trackType: 'video', trackIndex: 0, start: 100, end: 160, inPoint: 20, outPoint: 80, mediaPath: 'C:/m.mp4', ...over,
});
const aclip = (over: Record<string, unknown> = {}) => ({
  id: 'a1', trackType: 'audio', trackIndex: 0, start: 100, end: 160, inPoint: 20, outPoint: 80, mediaPath: 'C:/m.wav', ...over,
});
const ctxWith = (clips: unknown[], endTime = 600): ToolContext => ({
  bridge: { executeScript: jest.fn().mockResolvedValue({ success: true, sequenceId: 's1', sequenceName: 'S', frameDuration: 0.04, endTime, clips }) },
} as unknown as ToolContext);

/** 2 s windows every second from 0 to 100 s of the source. */
const windows = Array.from({ length: 99 }, (_, i) => ({ start: i, end: i + 2, score: 0.5, exposure: 0.5, sharpness: 0.5, flags: [] }));

beforeEach(() => {
  jest.resetAllMocks();
  findFfTool.mockResolvedValue('ffmpeg');
  timelineLoudness.mockResolvedValue([]);
  scoreAll.mockResolvedValue({ scored: [{ mediaPath: 'C:/m.mp4', sourceDuration: 100, windows }], failed: [] });
  detectScenes.mockResolvedValue({
    cutTimes: [],
    // The first shot lies before the clip's in point, the last after its out point.
    shots: [{ start: 0, end: 10 }, { start: 10, end: 30 }, { start: 30, end: 40 }, { start: 40, end: 70 }, { start: 70, end: 90 }, { start: 90, end: 100 }],
  });
});

describe('plan_recap schema', () => {
  it('applies the defaults', () => {
    expect(parse()).toMatchObject({ targetSec: 90, mode: 'auto', maxSegmentSec: 20 });
    // Left unset so each mode applies its own floor (8 s speech, 4 s shots).
    expect(parse().minSegmentSec).toBeUndefined();
  });
  it('rejects a minimum above the maximum', () => {
    expect(() => parse({ minSegmentSec: 30 })).toThrow(/minSegmentSec/);
  });
});

describe('plan_recap shots mode', () => {
  it('maps source time to sequence time and drops shots outside the clip in/out', async () => {
    const result: any = await tool.run(ctxWith([vclip()]), parse({ mode: 'shots', targetSec: 24 }));
    expect(result.success).toBe(true);
    expect(result.mode).toBe('shots');
    expect(loadTranscript).not.toHaveBeenCalled();
    expect(result.segments.length).toBeGreaterThan(0);
    for (const s of result.segments) {
      // The clip shows source 20-80 at sequence 100-160.
      expect(s.start).toBeGreaterThanOrEqual(100);
      expect(s.end).toBeLessThanOrEqual(160);
      expect(s.end - s.start).toBeLessThanOrEqual(6 + 1e-9);
    }
    const sum = result.segments.reduce((t: number, s: any) => t + s.end - s.start, 0);
    expect(sum).toBeGreaterThanOrEqual(21.6);
    expect(sum).toBeLessThanOrEqual(26.4);
    // The shot 10-30 becomes source 20-30, which is sequence 100-110; the first shot is gone.
    expect(result.candidates.some((c: any) => c.start === 100)).toBe(true);
    expect(result.candidates.every((c: any) => c.id.startsWith('shot-'))).toBe(true);
    expect(result.sequenceSec).toBe(600);
    expect(result.totalSec).toBeCloseTo(result.segments.reduce((t: number, s: any) => t + s.end - s.start, 0), 2);
    expect(typeof result.fingerprint).toBe('string');
    expect(scoreAll).toHaveBeenCalledWith(['C:/m.mp4'], 2, 'plan_recap');
    expect(detectScenes).toHaveBeenCalledWith('C:/m.mp4', { threshold: 0.3, minShotSec: 0.5 });
  });

  it('uses only the lowest video track that has clips', async () => {
    const upper = vclip({ id: 'v2', trackIndex: 1, mediaPath: 'C:/other.mp4' });
    await tool.run(ctxWith([upper, vclip({ trackIndex: 0 })]), parse({ mode: 'shots', targetSec: 24 }));
    expect(scoreAll).toHaveBeenCalledWith(['C:/m.mp4'], 2, 'plan_recap');
  });

  it('skips clips with changed speed and reports it in Vietnamese', async () => {
    const result: any = await tool.run(ctxWith([vclip({ outPoint: 140 }), vclip({ id: 'v3', start: 200, end: 260 })]), parse({ mode: 'shots', targetSec: 24 }));
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/đổi tốc độ/);
    expect(result.segments.every((s: any) => s.start >= 200)).toBe(true);
  });

  it('warns in Vietnamese when the plan is under 90% of the target', async () => {
    const result: any = await tool.run(ctxWith([vclip()]), parse({ mode: 'shots', targetSec: 90 }));
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/Chỉ chọn được .* giây, thấp hơn mục tiêu 90/);
  });

  it('fails clearly when there is no video', async () => {
    const result: any = await tool.run(ctxWith([aclip()]), parse({ mode: 'shots' }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/video/);
  });

  it('returns the ffmpeg-missing result from scoring as is', async () => {
    scoreAll.mockResolvedValue({ failure: { success: false, error: 'ffmpeg missing' } });
    const result: any = await tool.run(ctxWith([vclip()]), parse({ mode: 'shots' }));
    expect(result).toEqual({ success: false, error: 'ffmpeg missing' });
  });
});

describe('plan_recap auto and speech modes', () => {
  const sentences = Array.from({ length: 60 }, (_, i) => ({
    id: i, start: i * 10, end: i * 10 + 9.5, text: `một${i} hai${i} ba${i} bốn${i} chung`, firstWord: i, lastWord: i,
  }));
  const words = sentences.map((s) => ({ w: s.text, start: s.start, end: s.end, p: 1, trackIndex: 0, clipId: 'a1' }));
  const ready = (over: Record<string, unknown> = {}) => ({
    status: 'done', sequenceId: 's1', fingerprint: 'fp1', dialogueTrackIndices: [0], words, sentences, warnings: [], endTime: 600, frameDuration: 0.04, ...over,
  });
  const clips = [aclip({ start: 0, end: 600, inPoint: 0, outPoint: 600 }), vclip()];

  it('picks speech when the dialogue covers the sequence', async () => {
    loadTranscript.mockResolvedValue(ready());
    const result: any = await tool.run(ctxWith(clips), parse());
    expect(result.mode).toBe('speech');
    expect(result.fingerprint).toBe('fp1');
    const sum = result.segments.reduce((t: number, s: any) => t + s.end - s.start, 0);
    expect(sum).toBeGreaterThanOrEqual(81);
    expect(sum).toBeLessThanOrEqual(99);
    expect(result.candidates.length).toBeLessThanOrEqual(24);
    for (const s of result.segments) expect(s.text).toEqual(expect.any(String));
    expect(detectScenes).not.toHaveBeenCalled();
    // totalSec is the recap's length, not the sequence's.
    expect(result.totalSec).toBeCloseTo(sum, 2);
    expect(result.sequenceSec).toBe(600);
  });

  it('keeps speech segments at least 8 s long by default', async () => {
    // 3 s sentences: the old 4 s floor let single fragments through.
    const short = Array.from({ length: 200 }, (_, i) => ({
      id: i, start: i * 3, end: i * 3 + 2.8, text: `ý${i} một hai ba`, firstWord: i, lastWord: i,
    }));
    const shortWords = short.map((s) => ({ w: s.text, start: s.start, end: s.end, p: 1, trackIndex: 0, clipId: 'a1' }));
    loadTranscript.mockResolvedValue(ready({ sentences: short, words: shortWords }));
    const result: any = await tool.run(ctxWith(clips), parse());
    expect(result.mode).toBe('speech');
    expect(result.segments.length).toBeGreaterThan(0);
    for (const s of result.segments) expect(s.end - s.start).toBeGreaterThanOrEqual(8);
  });

  it('never ends a recap segment on an unanswered question', async () => {
    // Every other sentence is a question; the scorer used to favour exactly those.
    const qa = sentences.map((s, i) => ({ ...s, text: i % 2 === 0 ? `${s.text} phải không?` : s.text }));
    const qaWords = qa.map((s) => ({ w: s.text, start: s.start, end: s.end, p: 1, trackIndex: 0, clipId: 'a1' }));
    loadTranscript.mockResolvedValue(ready({ sentences: qa, words: qaWords }));
    const result: any = await tool.run(ctxWith(clips), parse());
    expect(result.mode).toBe('speech');
    expect(result.segments.length).toBeGreaterThan(0);
    for (const s of result.segments) expect(s.text.trim()).not.toMatch(/\?$/);
  });

  it('switches to shots when the speech covers under 30%', async () => {
    loadTranscript.mockResolvedValue(ready({ sentences: sentences.slice(0, 10), endTime: 600 }));
    const result: any = await tool.run(ctxWith(clips), parse({ targetSec: 24 }));
    expect(result.mode).toBe('shots');
    expect(result.warnings.join(' ')).toMatch(/shots/);
  });

  it('switches to shots when the transcript is empty', async () => {
    loadTranscript.mockResolvedValue(ready({ sentences: [], words: [] }));
    const result: any = await tool.run(ctxWith(clips), parse({ targetSec: 24 }));
    expect(result.mode).toBe('shots');
  });

  it('switches to shots without calling the transcript when no audio track has media', async () => {
    const result: any = await tool.run(ctxWith([vclip()]), parse({ targetSec: 24 }));
    expect(result.mode).toBe('shots');
    expect(loadTranscript).not.toHaveBeenCalled();
    expect(result.warnings.join(' ')).toMatch(/lời thoại/);
  });

  it('stays in speech mode when asked, even with little speech', async () => {
    loadTranscript.mockResolvedValue(ready({ sentences: sentences.slice(0, 10) }));
    const result: any = await tool.run(ctxWith(clips), parse({ mode: 'speech' }));
    expect(result.mode).toBe('speech');
  });

  it('passes a running transcription through', async () => {
    loadTranscript.mockResolvedValue({ status: 'running', progress: 0.4, files: 1 });
    const result: any = await tool.run(ctxWith(clips), parse());
    expect(result).toMatchObject({ success: true, status: 'running', progress: 0.4 });
    expect(result.nextStep).toMatch(/plan_recap/);
  });

  it('passes a transcript failure through', async () => {
    loadTranscript.mockResolvedValue({ success: false, error: 'boom' });
    const result: any = await tool.run(ctxWith(clips), parse());
    expect(result).toEqual({ success: false, error: 'boom' });
  });
});
