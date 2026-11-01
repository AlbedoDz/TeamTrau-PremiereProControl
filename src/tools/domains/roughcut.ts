/**
 * Rough cut from a folder of footage: score_clips ranks the best stretches of each
 * file, assemble_rough_cut lays the best ones onto a sequence to a target length.
 * Premiere cannot see pixels, so exposure and sharpness are measured on the media
 * file with ffmpeg (src/analysis/roughcut.ts decides what to keep).
 */
import { z } from 'zod';
import { access, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { ToolContext, ToolModule } from '../context.js';
import { cached } from '../../analysis/cache.js';
import { analysisConcurrency, mapLimit } from '../../analysis/pool.js';
import { ffmpegMissingResult, findFfTool, probeMedia, runFf } from '../../analysis/ffmpeg.js';
import { bestWindows, parseMetric, planRoughCut, scoreWindows, type Candidate, type WindowScore } from '../../analysis/roughcut.js';
import { backupProject, BACKUP_FAILED_HINT, isError, readSequence } from './cleanup.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mxf', '.mkv', '.m4v', '.avi', '.mts', '.m2ts', '.webm']);
const MAX_FILES = 500;
/** Keyframe sampling below this many samples per second is too sparse to score; decode one frame per second instead. */
const MIN_SAMPLES_PER_SECOND = 0.2;

export async function listFootage(args: { mediaPaths?: string[] | undefined; folderPath?: string | undefined; recursive?: boolean | undefined }): Promise<{ paths: string[] } | { error: string }> {
  if (args.mediaPaths?.length) return { paths: args.mediaPaths };
  if (!args.folderPath) return { error: 'Provide mediaPaths or folderPath.' };
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (args.recursive) await walk(full);
      } else if (VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        found.push(full);
      }
    }
  };
  try {
    await walk(args.folderPath);
  } catch (err) {
    return { error: `Cannot read folder ${args.folderPath}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (found.length === 0) return { error: `No video files found in ${args.folderPath}${args.recursive ? '' : ' (pass recursive=true to include subfolders)'}.` };
  if (found.length > MAX_FILES) return { error: `${found.length} files is more than the ${MAX_FILES} limit. Point at a smaller folder.` };
  return { paths: found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) };
}

interface FileScores {
  mediaPath: string;
  sourceDuration: number;
  windows: WindowScore[];
}

const metricArgs = (mediaPath: string, chain: string, sampling: 'keyframes' | 'fps'): string[] => [
  '-hide_banner', '-nostats',
  ...(sampling === 'keyframes' ? ['-skip_frame', 'nokey'] : []),
  '-i', mediaPath, '-an',
  '-vf', `${sampling === 'fps' ? 'fps=1,' : ''}scale=320:-2,${chain}signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`,
  '-f', 'null', '-',
];

async function scoreFile(ffmpeg: string, ffprobe: string, mediaPath: string, windowSeconds: number): Promise<FileScores | { mediaPath: string; error: string }> {
  try {
    await access(mediaPath);
    const probe = await cached(mediaPath, 'probe', null, () => probeMedia(ffprobe, mediaPath));
    const duration = probe.durationSeconds;
    if (!duration || !probe.streams.some((s) => s.type === 'video')) return { mediaPath, error: 'No video stream or unknown duration.' };
    const windows = await cached(mediaPath, 'score-windows', { w: windowSeconds }, async () => {
      const measure = async (sampling: 'keyframes' | 'fps') => {
        const [luma, edge] = await Promise.all([
          runFf(ffmpeg, metricArgs(mediaPath, '', sampling)),
          runFf(ffmpeg, metricArgs(mediaPath, 'edgedetect,', sampling)),
        ]);
        if (luma.code !== 0 || edge.code !== 0) throw new Error(`ffmpeg could not read ${mediaPath}: ${(luma.code !== 0 ? luma : edge).stderr.slice(-300)}`);
        return { luma: parseMetric(luma.stdout), edge: parseMetric(edge.stdout) };
      };
      let samples = await measure('keyframes');
      if (samples.luma.length / duration < MIN_SAMPLES_PER_SECOND) samples = await measure('fps');
      return scoreWindows(samples.luma, samples.edge, duration, windowSeconds);
    });
    return { mediaPath, sourceDuration: duration, windows };
  } catch (err) {
    return { mediaPath, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function scoreAll(
  paths: string[],
  windowSeconds: number,
  toolName: string,
): Promise<{ scored: FileScores[]; failed: Array<{ mediaPath: string; error: string }> } | { failure: Record<string, unknown> }> {
  const ffmpeg = await findFfTool('ffmpeg');
  const ffprobe = await findFfTool('ffprobe');
  if (!ffmpeg || !ffprobe) return { failure: ffmpegMissingResult(toolName) };
  const results = await mapLimit(paths, analysisConcurrency(), (p) => scoreFile(ffmpeg, ffprobe, p, windowSeconds));
  return {
    scored: results.filter((r): r is FileScores => 'windows' in r),
    failed: results.filter((r): r is { mediaPath: string; error: string } => 'error' in r),
  };
}

// --------------------------------------------------------------- score_clips

async function scoreClips(
  _ctx: ToolContext,
  args: { mediaPaths?: string[]; folderPath?: string; recursive: boolean; windowSeconds: number; topPerFile: number },
): Promise<any> {
  const listed = await listFootage(args);
  if ('error' in listed) return { success: false, error: listed.error };
  const all = await scoreAll(listed.paths, args.windowSeconds, 'score_clips');
  if ('failure' in all) return all.failure;
  const files = all.scored
    .map((f) => {
      const best = bestWindows(f.windows, args.topPerFile, args.windowSeconds / 2);
      return { mediaPath: f.mediaPath, durationSeconds: f.sourceDuration, bestScore: best[0]?.score ?? 0, windows: best };
    })
    .sort((a, b) => b.bestScore - a.bestScore);
  return {
    success: true,
    checked: listed.paths.length,
    scored: files.length,
    windowSeconds: args.windowSeconds,
    files,
    ...(all.failed.length ? { failed: all.failed } : {}),
    note: 'Score is 0-1 from exposure (45%) and sharpness (55%). Shake and motion are not measured.',
  };
}

// ------------------------------------------------------ assemble_rough_cut

const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

/** Project item id for each media path already in the project, keyed by normalised path. */
async function projectItemIds(ctx: ToolContext): Promise<Map<string, string>> {
  const result: any = await ctx.bridge.executeScript(`
    try {
      var out = [];
      function walk(parent) {
        for (var i = 0; i < parent.children.numItems; i++) {
          var child = parent.children[i];
          if (child.type === ProjectItemType.BIN) { walk(child); continue; }
          var p = null;
          try { p = child.getMediaPath(); } catch (e1) {}
          if (p) out.push({ id: child.nodeId, path: String(p) });
        }
      }
      walk(app.project.rootItem);
      return JSON.stringify({ success: true, items: out });
    } catch (e) {
      return JSON.stringify({ success: false, error: e.toString() });
    }
  `);
  const map = new Map<string, string>();
  for (const item of result?.items ?? []) map.set(norm(item.path), String(item.id));
  return map;
}

/** Project item id for each path, importing the ones that are not in the project yet. */
export async function ensureProjectItems(ctx: ToolContext, paths: string[]): Promise<{ ids: Map<string, string> } | { error: string }> {
  const known = await projectItemIds(ctx);
  const ids = new Map<string, string>();
  for (const path of new Set(paths)) {
    let id = known.get(norm(path));
    if (!id) {
      const imported: any = await ctx.bridge.importMedia(path);
      if (!imported || imported.success === false || !imported.id) return { error: `Could not import ${path}: ${imported?.error ?? 'no id returned'}` };
      id = String(imported.id);
    }
    ids.set(path, id);
  }
  return { ids };
}

async function assembleRoughCut(
  ctx: ToolContext,
  args: {
    mediaPaths?: string[];
    folderPath?: string;
    recursive: boolean;
    targetSeconds: number;
    shotSeconds: number;
    maxPerFile: number;
    order: 'chronological' | 'score';
    sequenceId?: string;
    videoTrackIndex: number;
    startTime: number;
    linkAudio: boolean;
    overwrite: boolean;
    dryRun: boolean;
    backup: boolean;
  },
): Promise<any> {
  const before = await readSequence(ctx, args.sequenceId);
  if (isError(before)) return { success: false, error: before.error };
  const listed = await listFootage(args);
  if ('error' in listed) return { success: false, error: listed.error };

  const all = await scoreAll(listed.paths, args.shotSeconds, 'assemble_rough_cut');
  if ('failure' in all) return all.failure;
  const candidates: Candidate[] = all.scored.flatMap((f) =>
    bestWindows(f.windows, args.maxPerFile, args.shotSeconds / 2).map((w) => ({ mediaPath: f.mediaPath, sourceDuration: f.sourceDuration, start: w.start, end: w.end, score: w.score })),
  );
  const plan = planRoughCut(candidates, {
    targetSeconds: args.targetSeconds,
    shotSeconds: args.shotSeconds,
    frameDuration: before.frameDuration,
    maxPerFile: args.maxPerFile,
    order: args.order,
  });
  const summary = {
    sequenceName: before.sequenceName,
    targetSeconds: args.targetSeconds,
    totalSeconds: plan.totalSeconds,
    shortfallSeconds: plan.shortfallSeconds,
    shotCount: plan.shots.length,
    shots: plan.shots,
    ...(all.failed.length ? { skippedFiles: all.failed } : {}),
  };
  if (plan.shots.length === 0) return { success: false, error: 'No usable footage to build a cut from.', ...summary };

  const endsAt = args.startTime + plan.totalSeconds;
  const occupied = before.clips.filter((c) => c.trackType === 'video' && c.trackIndex === args.videoTrackIndex && c.end > args.startTime && c.start < endsAt);
  if (occupied.length > 0 && !args.overwrite) {
    return { success: false, error: `Video track ${args.videoTrackIndex + 1} already has ${occupied.length} clip(s) between ${args.startTime}s and ${endsAt}s. Placing would overwrite them. Choose another track or startTime, or pass overwrite=true.`, ...summary };
  }
  if (args.dryRun) return { success: true, dryRun: true, applied: false, ...summary, note: 'Dry run: nothing was changed.' };

  let backupPath: string | undefined;
  if (args.backup) {
    const backup = await backupProject(ctx);
    if ('error' in backup) return { success: false, error: `Backup failed, nothing was changed: ${backup.error}${BACKUP_FAILED_HINT}`, ...summary };
    backupPath = backup.path;
  }

  const items = await ensureProjectItems(ctx, plan.shots.map((x) => x.mediaPath));
  if ('error' in items) return { success: false, error: items.error, backupPath, ...summary };
  const ids = items.ids;

  const placed: any = await ctx.bridge.addToTimelineBatch(
    before.sequenceId,
    plan.shots.map((s) => ({
      projectItemId: ids.get(s.mediaPath)!,
      trackIndex: args.videoTrackIndex,
      time: Math.round((args.startTime + s.timelineStart) * 1000) / 1000,
      linkAudio: args.linkAudio,
      sourceInPoint: s.in,
      sourceOutPoint: s.out,
    })),
  );
  const failures = (placed?.results ?? []).filter((r: { success?: boolean }) => r.success === false);
  if (placed?.success === false || failures.length) {
    return { success: false, error: `${failures.length || 'Some'} shot(s) could not be placed.`, failures, backupPath, ...summary };
  }

  const after = await readSequence(ctx, before.sequenceId);
  if (isError(after)) return { success: false, error: `Shots were placed but the result could not be re-read: ${after.error}`, backupPath, ...summary };
  const placedEnd = Math.max(0, ...after.clips.filter((c) => c.trackType === 'video' && c.trackIndex === args.videoTrackIndex).map((c) => c.end));
  const verified = Math.abs(placedEnd - endsAt) <= before.frameDuration * (plan.shots.length + 1);
  return {
    success: true,
    dryRun: false,
    applied: true,
    verified,
    backupPath,
    ...summary,
    videoTrackEndsAt: Math.round(placedEnd * 1000) / 1000,
    ...(verified ? {} : { warning: `The video track ends at ${placedEnd}s but the cut should end at ${endsAt}s. Check for locked tracks or clips that were not placed.` }),
  };
}

// -------------------------------------------------------------- declarations

const sourceArgs = {
  mediaPaths: z.array(z.string()).optional().describe('Video files to choose from. Use this or folderPath.'),
  folderPath: z.string().optional().describe('Folder of video files to choose from. Use this or mediaPaths.'),
  recursive: z.boolean().default(false).describe('Include subfolders of folderPath (default false).'),
};

export const roughcutTools: ToolModule[] = [
  {
    name: 'score_clips',
    description:
      'Ranks the best stretches of each video file by exposure and sharpness, measured with ffmpeg on a small sampled copy of the frames (keyframes, or one frame per second for sparse footage). Returns per-file best windows with scores and flags such as dark, bright or soft. Read-only; results are cached on disk. Shake and motion are not measured. Requires ffmpeg.',
    inputSchema: z.object({
      ...sourceArgs,
      windowSeconds: z.number().positive().default(3).describe('Length of each scored stretch in seconds (default 3).'),
      topPerFile: z.number().int().min(1).default(3).describe('Best stretches reported per file (default 3).'),
    }),
    run: (ctx, args) => scoreClips(ctx, args),
  },
  {
    name: 'assemble_rough_cut',
    description:
      'Builds a rough cut of a target length from a folder of footage: scores every file (exposure and sharpness), takes the best stretches (each used once, at most maxPerFile per file), orders them chronologically by file name or by score, and places them back to back on a video track of the target sequence, ending within a frame of targetSeconds. Imports files that are not in the project yet. Refuses to overwrite existing clips on the track unless overwrite=true. Use dryRun=true to see the shots first. Requires ffmpeg.',
    inputSchema: z.object({
      ...sourceArgs,
      targetSeconds: z.number().positive().describe('Length of the cut in seconds.'),
      shotSeconds: z.number().positive().default(3).describe('Typical shot length in seconds; sets how many shots are used (default 3).'),
      maxPerFile: z.number().int().min(1).default(2).describe('Most shots taken from one file (default 2).'),
      order: z.enum(['chronological', 'score']).default('chronological').describe('Order shots by file name and time (default) or best first.'),
      sequenceId: z.string().optional().describe('Target sequence ID. Defaults to the active sequence, whose frame rate sets the frame grid.'),
      videoTrackIndex: z.number().int().min(0).default(0).describe('Zero-based video track to place on (default 0).'),
      startTime: z.number().min(0).default(0).describe('Timeline position in seconds where the cut starts (default 0).'),
      linkAudio: z.boolean().default(true).describe("Keep each clip's linked audio (default true). Set false for silent B-roll."),
      overwrite: z.boolean().default(false).describe('Allow placing over existing clips on the track (default false).'),
      dryRun: z.boolean().default(false).describe('When true, report the shots and change nothing.'),
      backup: z.boolean().default(true).describe('Save the project and copy it to a premiere-mcp-backups folder beside it before changing anything (default true). Ignored on a dry run.'),
    }),
    run: (ctx, args) => assembleRoughCut(ctx, args),
  },
];
