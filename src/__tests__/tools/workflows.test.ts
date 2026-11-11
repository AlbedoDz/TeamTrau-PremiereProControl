import type { ToolContext } from '../../tools/context.js';

jest.mock('../../tools/domains/shorts.js', () => ({
  ...jest.requireActual('../../tools/domains/shorts.js'),
  loadTranscript: jest.fn(),
}));
jest.mock('../../analysis/ffmpeg.js', () => ({
  ...jest.requireActual('../../analysis/ffmpeg.js'),
  findFfTool: jest.fn(),
}));
jest.mock('../../tools/domains/cleanup.js', () => ({
  ...jest.requireActual('../../tools/domains/cleanup.js'),
  readSequence: jest.fn(),
  removeRanges: jest.fn(),
  analyseSilence: jest.fn(),
}));
jest.mock('../../tools/domains/fillers.js', () => ({
  ...jest.requireActual('../../tools/domains/fillers.js'),
  findFillersAndRetakes: jest.fn(),
}));
jest.mock('../../tools/domains/sequence.js', () => ({
  ...jest.requireActual('../../tools/domains/sequence.js'),
  duplicateSequence: jest.fn(),
  createCaptionTrack: jest.fn(),
}));
jest.mock('../../tools/domains/editing.js', () => ({
  ...jest.requireActual('../../tools/domains/editing.js'),
  ensureBackup: jest.fn(),
  qaSequence: jest.fn(),
  applyDialogueChain: jest.fn(),
}));
jest.mock('../../tools/domains/subtitles.js', () => ({
  ...jest.requireActual('../../tools/domains/subtitles.js'),
  createCaptionsFromTranscript: jest.fn(),
}));
jest.mock('../../tools/domains/media.js', () => ({
  ...jest.requireActual('../../tools/domains/media.js'),
  importMedia: jest.fn(),
}));
jest.mock('../../tools/domains/project.js', () => ({
  ...jest.requireActual('../../tools/domains/project.js'),
  ensureRootBin: jest.fn(),
}));

import * as ffmpeg from '../../analysis/ffmpeg.js';
import * as shorts from '../../tools/domains/shorts.js';
import * as cleanup from '../../tools/domains/cleanup.js';
import * as fillers from '../../tools/domains/fillers.js';
import * as sequence from '../../tools/domains/sequence.js';
import * as editing from '../../tools/domains/editing.js';
import * as subtitles from '../../tools/domains/subtitles.js';
import * as media from '../../tools/domains/media.js';
import * as project from '../../tools/domains/project.js';
import { awaitTranscript, runSteps, uniqueSequenceName } from '../../tools/workflows/steps.js';
import { workflowToolsTools } from '../../tools/domains/workflow-tools.js';

const findFfTool = ffmpeg.findFfTool as jest.Mock;
const loadTranscript = shorts.loadTranscript as jest.Mock;
const readSequence = cleanup.readSequence as jest.Mock;
const removeRanges = cleanup.removeRanges as jest.Mock;
const analyseSilence = cleanup.analyseSilence as jest.Mock;
const findFillers = fillers.findFillersAndRetakes as jest.Mock;
const duplicateSequence = sequence.duplicateSequence as jest.Mock;
const createCaptionTrack = sequence.createCaptionTrack as jest.Mock;
const ensureBackup = editing.ensureBackup as jest.Mock;
const qaSequence = editing.qaSequence as jest.Mock;
const applyDialogueChain = editing.applyDialogueChain as jest.Mock;
const createCaptions = subtitles.createCaptionsFromTranscript as jest.Mock;
const importMedia = media.importMedia as jest.Mock;
const ensureRootBin = project.ensureRootBin as jest.Mock;

const ctxWith = (overrides: Partial<ToolContext> = {}, names: string[] = ['Tap 1']): ToolContext =>
  ({ bridge: { executeScript: jest.fn().mockResolvedValue({ success: true, names }) }, ...overrides }) as unknown as ToolContext;

const tool = (name: string) => workflowToolsTools.find((t) => t.name === name)!;
const runTool = (name: string, ctx: ToolContext, args: Record<string, unknown> = {}): Promise<any> =>
  tool(name).run(ctx, tool(name).inputSchema.parse(args)) as Promise<any>;

beforeEach(() => {
  jest.resetAllMocks();
});

describe('runSteps', () => {
  it('reports progress for every step, in order', async () => {
    const progress = jest.fn();
    const ctx = ctxWith({ progress });
    const result = await runSteps(ctx, [
      { label: 'A', run: async () => ({ ok: true }) },
      { label: 'B', run: async () => ({ ok: true }) },
      { label: 'C', run: async () => ({ ok: true }) },
    ]);
    expect(result.success).toBe(true);
    expect(progress.mock.calls).toEqual([[1, 3, 'A'], [2, 3, 'B'], [3, 3, 'C']]);
    expect(result.steps.map((s) => s.label)).toEqual(['A', 'B', 'C']);
  });

  it('stops at the first failing step and gives a nextStep', async () => {
    const third = jest.fn();
    const result = await runSteps(ctxWith(), [
      { label: 'A', run: async () => ({ ok: true }) },
      { label: 'B', run: async () => ({ ok: false, detail: { error: 'x' } }) },
      { label: 'C', run: third },
    ]);
    expect(third).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.nextStep).toEqual(expect.any(String));
    expect(result.steps).toHaveLength(2);
  });

  it('turns a thrown error into a failed step', async () => {
    const result = await runSteps(ctxWith(), [{ label: 'A', run: async () => { throw new Error('boom'); } }]);
    expect(result.success).toBe(false);
    expect(result.steps[0]).toMatchObject({ ok: false, detail: { error: 'boom' } });
  });

  it('returns cancelled, skips later steps and renames the copy it created', async () => {
    const controller = new AbortController();
    const ctx = ctxWith({ signal: controller.signal });
    const second = jest.fn();
    const result = await runSteps(ctx, [
      { label: 'A', run: async () => { controller.abort(); return { ok: true, createdSequenceId: 'copy1' }; } },
      { label: 'B', run: second },
    ]);
    expect(second).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, cancelled: true, outputSequenceIds: ['copy1'] });
    const script = (ctx.bridge.executeScript as jest.Mock).mock.calls[0][0] as string;
    expect(script).toContain('"copy1"');
    expect(script).toContain('(đã hủy)');
  });

  it('uses the "dang dở" suffix when the panel was closed', async () => {
    const controller = new AbortController();
    const ctx = ctxWith({ signal: controller.signal });
    const result = await runSteps(ctx, [
      { label: 'A', run: async () => { controller.abort('panel-closed'); return { ok: true, createdSequenceId: 'copy1' }; } },
      { label: 'B', run: async () => ({ ok: true }) },
    ]);
    expect(result.cancelled).toBe(true);
    expect((ctx.bridge.executeScript as jest.Mock).mock.calls[0][0]).toContain('(dang dở)');
  });
});

describe('awaitTranscript', () => {
  it('polls while running, reports a percentage in the label, and returns the done transcript', async () => {
    const progress = jest.fn();
    const done = { status: 'done', sequenceId: 's', words: [] };
    loadTranscript
      .mockResolvedValueOnce({ status: 'running', progress: 0.4, files: 1 })
      .mockResolvedValueOnce({ status: 'running', progress: 0.8, files: 1 })
      .mockResolvedValueOnce(done);
    const result = await awaitTranscript(ctxWith({ progress }), {}, 'Nhận dạng', { pollMs: 1 });
    expect(result).toBe(done);
    expect(loadTranscript).toHaveBeenCalledTimes(3);
    expect(progress.mock.calls.map((c) => c[2])).toEqual(['Nhận dạng 40%', 'Nhận dạng 80%']);
  });

  it('passes a failure through', async () => {
    loadTranscript.mockResolvedValueOnce({ success: false, error: 'no sidecar' });
    expect(await awaitTranscript(ctxWith(), {}, 'x')).toEqual({ success: false, error: 'no sidecar' });
  });

  it('is cancellable while waiting', async () => {
    const controller = new AbortController();
    loadTranscript.mockResolvedValue({ status: 'running', progress: 0.1, files: 1 });
    const pending = awaitTranscript(ctxWith({ signal: controller.signal }), {}, 'x', { pollMs: 60_000 });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toThrow('cancelled');
  });
});

describe('uniqueSequenceName', () => {
  it('keeps accents, slash and colon, and adds (2) when taken', async () => {
    const ctx = ctxWith({}, ['Phỏng vấn: tập 1/2']);
    expect(await uniqueSequenceName(ctx, 'Phỏng vấn: tập 1/2')).toBe('Phỏng vấn: tập 1/2 (2)');
    expect(await uniqueSequenceName(ctxWith({}, ['a', 'a (2)']), 'a')).toBe('a (3)');
    expect(await uniqueSequenceName(ctxWith({}, ['b']), 'a')).toBe('a');
  });
});

describe('workflow_clean_voiceover', () => {
  const aclip = { id: 'a1', trackType: 'audio', trackIndex: 0, start: 0, end: 100, inPoint: 0, outPoint: 100, mediaPath: 'C:/m.wav' };
  const snapshot = { sequenceId: 'src', sequenceName: 'Tap 1', frameDuration: 0.04, endTime: 100, clips: [aclip] };
  const transcript = (words: unknown[] = [{ text: 'a' }]) => ({ status: 'done', sequenceId: 'src', words, sentences: [], dialogueTrackIndices: [0], warnings: [] });
  const fillerResult = {
    success: true,
    ranges: [
      { start: 30, end: 30.4, reason: 'filler-A', text: 'ờ' },
      { start: 50, end: 52, reason: 'retake', text: 'x' },
    ],
    skippedClips: [],
    warnings: ['canh bao'],
  };

  beforeEach(() => {
    readSequence.mockResolvedValue(snapshot);
    findFfTool.mockResolvedValue('ffmpeg');
    analyseSilence.mockResolvedValue({ silenceByMedia: new Map([['C:/m.wav', [{ start: 10, end: 12, duration: 2 }]]]) });
    loadTranscript.mockResolvedValue(transcript());
    findFillers.mockResolvedValue(fillerResult);
    ensureBackup.mockResolvedValue({ path: 'C:/b.prproj' });
    duplicateSequence.mockResolvedValue({ success: true, newSequenceId: 'copy' });
    removeRanges.mockResolvedValue({ success: true, removed: [{ start: 10, end: 12, duration: 2 }], durationBefore: 100, durationAfter: 95, verified: true, crossfadeFrames: 1, crossfadeMsActual: 40 });
    applyDialogueChain.mockResolvedValue({ success: true, results: [] });
    qaSequence.mockResolvedValue({ success: true, findings: [] });
  });

  it('measures everything before duplicating and calls remove_ranges once with the union', async () => {
    const order: string[] = [];
    findFillers.mockImplementation(async () => { order.push('fillers'); return fillerResult; });
    analyseSilence.mockImplementation(async () => { order.push('silence'); return { silenceByMedia: new Map([['C:/m.wav', [{ start: 10, end: 12, duration: 2 }]]]) }; });
    duplicateSequence.mockImplementation(async () => { order.push('duplicate'); return { success: true, newSequenceId: 'copy' }; });

    const result = await runTool('workflow_clean_voiceover', ctxWith(), {});

    expect(order).toEqual(['silence', 'fillers', 'duplicate']);
    expect(removeRanges).toHaveBeenCalledTimes(1);
    const call = removeRanges.mock.calls[0][1];
    expect(call).toMatchObject({ sequenceId: 'copy', invert: false, crossfadeMs: 30, mergeGapSec: 0.4, minKeepSec: 0.4, dryRun: false, backup: false });
    expect(call.ranges).toHaveLength(3);
    expect(call.ranges.map((r: any) => [r.start, r.end])).toEqual(expect.arrayContaining([[30, 30.4], [50, 52]]));
    expect(duplicateSequence.mock.calls[0][1]).toBe('src');
    expect(duplicateSequence.mock.calls[0][2]).toBe('Tap 1 - clean');
    expect(result).toMatchObject({ success: true, outputSequenceIds: ['copy'] });
    expect(result.steps).toHaveLength(6);
    expect(result.warnings).toContain('canh bao');
    expect(applyDialogueChain.mock.calls[0][1]).toMatchObject({ sequenceId: 'copy', targetLufs: -16, backup: false });
  });

  it('dryRun does not duplicate and returns the plan', async () => {
    const result = await runTool('workflow_clean_voiceover', ctxWith(), { dryRun: true });
    expect(duplicateSequence).not.toHaveBeenCalled();
    expect(removeRanges).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.outputSequenceIds).toEqual([]);
    expect(result.summary.dryRun).toBe(true);
    expect(result.summary.cutCount).toBe(3);
  });

  it('cuts only silence, with a warning, when the transcript is empty', async () => {
    loadTranscript.mockResolvedValue(transcript([]));
    const result = await runTool('workflow_clean_voiceover', ctxWith(), {});
    expect(findFillers).not.toHaveBeenCalled();
    expect(removeRanges).toHaveBeenCalledTimes(1);
    expect(removeRanges.mock.calls[0][1].ranges).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).toContain('Transcript rỗng');
  });

  it('waits for a running transcription before looking for fillers', async () => {
    loadTranscript
      .mockResolvedValueOnce({ status: 'running', progress: 0.5, files: 1 })
      .mockResolvedValue(transcript());
    const progress = jest.fn();
    // Real 3 s poll would be slow: run with fake timers.
    jest.useFakeTimers();
    try {
      const pending = runTool('workflow_clean_voiceover', ctxWith({ progress }), {});
      await jest.advanceTimersByTimeAsync(3000);
      const result = await pending;
      expect(result.success).toBe(true);
    } finally {
      jest.useRealTimers();
    }
    expect(progress.mock.calls.some((c) => /Nhận dạng giọng nói 50%/.test(c[2]))).toBe(true);
  });

  it('with cutFillers and cutRetakes off, skips the transcript entirely', async () => {
    await runTool('workflow_clean_voiceover', ctxWith(), { cutFillers: false, cutRetakes: false });
    expect(loadTranscript).not.toHaveBeenCalled();
    expect(removeRanges.mock.calls[0][1].ranges).toHaveLength(1);
  });

  it('lists skipped clips and still runs for the rest', async () => {
    findFillers.mockResolvedValue({ ...fillerResult, skippedClips: [{ clipId: 'a9', reason: 'speed changed' }] });
    const result = await runTool('workflow_clean_voiceover', ctxWith(), {});
    expect(result.success).toBe(true);
    expect(result.summary.skippedClips).toEqual([{ clipId: 'a9', reason: 'speed changed' }]);
  });

  it('surfaces verified:false from remove_ranges as a warning', async () => {
    removeRanges.mockResolvedValue({ success: true, removed: [], durationBefore: 100, durationAfter: 100, verified: false, crossfadeFrames: 1, crossfadeMsActual: 40, warning: 'locked' });
    const result = await runTool('workflow_clean_voiceover', ctxWith(), {});
    expect(result.summary.verified).toBe(false);
    expect(result.warnings).toContain('locked');
  });

  it('stops with nextStep when the cut fails', async () => {
    removeRanges.mockResolvedValue({ success: false, removed: [], durationBefore: 100, crossfadeFrames: 1, crossfadeMsActual: 40, error: 'bad' });
    const result = await runTool('workflow_clean_voiceover', ctxWith(), {});
    expect(result.success).toBe(false);
    expect(result.nextStep).toEqual(expect.any(String));
    expect(applyDialogueChain).not.toHaveBeenCalled();
    expect(result.outputSequenceIds).toEqual(['copy']);
  });

  it('renames the copy when cancelled after it was created', async () => {
    const controller = new AbortController();
    duplicateSequence.mockImplementation(async () => { controller.abort(); return { success: true, newSequenceId: 'copy' }; });
    const ctx = ctxWith({ signal: controller.signal });
    const result = await runTool('workflow_clean_voiceover', ctx, {});
    expect(result.cancelled).toBe(true);
    expect(removeRanges).not.toHaveBeenCalled();
    expect((ctx.bridge.executeScript as jest.Mock).mock.calls.some((c) => String(c[0]).includes('(đã hủy)'))).toBe(true);
  });
});

describe('workflow_subtitles', () => {
  beforeEach(() => {
    loadTranscript.mockResolvedValue({ status: 'done', sequenceId: 'src', words: [{ text: 'a' }], sentences: [], dialogueTrackIndices: [0], warnings: [] });
    createCaptions.mockResolvedValue({ success: true, sequenceId: 'src', cueCount: 4, srtPath: 'C:/r/x.srt', preview: [], warnings: [] });
    readSequence.mockResolvedValue({ sequenceId: 'src', sequenceName: 'Tap 1', frameDuration: 0.04, endTime: 10, clips: [] });
    ensureBackup.mockResolvedValue({});
    duplicateSequence.mockResolvedValue({ success: true, newSequenceId: 'copy' });
    ensureRootBin.mockResolvedValue({ success: true, created: false });
    importMedia.mockResolvedValue({ success: true, id: 'item9' });
    createCaptionTrack.mockResolvedValue({ success: true });
  });

  it('writes only the SRT by default and leaves the project alone', async () => {
    const result = await runTool('workflow_subtitles', ctxWith(), {});
    expect(createCaptions.mock.calls[0][1]).toMatchObject({ srtOnly: true, maxCharsPerLine: 42 });
    expect(duplicateSequence).not.toHaveBeenCalled();
    expect(createCaptionTrack).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, outputSequenceIds: [] });
    expect(result.summary).toMatchObject({ srtPath: 'C:/r/x.srt', cueCount: 4 });
  });

  it('caption_track imports the written SRT and makes the track on a copy', async () => {
    const result = await runTool('workflow_subtitles', ctxWith(), { output: 'caption_track' });
    expect(createCaptions).toHaveBeenCalledTimes(1);
    expect(duplicateSequence.mock.calls[0][2]).toBe('Tap 1 - phụ đề');
    expect(importMedia.mock.calls[0][1]).toBe('C:/r/x.srt');
    expect(createCaptionTrack).toHaveBeenCalledWith(expect.anything(), 'copy', 'item9', 0);
    expect(result).toMatchObject({ success: true, outputSequenceIds: ['copy'] });
  });

  it('dryRun changes nothing even with caption_track', async () => {
    createCaptions.mockResolvedValue({ success: true, dryRun: true, cueCount: 4, preview: [], warnings: [] });
    const result = await runTool('workflow_subtitles', ctxWith(), { output: 'caption_track', dryRun: true });
    expect(duplicateSequence).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('fails the step when the transcript is empty', async () => {
    loadTranscript.mockResolvedValue({ status: 'done', sequenceId: 'src', words: [], sentences: [], dialogueTrackIndices: [0], warnings: [] });
    const result = await runTool('workflow_subtitles', ctxWith(), {});
    expect(result.success).toBe(false);
    expect(createCaptions).not.toHaveBeenCalled();
  });
});
