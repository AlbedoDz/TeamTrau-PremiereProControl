import { PremiereProTools } from '../../tools/index.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
const clips = [
  { id: 'v1', trackType: 'video', trackIndex: 0, start: 0, end: 4, inPoint: 0, outPoint: 4, mediaPath: 'talk.mp4' },
  { id: 'v2', trackType: 'video', trackIndex: 0, start: 4, end: 8, inPoint: 4, outPoint: 8, mediaPath: 'talk.mp4' },
  { id: 'v3', trackType: 'video', trackIndex: 0, start: 8, end: 12, inPoint: 8, outPoint: 12, mediaPath: 'talk.mp4' },
  { id: 'd1', trackType: 'audio', trackIndex: 0, start: 0, end: 12, inPoint: 0, outPoint: 12, mediaPath: 'talk.mp4' },
  { id: 'm1', trackType: 'audio', trackIndex: 1, start: 0, end: 12, inPoint: 0, outPoint: 12, mediaPath: 'music.mp3' },
];
const snapshot = (list: unknown[] = clips) => ({ success: true, sequenceId: 's1', sequenceName: 'Main', frameDuration: FRAME, endTime: 12, clips: list });

describe('editing tools', () => {
  let executeScript: jest.Mock;
  let tools: PremiereProTools;

  beforeAll(() => {
    process.env.PREMIERE_MCP_CACHE_DIR = mkdtempSync(join(tmpdir(), 'premiere-mcp-cache-'));
  });

  beforeEach(async () => {
    await clearAnalysisCache();
    findFfTool.mockReset().mockResolvedValue('ffmpeg');
    runFf.mockReset();
    executeScript = jest.fn();
    tools = new PremiereProTools({ executeScript } as never);
  });

  describe('auto_duck_music', () => {
    // talk.mp4 is silent 0-2 and 6-12, so speech is 2-6.
    const talk = { code: 0, stdout: '', stderr: 'silence_start: 0\nsilence_end: 2 | silence_duration: 2\nsilence_start: 6\nsilence_end: 12 | silence_duration: 6' };

    it('reports the ducking windows on a dry run without touching the clips', async () => {
      executeScript.mockResolvedValueOnce(snapshot());
      runFf.mockResolvedValue(talk);
      const r = await tools.executeTool('auto_duck_music', { dialogueTrackIndices: [0], musicTrackIndices: [1], dryRun: true });
      expect(r).toMatchObject({ success: true, dryRun: true, applied: false, speechRanges: 1, speechSeconds: 4 });
      expect(r.clips[0]).toMatchObject({ clipId: 'm1', duckingWindows: 1 });
      expect(r.clips[0].windows[0]).toEqual({ startTime: 2, endTime: 6, duckedDb: -24 });
      expect(executeScript).toHaveBeenCalledTimes(1);
    });

    it('writes volume keyframes for each music clip after a backup', async () => {
      const project = join(mkdtempSync(join(tmpdir(), 'premiere-mcp-proj-')), 'Show.prproj');
      writeFileSync(project, 'x');
      executeScript
        .mockResolvedValueOnce(snapshot())
        .mockResolvedValueOnce({ success: true, path: project })
        .mockResolvedValueOnce({ success: true });
      runFf.mockResolvedValue(talk);
      const r = await tools.executeTool('auto_duck_music', { dialogueTrackIndices: [0], musicTrackIndices: [1] });
      expect(r).toMatchObject({ success: true, applied: true });
      expect(r.backupPath).toContain('premiere-mcp-backups');
      expect(r.results[0]).toMatchObject({ clipId: 'm1', applied: true });
      const keyframeScript = executeScript.mock.calls[2]![0] as string;
      expect(keyframeScript).toContain('addKey(2)');
      expect(keyframeScript).toContain('addKey(6)');
    });

    it('rejects a track listed as both dialogue and music', async () => {
      executeScript.mockResolvedValueOnce(snapshot());
      const r = await tools.executeTool('auto_duck_music', { dialogueTrackIndices: [0], musicTrackIndices: [0, 1] });
      expect(r.success).toBe(false);
      expect(r.error).toContain('both dialogue and music');
    });

    it('leaves the music alone when there is no speech', async () => {
      executeScript.mockResolvedValueOnce(snapshot());
      runFf.mockResolvedValue({ code: 0, stdout: '', stderr: 'silence_start: 0\nsilence_end: 12 | silence_duration: 12' });
      const r = await tools.executeTool('auto_duck_music', { dialogueTrackIndices: [0], musicTrackIndices: [1] });
      expect(r).toMatchObject({ success: true, applied: false });
      expect(executeScript).toHaveBeenCalledTimes(1);
    });
  });

  describe('qa_sequence', () => {
    it('reports flash frames and gaps, and a clean sequence as clean', async () => {
      const bad = [
        { ...clips[0]!, end: 4 },
        { ...clips[1]!, start: 5, end: 5.08 },
        { ...clips[2]!, start: 8, end: 12 },
      ];
      executeScript.mockResolvedValueOnce(snapshot(bad));
      const r = await tools.executeTool('qa_sequence', { checkMedia: false });
      expect(r.findings.map((f: { code: string }) => f.code)).toEqual(['GAP', 'FLASH_FRAME', 'GAP']);
      expect(r.clean).toBe(false);

      executeScript.mockResolvedValueOnce(snapshot());
      expect(await tools.executeTool('qa_sequence', { checkMedia: false })).toMatchObject({ clean: true, errors: 0, warnings: 0 });
    });

    it('flags clips whose media file is gone', async () => {
      executeScript.mockResolvedValueOnce(snapshot());
      const r = await tools.executeTool('qa_sequence', {});
      expect(r.errors).toBeGreaterThan(0);
      expect(r.findings.map((f: { code: string }) => f.code)).toContain('MEDIA_MISSING');
    });
  });

  describe('apply_dialogue_chain', () => {
    it('plans on a dry run', async () => {
      executeScript.mockResolvedValueOnce(snapshot());
      const r = await tools.executeTool('apply_dialogue_chain', { dialogueTrackIndices: [0], dryRun: true });
      expect(r).toMatchObject({ success: true, dryRun: true, clipIds: ['d1'], effects: ['DeNoise', 'Dynamics'], normalize: -16 });
    });

    it('applies each effect and reports ones that were not found', async () => {
      executeScript
        .mockResolvedValueOnce(snapshot())
        .mockResolvedValueOnce({ success: true })           // audio-clip guard for DeNoise
        .mockResolvedValueOnce({ success: true })           // apply DeNoise
        .mockResolvedValueOnce({ success: true })           // audio-clip guard for Dynamics
        .mockResolvedValueOnce({ success: false, error: 'Effect not found: Dynamics' });
      const r = await tools.executeTool('apply_dialogue_chain', { dialogueTrackIndices: [0], backup: false, normalize: false });
      expect(r.success).toBe(false);
      expect(r.results[0].applied).toEqual(['DeNoise']);
      expect(r.results[0].failed[0]).toMatchObject({ effect: 'Dynamics' });
      expect(r.note).toContain('effects');
    });
  });

  describe('auto_punch_in', () => {
    it('lists the clips that would be scaled on a dry run', async () => {
      executeScript.mockResolvedValueOnce(snapshot());
      const r = await tools.executeTool('auto_punch_in', { dryRun: true });
      expect(r).toMatchObject({ success: true, dryRun: true, punchedClips: ['v3'], punchScale: 112 });
    });

    it('sets the static scale on each target and 100 on the rest when asked', async () => {
      executeScript.mockResolvedValue({ success: true }).mockResolvedValueOnce(snapshot());
      const r = await tools.executeTool('auto_punch_in', { backup: false, resetOthers: true });
      expect(r).toMatchObject({ success: true, applied: true, punchedClips: ['v3'], resetClips: ['v1', 'v2'] });
      const scripts = executeScript.mock.calls.slice(1).map((c) => c[0] as string);
      expect(scripts[0]).toContain('setValue(112, true)');
      expect(scripts.filter((s) => s.includes('setValue(100, true)'))).toHaveLength(2);
    });
  });
});
