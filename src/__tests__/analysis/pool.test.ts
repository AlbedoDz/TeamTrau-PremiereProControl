import { analysisConcurrency, mapLimit } from '../../analysis/pool.js';

describe('mapLimit', () => {
  it('keeps input order and never exceeds the limit', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([30, 5, 20, 1, 10, 2], 2, async (ms, i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('handles an empty list', async () => {
    await expect(mapLimit([], 4, async () => 1)).resolves.toEqual([]);
  });
});

describe('analysisConcurrency', () => {
  afterEach(() => { delete process.env.PREMIERE_MCP_ANALYSIS_JOBS; });

  it('defaults to between 1 and 8 and honours an override', () => {
    expect(analysisConcurrency()).toBeGreaterThanOrEqual(1);
    expect(analysisConcurrency()).toBeLessThanOrEqual(8);
    process.env.PREMIERE_MCP_ANALYSIS_JOBS = '3';
    expect(analysisConcurrency()).toBe(3);
  });
});
