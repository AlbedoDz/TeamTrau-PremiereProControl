import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('../../analysis/ffmpeg.js', () => {
  const actual = jest.requireActual('../../analysis/ffmpeg.js');
  return { ...actual, runFf: jest.fn(actual.runFf) };
});

import * as ffmpeg from '../../analysis/ffmpeg.js';
import { detectScenes, parseSceneCuts, shotsFromCuts } from '../../analysis/scenes.js';

const haveFfmpeg = ['ffmpeg', 'ffprobe'].every((t) => spawnSync(t, ['-version']).status === 0);
const ifFfmpeg = haveFfmpeg ? it : it.skip;

describe('parseSceneCuts', () => {
  it('reads pts_time from showinfo lines only', () => {
    const stderr = [
      'Input #0, lavfi, from ...',
      '[Parsed_showinfo_1 @ 000001] n:   0 pts:  50 pts_time:2       duration:1 fmt:yuv420p',
      '[Parsed_showinfo_1 @ 000001] n:   1 pts: 100 pts_time:4.04    duration:1 fmt:yuv420p',
      'frame=  150 fps=0.0 pts_time:99',
    ].join('\n');
    expect(parseSceneCuts(stderr)).toEqual([2, 4.04]);
  });
  it('returns nothing for unrelated output', () => {
    expect(parseSceneCuts('no cuts')).toEqual([]);
  });
});

describe('shotsFromCuts', () => {
  it('merges a short shot into the previous one', () => {
    expect(shotsFromCuts([1.0, 1.2, 5.0], 8, 0.5)).toEqual([
      { start: 0, end: 1.2 },
      { start: 1.2, end: 5 },
      { start: 5, end: 8 },
    ]);
  });
  it('merges a too-short first shot into the next', () => {
    expect(shotsFromCuts([0.2, 3], 6, 0.5)).toEqual([{ start: 0, end: 3 }, { start: 3, end: 6 }]);
  });
  it('merges a too-short last shot into the previous', () => {
    expect(shotsFromCuts([3, 5.8], 6, 0.5)).toEqual([{ start: 0, end: 3 }, { start: 3, end: 6 }]);
  });
  it('returns one shot when there are no cuts', () => {
    expect(shotsFromCuts([], 8, 0.5)).toEqual([{ start: 0, end: 8 }]);
  });
});

describe('detectScenes with real ffmpeg', () => {
  let media: string;

  beforeAll(() => {
    if (!haveFfmpeg) return;
    process.env.PREMIERE_MCP_CACHE_DIR = mkdtempSync(join(tmpdir(), 'premiere-mcp-scenes-cache-'));
    media = join(mkdtempSync(join(tmpdir(), 'premiere-mcp-scenes-')), 'three.mp4');
    const colour = (c: string) => `color=c=${c}:s=160x120:r=25:d=2`;
    const made = spawnSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', colour('black'), '-f', 'lavfi', '-i', colour('white'), '-f', 'lavfi', '-i', colour('red'),
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-pix_fmt', 'yuv420p', media,
    ]);
    if (made.status !== 0) throw new Error(`could not build test media: ${made.stderr}`);
  });

  ifFfmpeg('finds the cuts near 2 s and 4 s, then serves the second run from cache', async () => {
    const runFf = ffmpeg.runFf as jest.Mock;
    runFf.mockClear();
    const first = await detectScenes(media, { threshold: 0.3, minShotSec: 0.5 });
    if ('failure' in first) throw new Error(JSON.stringify(first.failure));
    expect(first.cutTimes).toHaveLength(2);
    expect(first.cutTimes[0]).toBeCloseTo(2, 1);
    expect(first.cutTimes[1]).toBeCloseTo(4, 1);
    expect(first.shots).toHaveLength(3);
    expect(first.shots[0]!.start).toBe(0);
    expect(first.shots[2]!.end).toBeCloseTo(6, 1);
    const callsAfterFirst = runFf.mock.calls.length;

    const second = await detectScenes(media, { threshold: 0.3, minShotSec: 0.5 });
    expect(second).toEqual(first);
    expect(runFf.mock.calls.length).toBe(callsAfterFirst);
  });
});
