import { PremiereProTools } from '../../tools/index.js';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('../../bridge/index.js');
jest.mock('../../analysis/sidecar.js', () => {
  const actual = jest.requireActual('../../analysis/sidecar.js');
  return {
    ...actual,
    sidecarPython: jest.fn(),
    startJob: jest.fn(),
    jobStatus: jest.fn(),
    premiereMcpHome: jest.fn(),
    runSidecar: jest.fn(),
  };
});
jest.mock('../../analysis/ffmpeg.js', () => {
  const actual = jest.requireActual('../../analysis/ffmpeg.js');
  return { ...actual, findFfTool: jest.fn(), runFf: jest.fn() };
});

import * as sidecar from '../../analysis/sidecar.js';
import * as ffmpeg from '../../analysis/ffmpeg.js';
import { ASR_MODEL } from '../../tools/domains/shorts.js';

const sidecarPython = sidecar.sidecarPython as jest.Mock;
const startJob = sidecar.startJob as jest.Mock;
const jobStatus = sidecar.jobStatus as jest.Mock;
const premiereMcpHome = sidecar.premiereMcpHome as jest.Mock;

const runSidecar = sidecar.runSidecar as jest.Mock;
const findFfTool = ffmpeg.findFfTool as jest.Mock;
const runFf = ffmpeg.runFf as jest.Mock;

const FRAME = 1 / 25;

const aclip = (id: string, trackIndex: number, start: number, mediaPath: string | null, over: Record<string, unknown> = {}) => ({
  id, trackType: 'audio', trackIndex, start, end: start + 10, inPoint: 0, outPoint: 10, mediaPath, ...over,
});

const sequence = (clips: unknown[]) => ({
  success: true, sequenceId: 's1', sequenceName: 'Pod', frameDuration: FRAME, endTime: 30, clips,
});

describe('transcribe_sequence', () => {
  let executeScript: jest.Mock;
  let tools: PremiereProTools;
  let home: string;
  let fileA: string;
  let fileB: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'premiere-mcp-home-'));
    fileA = join(home, 'a.wav');
    fileB = join(home, 'b.wav');
    writeFileSync(fileA, 'x');
    writeFileSync(fileB, 'y');
    premiereMcpHome.mockReset().mockReturnValue(home);
    sidecarPython.mockReset().mockResolvedValue('python');
    startJob.mockReset();
    jobStatus.mockReset().mockResolvedValue(null);
    executeScript = jest.fn();
    tools = new PremiereProTools({ executeScript } as never);
  });

  it('returns the install result when the sidecar is missing', async () => {
    sidecarPython.mockResolvedValue(null);
    const r = await tools.executeTool('transcribe_sequence', {});
    expect(r).toMatchObject({ success: false, retry: false, userActionRequired: true, errorCode: 'asr.not_installed', command: 'premiere-pro-mcp --setup-asr' });
    expect(startJob).not.toHaveBeenCalled();
  });

  it('starts one job per unique audio file and reports running', async () => {
    executeScript.mockResolvedValue(sequence([aclip('c1', 0, 0, fileA), aclip('c2', 0, 10, fileA), aclip('c3', 1, 0, fileB)]));
    startJob.mockResolvedValueOnce({ status: 'running', progress: 0.5, etaSec: 30 }).mockResolvedValueOnce({ status: 'done', progress: 1, result: { words: [] } });
    const r = await tools.executeTool('transcribe_sequence', { glossary: ['Trau', 'MCP'] });
    expect(startJob).toHaveBeenCalledTimes(2);
    const [key, command, input] = startJob.mock.calls[0];
    expect(key).toMatch(new RegExp(`^transcribe\\|${fileA.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\|1:[\\d.]+\\|${ASR_MODEL}\\|Trau\\nMCP$`));
    expect(command).toBe('transcribe');
    expect(input).toMatchObject({ mediaPath: fileA, language: 'vi', glossary: ['Trau', 'MCP'], device: 'auto', model: ASR_MODEL });
    expect(r).toMatchObject({ success: true, status: 'running', files: 2 });
    expect(r.progress).toBeCloseTo(0.75);
    expect(r.etaSec).toBe(30);
  });

  it('returns paged sentences when every job is done', async () => {
    executeScript.mockResolvedValue(sequence([aclip('c1', 0, 0, fileA)]));
    startJob.mockResolvedValue({
      status: 'done', progress: 1,
      result: {
        device: 'cpu', computeType: 'int8', durationSec: 10,
        words: [
          { w: 'Xin', start: 1, end: 1.3, p: 0.9 },
          { w: 'chào.', start: 1.3, end: 1.3, p: 0.9 },
          { w: 'Hôm', start: 3, end: 3.3, p: 0.9 },
          { w: 'nay.', start: 3.3, end: 3.6, p: 0.9 },
        ],
      },
    });
    const r = await tools.executeTool('transcribe_sequence', { pageSize: 1 });
    expect(r).toMatchObject({ success: true, status: 'done', totalSentences: 2, totalWords: 4, page: 0, pageSize: 1 });
    expect(r.sentences).toHaveLength(1);
    expect(r.sentences[0].text).toBe('Xin chào.');
    expect(r.warnings.join(' ')).toContain('CPU fallback');
    expect(r.warnings.join(' ')).toContain('Repaired 1');
    const saved = JSON.parse(readFileSync(r.wordsFile, 'utf8'));
    expect(saved).toHaveLength(4);
    expect(r.wordsFile).toContain(join(home, 'renders'));
    const second = await tools.executeTool('transcribe_sequence', { pageSize: 1, page: 1 });
    expect(second.sentences[0].text).toBe('Hôm nay.');
  });

  it('errors when the dialogue tracks have no clips', async () => {
    executeScript.mockResolvedValue(sequence([aclip('c1', 0, 0, fileA)]));
    const r = await tools.executeTool('transcribe_sequence', { dialogueTrackIndices: [4] });
    expect(r.success).toBe(false);
    expect(r.error).toContain('4');
    expect(startJob).not.toHaveBeenCalled();
  });

  it('reports a failed job with its error and still restarts it', async () => {
    executeScript.mockResolvedValue(sequence([aclip('c1', 0, 0, fileA), aclip('c2', 1, 0, fileB)]));
    jobStatus.mockImplementation(async (key: string) => (key.includes(fileA) ? { status: 'failed', progress: 0, error: 'ffmpeg exploded' } : null));
    startJob.mockResolvedValue({ status: 'running', progress: 0 });
    const r = await tools.executeTool('transcribe_sequence', {});
    expect(r).toMatchObject({ success: false, retry: true });
    expect(r.error).toBe(`${fileA}: ffmpeg exploded`);
    expect(r.nextStep).toContain('restarted');
    expect(startJob).toHaveBeenCalledTimes(2);
    expect(startJob.mock.calls.some(([key]) => String(key).includes(fileA))).toBe(true);
  });

  it('errors before starting any job when a media file does not exist', async () => {
    const missing = join(home, 'gone.wav');
    executeScript.mockResolvedValue(sequence([aclip('c1', 0, 0, missing)]));
    const r = await tools.executeTool('transcribe_sequence', {});
    expect(r).toMatchObject({ success: false, error: `Media file not found: ${missing}` });
    expect(startJob).not.toHaveBeenCalled();
  });
});

describe('find_highlight_candidates', () => {
  let executeScript: jest.Mock;
  let tools: PremiereProTools;
  let home: string;
  let fileA: string;
  let vidA: string;

  // Four 12 s sentences with no gaps: 0-12, 12-24, 24-36, 36-48.
  const words = [0, 1, 2, 3].flatMap((s) => Array.from({ length: 4 }, (_, i) => ({
    w: i === 3 ? 'nhé.' : `từ${i}`, start: s * 12 + i * 3, end: s * 12 + i * 3 + 2.5, p: 0.9,
  })));
  const done = { status: 'done', progress: 1, result: { words } };
  const vclip = (id: string, trackIndex: number, mediaPath: string) => ({
    id, trackType: 'video', trackIndex, start: 0, end: 48, inPoint: 0, outPoint: 48, mediaPath,
  });
  const ebur = (n: number) => Array.from({ length: n }, (_, i) =>
    `[Parsed_ebur128_0 @ 0x1] t: ${i + 1}    TARGET:-23 LUFS    M: -20.0 S: -${18 + (i % 3)}.0     I: -20.0 LUFS`).join('\n');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'premiere-mcp-home-'));
    fileA = join(home, 'a.wav');
    vidA = join(home, 'v.mp4');
    writeFileSync(fileA, 'x');
    writeFileSync(vidA, 'v');
    premiereMcpHome.mockReset().mockReturnValue(home);
    sidecarPython.mockReset().mockResolvedValue('python');
    startJob.mockReset().mockResolvedValue(done);
    jobStatus.mockReset().mockResolvedValue(null);
    runSidecar.mockReset().mockResolvedValue({ samples: [] });
    findFfTool.mockReset().mockResolvedValue('ffmpeg');
    runFf.mockReset().mockResolvedValue({ code: 0, stdout: '', stderr: ebur(48) });
    executeScript = jest.fn().mockResolvedValue(sequence([aclip('c1', 0, 0, fileA, { end: 48, outPoint: 48 }), vclip('v1', 0, vidA)]));
    tools = new PremiereProTools({ executeScript } as never);
  });

  it('returns running while the transcript is pending', async () => {
    startJob.mockResolvedValue({ status: 'running', progress: 0.3 });
    const r = await tools.executeTool('find_highlight_candidates', {});
    expect(r).toMatchObject({ status: 'running', files: 1 });
    expect(runFf).not.toHaveBeenCalled();
  });

  it('returns candidates with text and signals and never calls the faces sidecar by default', async () => {
    const r = await tools.executeTool('find_highlight_candidates', { minSec: 20, maxSec: 40, limit: 2 });
    expect(r).toMatchObject({ success: true, sequenceId: 's1', detectFaces: false });
    expect(r.totalCandidates).toBeGreaterThan(0);
    expect(r.candidates.length).toBeGreaterThan(0);
    const c = r.candidates[0];
    expect(c.text).toContain('từ0 từ1 từ2 nhé.');
    expect(c.signals).toMatchObject({ multiFaceRatio: 0 });
    expect(typeof c.rawScore).toBe('number');
    expect(runFf).toHaveBeenCalledTimes(1);
    expect(runFf.mock.calls[0][1]).toEqual(expect.arrayContaining(['-hide_banner', '-nostats', '-i', fileA, '-map', '0:a:0', '-af', 'ebur128=framelog=verbose']));
    expect(runSidecar).not.toHaveBeenCalled();
  });

  it('derives multiFaceRatio from the mocked faces when detectFaces is true', async () => {
    runSidecar.mockResolvedValue({ samples: Array.from({ length: 48 }, (_, t) => ({ t, count: 2 })) });
    const r = await tools.executeTool('find_highlight_candidates', { detectFaces: true, minSec: 20, maxSec: 40 });
    expect(r.detectFaces).toBe(true);
    expect(runSidecar).toHaveBeenCalledTimes(1);
    expect(runSidecar.mock.calls[0][0]).toBe('faces');
    expect(runSidecar.mock.calls[0][1]).toMatchObject({ mediaPath: vidA, fps: 1, ranges: [{ start: 0, end: 48 }] });
    expect(r.candidates[0].signals.multiFaceRatio).toBeCloseTo(1);
  });

  it('reports a missing ffmpeg', async () => {
    findFfTool.mockResolvedValue(null);
    const r = await tools.executeTool('find_highlight_candidates', {});
    expect(r).toMatchObject({ success: false, errorCode: 'ffmpeg.not_found' });
  });
});
