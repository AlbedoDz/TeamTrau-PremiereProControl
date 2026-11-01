import { PremiereProTools } from '../../tools/index.js';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('../../bridge/index.js');
jest.mock('../../analysis/sidecar.js', () => {
  const actual = jest.requireActual('../../analysis/sidecar.js');
  return { ...actual, sidecarPython: jest.fn(), startJob: jest.fn(), jobStatus: jest.fn(), premiereMcpHome: jest.fn() };
});

import * as sidecar from '../../analysis/sidecar.js';

const sidecarPython = sidecar.sidecarPython as jest.Mock;
const startJob = sidecar.startJob as jest.Mock;
const jobStatus = sidecar.jobStatus as jest.Mock;
const premiereMcpHome = sidecar.premiereMcpHome as jest.Mock;

describe('create_captions_from_transcript', () => {
  let executeScript: jest.Mock;
  let importMedia: jest.Mock;
  let tools: PremiereProTools;
  let home: string;
  let scripts: string[];
  let captionResult: Record<string, unknown>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'premiere-mcp-home-'));
    const media = join(home, 'a.wav');
    writeFileSync(media, 'x');
    writeFileSync(join(home, 'p.prproj'), 'p');
    premiereMcpHome.mockReset().mockReturnValue(home);
    sidecarPython.mockReset().mockResolvedValue('python');
    jobStatus.mockReset().mockResolvedValue(null);
    startJob.mockReset().mockResolvedValue({
      status: 'done', progress: 1,
      result: {
        device: 'cuda', words: [
          { w: 'Xin', start: 1, end: 1.3 }, { w: 'chào', start: 1.3, end: 1.6 }, { w: 'bạn.', start: 1.6, end: 2 },
          { w: 'Hôm', start: 3, end: 3.3 }, { w: 'nay.', start: 3.3, end: 3.6 },
        ],
      },
    });
    scripts = [];
    captionResult = { success: true, message: 'Caption track created' };
    executeScript = jest.fn(async (script: string) => {
      scripts.push(script);
      if (script.includes('collect(sequence.videoTracks')) {
        return {
          success: true, sequenceId: 's1', sequenceName: 'Pod', frameDuration: 1 / 25, endTime: 30,
          clips: [{ id: 'c1', trackType: 'audio', trackIndex: 0, start: 0, end: 10, inPoint: 0, outPoint: 10, mediaPath: media }],
        };
      }
      if (script.includes('p.save()')) return { success: true, path: join(home, 'p.prproj') };
      if (script.includes('sequence.createCaptionTrack')) return captionResult;
      return { success: true };
    });
    importMedia = jest.fn(async (path: string) => ({ success: true, id: 'item1', mediaPath: path }));
    tools = new PremiereProTools({ executeScript, importMedia } as never);
  });

  const writes = () => scripts.filter((s) => /p\.save\(\)|sequence\.createCaptionTrack/.test(s));

  it('dryRun writes no file and calls no bridge write', async () => {
    const r = await tools.executeTool('create_captions_from_transcript', { dryRun: true });
    expect(r).toMatchObject({ success: true, dryRun: true, cueCount: 2 });
    expect(r.preview).toHaveLength(2);
    expect(importMedia).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    expect(existsSync(join(home, 'renders'))).toBe(false);
  });

  it('returns running while the transcript is not ready', async () => {
    startJob.mockResolvedValue({ status: 'running', progress: 0.4 });
    const r = await tools.executeTool('create_captions_from_transcript', {});
    expect(r).toMatchObject({ success: true, status: 'running' });
    expect(importMedia).not.toHaveBeenCalled();
  });

  it('imports the SRT then creates the caption track with the imported id', async () => {
    const r = await tools.executeTool('create_captions_from_transcript', {});
    expect(r).toMatchObject({ success: true, sequenceId: 's1', cueCount: 2, projectItemId: 'item1' });
    expect(importMedia).toHaveBeenCalledWith(r.srtPath, 'Captions');
    const text = readFileSync(r.srtPath, 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('Xin chào bạn.');
    expect(text).toContain('\r\n');
    const create = scripts.find((s) => s.includes('sequence.createCaptionTrack'))!;
    expect(create).toContain('"item1"');
    expect(create).toContain('var startAtTime = 0;');
  });

  it('honours startTime/endTime and an explicit outputPath', async () => {
    const out = join(home, 'out.srt');
    const r = await tools.executeTool('create_captions_from_transcript', { startTime: 2.5, outputPath: out, backup: false });
    expect(r.srtPath).toBe(out);
    expect(r.cueCount).toBe(1);
    expect(readFileSync(out, 'utf8')).toContain('00:00:03,000');
    expect(scripts.some((s) => s.includes('p.save()'))).toBe(false);
  });

  it('reports failedStep create_caption_track with the srtPath', async () => {
    captionResult = { success: false, error: 'boom' };
    const r = await tools.executeTool('create_captions_from_transcript', {});
    expect(r).toMatchObject({ success: false, failedStep: 'create_caption_track', srtPath: expect.stringContaining('.srt') });
    expect(r.backupPath).toContain('premiere-mcp-backups');
    expect(existsSync(r.srtPath)).toBe(true);
  });
});
