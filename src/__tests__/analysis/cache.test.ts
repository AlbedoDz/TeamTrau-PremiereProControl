import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('analysis cache', () => {
  let media: string;

  beforeEach(() => {
    process.env.PREMIERE_MCP_CACHE_DIR = mkdtempSync(join(tmpdir(), 'premiere-mcp-cache-'));
    media = join(mkdtempSync(join(tmpdir(), 'premiere-mcp-media-')), 'clip.mp4');
    writeFileSync(media, 'abc');
  });

  const freshCache = () => {
    let mod!: typeof import('../../analysis/cache.js');
    jest.isolateModules(() => {
      mod = require('../../analysis/cache.js');
    });
    return mod;
  };

  it('computes once per file, operation and params', async () => {
    const { cached } = freshCache();
    const compute = jest.fn().mockResolvedValue({ n: 1 });
    await cached(media, 'probe', null, compute);
    await cached(media, 'probe', null, compute);
    await cached(media, 'silence', { db: -35 }, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('survives a restart: a fresh process reads the value from disk', async () => {
    const first = freshCache();
    await first.cached(media, 'probe', null, async () => ({ n: 7 }));
    expect(readdirSync(process.env.PREMIERE_MCP_CACHE_DIR!)).toHaveLength(1);

    const second = freshCache();
    const compute = jest.fn().mockResolvedValue({ n: 99 });
    await expect(second.cached(media, 'probe', null, compute)).resolves.toEqual({ n: 7 });
    expect(compute).not.toHaveBeenCalled();
  });

  it('recomputes when the file changes', async () => {
    const { cached } = freshCache();
    const compute = jest.fn().mockResolvedValue(1);
    await cached(media, 'probe', null, compute);
    writeFileSync(media, 'abcdef');
    await cached(media, 'probe', null, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('still computes when the cache directory cannot be written', async () => {
    process.env.PREMIERE_MCP_CACHE_DIR = join(media, 'not-a-directory');
    const { cached } = freshCache();
    await expect(cached(media, 'probe', null, async () => 5)).resolves.toBe(5);
  });

  it('clearAnalysisCache empties memory and disk', async () => {
    const { cached, clearAnalysisCache } = freshCache();
    const compute = jest.fn().mockResolvedValue(1);
    await cached(media, 'probe', null, compute);
    await clearAnalysisCache();
    await cached(media, 'probe', null, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
