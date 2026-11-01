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
import { ASR_MODEL, buildShortTiming, median, timelineLoudness } from '../../tools/domains/shorts.js';
import { SAFE_AREA, safeFileName } from '../../analysis/captions.js';

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

  it('warns and still returns candidates when ffmpeg fails, without caching the failure', async () => {
    runFf.mockResolvedValue({ code: 1, stdout: '', stderr: 'a.wav: Invalid data found' });
    const r = await tools.executeTool('find_highlight_candidates', { minSec: 20, maxSec: 40 });
    expect(r.success).toBe(true);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.warnings.join(' ')).toContain('Loudness unavailable for a.wav');
    await tools.executeTool('find_highlight_candidates', { minSec: 20, maxSec: 40 });
    expect(runFf).toHaveBeenCalledTimes(2);
  });

  it('warns and succeeds when the faces sidecar throws', async () => {
    runSidecar.mockRejectedValue(new Error('boom'));
    const r = await tools.executeTool('find_highlight_candidates', { detectFaces: true, minSec: 20, maxSec: 40 });
    expect(r.success).toBe(true);
    expect(r.warnings.join(' ')).toContain('Face detection unavailable for v.mp4: boom');
  });

  it('returns the install result when detectFaces is requested and the sidecar is missing', async () => {
    sidecarPython.mockResolvedValue(null);
    const r = await tools.executeTool('find_highlight_candidates', { detectFaces: true });
    expect(r).toMatchObject({ success: false, errorCode: 'asr.not_installed' });
  });

  it('maps loudness per clip when one file is used twice with an offset', async () => {
    runFf.mockResolvedValue({ code: 0, stdout: '', stderr: ebur(60) });
    const two = [
      { ...aclip('c1', 0, 0, fileA), end: 10, outPoint: 10 },
      { ...aclip('c2', 0, 20, fileA), end: 30, inPoint: 30, outPoint: 40 },
    ];
    const out = await timelineLoudness('ffmpeg', two as never);
    // c1 keeps source t 1..9 at timeline 1..9; c2 maps source t 30..39 to timeline 20..29.
    expect(out.map((s) => s.t)).toEqual([...[1, 2, 3, 4, 5, 6, 7, 8, 9], ...[20, 21, 22, 23, 24, 25, 26, 27, 28, 29]].sort((a, b) => a - b));
    expect(runFf).toHaveBeenCalledTimes(1);
  });

  it('median averages the two middle values for an even count', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBe(0);
  });
});

describe('build_short', () => {
  const TICKS = 254016000000;
  let executeScript: jest.Mock;
  let importMedia: jest.Mock;
  let tools: PremiereProTools;
  let home: string;
  let fileA: string;
  let vidA: string;
  let project: string;
  let events: string[];
  let scripts: string[];
  let captionPath: string;
  let reframeResult: Record<string, unknown>;
  let readbacks: Array<Record<string, unknown>>;
  let sourceReads: number;
  let staleAfterFirstRead: boolean;

  // Four 12 s sentences with no gaps: 0-11.5, 12-23.5, 24-35.5, 36-47.5.
  const words = [0, 1, 2, 3].flatMap((s) => Array.from({ length: 4 }, (_, i) => ({
    w: i === 3 ? 'nhé.' : `từ${i}`, start: s * 12 + i * 3, end: s * 12 + i * 3 + 2.5, p: 0.9,
  })));
  const vclip = (id: string, trackIndex: number, mediaPath: string, start = 0, end = 48) => ({
    id, trackType: 'video', trackIndex, start, end, inPoint: start, outPoint: end, mediaPath,
  });
  const source = (stale: boolean) => sequence([
    aclip('c1', 0, 0, fileA, { end: stale ? 40 : 48, outPoint: stale ? 40 : 48 }),
    vclip('v1', 0, vidA),
  ]);
  const short = () => ({
    success: true, sequenceId: 'short1', sequenceName: 'Short', frameDuration: FRAME, endTime: 23.5,
    clips: [
      aclip('sa', 0, 0, fileA, { end: 23.5, inPoint: 12, outPoint: 35.5 }),
      vclip('sv', 0, vidA, 0, 23.5),
      vclip('cap', 1, captionPath, 0, 23.5),
    ],
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'premiere-mcp-home-'));
    process.env.PREMIERE_MCP_CACHE_DIR = join(home, 'cache');
    fileA = join(home, 'a.wav');
    vidA = join(home, 'v.mp4');
    project = join(home, 'Pod.prproj');
    writeFileSync(fileA, 'x');
    writeFileSync(vidA, 'v');
    writeFileSync(project, 'p');
    events = [];
    scripts = [];
    captionPath = '';
    sourceReads = 0;
    staleAfterFirstRead = false;
    buildShortTiming.pollMs = 0;
    buildShortTiming.timeoutMs = 0;
    reframeResult = {
      success: true, sequenceID: 'short1', name: 'Short', frameSizeHorizontal: 1215, frameSizeVertical: 2160,
      end: String(23.5 * TICKS), deleted: true,
    };
    readbacks = [];
    premiereMcpHome.mockReset().mockReturnValue(home);
    sidecarPython.mockReset().mockResolvedValue('python');
    startJob.mockReset().mockResolvedValue({ status: 'done', progress: 1, result: { words } });
    jobStatus.mockReset().mockResolvedValue(null);
    runSidecar.mockReset().mockImplementation(async (command: string, input: any) => {
      events.push(command);
      if (command === 'captions') {
        captionPath = input.outPath;
        return { path: input.outPath, frames: 588 };
      }
      return { samples: [] };
    });
    findFfTool.mockReset().mockResolvedValue('ffmpeg');
    runFf.mockReset().mockImplementation(async () => {
      events.push('ffmpeg');
      return { code: 0, stdout: '', stderr: 'Summary:\n  Integrated loudness:\n    I:         -20.0 LUFS' };
    });
    executeScript = jest.fn(async (script: string) => {
      scripts.push(script);
      if (script.includes('build_short:probe')) { events.push('probe'); return { success: true, frameSizeHorizontal: 3840, frameSizeVertical: 2160 }; }
      if (script.includes('p.save()')) { events.push('backup'); return { success: true, path: project }; }
      if (script.includes('build_short:reframe')) { events.push('reframe'); return reframeResult; }
      if (script.includes('build_short:place')) { events.push('place'); return { success: true, trackIndex: 1 }; }
      if (script.includes('build_short:markers')) { events.push('markers'); return { success: true, added: 1 }; }
      if (script.includes('build_short:readback')) {
        events.push('readback');
        return readbacks.shift() ?? {
          success: true, frameSizeHorizontal: 1215, frameSizeVertical: 2160, endSeconds: 23.5,
          topTrackIndex: 1, topTrackPaths: [captionPath], reframeKeys: 42,
        };
      }
      if (script.includes('collect(sequence.videoTracks')) {
        if (script.includes('"short1"')) { events.push('read-short'); return short(); }
        sourceReads += 1;
        return source(staleAfterFirstRead && sourceReads > 1);
      }
      if (script.includes('__findClip')) { events.push('gain'); return { success: true }; }
      return { success: true };
    });
    importMedia = jest.fn(async (path: string) => {
      events.push('import');
      return { success: true, id: 'item1', name: 'cap.mov', mediaPath: path };
    });
    tools = new PremiereProTools({ executeScript, importMedia } as never);
  });

  afterEach(() => {
    delete process.env.PREMIERE_MCP_CACHE_DIR;
  });

  const writes = () => scripts.filter((s) => /createSubsequence|p\.save\(\)|build_short:(place|markers)/.test(s));

  it('dryRun returns caption groups and never calls Premiere writes or the renderer', async () => {
    const r = await tools.executeTool('build_short', {
      startSentenceId: 1, endSentenceId: 2, name: 'Short', dryRun: true,
      captions: [{ start: 0, end: 8.5, text: 'Chào cả nhà' }],
    });
    expect(r).toMatchObject({ success: true, dryRun: true, start: 12, end: 35.5, durationSec: 23.5, name: 'Short' });
    expect(r.captions[0]).toMatchObject({ start: 0, end: 8.5, text: 'Chào cả nhà' });
    expect(r.captions.at(-1).end).toBe(23.5);
    expect(runSidecar).not.toHaveBeenCalled();
    expect(importMedia).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('rejects a reversed or out-of-range sentence range', async () => {
    const reversed = await tools.executeTool('build_short', { startSentenceId: 2, endSentenceId: 1, name: 'S' });
    expect(reversed).toMatchObject({ success: false, totalSentences: 4 });
    expect(reversed.error).toContain('totalSentences');
    const missing = await tools.executeTool('build_short', { startSentenceId: 1, endSentenceId: 9, name: 'S' });
    expect(missing).toMatchObject({ success: false, totalSentences: 4 });
    expect(runSidecar).not.toHaveBeenCalled();
  });

  it('rejects a stale transcript', async () => {
    staleAfterFirstRead = true;
    const r = await tools.executeTool('build_short', { startSentenceId: 1, endSentenceId: 2, name: 'S' });
    expect(r).toMatchObject({ success: false, error: 'The sequence changed since it was transcribed. Run transcribe_sequence again.' });
    expect(runSidecar).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('returns the install result when the sidecar is missing', async () => {
    sidecarPython.mockResolvedValue(null);
    const r = await tools.executeTool('build_short', { startSentenceId: 1, endSentenceId: 2, name: 'S' });
    expect(r).toMatchObject({ success: false, errorCode: 'asr.not_installed' });
    expect(r.error).toContain('build_short');
  });

  it('renders captions before touching Premiere', async () => {
    runSidecar.mockRejectedValue(new Error('font missing'));
    const r = await tools.executeTool('build_short', { startSentenceId: 1, endSentenceId: 2, name: 'S' });
    expect(r).toMatchObject({ success: false, verified: false, failedStep: 'render_captions' });
    expect(r.error).toContain('font missing');
    expect(scripts.some((s) => s.includes('createSubsequence'))).toBe(false);
    expect(writes()).toEqual([]);
  });

  it('runs the steps in order and verifies', async () => {
    const r = await tools.executeTool('build_short', { startSentenceId: 1, endSentenceId: 2, name: 'Short', captionStyle: 'pop' });
    const order = ['probe', 'captions', 'backup', 'reframe', 'import', 'place', 'ffmpeg', 'readback'];
    const seen = order.map((e) => events.indexOf(e));
    expect(seen.every((i) => i >= 0)).toBe(true);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    // qa reads the short after normalize measured it, before the readback.
    expect(events.lastIndexOf('read-short')).toBeGreaterThan(events.indexOf('ffmpeg'));
    expect(events.lastIndexOf('read-short')).toBeLessThan(events.indexOf('readback'));
    expect(events).not.toContain('markers'); // detectFaces is off by default
    expect(events).not.toContain('faces');

    const render = runSidecar.mock.calls.find(([c]) => c === 'captions')![1];
    expect(render).toMatchObject({ style: 'pop', width: 1215, height: 2160, fps: 25, duration: 23.5, safeArea: SAFE_AREA });
    expect(render.groups[0].start).toBe(0);
    expect(render.outPath.startsWith(join(home, 'renders', 'Short-'))).toBe(true);
    expect(render.outPath.endsWith('.mov')).toBe(true);

    const reframe = scripts.find((s) => s.includes('build_short:reframe'))!;
    expect(reframe).toContain('setInPoint');
    expect(reframe).toContain('createSubsequence(true)');
    expect(reframe).toContain('autoReframeSequence(9, 16');
    expect(reframe).toContain('deleteSequence');
    expect(importMedia).toHaveBeenCalledWith(captionPath, undefined);
    const place = scripts.find((s) => s.includes('build_short:place'))!;
    expect(place).toContain('"Shorts"');
    expect(place).toContain('addTracks');
    expect(place).toContain('overwriteClip');

    expect(r).toMatchObject({
      success: true, verified: true, shortSequenceId: 'short1', name: 'Short', durationSec: 23.5,
      captionFile: captionPath, backupPath: expect.stringContaining('premiere-mcp-backups'),
    });
    expect(r.qa).toMatchObject({ success: true });
    expect(r.markers).toEqual([]);
  });

  it('reports verified false when the readback does not match', async () => {
    readbacks = [{ success: true, frameSizeHorizontal: 1080, frameSizeVertical: 1080, endSeconds: 20, topTrackIndex: 1, topTrackPaths: [], reframeKeys: 42 }];
    const r = await tools.executeTool('build_short', { startSentenceId: 1, endSentenceId: 2, name: 'Short' });
    expect(r).toMatchObject({ success: true, verified: false });
    expect(r.warnings.join(' ')).toMatch(/9:16/);
  });

  it('warns when the reframed size differs from the predicted caption size', async () => {
    reframeResult = { ...reframeResult, frameSizeHorizontal: 1080, frameSizeVertical: 1920 };
    readbacks = [{ success: true, frameSizeHorizontal: 1080, frameSizeVertical: 1920, endSeconds: 23.5, topTrackIndex: 1, topTrackPaths: [], reframeKeys: 3 }];
    const r = await tools.executeTool('build_short', { startSentenceId: 1, endSentenceId: 2, name: 'Short' });
    expect(r.warnings.join(' ')).toContain('1215×2160');
  });

  it('waits for the Auto Reframe keyframes and warns when they never appear', async () => {
    buildShortTiming.pollMs = 1;
    buildShortTiming.timeoutMs = 2000;
    const base = { success: true, frameSizeHorizontal: 1215, frameSizeVertical: 2160, endSeconds: 23.5, topTrackIndex: 1, topTrackPaths: [] };
    readbacks = [{ ...base, reframeKeys: 0 }, { ...base, reframeKeys: 0 }];
    // The third readback falls back to the default, which has keyframes.
    const r = await tools.executeTool('build_short', { startSentenceId: 1, endSentenceId: 2, name: 'Short' });
    expect(events.filter((e) => e === 'readback')).toHaveLength(3);
    expect(r.verified).toBe(true);
    expect(r.warnings.join(' ')).not.toContain('Auto Reframe');

    buildShortTiming.timeoutMs = 0;
    readbacks = [{ ...base, reframeKeys: 0 }];
    const late = await tools.executeTool('build_short', { startSentenceId: 1, endSentenceId: 2, name: 'Short' });
    expect(late.success).toBe(true);
    expect(late.warnings.join(' ')).toContain('Auto Reframe');
  });

  it('stops at the failing step and keeps what was built', async () => {
    reframeResult = { success: false, error: 'Auto Reframe is unavailable' };
    const r = await tools.executeTool('build_short', { startSentenceId: 1, endSentenceId: 2, name: 'Short' });
    expect(r).toMatchObject({
      success: false, verified: false, failedStep: 'reframe',
      backupPath: expect.stringContaining('premiere-mcp-backups'), captionFile: captionPath,
    });
    expect(r.error).toContain('Auto Reframe is unavailable');
    expect(importMedia).not.toHaveBeenCalled();
  });

  it('honours backup=false', async () => {
    const r = await tools.executeTool('build_short', { startSentenceId: 1, endSentenceId: 2, name: 'Short', backup: false });
    expect(r.success).toBe(true);
    expect(events).not.toContain('backup');
    expect(r.backupPath).toBeUndefined();
  });

  it('adds a warning marker for each multi-face stretch', async () => {
    runSidecar.mockImplementation(async (command: string, input: any) => {
      events.push(command);
      if (command === 'captions') { captionPath = input.outPath; return { path: input.outPath, frames: 1 }; }
      return { samples: Array.from({ length: 48 }, (_, t) => ({ t, count: t === 20 || t === 21 ? 2 : 1 })) };
    });
    const r = await tools.executeTool('build_short', { startSentenceId: 1, endSentenceId: 2, name: 'Short', detectFaces: true });
    expect(r.success).toBe(true);
    const script = scripts.find((s) => s.includes('build_short:markers'))!;
    expect(script.split('Cảnh nhiều người — kiểm tra khung reframe')).toHaveLength(2);
    expect(r.markers).toEqual([{ start: 8, end: 10, name: 'Cảnh nhiều người — kiểm tra khung reframe' }]);
    expect(events.indexOf('markers')).toBeGreaterThan(events.lastIndexOf('read-short'));
    expect(events.indexOf('markers')).toBeLessThan(events.indexOf('readback'));
  });

  it('keeps the Vietnamese sequence name but writes a safe file name', async () => {
    const name = 'Tập 1: "Khó" nói?';
    const r = await tools.executeTool('build_short', { startSentenceId: 1, endSentenceId: 2, name });
    expect(r.name).toBe(name);
    const reframe = scripts.find((s) => s.includes('build_short:reframe'))!;
    expect(reframe).toContain(JSON.stringify(name));
    const out = runSidecar.mock.calls.find(([c]) => c === 'captions')![1].outPath as string;
    const file = out.slice(join(home, 'renders').length + 1);
    expect(file.startsWith(`${safeFileName(name)}-`)).toBe(true);
    expect(file).not.toMatch(/[:"?]/);
    const place = scripts.find((s) => s.includes('build_short:place'))!;
    expect(place).toContain(JSON.stringify(safeFileName(name)));
  });
});
