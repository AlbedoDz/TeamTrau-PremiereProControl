/**
 * Footage cleanup: media preflight, dead-segment detection, silence removal and
 * loudness normalisation.
 *
 * Premiere's scripting surface cannot read audio levels or pixels, so analysis
 * runs on the media file with ffmpeg/ffprobe (src/analysis). What to cut or
 * flag is decided by pure functions in src/analysis/cleanup.ts; the handlers
 * here gather inputs from Premiere, run the analysis, and apply the result.
 */
import { z } from 'zod';
import { access } from 'node:fs/promises';
import type { ToolContext, ToolModule } from '../context.js';
import { cached } from '../../analysis/cache.js';
import {
  ffmpegMissingResult,
  findFfTool,
  parseBlackIntervals,
  parseFreezeIntervals,
  parseIntegratedLoudness,
  parseSilenceIntervals,
  probeMedia,
  runFf,
  type Interval,
} from '../../analysis/ffmpeg.js';
import {
  liveSegments,
  loudnessGainDb,
  planSilenceCuts,
  preflightIssues,
  unionIntervals,
  type SequenceClip,
} from '../../analysis/cleanup.js';
import { adjustAudioLevels, resolveProjectItemMediaPath } from './audio.js';
import { razorTimelineAtTime } from './timeline.js';

interface SequenceSnapshot {
  sequenceId: string;
  sequenceName: string;
  frameDuration: number;
  endTime: number;
  clips: SequenceClip[];
}

const sequenceLookup = (sequenceId?: string): string =>
  sequenceId ? `__findSequence(${JSON.stringify(sequenceId)})` : 'app.project.activeSequence';

/** Read every clip of a sequence with the media file behind it. */
async function readSequence(ctx: ToolContext, sequenceId?: string): Promise<SequenceSnapshot | { error: string }> {
  const missing = sequenceId
    ? `"Sequence not found by id: " + ${JSON.stringify(sequenceId)}`
    : '"No active sequence"';
  const script = `
    try {
      var sequence = ${sequenceLookup(sequenceId)};
      if (!sequence) return JSON.stringify({ success: false, error: ${missing} });
      var clips = [];
      var endTime = 0;
      function collect(tracks, type) {
        for (var i = 0; i < tracks.numTracks; i++) {
          var track = tracks[i];
          for (var j = 0; j < track.clips.numItems; j++) {
            var clip = track.clips[j];
            var mediaPath = null;
            try { mediaPath = clip.projectItem ? clip.projectItem.getMediaPath() : null; } catch (e1) {}
            if (clip.end.seconds > endTime) endTime = clip.end.seconds;
            clips.push({
              id: clip.nodeId, trackType: type, trackIndex: i,
              start: clip.start.seconds, end: clip.end.seconds,
              inPoint: clip.inPoint.seconds, outPoint: clip.outPoint.seconds,
              mediaPath: mediaPath ? String(mediaPath) : null
            });
          }
        }
      }
      collect(sequence.videoTracks, "video");
      collect(sequence.audioTracks, "audio");
      var frameDuration = Number(sequence.timebase) / 254016000000.0;
      return JSON.stringify({
        success: true, sequenceId: sequence.sequenceID, sequenceName: sequence.name,
        frameDuration: frameDuration, endTime: endTime, clips: clips
      });
    } catch (e) {
      return JSON.stringify({ success: false, error: e.toString() });
    }
  `;
  const result = await ctx.bridge.executeScript(script);
  if (!result || result.success === false) return { error: result?.error || 'Could not read the sequence' };
  if (!(result.frameDuration > 0)) return { error: 'Could not determine the sequence frame rate' };
  return result as SequenceSnapshot;
}

const isError = (value: unknown): value is { error: string } =>
  typeof value === 'object' && value !== null && 'error' in value;

const uniquePaths = (clips: SequenceClip[], type?: 'audio' | 'video'): string[] => [
  ...new Set(clips.filter((c) => c.mediaPath && (!type || c.trackType === type)).map((c) => c.mediaPath!)),
];

async function resolveMediaPath(
  ctx: ToolContext,
  mediaPath?: string,
  projectItemId?: string,
): Promise<{ path?: string; error?: string }> {
  if (mediaPath) return { path: mediaPath };
  if (projectItemId) return resolveProjectItemMediaPath(ctx, projectItemId);
  return { error: 'Provide either mediaPath or projectItemId' };
}

// ---------------------------------------------------------------- preflight_media

async function preflightMedia(
  ctx: ToolContext,
  args: { mediaPaths?: string[]; sequenceId?: string; sequenceFps?: number; targetSampleRate?: number },
): Promise<any> {
  let paths = args.mediaPaths ?? [];
  let sequenceFps = args.sequenceFps;
  let sequenceName: string | undefined;
  if (paths.length === 0) {
    const snapshot = await readSequence(ctx, args.sequenceId);
    if (isError(snapshot)) return { success: false, error: snapshot.error };
    paths = uniquePaths(snapshot.clips);
    sequenceFps ??= 1 / snapshot.frameDuration;
    sequenceName = snapshot.sequenceName;
  }
  if (paths.length === 0) {
    return { success: false, error: 'No media files to check. Pass mediaPaths, or a sequence that contains clips.' };
  }

  const ffprobe = await findFfTool('ffprobe');
  if (!ffprobe) return ffmpegMissingResult('preflight_media');

  const files = [];
  for (const mediaPath of paths) {
    try {
      await access(mediaPath);
    } catch {
      files.push({ mediaPath, issues: [{ code: 'MEDIA_MISSING', severity: 'error', message: 'File does not exist or is not readable.' }] });
      continue;
    }
    try {
      const probe = await cached(mediaPath, 'probe', null, () => probeMedia(ffprobe, mediaPath));
      files.push({ mediaPath, issues: preflightIssues(probe, { sequenceFps, targetSampleRate: args.targetSampleRate }) });
    } catch (err) {
      files.push({ mediaPath, issues: [{ code: 'MEDIA_UNREADABLE', severity: 'error', message: err instanceof Error ? err.message : String(err) }] });
    }
  }
  const all = files.flatMap((f) => f.issues);
  return {
    success: true,
    sequenceName,
    checked: files.length,
    errors: all.filter((i) => i.severity === 'error').length,
    warnings: all.filter((i) => i.severity === 'warning').length,
    clean: all.length === 0,
    files,
  };
}

// ------------------------------------------------------------- find_dead_segments

const DEAD_KINDS = ['silence', 'black', 'freeze'] as const;
type DeadKind = (typeof DEAD_KINDS)[number];

async function findDeadSegments(
  ctx: ToolContext,
  args: {
    mediaPath?: string;
    projectItemId?: string;
    detect?: DeadKind[];
    silenceDb: number;
    minSilenceSeconds: number;
    minBlackSeconds: number;
    minFreezeSeconds: number;
  },
): Promise<any> {
  const resolved = await resolveMediaPath(ctx, args.mediaPath, args.projectItemId);
  if (!resolved.path) return { success: false, error: resolved.error };
  const mediaPath = resolved.path;
  const ffmpeg = await findFfTool('ffmpeg');
  const ffprobe = await findFfTool('ffprobe');
  if (!ffmpeg || !ffprobe) return ffmpegMissingResult('find_dead_segments');

  const kinds = new Set<DeadKind>(args.detect ?? DEAD_KINDS);
  let probe;
  try {
    probe = await cached(mediaPath, 'probe', null, () => probeMedia(ffprobe, mediaPath));
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), mediaPath };
  }
  const hasVideo = probe.streams.some((s) => s.type === 'video');
  const hasAudio = probe.streams.some((s) => s.type === 'audio');
  const runSilence = hasAudio && kinds.has('silence');
  const runBlack = hasVideo && kinds.has('black');
  const runFreeze = hasVideo && kinds.has('freeze');

  const ffArgs = ['-hide_banner', '-nostats', '-i', mediaPath];
  const vf: string[] = [];
  if (runBlack) vf.push(`blackdetect=d=${args.minBlackSeconds}:pix_th=0.10`);
  if (runFreeze) vf.push(`freezedetect=n=-60dB:d=${args.minFreezeSeconds}`);
  if (vf.length) ffArgs.push('-vf', vf.join(','));
  if (runSilence) ffArgs.push('-af', `silencedetect=noise=${args.silenceDb}dB:d=${args.minSilenceSeconds}`);
  if (!vf.length && !runSilence) {
    return { success: false, error: 'Nothing to detect: the requested detectors do not apply to the streams in this file.', mediaPath };
  }
  ffArgs.push('-f', 'null', '-');

  const { mediaPath: _m, projectItemId: _p, ...params } = args;
  let run;
  try {
    run = await cached(mediaPath, 'dead-segments', params, () => runFf(ffmpeg, ffArgs));
  } catch (err) {
    return { success: false, error: `Failed to run ffmpeg: ${err instanceof Error ? err.message : String(err)}`, mediaPath };
  }
  if (run.code !== 0) {
    return { success: false, error: `ffmpeg exited with code ${run.code}`, mediaPath, ffmpegStderr: run.stderr.slice(-1500) };
  }

  const found: Record<DeadKind, Interval[]> = {
    silence: runSilence ? parseSilenceIntervals(run.stderr) : [],
    black: runBlack ? parseBlackIntervals(run.stderr) : [],
    freeze: runFreeze ? parseFreezeIntervals(run.stderr) : [],
  };
  const total = probe.durationSeconds;
  const merged = unionIntervals([...found.silence, ...found.black, ...found.freeze]);
  return {
    success: true,
    mediaPath,
    durationSeconds: total,
    ...found,
    anyDeadSegments: merged,
    liveSegments: total === null ? undefined : liveSegments(merged, total),
    note: 'anyDeadSegments is the union of every detector, so it also covers a silent-but-moving or black-but-audible stretch. Detection only: nothing was changed.',
  };
}

// ---------------------------------------------------- remove_silence_from_sequence

/** Lift every clip inside [start, end] on all tracks except one, then ripple-delete that one so all tracks close the gap. */
async function rippleDeleteRange(
  ctx: ToolContext,
  sequenceId: string,
  start: number,
  end: number,
  tolerance: number,
): Promise<any> {
  const script = `
    try {
      var sequence = __findSequence(${JSON.stringify(sequenceId)});
      if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found" });
      var inside = [];
      function scan(tracks) {
        for (var i = 0; i < tracks.numTracks; i++) {
          for (var j = 0; j < tracks[i].clips.numItems; j++) {
            var clip = tracks[i].clips[j];
            if (clip.start.seconds >= ${start} - ${tolerance} && clip.end.seconds <= ${end} + ${tolerance}) inside.push(clip);
          }
        }
      }
      scan(sequence.videoTracks);
      scan(sequence.audioTracks);
      if (inside.length === 0) return JSON.stringify({ success: false, error: "No clips found inside the range after razoring; the razor may not have landed on the requested time." });
      for (var k = 0; k < inside.length - 1; k++) inside[k].remove(false, false);
      inside[inside.length - 1].remove(true, true);
      return JSON.stringify({ success: true, removedClips: inside.length });
    } catch (e) {
      return JSON.stringify({ success: false, error: e.toString() });
    }
  `;
  return ctx.bridge.executeScript(script);
}

async function removeSilenceFromSequence(
  ctx: ToolContext,
  args: {
    sequenceId?: string;
    noiseThresholdDb: number;
    minSilenceSeconds: number;
    paddingSeconds: number;
    audioTrackIndices?: number[];
    dryRun: boolean;
  },
): Promise<any> {
  const before = await readSequence(ctx, args.sequenceId);
  if (isError(before)) return { success: false, error: before.error };
  const audioPaths = uniquePaths(before.clips, 'audio');
  if (audioPaths.length === 0) return { success: false, error: 'The sequence has no audio clips with a media file to analyse.' };

  const ffmpeg = await findFfTool('ffmpeg');
  if (!ffmpeg) return ffmpegMissingResult('remove_silence_from_sequence');

  const silenceByMedia = new Map<string, Interval[]>();
  for (const mediaPath of audioPaths) {
    const params = { db: args.noiseThresholdDb, d: args.minSilenceSeconds };
    try {
      const run = await cached(mediaPath, 'silence', params, () =>
        runFf(ffmpeg, [
          '-hide_banner', '-nostats', '-i', mediaPath,
          '-af', `silencedetect=noise=${args.noiseThresholdDb}dB:d=${args.minSilenceSeconds}`,
          '-f', 'null', '-',
        ]),
      );
      if (run.code !== 0) return { success: false, error: `ffmpeg could not analyse ${mediaPath}`, ffmpegStderr: run.stderr.slice(-1000) };
      silenceByMedia.set(mediaPath, parseSilenceIntervals(run.stderr));
    } catch (err) {
      return { success: false, error: `Failed to run ffmpeg: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  const plan = planSilenceCuts(before.clips, silenceByMedia, {
    paddingSeconds: args.paddingSeconds,
    minCutSeconds: args.minSilenceSeconds / 2,
    frameDuration: before.frameDuration,
    audioTrackIndices: args.audioTrackIndices,
  });
  const removedSeconds = Math.round(plan.cuts.reduce((sum, c) => sum + c.duration, 0) * 1000) / 1000;
  const summary = {
    sequenceId: before.sequenceId,
    sequenceName: before.sequenceName,
    cuts: plan.cuts,
    cutCount: plan.cuts.length,
    removedSeconds,
    skippedClips: plan.skippedClips,
  };
  if (args.dryRun || plan.cuts.length === 0) {
    return {
      success: true,
      dryRun: args.dryRun,
      applied: false,
      ...summary,
      note: plan.cuts.length === 0 ? 'No silence long enough to cut.' : 'Dry run: nothing was changed. Run again with dryRun=false to apply.',
    };
  }

  // Back to front, so earlier timeline positions are unaffected by each ripple.
  const tolerance = before.frameDuration / 2;
  const applied: Interval[] = [];
  for (const cut of [...plan.cuts].reverse()) {
    for (const time of [cut.end, cut.start]) {
      const razor = await razorTimelineAtTime(ctx, before.sequenceId, time);
      if (razor?.success === false) {
        return { success: false, error: `Razor failed at ${time}s: ${razor.error}`, applied, ...summary };
      }
    }
    const removed = await rippleDeleteRange(ctx, before.sequenceId, cut.start, cut.end, tolerance);
    if (!removed || removed.success === false) {
      return { success: false, error: `Could not delete ${cut.start}s-${cut.end}s: ${removed?.error ?? 'no result'}`, applied, ...summary };
    }
    applied.push(cut);
  }

  const after = await readSequence(ctx, before.sequenceId);
  if (isError(after)) {
    return { success: false, error: `Cuts were applied but the result could not be re-read: ${after.error}`, applied, ...summary };
  }
  const actualRemoved = Math.round((before.endTime - after.endTime) * 1000) / 1000;
  const verified = Math.abs(actualRemoved - removedSeconds) <= before.frameDuration * (plan.cuts.length + 1);
  return {
    success: true,
    dryRun: false,
    applied: true,
    verified,
    ...summary,
    sequenceDurationBefore: before.endTime,
    sequenceDurationAfter: after.endTime,
    actualRemovedSeconds: actualRemoved,
    ...(verified
      ? {}
      : {
          warning: `The sequence shortened by ${actualRemoved}s but ${removedSeconds}s was planned. Tracks may be locked or sync lock off, leaving audio and video out of step. Use undo, unlock tracks, and retry.`,
        }),
  };
}

// ------------------------------------------------------------- normalize_loudness

async function normalizeLoudness(
  ctx: ToolContext,
  args: { sequenceId?: string; targetLufs: number; audioTrackIndices?: number[]; dryRun: boolean },
): Promise<any> {
  const snapshot = await readSequence(ctx, args.sequenceId);
  if (isError(snapshot)) return { success: false, error: snapshot.error };
  const clips = snapshot.clips.filter(
    (c) => c.trackType === 'audio' && c.mediaPath && (!args.audioTrackIndices || args.audioTrackIndices.includes(c.trackIndex)),
  );
  if (clips.length === 0) return { success: false, error: 'The sequence has no audio clips with a media file to measure.' };
  const ffmpeg = await findFfTool('ffmpeg');
  if (!ffmpeg) return ffmpegMissingResult('normalize_loudness');

  const results: Array<Record<string, unknown>> = [];
  for (const clip of clips) {
    const length = clip.outPoint - clip.inPoint;
    let measured: number | null;
    try {
      const run = await cached(clip.mediaPath!, 'loudness', { in: clip.inPoint, length }, () =>
        runFf(ffmpeg, [
          '-hide_banner', '-nostats', '-ss', String(clip.inPoint), '-t', String(length),
          '-i', clip.mediaPath!, '-vn', '-af', 'ebur128', '-f', 'null', '-',
        ]),
      );
      measured = run.code === 0 ? parseIntegratedLoudness(run.stderr) : null;
    } catch {
      measured = null;
    }
    // ebur128 reports -70 LUFS (its gate floor) for silence; there is nothing to normalise.
    if (measured === null || measured <= -69) {
      results.push({ clipId: clip.id, trackIndex: clip.trackIndex, measuredLufs: measured, skipped: 'no measurable loudness' });
      continue;
    }
    const gainDb = loudnessGainDb(measured, args.targetLufs);
    const entry: Record<string, unknown> = { clipId: clip.id, trackIndex: clip.trackIndex, measuredLufs: measured, gainDb };
    if (!args.dryRun) {
      const set = await adjustAudioLevels(ctx, clip.id, gainDb);
      entry.applied = set?.success !== false;
      if (set?.success === false) entry.error = set.error;
    }
    results.push(entry);
  }
  const failed = results.filter((r) => r.applied === false).length;
  return {
    success: failed === 0,
    dryRun: args.dryRun,
    targetLufs: args.targetLufs,
    sequenceName: snapshot.sequenceName,
    clips: results,
    note: "Gain replaces the clip's current Volume level. Loudness is measured on each clip's trimmed source range, before any other effect on the clip.",
  };
}

// ------------------------------------------------------------------- declarations

const sequenceIdArg = z.string().optional().describe('Sequence ID. Defaults to the active sequence.');
const trackArg = z
  .array(z.number().int().min(0))
  .optional()
  .describe('Audio track indices to consider. Defaults to all audio tracks.');

export const cleanupTools: ToolModule[] = [
  {
    name: 'preflight_media',
    description:
      'Checks media files with ffprobe before editing: missing or unreadable files, variable frame rate, frame-rate mismatch with the sequence, mono or multichannel audio, and sample-rate mismatch. Pass mediaPaths, or omit them to check every clip in a sequence. Read-only. Requires ffmpeg (ffprobe); if missing, the result has nextStep/installCommand.',
    inputSchema: z.object({
      mediaPaths: z.array(z.string()).optional().describe('Files to check. When omitted, every clip in the sequence is checked.'),
      sequenceId: sequenceIdArg,
      sequenceFps: z.number().positive().optional().describe('Frame rate to compare sources against. Defaults to the sequence frame rate when checking a sequence.'),
      targetSampleRate: z.number().int().positive().optional().describe('Expected audio sample rate in Hz, e.g. 48000. Omit to skip the check.'),
    }),
    run: (ctx, args) => preflightMedia(ctx, args),
  },
  {
    name: 'find_dead_segments',
    description:
      'Finds silent, black and frozen stretches in a media file with ffmpeg (silencedetect, blackdetect, freezedetect) and returns them with the complementary live segments. Detection only; use remove_silence_from_sequence to cut silence from a sequence. Requires ffmpeg.',
    inputSchema: z
      .object({
        mediaPath: z.string().optional().describe('Direct filesystem path to the media file'),
        projectItemId: z.string().optional().describe('Project item ID to resolve to a media path instead of mediaPath'),
        detect: z.array(z.enum(DEAD_KINDS)).optional().describe('Which detectors to run. Defaults to all three.'),
        silenceDb: z.number().max(0).default(-35).describe('Silence threshold in dBFS (default -35).'),
        minSilenceSeconds: z.number().positive().default(1).describe('Shortest silence to report (default 1).'),
        minBlackSeconds: z.number().positive().default(1).describe('Shortest black stretch to report (default 1).'),
        minFreezeSeconds: z.number().positive().default(2).describe('Shortest frozen-frame stretch to report (default 2).'),
      })
      .refine((d) => Boolean(d.mediaPath) || Boolean(d.projectItemId), { message: 'Provide either mediaPath or projectItemId' }),
    run: (ctx, args) => findDeadSegments(ctx, args),
  },
  {
    name: 'remove_silence_from_sequence',
    description:
      "Cuts silence out of a sequence and closes the gaps. Analyses each audio clip's media with ffmpeg, cuts only where every considered audio track is silent and at least one audio clip is present (video-only stretches are never cut), razors all tracks, then ripple-deletes back to front. Keeps paddingSeconds of silence at each side of a cut. Skips clips whose speed is not 100%. Verifies the new sequence length and reports verified=false with a warning if tracks drifted (locked tracks or sync lock off). Use dryRun=true first to see the cuts. Requires ffmpeg.",
    inputSchema: z.object({
      sequenceId: sequenceIdArg,
      noiseThresholdDb: z.number().max(0).default(-35).describe('Silence threshold in dBFS (default -35).'),
      minSilenceSeconds: z.number().positive().default(0.5).describe('Shortest silence to consider (default 0.5).'),
      paddingSeconds: z.number().min(0).default(0.1).describe('Silence kept on each side of a cut so speech is not clipped (default 0.1).'),
      audioTrackIndices: trackArg.describe('Audio tracks that decide what counts as sound, e.g. only the dialogue track so music does not keep silence alive. Defaults to all audio tracks.'),
      dryRun: z.boolean().default(false).describe('When true, report the planned cuts and change nothing.'),
    }),
    run: (ctx, args) => removeSilenceFromSequence(ctx, args),
  },
  {
    name: 'normalize_loudness',
    description:
      "Measures each audio clip's integrated loudness (LUFS, EBU R128, via ffmpeg) over its trimmed range and sets the clip Volume so it hits targetLufs. Replaces the clip's current Volume level. Gain is limited to -40..+15 dB. Use dryRun=true to see the measurements and gains. Requires ffmpeg.",
    inputSchema: z.object({
      sequenceId: sequenceIdArg,
      targetLufs: z.number().min(-60).max(0).default(-14).describe('Target integrated loudness in LUFS: -14 for social platforms, -16 for web dialogue, -23 for broadcast (default -14).'),
      audioTrackIndices: trackArg,
      dryRun: z.boolean().default(false).describe('When true, measure and report gains without changing any clip.'),
    }),
    run: (ctx, args) => normalizeLoudness(ctx, args),
  },
];
