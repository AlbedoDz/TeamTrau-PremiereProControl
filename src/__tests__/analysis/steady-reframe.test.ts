import { describe, expect, it, jest } from '@jest/globals';
import { steadyPath } from '../../analysis/steady-reframe.js';

const F = 0.04;

describe('steadyPath', () => {
  // Live shape on FINAL_01: the path glides from 0.53 to 0.46 after a camera cut at 1477.2 s.
  const keys = [
    { t: 1472.48, x: 0.60, y: 0.5 }, { t: 1474.68, x: 0.60, y: 0.5 }, { t: 1475.68, x: 0.64, y: 0.5 },
    { t: 1477.28, x: 0.53, y: 0.5 }, { t: 1478.68, x: 0.46, y: 0.5 }, { t: 1480.0, x: 0.46, y: 0.5 }, { t: 1481.0, x: 0.47, y: 0.5 },
  ];

  it('holds one position per shot and jumps on the cut', () => {
    const out = steadyPath(keys, [1477.2], 1472.28, 1482, F);
    expect(out.map((k) => k.t)).toEqual([1472.28, 1477.2 - F, 1477.2, 1482]);
    expect(out[0]!.x).toBe(out[1]!.x);
    expect(out[0]!.x).toBeCloseTo(0.6, 5);
    expect(out[2]!.x).toBe(out[3]!.x);
    expect(out[2]!.x).toBeCloseTo(0.465, 5);
  });

  it('holds a single position without cuts, ignores cuts outside the clip, and returns [] without keys', () => {
    const one = steadyPath(keys, [1400, 1490], 1472.28, 1482, F);
    expect(one).toHaveLength(2);
    expect(one[0]!.x).toBe(one[1]!.x);
    expect(steadyPath([], [1477.2], 1472.28, 1482, F)).toEqual([]);
  });

  it('merges neighbouring shots that hold nearly the same position (live: 0.461 / 0.463 on a recap clip)', () => {
    const flat = [{ t: 0, x: 0.461, y: 0.5 }, { t: 3, x: 0.463, y: 0.5 }, { t: 6, x: 0.70, y: 0.5 }];
    const out = steadyPath(flat, [2, 5], 0, 8, F);
    expect(out.map((k) => k.t)).toEqual([0, 5 - F, 5, 8]);
    expect(out[0]!.x).toBe(out[1]!.x);
    expect(out[2]!.x).toBeCloseTo(0.70, 5);
  });

  it('uses the path at the middle of a shot that has no key inside', () => {
    const sparse = [{ t: 0, x: 0.2, y: 0.5 }, { t: 10, x: 0.8, y: 0.5 }];
    const out = steadyPath(sparse, [4, 6], 0, 10, F);
    expect(out[2]!.x).toBeCloseTo(0.5, 5); // shot 4-6 s, middle 5 s
  });
});

describe('steadyReframe', () => {
  it('waits for the path, then writes held keys per clip', async () => {
    const { steadyReframe, steadyReframeTiming } = await import('../../tools/steady-reframe.js');
    steadyReframeTiming.pollMs = 1;
    const scripts: string[] = [];
    let reads = 0;
    const executeScript = jest.fn(async (script: string) => {
      scripts.push(script);
      if (script.includes('steady_reframe:read')) {
        reads++;
        const keys = reads < 2 ? [] : [[10, 0.6, 0.5], [12, 0.6, 0.5]];
        return { success: true, frameSec: 0.04, clips: [{ track: 0, index: 0, mediaPath: '', inPoint: 10, outPoint: 14, keys }] };
      }
      return { success: true, written: 1, errors: [] };
    });
    const r = await steadyReframe({ bridge: { executeScript } } as never, 'seq');
    expect(reads).toBe(2);
    expect(r).toEqual({ steadied: 1, warnings: [] });
    const write = scripts.find((s) => s.includes('steady_reframe:write'))!;
    expect(write).toContain('"t":10,"x":0.6,"y":0.5');
    expect(write).toContain('"t":14,"x":0.6,"y":0.5');
    expect(write).toContain('ovr.setValue(true, true)');
  });

  it('returns at once when the sequence has no Auto Reframe clip', async () => {
    const { steadyReframe } = await import('../../tools/steady-reframe.js');
    const executeScript = jest.fn(async () => ({ success: true, frameSec: 0.04, clips: [] }));
    expect(await steadyReframe({ bridge: { executeScript } } as never, 'seq')).toEqual({ steadied: 0, warnings: [] });
    expect(executeScript).toHaveBeenCalledTimes(1);
  });
});
