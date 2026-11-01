import { PremiereProTools } from '../../tools/index.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearAnalysisCache } from '../../analysis/cache.js';

jest.mock('../../bridge/index.js');
jest.mock('../../analysis/ffmpeg.js', () => {
  const actual = jest.requireActual('../../analysis/ffmpeg.js');
  return { ...actual, findFfTool: jest.fn(), runFf: jest.fn(), probeMedia: jest.fn() };
});

import * as ff from '../../analysis/ffmpeg.js';

const findFfTool = ff.findFfTool as jest.Mock;
const runFf = ff.runFf as jest.Mock;
const probeMedia = ff.probeMedia as jest.Mock;

const FRAME = 1 / 25;

/** Metric output with a sample every second, constant value. */
const metric = (value: number, seconds: number) =>
  Array.from({ length: seconds }, (_, t) => `frame:${t} pts:${t} pts_time:${t}\nlavfi.signalstats.YAVG=${value}`).join('\n');

const sequence = (over: Record<string, unknown> = {}) => ({
  success: true, sequenceId: 's1', sequenceName: 'Cut', frameDuration: FRAME, endTime: 0, clips: [], ...over,
});

describe('rough cut tools', () => {
  let executeScript: jest.Mock;
  let addToTimelineBatch: jest.Mock;
  let importMedia: jest.Mock;
  let tools: PremiereProTools;
  let folder: string;

  beforeAll(() => {
    process.env.PREMIERE_MCP_CACHE_DIR = mkdtempSync(join(tmpdir(), 'premiere-mcp-cache-'));
  });

  beforeEach(async () => {
    await clearAnalysisCache();
    folder = mkdtempSync(join(tmpdir(), 'premiere-mcp-footage-'));
    for (const name of ['a.mp4', 'b.mp4', 'c.mp4', 'notes.txt']) writeFileSync(join(folder, name), 'x');
    findFfTool.mockReset().mockResolvedValue('ffmpeg');
    probeMedia.mockReset().mockResolvedValue({ durationSeconds: 20, streams: [{ type: 'video' }] });
    // luma pass prints 118, the edge pass (edgedetect in its filter chain) prints 12: a perfect score.
    runFf.mockReset().mockImplementation(async (_bin: string, args: string[]) => ({
      code: 0, stderr: '', stdout: metric(args.join(' ').includes('edgedetect') ? 12 : 118, 20),
    }));
    executeScript = jest.fn();
    addToTimelineBatch = jest.fn();
    importMedia = jest.fn();
    tools = new PremiereProTools({ executeScript, addToTimelineBatch, importMedia } as never);
  });

  describe('score_clips', () => {
    it('lists only video files in the folder and ranks their best windows', async () => {
      const r = await tools.executeTool('score_clips', { folderPath: folder, topPerFile: 2 });
      expect(r).toMatchObject({ success: true, checked: 3, scored: 3 });
      expect(r.files[0].windows).toHaveLength(2);
      expect(r.files[0].bestScore).toBe(1);
    });

    it('needs a source and reports a missing ffmpeg', async () => {
      expect((await tools.executeTool('score_clips', {})).error).toContain('mediaPaths or folderPath');
      findFfTool.mockResolvedValue(null);
      expect(await tools.executeTool('score_clips', { folderPath: folder })).toMatchObject({ success: false, errorCode: 'ffmpeg.not_found' });
    });

    it('reports a file it cannot read without failing the rest', async () => {
      probeMedia.mockImplementation(async (_b: string, p: string) => {
        if (p.endsWith('b.mp4')) throw new Error('corrupt');
        return { durationSeconds: 20, streams: [{ type: 'video' }] };
      });
      const r = await tools.executeTool('score_clips', { folderPath: folder });
      expect(r.scored).toBe(2);
      expect(r.failed[0]).toMatchObject({ error: 'corrupt' });
    });

    it('decodes one frame per second when keyframes are too sparse', async () => {
      runFf.mockImplementation(async (_bin: string, args: string[]) => {
        const sparse = args.includes('-skip_frame');
        return { code: 0, stderr: '', stdout: metric(args.join(' ').includes('edgedetect') ? 12 : 118, sparse ? 1 : 20) };
      });
      await tools.executeTool('score_clips', { mediaPaths: [join(folder, 'a.mp4')] });
      expect(runFf.mock.calls.some((c) => (c[1] as string[]).join(' ').includes('fps=1'))).toBe(true);
    });
  });

  describe('assemble_rough_cut', () => {
    const args = () => ({ folderPath: folder, targetSeconds: 9, shotSeconds: 3, maxPerFile: 1 });

    it('plans on a dry run without touching Premiere beyond reading the sequence', async () => {
      executeScript.mockResolvedValueOnce(sequence());
      const r = await tools.executeTool('assemble_rough_cut', { ...args(), dryRun: true });
      expect(r).toMatchObject({ success: true, dryRun: true, applied: false, shotCount: 3, shortfallSeconds: 0 });
      expect(Math.abs(r.totalSeconds - 9)).toBeLessThanOrEqual(FRAME);
      expect(addToTimelineBatch).not.toHaveBeenCalled();
      expect(executeScript).toHaveBeenCalledTimes(1);
    });

    it('refuses to place over existing clips unless overwrite is set', async () => {
      const clip = { id: 'x', trackType: 'video', trackIndex: 0, start: 2, end: 6, inPoint: 0, outPoint: 4, mediaPath: null };
      executeScript.mockResolvedValueOnce(sequence({ clips: [clip] }));
      const r = await tools.executeTool('assemble_rough_cut', args());
      expect(r.success).toBe(false);
      expect(r.error).toContain('overwrite=true');
      expect(addToTimelineBatch).not.toHaveBeenCalled();
    });

    it('imports missing files, places shots with source ranges, and verifies the end', async () => {
      const project = join(mkdtempSync(join(tmpdir(), 'premiere-mcp-proj-')), 'Show.prproj');
      writeFileSync(project, 'x');
      const placedClip = { id: 'v', trackType: 'video', trackIndex: 0, start: 0, end: 9, inPoint: 0, outPoint: 9, mediaPath: null };
      executeScript
        .mockResolvedValueOnce(sequence())                                   // before
        .mockResolvedValueOnce({ success: true, path: project })             // backup
        .mockResolvedValueOnce({ success: true, items: [{ id: 'item-a', path: join(folder, 'a.mp4').replace(/\\/g, '/') }] })
        .mockResolvedValueOnce(sequence({ clips: [placedClip] }));           // after
      importMedia.mockImplementation(async (path: string) => ({ success: true, id: `imp-${path.slice(-5)}` }));
      addToTimelineBatch.mockResolvedValue({ success: true, results: [{ success: true }, { success: true }, { success: true }] });

      const r = await tools.executeTool('assemble_rough_cut', args());

      expect(r).toMatchObject({ success: true, applied: true, verified: true, shotCount: 3 });
      expect(r.backupPath).toContain('premiere-mcp-backups');
      expect(importMedia).toHaveBeenCalledTimes(2); // b and c; a is already in the project
      const specs = addToTimelineBatch.mock.calls[0]![1] as Array<{ projectItemId: string; time: number; sourceInPoint: number; sourceOutPoint: number }>;
      expect(specs[0]).toMatchObject({ projectItemId: 'item-a', time: 0 });
      expect(specs[1]!.time).toBeCloseTo(specs[0]!.time + (specs[0]!.sourceOutPoint - specs[0]!.sourceInPoint), 3);
      expect(specs.every((s) => s.sourceOutPoint > s.sourceInPoint)).toBe(true);
    });

    it('stops with the backup path when a shot cannot be placed', async () => {
      const project = join(mkdtempSync(join(tmpdir(), 'premiere-mcp-proj-')), 'Show.prproj');
      writeFileSync(project, 'x');
      executeScript
        .mockResolvedValueOnce(sequence())
        .mockResolvedValueOnce({ success: true, path: project })
        .mockResolvedValueOnce({ success: true, items: [] });
      importMedia.mockResolvedValue({ success: true, id: 'i' });
      addToTimelineBatch.mockResolvedValue({ success: true, results: [{ success: true }, { success: false, error: 'Track not found' }] });
      const r = await tools.executeTool('assemble_rough_cut', args());
      expect(r.success).toBe(false);
      expect(r.backupPath).toContain('premiere-mcp-backups');
      expect(r.failures).toHaveLength(1);
    });
  });
});
