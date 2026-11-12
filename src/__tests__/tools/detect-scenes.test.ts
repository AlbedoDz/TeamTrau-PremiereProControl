import type { ToolContext } from '../../tools/context.js';

jest.mock('../../analysis/scenes.js', () => ({ detectScenes: jest.fn() }));
jest.mock('../../tools/domains/audio.js', () => ({
  ...jest.requireActual('../../tools/domains/audio.js'),
  resolveProjectItemMediaPath: jest.fn(),
}));

import * as scenes from '../../analysis/scenes.js';
import * as audio from '../../tools/domains/audio.js';
import { cleanupTools } from '../../tools/domains/cleanup.js';

const detectScenes = scenes.detectScenes as jest.Mock;
const resolveItem = audio.resolveProjectItemMediaPath as jest.Mock;
const tool = cleanupTools.find((t) => t.name === 'detect_scenes')!;
const ctx = {} as ToolContext;
const parse = (args: Record<string, unknown>) => tool.inputSchema.parse(args);

describe('detect_scenes tool', () => {
  beforeEach(() => jest.resetAllMocks());

  it('applies the defaults and returns shots for a mediaPath', async () => {
    detectScenes.mockResolvedValue({ shots: [{ start: 0, end: 3 }, { start: 3, end: 6 }], cutTimes: [3] });
    const result: any = await tool.run(ctx, parse({ mediaPath: 'C:/m.mp4' }));
    expect(detectScenes).toHaveBeenCalledWith('C:/m.mp4', { threshold: 0.3, minShotSec: 0.5 });
    expect(result).toMatchObject({ success: true, mediaPath: 'C:/m.mp4', shotCount: 2, cutTimes: [3] });
  });

  it('resolves a projectItemId', async () => {
    resolveItem.mockResolvedValue({ path: 'C:/item.mp4' });
    detectScenes.mockResolvedValue({ shots: [{ start: 0, end: 2 }], cutTimes: [] });
    const result: any = await tool.run(ctx, parse({ projectItemId: 'p1', threshold: 0.5, minShotSec: 1 }));
    expect(detectScenes).toHaveBeenCalledWith('C:/item.mp4', { threshold: 0.5, minShotSec: 1 });
    expect(result.success).toBe(true);
  });

  it('requires a mediaPath or projectItemId', () => {
    expect(() => parse({})).toThrow(/mediaPath or projectItemId/);
  });

  it('passes a failure through', async () => {
    detectScenes.mockResolvedValue({ failure: { success: false, error: 'boom' } });
    await expect(tool.run(ctx, parse({ mediaPath: 'C:/m.mp4' }))).resolves.toEqual({ success: false, error: 'boom' });
  });
});
