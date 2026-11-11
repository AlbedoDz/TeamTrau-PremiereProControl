import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../../tools/context.js';

jest.mock('../../tools/domains/shorts.js', () => ({
  ...jest.requireActual('../../tools/domains/shorts.js'),
  loadTranscript: jest.fn(),
}));
jest.mock('../../analysis/cache.js', () => ({
  cached: (_media: string, _op: string, _params: unknown, compute: () => unknown) => compute(),
}));
jest.mock('../../analysis/ffmpeg.js', () => ({
  ...jest.requireActual('../../analysis/ffmpeg.js'),
  findFfTool: jest.fn(),
  runFf: jest.fn(),
}));

import * as shorts from '../../tools/domains/shorts.js';
import * as ffmpeg from '../../analysis/ffmpeg.js';
import { findFillersAndRetakes } from '../../tools/domains/fillers.js';

const loadTranscript = shorts.loadTranscript as jest.Mock;
const findFfTool = ffmpeg.findFfTool as jest.Mock;
const runFf = ffmpeg.runFf as jest.Mock;

const word = (w: string, start: number, end: number) => ({ w, start, end, p: 1, trackIndex: 0, clipId: 'a1' });
// "tôi nói [ờ] rằng xong": the filler has a 0.38 s pause before it, so tier A cuts it.
const words = [word('tôi', 0, 0.3), word('nói', 0.32, 0.62), word('ờ', 1.0, 1.3), word('rằng', 1.32, 1.6), word('xong', 1.62, 1.9)];
const ready = {
  status: 'done',
  sequenceId: 's1',
  fingerprint: 'fp',
  dialogueTrackIndices: [0],
  words,
  sentences: [{ id: 0, start: 0, end: 1.9, text: 'tôi nói ờ rằng xong', firstWord: 0, lastWord: 4 }],
  warnings: [],
  endTime: 10,
  frameDuration: 0.04,
};

const clip = (over: Record<string, unknown> = {}) => ({
  id: 'a1', trackType: 'audio', trackIndex: 0, start: 0, end: 10, inPoint: 0, outPoint: 10, mediaPath: 'C:/m.wav', ...over,
});
const videoClip = { id: 'v1', trackType: 'video', trackIndex: 0, start: 0, end: 10, inPoint: 0, outPoint: 10, mediaPath: 'C:/m.mp4' };

const ctxWith = (clips: unknown[]): ToolContext => ({
  bridge: { executeScript: jest.fn().mockResolvedValue({ success: true, sequenceId: 's1', sequenceName: 'S', frameDuration: 0.04, endTime: 10, clips }) },
} as unknown as ToolContext);

const baseArgs = { retakes: true, minPauseMs: 150 };

/** ffmpeg metadata output: loud everywhere except one silent 10 ms bucket. */
const rmsOutput = (quietAt: number) => {
  let out = '';
  for (let i = 0; i < 1100; i++) {
    out += `frame:${i} pts:${i} pts_time:${(i / 100).toFixed(2)}\nlavfi.astats.Overall.RMS_level=${i === quietAt ? '-inf' : '-20.0'}\n`;
  }
  return out;
};

beforeEach(() => {
  process.env.PREMIERE_MCP_HOME = mkdtempSync(join(tmpdir(), 'fillers-tool-'));
  loadTranscript.mockReset().mockResolvedValue(ready);
  findFfTool.mockReset().mockResolvedValue('ffmpeg');
  runFf.mockReset().mockResolvedValue({ code: 0, stdout: rmsOutput(94), stderr: '' });
});

describe('find_fillers_and_retakes', () => {
  it('defaults tiers to ["A"] when the sequence has a video clip', async () => {
    const result: any = await findFillersAndRetakes(ctxWith([videoClip, clip()]), baseArgs);
    expect(result.success).toBe(true);
    expect(result.tiers).toEqual(['A']);
  });

  it('defaults tiers to ["A","B"] when there is no video', async () => {
    const result: any = await findFillersAndRetakes(ctxWith([clip()]), baseArgs);
    expect(result.tiers).toEqual(['A', 'B']);
  });

  it('keeps an explicit tiers argument', async () => {
    const result: any = await findFillersAndRetakes(ctxWith([clip()]), { ...baseArgs, tiers: ['A'] });
    expect(result.tiers).toEqual(['A']);
  });

  it('returns the running state of the transcript unchanged', async () => {
    loadTranscript.mockResolvedValue({ status: 'running', progress: 0.4, etaSec: 30, files: 1 });
    const result: any = await findFillersAndRetakes(ctxWith([clip()]), baseArgs);
    expect(result).toMatchObject({ success: true, status: 'running', progress: 0.4, etaSec: 30, files: 1 });
    expect(runFf).not.toHaveBeenCalled();
  });

  it('passes a transcript failure through', async () => {
    loadTranscript.mockResolvedValue({ success: false, error: 'no sidecar' });
    expect(await findFillersAndRetakes(ctxWith([clip()]), baseArgs)).toEqual({ success: false, error: 'no sidecar' });
  });

  it('snaps a cut edge to the quietest RMS sample (60 ms before the filler)', async () => {
    const result: any = await findFillersAndRetakes(ctxWith([clip()]), baseArgs);
    expect(result.ranges).toHaveLength(1);
    expect(result.ranges[0]).toMatchObject({ reason: 'filler-A', text: 'ờ' });
    expect(result.ranges[0].start).toBeCloseTo(0.94, 5);
    expect(result.ranges[0].end).toBeCloseTo(1.3, 5);
    expect(result.removedSeconds).toBeCloseTo(0.36, 3);
    // only the media around the range is measured, not the whole file
    const args: string[] = runFf.mock.calls[0][1];
    expect(Number(args[args.indexOf('-t') + 1])).toBeLessThan(10);
  });

  it('maps sequence time to source time through the clip in-point', async () => {
    // the clip plays media from 5 s: the silent bucket is at source 5.94 s
    runFf.mockImplementation(async (_bin: string, args: string[]) => {
      const a = Number(args[args.indexOf('-ss') + 1]);
      let out = '';
      for (let i = 0; i < 400; i++) {
        const t = i / 100;
        out += `pts_time:${t.toFixed(2)}\nlavfi.astats.Overall.RMS_level=${Math.abs(a + t - 5.94) < 0.001 ? '-inf' : '-20.0'}\n`;
      }
      return { code: 0, stdout: out, stderr: '' };
    });
    const result: any = await findFillersAndRetakes(ctxWith([clip({ inPoint: 5, outPoint: 15 })]), baseArgs);
    expect(result.ranges[0].start).toBeCloseTo(0.94, 5);
  });

  it('lists a speed-changed clip in skippedClips and returns none of its ranges', async () => {
    const result: any = await findFillersAndRetakes(ctxWith([clip({ outPoint: 20 })]), baseArgs);
    expect(result.success).toBe(true);
    expect(result.ranges).toEqual([]);
    expect(result.skippedClips).toEqual([{ clipId: 'a1', reason: 'speed changed' }]);
    expect(result.warnings.join(' ')).toMatch(/không cắt/);
    expect(runFf).not.toHaveBeenCalled();
  });

  it('lists a clip without media in skippedClips', async () => {
    const result: any = await findFillersAndRetakes(ctxWith([clip({ mediaPath: null })]), baseArgs);
    expect(result.ranges).toEqual([]);
    expect(result.skippedClips).toEqual([{ clipId: 'a1', reason: 'no analysable media file' }]);
  });

  it('keeps unsnapped edges and warns when ffmpeg cannot read the file', async () => {
    runFf.mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' });
    const result: any = await findFillersAndRetakes(ctxWith([clip()]), baseArgs);
    expect(result.ranges[0].start).toBe(1.0);
    expect(result.warnings.join(' ')).toMatch(/Không đo được/);
  });

  it('reports a missing ffmpeg instead of guessing the edges', async () => {
    findFfTool.mockResolvedValue(null);
    const result: any = await findFillersAndRetakes(ctxWith([clip()]), baseArgs);
    expect(result).toMatchObject({ success: false, errorCode: 'ffmpeg.not_found' });
  });
});
