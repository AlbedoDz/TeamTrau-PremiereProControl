import type { ToolContext } from '../../tools/context.js';

jest.mock('../../tools/domains/shorts.js', () => ({
  ...jest.requireActual('../../tools/domains/shorts.js'),
  loadTranscript: jest.fn(),
  reframeToVertical: jest.fn(),
  addAlphaCaptions: jest.fn(),
}));
jest.mock('../../tools/domains/cleanup.js', () => ({
  ...jest.requireActual('../../tools/domains/cleanup.js'),
  readSequence: jest.fn(),
  removeRanges: jest.fn(),
  normalizeLoudness: jest.fn(),
}));
jest.mock('../../tools/domains/sequence.js', () => ({
  ...jest.requireActual('../../tools/domains/sequence.js'),
  duplicateSequence: jest.fn(),
}));
jest.mock('../../tools/domains/editing.js', () => ({
  ...jest.requireActual('../../tools/domains/editing.js'),
  ensureBackup: jest.fn(),
  qaSequence: jest.fn(),
}));

import * as shorts from '../../tools/domains/shorts.js';
import * as cleanup from '../../tools/domains/cleanup.js';
import * as sequence from '../../tools/domains/sequence.js';
import * as editing from '../../tools/domains/editing.js';
import { recapTools } from '../../tools/domains/recap.js';

const loadTranscript = shorts.loadTranscript as jest.Mock;
const reframeToVertical = shorts.reframeToVertical as jest.Mock;
const addAlphaCaptions = shorts.addAlphaCaptions as jest.Mock;
const readSequence = cleanup.readSequence as jest.Mock;
const removeRanges = cleanup.removeRanges as jest.Mock;
const normalizeLoudness = cleanup.normalizeLoudness as jest.Mock;
const duplicateSequence = sequence.duplicateSequence as jest.Mock;
const ensureBackup = editing.ensureBackup as jest.Mock;
const qaSequence = editing.qaSequence as jest.Mock;

const tool = recapTools.find((t) => t.name === 'build_recap')!;
const run = (ctx: ToolContext, args: Record<string, unknown>): Promise<any> => tool.run(ctx, tool.inputSchema.parse({ name: 'Recap', ...args })) as Promise<any>;

const SEGMENTS = [
  { id: 's1', start: 10, end: 20, score: 0.8 },
  { id: 's2', start: 50, end: 60, score: 0.7 },
];
const vclip = { id: 'v1', trackType: 'video', trackIndex: 0, start: 0, end: 100, inPoint: 0, outPoint: 100, mediaPath: 'C:/m.mp4' };
const snapshot = (clips: unknown[] = [vclip]) => ({ sequenceId: 'src', sequenceName: 'Tap 1', frameDuration: 0.04, endTime: 100, clips });
const ctxWith = (names: string[] = ['Tap 1']): ToolContext => ({
  bridge: { executeScript: jest.fn().mockResolvedValue({ success: true, names }) },
} as unknown as ToolContext);

/** The shots-mode fingerprint plan_recap would return for `vclip`. */
const shotsFingerprint = (): string => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto');
  return createHash('sha1').update(['v1', 0, 100, 0, 100, 'C:/m.mp4'].join('|') + '\nrecap-shots').digest('hex');
};

beforeEach(() => {
  jest.resetAllMocks();
  readSequence.mockImplementation(async (_c: unknown, id?: string) => (id === 'new' || id === 'vert' ? { ...snapshot(), sequenceId: id, endTime: 20 } : snapshot()));
  ensureBackup.mockResolvedValue({ path: 'C:/backup.prproj' });
  duplicateSequence.mockResolvedValue({ success: true, newSequenceId: 'new' });
  removeRanges.mockResolvedValue({
    success: true, verified: true, durationBefore: 100, durationAfter: 20, crossfadeFrames: 1, crossfadeMsActual: 40,
    removed: [{ start: 0, end: 10 }, { start: 20, end: 50 }, { start: 60, end: 100 }],
  });
  normalizeLoudness.mockResolvedValue({ success: true });
  qaSequence.mockResolvedValue({ success: true, errors: 0, findings: [] });
  reframeToVertical.mockResolvedValue({ sequenceId: 'vert', deleted: true, frameSizeHorizontal: 1215, frameSizeVertical: 2160 });
  addAlphaCaptions.mockResolvedValue({ ok: true });
});

describe('build_recap', () => {
  it('duplicates once, then removes ranges once with invert and exactly the segments', async () => {
    const result = await run(ctxWith(), { segments: SEGMENTS, expectedFingerprint: shotsFingerprint() });

    expect(result).toMatchObject({ success: true, sequenceId: 'new', durationSec: 20, verified: true, audioLeadSupported: false });
    expect(duplicateSequence).toHaveBeenCalledTimes(1);
    expect(duplicateSequence).toHaveBeenCalledWith(expect.anything(), 'src', 'Recap');
    expect(removeRanges).toHaveBeenCalledTimes(1);
    expect(removeRanges.mock.calls[0][1]).toMatchObject({
      sequenceId: 'new',
      invert: true,
      ranges: [{ start: 10, end: 20 }, { start: 50, end: 60 }],
      crossfadeMs: 30,
      mergeGapSec: 0.4,
      minKeepSec: 0.4,
      backup: false,
      dryRun: false,
    });
    expect(ensureBackup).toHaveBeenCalledTimes(1);
    expect(result.backupPath).toBe('C:/backup.prproj');
    expect(reframeToVertical).not.toHaveBeenCalled();
    expect(normalizeLoudness).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sequenceId: 'new', targetLufs: -14, backup: false }));
  });

  it('refuses a stale fingerprint without touching anything', async () => {
    loadTranscript.mockResolvedValue({ status: 'done', fingerprint: 'other', words: [], sentences: [] });
    const result = await run(ctxWith(), { segments: SEGMENTS, expectedFingerprint: 'stale' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/plan_recap/);
    expect(ensureBackup).not.toHaveBeenCalled();
    expect(duplicateSequence).not.toHaveBeenCalled();
    expect(removeRanges).not.toHaveBeenCalled();
  });

  it('accepts the transcript fingerprint of speech mode', async () => {
    loadTranscript.mockResolvedValue({ status: 'done', fingerprint: 'speech-fp', words: [], sentences: [] });
    const result = await run(ctxWith(), { segments: SEGMENTS, expectedFingerprint: 'speech-fp' });
    expect(result.success).toBe(true);
    expect(removeRanges).toHaveBeenCalledTimes(1);
  });

  it('warns music-chopped for a 40 s audio clip cut in 3 places', async () => {
    const music = { id: 'm1', trackType: 'audio', trackIndex: 2, start: 0, end: 40, inPoint: 0, outPoint: 40, mediaPath: 'C:/music.wav' };
    // Segments leave 3 interior gaps inside the 40 s music clip (0-40 here).
    const segments = [
      { id: 'a', start: 5, end: 10, score: 1 },
      { id: 'b', start: 15, end: 20, score: 1 },
      { id: 'c', start: 25, end: 30, score: 1 },
      { id: 'd', start: 35, end: 38, score: 1 },
    ];
    readSequence.mockResolvedValue(snapshot([vclip, music]));
    const result = await run(ctxWith(), { segments, dryRun: true });

    expect(result.success).toBe(true);
    expect(result.warnings.some((w: string) => w.includes('music-chopped'))).toBe(true);
  });

  it('does not warn music-chopped for a short audio clip or fewer cuts', async () => {
    const music = { id: 'm1', trackType: 'audio', trackIndex: 2, start: 0, end: 40, inPoint: 0, outPoint: 40, mediaPath: 'C:/music.wav' };
    readSequence.mockResolvedValue(snapshot([vclip, music]));
    const result = await run(ctxWith(), { segments: [{ id: 'a', start: 5, end: 10, score: 1 }, { id: 'b', start: 15, end: 20, score: 1 }], dryRun: true });
    expect(result.warnings.some((w: string) => w.includes('music-chopped'))).toBe(false);
  });

  it('reframes to 9:16 and captions the reframed sequence', async () => {
    const words = [{ w: 'xin', start: 12, end: 12.4, trackIndex: 0, clipId: 'a1' }];
    loadTranscript.mockResolvedValue({ status: 'done', fingerprint: shotsFingerprint(), words, sentences: [] });
    const result = await run(ctxWith(), { segments: SEGMENTS, expectedFingerprint: shotsFingerprint(), aspect: '9:16', captionStyle: 'pop' });

    expect(result).toMatchObject({ success: true, sequenceId: 'vert' });
    expect(reframeToVertical).toHaveBeenCalledTimes(1);
    expect(reframeToVertical).toHaveBeenCalledWith(expect.anything(), 'new', 'Recap');
    expect(duplicateSequence).toHaveBeenCalledWith(expect.anything(), 'src', 'Recap (16:9)');
    expect(addAlphaCaptions).toHaveBeenCalledTimes(1);
    const [, seqId, passedWords, style, timeMap] = addAlphaCaptions.mock.calls[0];
    expect(seqId).toBe('vert');
    expect(passedWords).toBe(words);
    expect(style).toBe('pop');
    expect(timeMap(12)).toBe(2); // 10 s removed before it
    expect(timeMap(55)).toBe(15); // 10 s removed, then 30 s removed, minus 0: 55-10-30
    expect(timeMap(30)).toBeNull(); // inside a removed stretch
  });

  it('does not caption or reframe with the defaults', async () => {
    await run(ctxWith(), { segments: SEGMENTS, expectedFingerprint: shotsFingerprint(), captionStyle: 'none' });
    expect(addAlphaCaptions).not.toHaveBeenCalled();
    expect(loadTranscript).not.toHaveBeenCalled();
  });

  it('ignores audioLeadSec with a warning and still builds', async () => {
    const result = await run(ctxWith(), { segments: SEGMENTS, expectedFingerprint: shotsFingerprint(), audioLeadSec: 0.5 });
    expect(result.success).toBe(true);
    expect(result.audioLeadSupported).toBe(false);
    expect(result.warnings.some((w: string) => w.includes('J-cut'))).toBe(true);
    expect(removeRanges).toHaveBeenCalledTimes(1);
  });

  it('appends (2), (3) when the name is taken and keeps accents', async () => {
    await run(ctxWith(['Tóm tắt: tập 1', 'Tóm tắt: tập 1 (2)']), { segments: SEGMENTS, expectedFingerprint: shotsFingerprint(), name: 'Tóm tắt: tập 1' });
    expect(duplicateSequence).toHaveBeenCalledWith(expect.anything(), 'src', 'Tóm tắt: tập 1 (3)');
  });

  it('dryRun changes nothing and reports the planned length', async () => {
    const result = await run(ctxWith(), { segments: SEGMENTS, expectedFingerprint: shotsFingerprint(), dryRun: true });
    expect(result).toMatchObject({ success: true, dryRun: true, durationSec: 20 });
    expect(ensureBackup).not.toHaveBeenCalled();
    expect(duplicateSequence).not.toHaveBeenCalled();
  });

  it('rejects overlapping or unordered segments before any change', async () => {
    const result = await run(ctxWith(), { segments: [{ start: 50, end: 60 }, { start: 10, end: 20 }] });
    expect(result.success).toBe(false);
    expect(ensureBackup).not.toHaveBeenCalled();
  });

  it('keeps the backup path and the sequence when remove_ranges fails', async () => {
    removeRanges.mockResolvedValue({ success: false, error: 'boom', removed: [], durationBefore: 100, crossfadeFrames: 0, crossfadeMsActual: 0 });
    const result = await run(ctxWith(), { segments: SEGMENTS, expectedFingerprint: shotsFingerprint() });
    expect(result).toMatchObject({ success: false, failedStep: 'remove_ranges', sequenceId: 'new', backupPath: 'C:/backup.prproj' });
  });

  it('reports verified false when remove_ranges could not verify', async () => {
    removeRanges.mockResolvedValue({ success: true, verified: false, warning: 'Track khóa', durationBefore: 100, durationAfter: 20, crossfadeFrames: 1, crossfadeMsActual: 40, removed: [] });
    const result = await run(ctxWith(), { segments: SEGMENTS, expectedFingerprint: shotsFingerprint() });
    expect(result.verified).toBe(false);
    expect(result.warnings).toContain('Track khóa');
  });
});
