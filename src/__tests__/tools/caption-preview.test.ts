import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, sep } from 'node:path';

jest.mock('../../analysis/sidecar.js', () => ({
  ...jest.requireActual('../../analysis/sidecar.js'),
  runSidecar: jest.fn(),
  sidecarPython: jest.fn(),
}));

import * as sidecar from '../../analysis/sidecar.js';
import { captionPreviewTools } from '../../tools/domains/caption-preview.js';

const runSidecar = sidecar.runSidecar as jest.Mock;
const sidecarPython = sidecar.sidecarPython as jest.Mock;
const tool = captionPreviewTools[0]!;
const call = (args: Record<string, unknown>) => tool.run({} as any, (tool.inputSchema as any).parse(args)) as Promise<any>;

beforeEach(() => {
  process.env.PREMIERE_MCP_HOME = mkdtempSync(`${tmpdir()}${sep}caption-preview-`);
  runSidecar.mockReset();
  sidecarPython.mockReset().mockResolvedValue('python');
  runSidecar.mockImplementation(async (_cmd: string, input: any) => {
    mkdirSync(dirname(input.outPath), { recursive: true });
    writeFileSync(input.outPath, 'png');
    return { path: input.outPath, width: input.width, height: input.height };
  });
});

describe('preview_caption_style', () => {
  it('renders a 540x960 preview for 9:16', async () => {
    const res = await call({ style: 'pop' });
    expect(res.success).toBe(true);
    expect(runSidecar).toHaveBeenCalledTimes(1);
    const [cmd, input] = runSidecar.mock.calls[0]!;
    expect(cmd).toBe('caption_preview');
    expect(input.width).toBe(540);
    expect(input.height).toBe(960);
    expect(input.look.accentColor).toBeDefined();
    expect(input.activeIndex).toBe(1);
    expect(input.outPath.endsWith('.png')).toBe(true);
    expect(input.outPath.split(/[\\/]/).slice(-3, -1)).toEqual(['renders', 'previews']);
    expect(res.path).toBe(input.outPath);
    expect(res.grouping).toBeDefined();
    expect(res.layout).toBe('9:16');
  });

  it.each([
    ['16:9', 960, 540],
    ['4:5', 768, 960],
    ['1:1', 960, 960],
  ])('aspect %s gives %ix%i', async (aspect, w, h) => {
    const res = await call({ style: 'clean', aspect });
    expect([res.width, res.height]).toEqual([w, h]);
  });

  it('uses explicit width and height over aspect, and requires both', async () => {
    const res = await call({ style: 'clean', aspect: '16:9', width: 400, height: 800 });
    expect([res.width, res.height]).toEqual([400, 800]);
    expect((await call({ style: 'clean', width: 400 })).success).toBe(false);
  });

  it('reuses a cached preview', async () => {
    await call({ style: 'highlight', captionAccent: '#22D3EE' });
    await call({ style: 'highlight', captionAccent: '#22D3EE' });
    expect(runSidecar).toHaveBeenCalledTimes(1);
    await call({ style: 'highlight', captionAccent: '#FF3B5C' });
    expect(runSidecar).toHaveBeenCalledTimes(2);
  });

  it('rejects a bad accent', () => {
    expect(() => (tool.inputSchema as any).parse({ style: 'clean', captionAccent: '#f00' })).toThrow(/#RRGGBB/);
  });

  it('reports a missing sidecar', async () => {
    sidecarPython.mockResolvedValue(null);
    const res = await call({ style: 'clean' });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('asr.not_installed');
    expect(runSidecar).not.toHaveBeenCalled();
  });

  it('reports a missing sidecar thrown by runSidecar', async () => {
    runSidecar.mockRejectedValue(new sidecar.SidecarError('The analysis sidecar is not installed. Run: x'));
    const res = await call({ style: 'clean' });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('asr.not_installed');
  });
});
