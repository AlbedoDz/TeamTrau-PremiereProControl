import type { ToolContext } from '../../tools/context.js';

jest.mock('../../tools/domains/shorts.js', () => ({
  ...jest.requireActual('../../tools/domains/shorts.js'),
  loadTranscript: jest.fn(),
  findHighlightCandidates: jest.fn(),
  buildShort: jest.fn(),
}));
jest.mock('../../tools/domains/recap.js', () => ({
  ...jest.requireActual('../../tools/domains/recap.js'),
  planRecap: jest.fn(),
  buildRecap: jest.fn(),
}));
jest.mock('../../tools/domains/roughcut.js', () => ({
  ...jest.requireActual('../../tools/domains/roughcut.js'),
  scoreClips: jest.fn(),
  assembleRoughCut: jest.fn(),
}));
jest.mock('../../tools/domains/music.js', () => ({
  ...jest.requireActual('../../tools/domains/music.js'),
  assembleBeatCut: jest.fn(),
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
  autoDuckMusic: jest.fn(),
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
import * as recap from '../../tools/domains/recap.js';
import * as roughcut from '../../tools/domains/roughcut.js';
import * as music from '../../tools/domains/music.js';
import { endsIncomplete, endsOnSentence, pickNonOverlapping } from '../../tools/workflows/shorts.js';
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
const planRecap = recap.planRecap as jest.Mock;
const buildRecap = recap.buildRecap as jest.Mock;
const findHighlights = shorts.findHighlightCandidates as jest.Mock;
const buildShort = shorts.buildShort as jest.Mock;
const scoreClips = roughcut.scoreClips as jest.Mock;
const assembleRoughCut = roughcut.assembleRoughCut as jest.Mock;
const assembleBeatCut = music.assembleBeatCut as jest.Mock;
const autoDuckMusic = editing.autoDuckMusic as jest.Mock;

const ctxWith = (overrides: Partial<ToolContext> = {}, names: string[] = ['Tap 1']): ToolContext =>
  ({ bridge: { executeScript: jest.fn().mockResolvedValue({ success: true, names }) }, ...overrides }) as unknown as ToolContext;

const tool = (name: string) => workflowToolsTools.find((t) => t.name === name)!;
const runTool = (name: string, ctx: ToolContext, args: Record<string, unknown> = {}): Promise<any> =>
  tool(name).run(ctx, tool(name).inputSchema.parse(args)) as Promise<any>;

/**
 * Simulates the editor switching the active sequence while the transcript is still running: an
 * unresolved call (no sequenceId) would get "other" from the second poll on.
 */
function activeSequenceDrifts(srcSnapshot: Record<string, unknown>, done: Record<string, unknown>): void {
  readSequence.mockReset()
    .mockResolvedValueOnce(srcSnapshot)
    .mockResolvedValue({ ...srcSnapshot, sequenceId: 'other', sequenceName: 'Other' });
  let calls = 0;
  loadTranscript.mockReset().mockImplementation(async (_ctx: unknown, a: { sequenceId?: string }) => {
    calls++;
    if (calls === 1) return { status: 'running', progress: 0.5, files: 1 };
    return { ...done, sequenceId: a.sequenceId ?? 'other' };
  });
}

/** Runs a workflow tool with fake timers so the 3 s transcript poll passes instantly. */
async function runPolling(name: string, ctx: ToolContext, args: Record<string, unknown> = {}): Promise<any> {
  jest.useFakeTimers();
  try {
    const pending = runTool(name, ctx, args);
    await jest.advanceTimersByTimeAsync(3100);
    return await pending;
  } finally {
    jest.useRealTimers();
  }
}

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
    // progress is the number of steps already done, so it rises from 0.
    expect(progress.mock.calls).toEqual([[0, 3, 'A'], [1, 3, 'B'], [2, 3, 'C']]);
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

  it('on cancel renames only the unfinished copies and lists them as partial', async () => {
    const controller = new AbortController();
    const ctx = ctxWith({ signal: controller.signal });
    const result = await runSteps(ctx, [
      { label: 'A', run: async () => ({ ok: true, createdSequenceId: 'done1', complete: true }) },
      { label: 'B', run: async () => { controller.abort(); return { ok: true, createdSequenceId: 'half' }; } },
      { label: 'C', run: async () => ({ ok: true }) },
    ]);
    expect(result).toMatchObject({ cancelled: true, outputSequenceIds: ['done1', 'half'], partialSequenceIds: ['half'] });
    const scripts = (ctx.bridge.executeScript as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('"half"');
    expect(scripts[0]).not.toContain('"done1"');
  });

  it('renames an unfinished copy " (lỗi)" when a later step fails', async () => {
    const ctx = ctxWith();
    const result = await runSteps(ctx, [
      { label: 'A', run: async () => ({ ok: true, createdSequenceId: 'done1', complete: true }) },
      { label: 'B', run: async () => ({ ok: true, createdSequenceId: 'copy' }) },
      { label: 'C', run: async () => ({ ok: false, detail: { error: 'x' } }) },
    ]);
    expect(result).toMatchObject({ success: false, outputSequenceIds: ['done1', 'copy'], partialSequenceIds: ['copy'] });
    expect(result.cancelled).toBeUndefined();
    const scripts = (ctx.bridge.executeScript as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('"copy"');
    expect(scripts[0]).toContain('(lỗi)');
  });

  it('a later step can mark a copy it finished as complete without listing it twice', async () => {
    const controller = new AbortController();
    const ctx = ctxWith({ signal: controller.signal });
    const result = await runSteps(ctx, [
      { label: 'A', run: async () => ({ ok: true, createdSequenceId: 'copy' }) },
      { label: 'B', run: async () => { controller.abort(); return { ok: true, createdSequenceId: 'copy', complete: true }; } },
      { label: 'C', run: async () => ({ ok: true }) },
    ]);
    expect(result).toMatchObject({ cancelled: true, outputSequenceIds: ['copy'], partialSequenceIds: [] });
    expect(ctx.bridge.executeScript).not.toHaveBeenCalled();
  });

  it('renames nothing and has no partial ids when every step succeeds', async () => {
    const ctx = ctxWith();
    const result = await runSteps(ctx, [{ label: 'A', run: async () => ({ ok: true, createdSequenceId: 'copy' }) }]);
    expect(result).toMatchObject({ success: true, outputSequenceIds: ['copy'], partialSequenceIds: [] });
    expect(ctx.bridge.executeScript).not.toHaveBeenCalled();
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

  it('sends a rising progress value inside the step: index - 1 + fraction, below the next step', async () => {
    const progress = jest.fn();
    loadTranscript
      .mockResolvedValueOnce({ status: 'running', progress: 0.4, files: 1 })
      .mockResolvedValueOnce({ status: 'running', progress: 0.4, files: 1 })
      .mockResolvedValueOnce({ status: 'running', progress: 1, files: 1 })
      .mockResolvedValueOnce({ status: 'done', sequenceId: 's', words: [] });
    const ctx = ctxWith({ progress });
    await runSteps(ctx, [
      { label: 'A', run: async () => ({ ok: true }) },
      { label: 'B', run: async () => { await awaitTranscript(ctx, {}, 'Nhận dạng', { pollMs: 1 }); return { ok: true }; } },
      { label: 'C', run: async () => ({ ok: true }) },
    ]);
    const values = progress.mock.calls.map((c) => c[0] as number);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]!);
    expect(values[2]).toBeCloseTo(1.4);
    expect(values[3]).toBeGreaterThan(1.4);
    expect(values[4]).toBeLessThan(2);
    expect(values[5]).toBe(2);
    expect(progress.mock.calls.map((c) => c[2])).toEqual(['A', 'B', 'Nhận dạng 40%', 'Nhận dạng 40%', 'Nhận dạng 100%', 'C']);
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

  it('transcribes with the verbatim engine (zipformer-68m) unless one is given', async () => {
    await runTool('workflow_clean_voiceover', ctxWith(), {});
    expect(loadTranscript.mock.calls[0][1]).toMatchObject({ engine: 'zipformer-68m' });
    expect(findFillers.mock.calls[0][1]).toMatchObject({ engine: 'zipformer-68m' });
    loadTranscript.mockClear();
    await runTool('workflow_clean_voiceover', ctxWith(), { engine: 'whisper-turbo' });
    expect(loadTranscript.mock.calls[0][1]).toMatchObject({ engine: 'whisper-turbo' });
  });

  it('falls back to the default engine with a warning when zipformer-68m is not installed', async () => {
    loadTranscript
      .mockResolvedValueOnce({ success: false, errorCode: 'asr.engine_not_installed', error: 'not installed' })
      .mockResolvedValue(transcript());
    const result: any = await runTool('workflow_clean_voiceover', ctxWith(), {});
    expect(result.success).toBe(true);
    expect(loadTranscript.mock.calls[1][1].engine).toBeUndefined();
    expect(result.warnings.some((w: string) => /zipformer-68m/.test(w))).toBe(true);
  });

  it('also cuts a short kept piece with no recognised word in it (live: a dropped hesitation)', async () => {
    // Silence 10-12 and 12.5-15 leave 12-12.5 kept; no word falls in it.
    analyseSilence.mockResolvedValue({ silenceByMedia: new Map([['C:/m.wav', [{ start: 10, end: 12, duration: 2 }, { start: 12.5, end: 15, duration: 2.5 }]]]) });
    loadTranscript.mockResolvedValue(transcript([{ w: 'a', start: 5, end: 5.3 }, { w: 'b', start: 20, end: 20.3 }]));
    const result: any = await runTool('workflow_clean_voiceover', ctxWith(), {});
    expect(result.summary.cuts.some((c: any) => c.reason === 'island')).toBe(true);
    const ranges = removeRanges.mock.calls[0][1].ranges as Array<{ start: number; end: number }>;
    // The island is folded into one cut with the silences around it.
    // Silence cuts are padded and snapped to the 0.04 s frame grid (10.12-11.88, 12.6-14.88).
    expect(ranges.some((r) => r.start <= 12.1 && r.end >= 14.8)).toBe(true);
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

  it('lists every cut before merging, with its reason and sentence', async () => {
    const result = await runTool('workflow_clean_voiceover', ctxWith(), { dryRun: true });
    expect(result.summary.cuts).toEqual([
      { start: 10.12, end: 11.88, reason: 'silence' },
      { start: 30, end: 30.4, reason: 'filler-A', text: 'ờ' },
      { start: 50, end: 52, reason: 'retake', text: 'x' },
    ]);
    expect(result.summary.plan).toHaveLength(3);
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

  it('resolves the source once: a sequence opened while waiting for the transcript is not used', async () => {
    activeSequenceDrifts(snapshot, transcript());
    const result = await runPolling('workflow_clean_voiceover', ctxWith());
    expect(result.success).toBe(true);
    expect(readSequence).toHaveBeenCalledTimes(1);
    expect(loadTranscript.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(loadTranscript.mock.calls.every((c) => c[1].sequenceId === 'src')).toBe(true);
    expect(findFillers.mock.calls[0][1].sequenceId).toBe('src');
    expect(duplicateSequence.mock.calls[0][1]).toBe('src');
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

  it('resolves the source once: a sequence opened while waiting for the transcript is not used', async () => {
    activeSequenceDrifts(
      { sequenceId: 'src', sequenceName: 'Tap 1', frameDuration: 0.04, endTime: 10, clips: [] },
      { status: 'done', words: [{ text: 'a' }], sentences: [], dialogueTrackIndices: [0], warnings: [] },
    );
    const result = await runPolling('workflow_subtitles', ctxWith(), { output: 'caption_track' });
    expect(result.success).toBe(true);
    expect(loadTranscript.mock.calls.length).toBe(2);
    expect(loadTranscript.mock.calls.every((c) => c[1].sequenceId === 'src')).toBe(true);
    expect(createCaptions.mock.calls[0][1].sequenceId).toBe('src');
    expect(duplicateSequence.mock.calls[0][1]).toBe('src');
    expect(duplicateSequence.mock.calls[0][2]).toBe('Tap 1 - phụ đề');
  });

  it('fails the step when the transcript is empty', async () => {
    loadTranscript.mockResolvedValue({ status: 'done', sequenceId: 'src', words: [], sentences: [], dialogueTrackIndices: [0], warnings: [] });
    const result = await runTool('workflow_subtitles', ctxWith(), {});
    expect(result.success).toBe(false);
    expect(createCaptions).not.toHaveBeenCalled();
  });
});

describe('endsIncomplete', () => {
  it('flags a final question or the host handing over (live: short 1 on FINAL_01)', () => {
    expect(endsIncomplete('Vậy biến chứng sẽ là gì đây?')).toBe(true);
    expect(endsIncomplete('Trong giai đoạn đó thì sao. Xin được mời Phó Giáo sư, Tiến sĩ, Bác sĩ Trời Quang Nam giải đáp cho khán giả ạ.')).toBe(true);
    // Live re-run: "nhờ" instead of "mời", and ASR hearing "giải đáp" as "dạy đáp" with no final stop.
    expect(endsIncomplete('Xin phép nhờ tiến sĩ bác sĩ Nguyễn Huy Luân giải đáp cho quý vị khán giả ngay bây giờ ạ.')).toBe(true);
    expect(endsIncomplete('nên nó phải chờ tiến sĩ bác sĩ Nguyễn Huy Luân dạy đáp thật là chi tiết cho quý vị khán giả để chúng ta có sự yên tâm trong việc chọn lừa ạ')).toBe(true);
    expect(endsIncomplete('thì quý vị cũng thấy đó, những người bị mắc đái tháo đường,')).toBe(true);
    expect(endsOnSentence('thời điểm nào thì phù hợp để phát huy được cái khả năng bảo vệ')).toBe(false);
    expect(endsOnSentence('Câu trả lời là tiêm nhắc lại.')).toBe(true);
    expect(endsIncomplete('Câu hỏi là gì? Câu trả lời là tiêm vắc xin đúng lịch.')).toBe(false);
    expect(endsIncomplete('Chúng tôi mời bà con đến khám sớm.')).toBe(false);
    expect(endsIncomplete(undefined)).toBe(false);
  });
});

describe('pickNonOverlapping', () => {
  it('takes candidates by rawScore descending and skips time overlaps', () => {
    const cands = [
      { start: 0, end: 40, rawScore: 0.5 },
      { start: 30, end: 70, rawScore: 0.9 },
      { start: 100, end: 140, rawScore: 0.7 },
      { start: 60, end: 100, rawScore: 0.6 },
    ];
    const picked = pickNonOverlapping(cands, 3);
    expect(picked.map((c) => c.rawScore)).toEqual([0.9, 0.7]);
    expect(pickNonOverlapping(cands, 1)).toEqual([cands[1]]);
  });
});

describe('workflow_shorts', () => {
  const candidates = [
    { start: 0, end: 40, rawScore: 0.5, startSentenceId: 0, endSentenceId: 5, text: 'a' },
    { start: 30, end: 70, rawScore: 0.95, startSentenceId: 4, endSentenceId: 9, text: 'b' },
    { start: 100, end: 140, rawScore: 0.8, startSentenceId: 12, endSentenceId: 18, text: 'c' },
    { start: 200, end: 240, rawScore: 0.7, startSentenceId: 20, endSentenceId: 26, text: 'd' },
    { start: 300, end: 340, rawScore: 0.6, startSentenceId: 30, endSentenceId: 36, text: 'e' },
  ];
  beforeEach(() => {
    loadTranscript.mockResolvedValue({ status: 'done', sequenceId: 'src', words: [{ w: 'a' }], sentences: [], dialogueTrackIndices: [0], warnings: [] });
    readSequence.mockResolvedValue({ sequenceId: 'src', sequenceName: 'Tap 1', frameDuration: 0.04, endTime: 400, clips: [] });
    findHighlights.mockResolvedValue({ success: true, fingerprint: 'fp1', candidates, warnings: [] });
    ensureBackup.mockResolvedValue({});
    let n = 0;
    buildShort.mockImplementation(async () => ({ success: true, verified: true, shortSequenceId: `short${++n}`, durationSec: 40, warnings: [] }));
  });

  it('builds count shorts from non-overlapping windows with the fingerprint', async () => {
    const result = await runTool('workflow_shorts', ctxWith(), { count: 3 });
    expect(buildShort).toHaveBeenCalledTimes(3);
    const calls = buildShort.mock.calls.map((c) => c[1]);
    expect(calls.map((c) => [c.startSentenceId, c.endSentenceId])).toEqual([[4, 9], [12, 18], [20, 26]]);
    expect(calls.every((c) => c.expectedFingerprint === 'fp1' && c.backup === false)).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(['Tap 1 - short 1', 'Tap 1 - short 2', 'Tap 1 - short 3']);
    expect(result).toMatchObject({ success: true, outputSequenceIds: ['short1', 'short2', 'short3'] });
  });

  it('skips candidates that end on a question or a hand-over to the guest', async () => {
    findHighlights.mockResolvedValue({
      success: true, fingerprint: 'fp1', warnings: [],
      candidates: [
        { ...candidates[1], text: 'Bệnh này nguy hiểm ra sao ạ?' },
        { ...candidates[2], text: 'Bối cảnh. Xin được mời Phó Giáo sư Nam giải đáp cho khán giả ạ.' },
        { ...candidates[3], text: 'Câu trả lời là tiêm nhắc lại đúng lịch.' },
        { ...candidates[4], text: 'Mũi nhắc lại sẽ giúp phát huy khả năng bảo vệ' },
      ],
    });
    await runTool('workflow_shorts', ctxWith(), { count: 1 });
    expect(buildShort.mock.calls[0][1]).toMatchObject({ startSentenceId: 20, endSentenceId: 26 });
  });

  it('keeps earlier shorts and stops when a later one fails', async () => {
    buildShort
      .mockReset()
      .mockResolvedValueOnce({ success: true, verified: true, shortSequenceId: 's1', warnings: [] })
      .mockResolvedValueOnce({ success: false, error: 'boom', shortSequenceId: 's2', warnings: [] });
    const result = await runTool('workflow_shorts', ctxWith(), { count: 3 });
    expect(buildShort).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.outputSequenceIds).toEqual(['s1', 's2']);
    expect(result.partialSequenceIds).toEqual(['s2']);
  });

  it('on cancel keeps the finished shorts as they are and renames only the unfinished one', async () => {
    const controller = new AbortController();
    buildShort
      .mockReset()
      .mockResolvedValueOnce({ success: true, verified: true, shortSequenceId: 's1', warnings: [] })
      .mockImplementationOnce(async () => { controller.abort(); return { success: true, verified: true, shortSequenceId: 's2', warnings: [] }; });
    const ctx = ctxWith({ signal: controller.signal });
    const result = await runTool('workflow_shorts', ctx, { count: 3 });
    expect(result).toMatchObject({ cancelled: true, outputSequenceIds: ['s1', 's2'], partialSequenceIds: [] });
    const renames = (ctx.bridge.executeScript as jest.Mock).mock.calls.map((c) => String(c[0])).filter((t) => t.includes('(đã hủy)'));
    expect(renames).toEqual([]);
  });

  it('renames a short that failed after it was created " (lỗi)", not the earlier ones', async () => {
    buildShort
      .mockReset()
      .mockResolvedValueOnce({ success: true, verified: true, shortSequenceId: 's1', warnings: [] })
      .mockResolvedValueOnce({ success: false, error: 'boom', shortSequenceId: 's2', warnings: [] });
    const ctx = ctxWith();
    await runTool('workflow_shorts', ctx, { count: 3 });
    const renames = (ctx.bridge.executeScript as jest.Mock).mock.calls.map((c) => String(c[0])).filter((t) => t.includes('(lỗi)'));
    expect(renames).toHaveLength(1);
    expect(renames[0]).toContain('"s2"');
  });

  it('resolves the source once: a sequence opened while waiting for the transcript is not used', async () => {
    activeSequenceDrifts(
      { sequenceId: 'src', sequenceName: 'Tap 1', frameDuration: 0.04, endTime: 400, clips: [] },
      { status: 'done', words: [{ w: 'a' }], sentences: [], dialogueTrackIndices: [0], warnings: [] },
    );
    const result = await runPolling('workflow_shorts', ctxWith(), { count: 1 });
    expect(result.success).toBe(true);
    expect(loadTranscript.mock.calls.every((c) => c[1].sequenceId === 'src')).toBe(true);
    expect(findHighlights.mock.calls[0][1].sequenceId).toBe('src');
    expect(buildShort.mock.calls[0][1]).toMatchObject({ sequenceId: 'src', name: 'Tap 1 - short 1' });
  });

  it('dryRun builds nothing', async () => {
    const result = await runTool('workflow_shorts', ctxWith(), { count: 2, dryRun: true });
    expect(buildShort).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, outputSequenceIds: [] });
    expect(result.summary.picks).toHaveLength(2);
  });
});

describe('workflow_recap', () => {
  const plan = {
    success: true,
    mode: 'speech',
    segments: [{ start: 1, end: 9 }, { start: 20, end: 30 }],
    candidates: [],
    totalSec: 18,
    fingerprint: 'fpR',
    warnings: ['w1'],
  };
  beforeEach(() => {
    readSequence.mockResolvedValue({ sequenceId: 'src', sequenceName: 'Tap 1', frameDuration: 0.04, endTime: 400, clips: [] });
    planRecap.mockResolvedValue(plan);
    buildRecap.mockResolvedValue({ success: true, sequenceId: 'rc', durationSec: 18, verified: true, warnings: [], audioLeadSupported: false });
  });

  it('passes the plan fingerprint and segments to build_recap and reports its sequence', async () => {
    const result = await runTool('workflow_recap', ctxWith(), { targetSec: 60 });
    expect(planRecap.mock.calls[0][1]).toMatchObject({ targetSec: 60, mode: 'auto' });
    expect(buildRecap.mock.calls[0][1]).toMatchObject({ expectedFingerprint: 'fpR', segments: plan.segments, name: 'Tap 1 - recap', targetLufs: -14 });
    expect(result).toMatchObject({ success: true, outputSequenceIds: ['rc'] });
    expect(result.warnings).toContain('w1');
  });

  it('waits while the transcript is still running', async () => {
    planRecap.mockReset().mockResolvedValueOnce({ success: true, status: 'running', progress: 0.5 }).mockResolvedValueOnce(plan);
    jest.useFakeTimers();
    const promise = runTool('workflow_recap', ctxWith(), {});
    await jest.advanceTimersByTimeAsync(3100);
    const result = await promise;
    jest.useRealTimers();
    expect(planRecap).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  });

  it('resolves the source once and passes its id to plan and build', async () => {
    readSequence.mockReset()
      .mockResolvedValueOnce({ sequenceId: 'src', sequenceName: 'Tap 1', frameDuration: 0.04, endTime: 400, clips: [] })
      .mockResolvedValue({ sequenceId: 'other', sequenceName: 'Other', frameDuration: 0.04, endTime: 400, clips: [] });
    planRecap.mockReset().mockResolvedValueOnce({ success: true, status: 'running', progress: 0.5 }).mockResolvedValueOnce(plan);
    const result = await runPolling('workflow_recap', ctxWith());
    expect(result.success).toBe(true);
    expect(planRecap.mock.calls.map((c) => c[1].sequenceId)).toEqual(['src', 'src']);
    expect(buildRecap.mock.calls[0][1].sequenceId).toBe('src');
  });

  it('passes minSec and maxSec to the plan and validates them', async () => {
    await runTool('workflow_recap', ctxWith(), { minSec: 75, maxSec: 105 });
    expect(planRecap.mock.calls[0][1]).toMatchObject({ minSec: 75, maxSec: 105 });
    expect(() => tool('workflow_recap').inputSchema.parse({ minSec: 105, maxSec: 75 })).toThrow(/minSec must be less than maxSec/);
    expect(() => tool('workflow_recap').inputSchema.parse({ maxSec: 75 })).toThrow(/minSec and maxSec/);
  });

  it('flags a built recap longer than maxSec by more than a frame', async () => {
    buildRecap.mockResolvedValue({ success: true, sequenceId: 'rc', durationSec: 17.05, verified: true, warnings: [], audioLeadSupported: false });
    const result = await runTool('workflow_recap', ctxWith(), { minSec: 10, maxSec: 17 });
    expect(result.summary.verified).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/dài 17.05 giây, vượt mức tối đa 17 giây/);
  });

  it('accepts a built recap within a frame of maxSec', async () => {
    buildRecap.mockResolvedValue({ success: true, sequenceId: 'rc', durationSec: 17.03, verified: true, warnings: [], audioLeadSupported: false });
    const result = await runTool('workflow_recap', ctxWith(), { minSec: 10, maxSec: 17 });
    expect(result.summary.verified).toBe(true);
  });

  it('dryRun plans only', async () => {
    const result = await runTool('workflow_recap', ctxWith(), { dryRun: true });
    expect(buildRecap).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, outputSequenceIds: [] });
    expect(result.summary.segments).toHaveLength(2);
  });
});

describe('workflow_rough_cut', () => {
  beforeEach(() => {
    readSequence.mockResolvedValue({ sequenceId: 'src', sequenceName: 'Tap 1', frameDuration: 0.04, endTime: 400, clips: [] });
    ensureBackup.mockResolvedValue({});
    duplicateSequence.mockResolvedValue({ success: true, newSequenceId: 'new1' });
    scoreClips.mockResolvedValue({ success: true, checked: 4, scored: 4, files: [] });
    assembleRoughCut.mockResolvedValue({ success: true, verified: true, shotCount: 10, totalSeconds: 30, shots: [] });
    assembleBeatCut.mockResolvedValue({ success: true, verified: true, shotCount: 12, cutSeconds: 40, bpm: 120, shots: [] });
    autoDuckMusic.mockResolvedValue({ success: true });
  });

  it('without music scores then assembles on a new cleared copy named after the folder', async () => {
    const result = await runTool('workflow_rough_cut', ctxWith(), { folderPath: 'D:\\Clips\\Chuyến đi', targetSec: 30 });
    expect(duplicateSequence).toHaveBeenCalledWith(expect.anything(), 'src', 'Chuyến đi - rough cut', true);
    expect(scoreClips).toHaveBeenCalledTimes(1);
    expect(assembleBeatCut).not.toHaveBeenCalled();
    expect(assembleRoughCut.mock.calls[0][1]).toMatchObject({ sequenceId: 'new1', targetSeconds: 30, shotSeconds: 3, dryRun: false });
    expect(autoDuckMusic).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, outputSequenceIds: ['new1'] });
  });

  it('energetic pace shortens shots and maps to the beat-cut preset', async () => {
    await runTool('workflow_rough_cut', ctxWith(), { folderPath: 'D:/Clips', targetSec: 30, pace: 'energetic' });
    expect(assembleRoughCut.mock.calls[0][1].shotSeconds).toBe(2);
    await runTool('workflow_rough_cut', ctxWith(), { folderPath: 'D:/Clips', musicPath: 'D:/m.mp3', pace: 'energetic' });
    expect(assembleBeatCut.mock.calls[0][1]).toMatchObject({ preset: 'energetic', sequenceId: 'new1', musicPath: 'D:/m.mp3' });
    expect(scoreClips).toHaveBeenCalledTimes(1);
  });

  it('hasVoiceover with music ducks the music on the new sequence', async () => {
    await runTool('workflow_rough_cut', ctxWith(), { folderPath: 'D:/Clips', musicPath: 'D:/m.mp3', hasVoiceover: true });
    expect(autoDuckMusic.mock.calls[0][1]).toMatchObject({ sequenceId: 'new1', dialogueTrackIndices: [0], musicTrackIndices: [1] });
  });

  it('a dry run plans against the resolved source sequence', async () => {
    await runTool('workflow_rough_cut', ctxWith(), { folderPath: 'D:/Clips', targetSec: 30, dryRun: true });
    expect(readSequence).toHaveBeenCalledTimes(1);
    expect(assembleRoughCut.mock.calls[0][1]).toMatchObject({ sequenceId: 'src', dryRun: true, overwrite: true });
  });

  it('never allows overwrite when placing for real', async () => {
    await runTool('workflow_rough_cut', ctxWith(), { folderPath: 'D:/Clips', targetSec: 30 });
    expect(assembleRoughCut.mock.calls[0][1]).toMatchObject({ dryRun: false, overwrite: false });
  });

  it('keeps the built rough cut when cancelled while the music is being ducked', async () => {
    const controller = new AbortController();
    assembleBeatCut.mockImplementation(async () => { controller.abort(); return { success: true, verified: true, shotCount: 12, cutSeconds: 40, bpm: 120, shots: [] }; });
    const ctx = ctxWith({ signal: controller.signal });
    const result = await runTool('workflow_rough_cut', ctx, { folderPath: 'D:/Clips', musicPath: 'D:/m.mp3', hasVoiceover: true });
    expect(result).toMatchObject({ cancelled: true, outputSequenceIds: ['new1'], partialSequenceIds: [] });
    expect(autoDuckMusic).not.toHaveBeenCalled();
  });

  it('requires targetSec without music', async () => {
    const result = await runTool('workflow_rough_cut', ctxWith(), { folderPath: 'D:/Clips' });
    expect(result.success).toBe(false);
    expect(duplicateSequence).not.toHaveBeenCalled();
  });

  it('dryRun creates no sequence', async () => {
    const result = await runTool('workflow_rough_cut', ctxWith(), { folderPath: 'D:/Clips', musicPath: 'D:/m.mp3', dryRun: true });
    expect(duplicateSequence).not.toHaveBeenCalled();
    expect(assembleBeatCut.mock.calls[0][1]).toMatchObject({ dryRun: true });
    expect(result).toMatchObject({ success: true, outputSequenceIds: [] });
  });
});
