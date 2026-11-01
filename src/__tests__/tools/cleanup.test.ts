import { PremiereProTools } from '../../tools/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearAnalysisCache } from '../../analysis/cache.js';

jest.mock('../../bridge/index.js');
jest.mock('../../analysis/ffmpeg.js', () => {
  const actual = jest.requireActual('../../analysis/ffmpeg.js');
  return { ...actual, findFfTool: jest.fn(), runFf: jest.fn() };
});

import * as ff from '../../analysis/ffmpeg.js';

const findFfTool = ff.findFfTool as jest.Mock;
const runFf = ff.runFf as jest.Mock;

const FRAME = 1 / 25;

function snapshot(endTime: number) {
  return {
    success: true,
    sequenceId: 'seq-1',
    sequenceName: 'Main',
    frameDuration: FRAME,
    endTime,
    clips: [
      { id: 'v1', trackType: 'video', trackIndex: 0, start: 0, end: 20, inPoint: 0, outPoint: 20, mediaPath: 'talk.mp4' },
      { id: 'a1', trackType: 'audio', trackIndex: 0, start: 0, end: 20, inPoint: 0, outPoint: 20, mediaPath: 'talk.mp4' },
    ],
  };
}

describe('cleanup tools', () => {
  let executeScript: jest.Mock;
  let tools: PremiereProTools;

  beforeEach(() => {
    clearAnalysisCache();
    findFfTool.mockReset().mockResolvedValue('ffmpeg');
    runFf.mockReset();
    executeScript = jest.fn();
    tools = new PremiereProTools({ executeScript } as never);
  });

  it('reports a missing ffmpeg with an install nextStep and never touches Premiere', async () => {
    findFfTool.mockResolvedValue(null);
    executeScript.mockResolvedValueOnce(snapshot(20));
    const result = await tools.executeTool('remove_silence_from_sequence', {});
    expect(result).toMatchObject({ success: false, errorCode: 'ffmpeg.not_found' });
    expect(result.nextStep).toContain('ffmpeg');
    expect(executeScript).toHaveBeenCalledTimes(1); // the read-only sequence snapshot
  });

  it('plans cuts on a dry run without razoring or deleting', async () => {
    executeScript.mockResolvedValueOnce(snapshot(20));
    runFf.mockResolvedValue({ code: 0, stdout: '', stderr: 'silence_start: 5\nsilence_end: 8 | silence_duration: 3' });
    const result = await tools.executeTool('remove_silence_from_sequence', { dryRun: true });
    expect(result).toMatchObject({ success: true, dryRun: true, applied: false, cutCount: 1 });
    expect(result.cuts[0].start).toBeCloseTo(5.12, 5);
    expect(result.cuts[0].end).toBeCloseTo(7.88, 5);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('applies cuts back to front, razoring both edges before the ripple delete, and verifies the new length', async () => {
    // Order: before, razor end, razor start, delete, after
    executeScript
      .mockResolvedValueOnce(snapshot(20))
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true, removedClips: 2 })
      .mockResolvedValueOnce(snapshot(20 - 2.76));
    runFf.mockResolvedValue({ code: 0, stdout: '', stderr: 'silence_start: 5\nsilence_end: 8 | silence_duration: 3' });

    const result = await tools.executeTool('remove_silence_from_sequence', {});

    expect(result).toMatchObject({ success: true, applied: true, verified: true, cutCount: 1 });
    const scripts = executeScript.mock.calls.map((c) => c[0] as string);
    expect(scripts[1]).toContain('razor(');
    expect(scripts[3]).toContain('inside[inside.length - 1].remove(true, true)');
  });

  it('flags verified=false when the sequence did not shorten as planned', async () => {
    executeScript
      .mockResolvedValueOnce(snapshot(20))
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true, removedClips: 2 })
      .mockResolvedValueOnce(snapshot(20));
    runFf.mockResolvedValue({ code: 0, stdout: '', stderr: 'silence_start: 5\nsilence_end: 8 | silence_duration: 3' });

    const result = await tools.executeTool('remove_silence_from_sequence', {});

    expect(result.success).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.warning).toContain('locked');
  });

  it('stops and reports partial progress when a razor fails', async () => {
    executeScript
      .mockResolvedValueOnce(snapshot(20))
      .mockResolvedValueOnce({ success: false, error: 'QE unavailable' });
    runFf.mockResolvedValue({ code: 0, stdout: '', stderr: 'silence_start: 5\nsilence_end: 8 | silence_duration: 3' });

    const result = await tools.executeTool('remove_silence_from_sequence', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('QE unavailable');
    expect(result.applied).toEqual([]);
  });

  it('normalises loudness on a dry run without writing any level', async () => {
    executeScript.mockResolvedValueOnce(snapshot(20));
    runFf.mockResolvedValue({ code: 0, stdout: '', stderr: 'Summary:\n  Integrated loudness:\n    I:         -20.0 LUFS\n' });
    const result = await tools.executeTool('normalize_loudness', { targetLufs: -14, dryRun: true });
    expect(result.clips).toEqual([{ clipId: 'a1', trackIndex: 0, measuredLufs: -20, gainDb: 6 }]);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('sets the clip level to the computed gain when normalising', async () => {
    executeScript
      .mockResolvedValueOnce(snapshot(20))
      .mockResolvedValueOnce({ success: true });
    runFf.mockResolvedValue({ code: 0, stdout: '', stderr: 'Summary:\n  Integrated loudness:\n    I:         -20.0 LUFS\n' });
    const result = await tools.executeTool('normalize_loudness', { targetLufs: -14 });
    expect(result.success).toBe(true);
    expect(result.clips[0].applied).toBe(true);
    expect(executeScript.mock.calls[1]![0]).toContain('var dB = 6;');
  });

  it('does not touch silent clips when normalising', async () => {
    executeScript.mockResolvedValueOnce(snapshot(20));
    runFf.mockResolvedValue({ code: 0, stdout: '', stderr: 'Summary:\n  Integrated loudness:\n    I:         -70.0 LUFS\n' });
    const result = await tools.executeTool('normalize_loudness', {});
    expect(result.clips[0].skipped).toBe('no measurable loudness');
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('preflight_media reports missing files without needing ffprobe output', async () => {
    const result = await tools.executeTool('preflight_media', { mediaPaths: [join(tmpdir(), 'premiere-mcp-no-such-file.mp4')] });
    expect(result).toMatchObject({ success: true, errors: 1, clean: false });
    expect(result.files[0].issues[0].code).toBe('MEDIA_MISSING');
  });

  it('find_dead_segments requires a path or project item', async () => {
    const result = await tools.executeTool('find_dead_segments', {});
    expect(result).toMatchObject({ success: false, status: 'validation' });
    expect(result.error).toContain('mediaPath or projectItemId');
  });
});
