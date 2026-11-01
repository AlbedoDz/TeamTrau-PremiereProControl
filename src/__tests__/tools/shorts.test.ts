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
  };
});

import * as sidecar from '../../analysis/sidecar.js';
import { ASR_MODEL } from '../../tools/domains/shorts.js';

const sidecarPython = sidecar.sidecarPython as jest.Mock;
const startJob = sidecar.startJob as jest.Mock;
const premiereMcpHome = sidecar.premiereMcpHome as jest.Mock;

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

  it('a failed job is reported with its error and restarted on the next call', async () => {
    executeScript.mockResolvedValue(sequence([aclip('c1', 0, 0, fileA)]));
    startJob.mockResolvedValueOnce({ status: 'failed', progress: 0, error: 'ffmpeg exploded' });
    const r = await tools.executeTool('transcribe_sequence', {});
    expect(r.success).toBe(false);
    expect(r.error).toContain('ffmpeg exploded');
    startJob.mockResolvedValueOnce({ status: 'running', progress: 0 });
    const again = await tools.executeTool('transcribe_sequence', {});
    expect(again).toMatchObject({ success: true, status: 'running', files: 1 });
    expect(startJob).toHaveBeenCalledTimes(2);
  });
});
