/**
 * Shot boundary detection with ffmpeg's scene score. The recap planner uses the
 * shots when a video has little or no speech to cut by.
 */
import { cached } from './cache.js';
import { findFfTool, ffmpegMissingResult, probeMedia, runFf } from './ffmpeg.js';

export interface Shot {
  start: number;
  end: number;
}

/** Reads the `pts_time` of every frame the scene filter selected (one showinfo line each). */
export function parseSceneCuts(stderr: string): number[] {
  const cuts: number[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes('showinfo')) continue;
    const match = /pts_time:\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(line);
    if (match) cuts.push(Number(match[1]));
  }
  return cuts;
}

/**
 * Turns cut times into contiguous shots covering [0, duration]. A shot shorter
 * than minShotSec is merged into the previous shot (the cut that starts it is
 * dropped); a too-short first shot merges into the next one.
 */
export function shotsFromCuts(cuts: number[], duration: number, minShotSec: number): Shot[] {
  const inner = [...new Set(cuts)].filter((t) => t > 0 && t < duration).sort((a, b) => a - b);
  const bounds = [0, ...inner, duration];
  // Shot k spans bounds[k]..bounds[k+1]. Dropping its starting cut folds it into the previous shot;
  // the first shot has no previous one, so its ending cut goes instead.
  for (let k = 0; k < bounds.length - 1 && bounds.length > 2; ) {
    if (bounds[k + 1]! - bounds[k]! < minShotSec) bounds.splice(k === 0 ? 1 : k, 1);
    else k++;
  }
  const shots: Shot[] = [];
  for (let i = 0; i < bounds.length - 1; i++) shots.push({ start: bounds[i]!, end: bounds[i + 1]! });
  return shots;
}

export async function detectScenes(
  mediaPath: string,
  opts: { threshold: number; minShotSec: number },
): Promise<{ shots: Shot[]; cutTimes: number[] } | { failure: Record<string, unknown> }> {
  const ffmpeg = await findFfTool('ffmpeg');
  const ffprobe = await findFfTool('ffprobe');
  if (!ffmpeg || !ffprobe) return { failure: ffmpegMissingResult('detect_scenes') };
  try {
    return await cached(mediaPath, 'scenes', opts, async () => {
      const probe = await probeMedia(ffprobe, mediaPath);
      if (!probe.streams.some((s) => s.type === 'video')) {
        return { failure: { success: false, error: 'The file has no video stream, so there are no shots to detect.', mediaPath } };
      }
      if (probe.durationSeconds === null) {
        return { failure: { success: false, error: 'ffprobe could not read the duration of the file.', mediaPath } };
      }
      const run = await runFf(ffmpeg, [
        '-hide_banner', '-nostats', '-i', mediaPath,
        '-vf', `select='gt(scene,${opts.threshold})',showinfo`,
        '-an', '-f', 'null', '-',
      ]);
      if (run.code !== 0) {
        return { failure: { success: false, error: `ffmpeg exited with code ${run.code}`, mediaPath, ffmpegStderr: run.stderr.slice(-1500) } };
      }
      const cutTimes = parseSceneCuts(run.stderr);
      return { shots: shotsFromCuts(cutTimes, probe.durationSeconds, opts.minShotSec), cutTimes };
    });
  } catch (err) {
    return { failure: { success: false, error: `Failed to run ffmpeg: ${err instanceof Error ? err.message : String(err)}`, mediaPath } };
  }
}
