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

/** ffmpeg RMS output for a 120 BPM song: a pulse every half second, louder in the second half. */
function songOutput(seconds: number): string {
  const lines: string[] = [];
  const total = seconds * 100;
  for (let i = 0; i < total; i++) {
    const t = i / 100;
    const sinceBeat = (t - 0.2) % 0.5;
    const gain = t < seconds / 2 ? 0.3 : 1;
    const level = t >= 0.2 && sinceBeat < 0.1 ? gain * Math.exp(-sinceBeat * 30) : 0.01;
    lines.push(`frame:${i} pts:${i * 221} pts_time:${t}`, `lavfi.astats.Overall.RMS_level=${(20 * Math.log10(level)).toFixed(3)}`);
  }
  return lines.join('\n');
}

const footageMetric = (value: number) =>
  Array.from({ length: 30 }, (_, t) => `frame:${t} pts:${t} pts_time:${t}\nlavfi.signalstats.YAVG=${value}`).join('\n');

const sequence = (over: Record<string, unknown> = {}) => ({
  success: true, sequenceId: 's1', sequenceName: 'Cut', frameDuration: FRAME, endTime: 0, clips: [], ...over,
});

describe('music tools', () => {
  let executeScript: jest.Mock;
  let addToTimelineBatch: jest.Mock;
  let importMedia: jest.Mock;
  let tools: PremiereProTools;
  let dir: string;
  let song: string;
  let footage: string;

  beforeAll(() => {
    process.env.PREMIERE_MCP_CACHE_DIR = mkdtempSync(join(tmpdir(), 'premiere-mcp-cache-'));
  });

  beforeEach(async () => {
    await clearAnalysisCache();
    dir = mkdtempSync(join(tmpdir(), 'premiere-mcp-music-'));
    song = join(dir, 'song.wav');
    footage = join(dir, 'clips');
    writeFileSync(song, 'x');
    require('node:fs').mkdirSync(footage);
    for (const name of ['a.mp4', 'b.mp4']) writeFileSync(join(footage, name), 'x');
    findFfTool.mockReset().mockResolvedValue('ffmpeg');
    probeMedia.mockReset().mockResolvedValue({ durationSeconds: 30, streams: [{ type: 'video' }] });
    runFf.mockReset().mockImplementation(async (_bin: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('astats')) return { code: 0, stderr: '', stdout: songOutput(40) };
      return { code: 0, stderr: '', stdout: footageMetric(joined.includes('edgedetect') ? 12 : 118) };
    });
    executeScript = jest.fn();
    addToTimelineBatch = jest.fn();
    importMedia = jest.fn();
    tools = new PremiereProTools({ executeScript, addToTimelineBatch, importMedia } as never);
  });

  describe('analyze_music', () => {
    it('reports tempo, bars and a quiet then loud section', async () => {
      const r = await tools.executeTool('analyze_music', { musicPath: song });
      expect(r.success).toBe(true);
      expect(r.bpm).toBeGreaterThan(119);
      expect(r.bpm).toBeLessThan(121);
      expect(r.confidence).toBeGreaterThan(0.3);
      expect(r.barCount).toBeGreaterThan(15);
      expect(r.sections[0].label).toBe('low');
      expect(r.beats).toBeUndefined();
      expect((await tools.executeTool('analyze_music', { musicPath: song, includeBeats: true })).beats.length).toBeGreaterThan(70);
    });

    it('reports a missing file and a missing ffmpeg', async () => {
      expect((await tools.executeTool('analyze_music', { musicPath: join(dir, 'nope.wav') })).error).toContain('not found');
      findFfTool.mockResolvedValue(null);
      expect(await tools.executeTool('analyze_music', { musicPath: song })).toMatchObject({ success: false, errorCode: 'ffmpeg.not_found' });
    });

    it('says so when there is no beat to find', async () => {
      runFf.mockResolvedValue({ code: 0, stderr: '', stdout: 'frame:0 pts:0 pts_time:0\nlavfi.astats.Overall.RMS_level=-inf' });
      expect((await tools.executeTool('analyze_music', { musicPath: song })).error).toContain('Could not find a beat');
    });
  });

  describe('assemble_beat_cut', () => {
    const args = () => ({ musicPath: song, folderPath: footage, durationSeconds: 16 });

    it('plans cuts on the beat grid without touching Premiere on a dry run', async () => {
      executeScript.mockResolvedValueOnce(sequence());
      const r = await tools.executeTool('assemble_beat_cut', { ...args(), dryRun: true });
      expect(r).toMatchObject({ success: true, dryRun: true, applied: false, cutSeconds: 16 });
      expect(r.slots[0].start).toBe(0);
      expect(r.slots[r.slots.length - 1].end).toBe(16);
      expect(r.shots).toHaveLength(r.slots.length);
      expect(addToTimelineBatch).not.toHaveBeenCalled();
      // Apart from the lead-in and the last slot, cuts in the quiet first half are at least 4 beats
      expect(r.slots.slice(1, -1).filter((s: { section: string }) => s.section === 'low').every((s: { beats: number }) => s.beats >= 4)).toBe(true);
    });

    it('places the shots and the music, then verifies the end', async () => {
      const project = join(mkdtempSync(join(tmpdir(), 'premiere-mcp-proj-')), 'Show.prproj');
      writeFileSync(project, 'x');
      const placedClip = { id: 'v', trackType: 'video', trackIndex: 0, start: 0, end: 16, inPoint: 0, outPoint: 16, mediaPath: null };
      executeScript
        .mockResolvedValueOnce(sequence())
        .mockResolvedValueOnce({ success: true, path: project })
        .mockResolvedValueOnce({ success: true, items: [] })
        .mockResolvedValueOnce(sequence({ clips: [placedClip] }));
      importMedia.mockImplementation(async (path: string) => ({ success: true, id: `id-${path.slice(-6)}` }));
      addToTimelineBatch.mockImplementation(async (_s: string, specs: unknown[]) => ({ success: true, results: specs.map(() => ({ success: true })) }));

      const r = await tools.executeTool('assemble_beat_cut', args());

      expect(r).toMatchObject({ success: true, applied: true, verified: true });
      expect(r.backupPath).toContain('premiere-mcp-backups');
      const specs = addToTimelineBatch.mock.calls[0]![1] as Array<{ trackIndex: number; time: number; sourceOutPoint: number }>;
      const music = specs[specs.length - 1]!;
      expect(music).toMatchObject({ trackIndex: 1, time: 0, sourceOutPoint: 16 });
      expect(specs.slice(0, -1).every((s) => s.trackIndex === 0)).toBe(true);
      expect(specs).toHaveLength(r.shotCount + 1);
    });

    it('leaves the music out when addMusic is false', async () => {
      const project = join(mkdtempSync(join(tmpdir(), 'premiere-mcp-proj-')), 'Show.prproj');
      writeFileSync(project, 'x');
      executeScript.mockResolvedValueOnce(sequence()).mockResolvedValueOnce({ success: true, path: project }).mockResolvedValueOnce({ success: true, items: [] }).mockResolvedValueOnce(sequence());
      importMedia.mockResolvedValue({ success: true, id: 'i' });
      addToTimelineBatch.mockImplementation(async (_s: string, specs: unknown[]) => ({ success: true, results: specs.map(() => ({ success: true })) }));
      const r = await tools.executeTool('assemble_beat_cut', { ...args(), addMusic: false });
      expect((addToTimelineBatch.mock.calls[0]![1] as unknown[]).length).toBe(r.shotCount);
    });

    it('refuses to place over existing clips unless overwrite is set', async () => {
      const clip = { id: 'x', trackType: 'video', trackIndex: 0, start: 2, end: 6, inPoint: 0, outPoint: 4, mediaPath: null };
      executeScript.mockResolvedValueOnce(sequence({ clips: [clip] }));
      const r = await tools.executeTool('assemble_beat_cut', args());
      expect(r.success).toBe(false);
      expect(r.error).toContain('overwrite=true');
      expect(addToTimelineBatch).not.toHaveBeenCalled();
    });

    it('honours a fixed number of beats per cut', async () => {
      executeScript.mockResolvedValueOnce(sequence());
      const r = await tools.executeTool('assemble_beat_cut', { ...args(), cutEveryBeats: 2, dryRun: true });
      expect(r.slots.slice(1, -1).every((s: { beats: number }) => s.beats === 2)).toBe(true);
    });
  });
});
