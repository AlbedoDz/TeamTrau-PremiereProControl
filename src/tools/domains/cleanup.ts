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
import { access, copyFile, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { ToolContext, ToolModule } from '../context.js';
import { cached } from '../../analysis/cache.js';
import { detectScenes } from '../../analysis/scenes.js';
import { analysisConcurrency, mapLimit } from '../../analysis/pool.js';
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
  crossfadeFrames,
  loudnessGainDb,
  normalizeRanges,
  planSilenceCuts,
  preflightIssues,
  unionIntervals,
  type SequenceClip,
} from '../../analysis/cleanup.js';
import { adjustAudioLevels, resolveProjectItemMediaPath } from './audio.js';
import { transitionVerificationScript } from './effects.js';
import { razorTimelineAtTime } from './timeline.js';

export interface SequenceSnapshot {
  sequenceId: string;
  sequenceName: string;
  frameDuration: number;
  endTime: number;
  clips: SequenceClip[];
}

const sequenceLookup = (sequenceId?: string): string =>
  sequenceId ? `__findSequence(${JSON.stringify(sequenceId)})` : 'app.project.activeSequence';

/** Read every clip of a sequence with the media file behind it. */
export async function readSequence(ctx: ToolContext, sequenceId?: string): Promise<SequenceSnapshot | { error: string }> {
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

export const isError = (value: unknown): value is { error: string } =>
  typeof value === 'object' && value !== null && 'error' in value;

export const uniquePaths = (clips: SequenceClip[], type?: 'audio' | 'video'): string[] => [
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

  const files = await mapLimit(paths, analysisConcurrency(), async (mediaPath) => {
    try {
      await access(mediaPath);
    } catch {
      return { mediaPath, issues: [{ code: 'MEDIA_MISSING', severity: 'error', message: 'File does not exist or is not readable.' }] };
    }
    try {
      const probe = await cached(mediaPath, 'probe', null, () => probeMedia(ffprobe, mediaPath));
      return { mediaPath, issues: preflightIssues(probe, { sequenceFps, targetSampleRate: args.targetSampleRate }) };
    } catch (err) {
      return { mediaPath, issues: [{ code: 'MEDIA_UNREADABLE', severity: 'error', message: err instanceof Error ? err.message : String(err) }] };
    }
  });
  const all = files.flatMap((f) => f.issues);
  const withIssues = files.filter((f) => f.issues.length > 0);
  return {
    success: true,
    sequenceName,
    checked: files.length,
    cleanFiles: files.length - withIssues.length,
    errors: all.filter((i) => i.severity === 'error').length,
    warnings: all.filter((i) => i.severity === 'warning').length,
    clean: all.length === 0,
    files: withIssues,
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
      // Lift every clip in the range, then close the gap by moving every later clip on
      // every track back by the range's length. Rippling the last removed clip only
      // closed its own track: live on a linked video+audio sequence, a 4078 s recap cut
      // shortened by 86 s and left 700 s gaps. TrackItem.move shifts one clip only
      // (its linked partner stays put), so every track is moved explicitly.
      for (var k = 0; k < inside.length; k++) inside[k].remove(false, false);
      var gap = ${end} - ${start};
      var moved = 0;
      function shift(tracks) {
        for (var i = 0; i < tracks.numTracks; i++) {
          for (var j = 0; j < tracks[i].clips.numItems; j++) {
            var later = tracks[i].clips[j];
            if (later.start.seconds >= ${end} - ${tolerance}) { later.move(-gap); moved++; }
          }
        }
      }
      shift(sequence.videoTracks);
      shift(sequence.audioTracks);
      return JSON.stringify({ success: true, removedClips: inside.length, movedClips: moved });
    } catch (e) {
      return JSON.stringify({ success: false, error: e.toString() });
    }
  `;
  return ctx.bridge.executeScript(script);
}

/** Silent stretches of each file in source time, run in parallel and cached. */
export async function analyseSilence(
  ffmpeg: string,
  mediaPaths: string[],
  noiseDb: number,
  minSeconds: number,
): Promise<{ silenceByMedia: Map<string, Interval[]> } | { failure: Record<string, unknown> }> {
  const params = { db: noiseDb, d: minSeconds };
  const analysed = await mapLimit(mediaPaths, analysisConcurrency(), async (mediaPath) => {
    try {
      const run = await cached(mediaPath, 'silence', params, () =>
        runFf(ffmpeg, [
          '-hide_banner', '-nostats', '-i', mediaPath,
          '-af', `silencedetect=noise=${noiseDb}dB:d=${minSeconds}`,
          '-f', 'null', '-',
        ]),
      );
      if (run.code !== 0) return { mediaPath, failure: { success: false, error: `ffmpeg could not analyse ${mediaPath}`, ffmpegStderr: run.stderr.slice(-1000) } };
      return { mediaPath, intervals: parseSilenceIntervals(run.stderr) };
    } catch (err) {
      return { mediaPath, failure: { success: false, error: `Failed to run ffmpeg: ${err instanceof Error ? err.message : String(err)}` } };
    }
  });
  const failed = analysed.find((r) => r.failure);
  if (failed) return { failure: failed.failure! };
  return { silenceByMedia: new Map(analysed.map((r) => [r.mediaPath, r.intervals!])) };
}

/**
 * Saves the open project and copies the .prproj beside it, so a bulk edit can be
 * rolled back by opening the copy. Deliberately not saveAs: that would re-point the
 * open project at the copy and the user would keep editing the backup.
 */
export async function backupProject(ctx: ToolContext): Promise<{ path: string } | { error: string }> {
  const info: any = await ctx.bridge.executeScript(`
    try {
      var p = app.project;
      if (!p.path) return JSON.stringify({ success: false, error: 'The project has not been saved yet, so there is nothing to back up.' });
      p.save();
      return JSON.stringify({ success: true, path: String(p.path) });
    } catch (e) {
      return JSON.stringify({ success: false, error: e.toString() });
    }
  `);
  if (!info || info.success === false || !info.path) {
    return { error: info?.error ?? 'Could not read the project path.' };
  }
  const source = String(info.path);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const dir = join(dirname(source), 'premiere-mcp-backups');
  const target = join(dir, `${basename(source, extname(source))}-${stamp}${extname(source) || '.prproj'}`);
  try {
    await mkdir(dir, { recursive: true });
    await copyFile(source, target);
  } catch (err) {
    return { error: `Could not copy the project file: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { path: target };
}

export const BACKUP_FAILED_HINT = ' Fix this, or pass backup=false to edit without a backup.';

export interface RemoveRangesArgs {
  sequenceId?: string;
  ranges: Array<{ start: number; end: number }>;
  invert: boolean;
  crossfadeMs: number;
  mergeGapSec: number;
  minKeepSec: number;
  dryRun: boolean;
  backup: boolean;
}

export interface RemoveRangesResult {
  success: boolean;
  removed: Interval[];
  durationBefore: number;
  durationAfter?: number;
  crossfadeFrames: number;
  crossfadeMsActual: number;
  verified?: boolean;
  warning?: string;
  backupPath?: string | undefined;
  error?: string;
  dryRun?: boolean;
  applied?: boolean | Interval[];
  sequenceId?: string;
}

/**
 * Audio crossfade (Constant Power) at each new join, through the QE DOM. Mirrors the
 * proven add_transition call in effects.ts: the QE sequence is addressed by id, only
 * QE items of type "Clip" count (gaps and transitions are items too), the transition
 * goes on the START of the clip that begins at the join, and a placement counts only
 * when the clip's transition state shows it. Best effort: the caller only warns.
 */
async function addAudioCrossfades(ctx: ToolContext, sequenceId: string, joins: number[], frames: number, tolerance: number): Promise<any> {
  const script = `
    try {
      app.enableQE();
      var sequence = __findSequence(${JSON.stringify(sequenceId)});
      if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found" });
      var qeSeq = __qeSequenceFor(sequence);
      if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address the sequence through the QE API." });
      var transition = __findQeNamed("audioTransition", "Constant Power");
      if (!transition) return JSON.stringify({ success: false, error: "Audio transition 'Constant Power' not found" });
      ${transitionVerificationScript()}
      function __clipStartingAt(qeTrack, at) {
        for (var i = 0; i < qeTrack.numItems; i++) {
          var item = qeTrack.getItemAt(i);
          if (!item || String(item.type) !== "Clip") continue;
          var secs = NaN;
          try { secs = Number(item.start.secs); } catch (eSecs) {}
          if (isNaN(secs)) {
            try { secs = Number(item.start.ticks) / 254016000000; } catch (eTicks) {}
          }
          if (!isNaN(secs) && Math.abs(secs - at) <= ${tolerance}) return item;
        }
        return null;
      }
      // Live Premiere 25.6: the QE transition state does not reflect a newly added
      // audio transition, while the DOM track's transitions collection does. Count
      // either signal as proof of placement.
      function __domTransitionCount(trackIndex) {
        try { return Number(sequence.audioTracks[trackIndex].transitions.numItems) || 0; } catch (eDom) { return -1; }
      }
      var joins = ${JSON.stringify(joins)};
      var placed = 0, attempted = 0, firstError = "", joinsPlaced = 0;
      for (var k = 0; k < joins.length; k++) {
        var joinHit = false;
        for (var t = 0; t < qeSeq.numAudioTracks; t++) {
          var qeTrack = qeSeq.getAudioTrackAt(t);
          var qeClip = __clipStartingAt(qeTrack, joins[k]);
          if (!qeClip) continue;
          attempted++;
          try {
            var before = __readQeTransitionState(qeClip);
            var domBefore = __domTransitionCount(t);
            // The second argument is "add at start": verified live on Premiere 25.6.3, where
            // true places the transition at this clip's head (the join) and false at its tail.
            qeClip.addTransition(transition, true, ${JSON.stringify(String(frames))}, "0", 0.5, true, true);
            try { if (typeof $ !== "undefined" && $.sleep) $.sleep(150); } catch (eWait) {}
            var after = __readQeTransitionState(__clipStartingAt(qeTrack, joins[k]));
            var domAfter = __domTransitionCount(t);
            if ((domBefore >= 0 && domAfter > domBefore) || __transitionWasVerified(before, after)) { placed++; joinHit = true; }
          } catch (e1) {
            if (!firstError) firstError = e1.toString();
          }
        }
        if (joinHit) joinsPlaced++;
      }
      return JSON.stringify({ success: true, joins: joins.length, joinsPlaced: joinsPlaced, placed: placed, attempted: attempted, error: firstError });
    } catch (e) {
      return JSON.stringify({ success: false, error: e.toString() });
    }
  `;
  return ctx.bridge.executeScript(script);
}

/**
 * The single timeline-cutting core: razors every range edge and ripple-deletes the
 * ranges back to front, re-reads the sequence to verify, then puts a short audio
 * crossfade on each new join. Ranges are cuts, or with `invert` the stretches to keep.
 */
export async function removeRanges(ctx: ToolContext, args: RemoveRangesArgs, snapshot?: SequenceSnapshot): Promise<RemoveRangesResult> {
  const before = snapshot ?? (await readSequence(ctx, args.sequenceId));
  if (isError(before)) return { success: false, error: before.error, removed: [], durationBefore: 0, crossfadeFrames: 0, crossfadeMsActual: 0 };

  const fd = before.frameDuration;
  const frames = crossfadeFrames(args.crossfadeMs, fd);
  const crossfadeMsActual = Math.round(frames * fd * 1000 * 1000) / 1000;
  const base = { durationBefore: before.endTime, crossfadeFrames: frames, crossfadeMsActual, sequenceId: before.sequenceId };
  const cuts = normalizeRanges(
    args.ranges.map((r) => ({ start: r.start, end: r.end, duration: r.end - r.start })),
    { total: before.endTime, frameDuration: fd, mergeGapSec: args.mergeGapSec, minKeepSec: args.minKeepSec, invert: args.invert },
  );
  if (args.dryRun || cuts.length === 0) {
    return { success: true, dryRun: args.dryRun, applied: false, removed: cuts, ...base };
  }

  let backupPath: string | undefined;
  if (args.backup) {
    const backup = await backupProject(ctx);
    if ('error' in backup) {
      return { success: false, error: `Backup failed, nothing was changed: ${backup.error}${BACKUP_FAILED_HINT}`, removed: cuts, ...base };
    }
    backupPath = backup.path;
  }

  // Back to front, so earlier timeline positions are unaffected by each ripple.
  const tolerance = fd / 2;
  const applied: Interval[] = [];
  for (const cut of [...cuts].reverse()) {
    for (const time of [cut.end, cut.start]) {
      const razor = await razorTimelineAtTime(ctx, before.sequenceId, time);
      if (razor?.success === false) {
        return { success: false, error: `Razor failed at ${time}s: ${razor.error}`, applied, removed: cuts, backupPath, ...base };
      }
    }
    const deleted = await rippleDeleteRange(ctx, before.sequenceId, cut.start, cut.end, tolerance);
    if (!deleted || deleted.success === false) {
      return { success: false, error: `Could not delete ${cut.start}s-${cut.end}s: ${deleted?.error ?? 'no result'}`, applied, removed: cuts, backupPath, ...base };
    }
    applied.push(cut);
  }

  const after = await readSequence(ctx, before.sequenceId);
  if (isError(after)) {
    return { success: false, error: `Cuts were applied but the result could not be re-read: ${after.error}`, applied, removed: cuts, backupPath, ...base };
  }
  const plannedSeconds = Math.round(cuts.reduce((sum, c) => sum + c.duration, 0) * 1000) / 1000;
  const actualRemoved = Math.round((before.endTime - after.endTime) * 1000) / 1000;
  const verified = Math.abs(actualRemoved - plannedSeconds) <= fd * (cuts.length + 1);
  const warnings: string[] = [];
  if (!verified) {
    warnings.push(`The sequence shortened by ${actualRemoved}s but ${plannedSeconds}s was planned. Tracks may be locked or sync lock off, leaving audio and video out of step. Use undo, unlock tracks, and retry.`);
  } else if (frames > 0) {
    // Joins on the shortened timeline; a cut at the very start or end leaves no join.
    const joins: number[] = [];
    let removedSoFar = 0;
    for (const cut of cuts) {
      const at = Math.round((cut.start - removedSoFar) * 1000) / 1000;
      removedSoFar += cut.duration;
      if (cut.start > 0 && cut.end < before.endTime - 1e-6) joins.push(at);
    }
    if (joins.length > 0) {
      try {
        const fade = await addAudioCrossfades(ctx, before.sequenceId, joins, frames, tolerance);
        if (!fade || fade.success === false) {
          warnings.push(`Audio crossfade could not be added: ${fade?.error ?? 'no result'}. The cuts themselves are fine.`);
        } else if (!(fade.joinsPlaced >= joins.length)) {
          warnings.push(`Only ${fade.joinsPlaced ?? 0} of ${joins.length} audio crossfades were placed and verified${fade.error ? ` (${fade.error})` : ''}. The cuts themselves are fine.`);
        }
      } catch (err) {
        warnings.push(`Audio crossfade could not be added: ${err instanceof Error ? err.message : String(err)}. The cuts themselves are fine.`);
      }
    }
  }
  return {
    success: true,
    dryRun: false,
    applied: true,
    verified,
    backupPath,
    removed: cuts,
    ...base,
    durationAfter: after.endTime,
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
  };
}

async function removeSilenceFromSequence(
  ctx: ToolContext,
  args: {
    sequenceId?: string;
    noiseThresholdDb: number;
    minSilenceSeconds: number;
    paddingSeconds: number;
    audioTrackIndices?: number[];
    crossfadeMs: number;
    dryRun: boolean;
    backup: boolean;
  },
): Promise<any> {
  const before = await readSequence(ctx, args.sequenceId);
  if (isError(before)) return { success: false, error: before.error };
  const audioPaths = uniquePaths(before.clips, 'audio');
  if (audioPaths.length === 0) return { success: false, error: 'The sequence has no audio clips with a media file to analyse.' };

  const ffmpeg = await findFfTool('ffmpeg');
  if (!ffmpeg) return ffmpegMissingResult('remove_silence_from_sequence');

  const analysed = await analyseSilence(ffmpeg, audioPaths, args.noiseThresholdDb, args.minSilenceSeconds);
  if ('failure' in analysed) return analysed.failure;
  const silenceByMedia = analysed.silenceByMedia;

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
      note: plan.cuts.length === 0 ? `No silence long enough to cut at ${args.noiseThresholdDb} dB. A loud or noisy recording keeps its pauses above the threshold: try a higher noiseThresholdDb such as -30 or -25 with dryRun=true.` : 'Dry run: nothing was changed. Run again with dryRun=false to apply.',
    };
  }

  // The plan is already padded and on the frame grid, so it goes in as-is: no merging, no sliver rule.
  const result = await removeRanges(ctx, {
    sequenceId: before.sequenceId,
    ranges: plan.cuts,
    invert: false,
    crossfadeMs: args.crossfadeMs,
    mergeGapSec: 0,
    minKeepSec: 0,
    dryRun: false,
    backup: args.backup,
  }, before);
  if (!result.success) {
    const { removed: _removed, durationBefore: _before, ...failure } = result;
    return { ...failure, ...summary, applied: Array.isArray(result.applied) ? result.applied : [] };
  }
  const actualRemoved = Math.round((before.endTime - (result.durationAfter ?? before.endTime)) * 1000) / 1000;
  return {
    success: true,
    dryRun: false,
    applied: true,
    verified: result.verified,
    backupPath: result.backupPath,
    ...summary,
    sequenceDurationBefore: before.endTime,
    sequenceDurationAfter: result.durationAfter,
    actualRemovedSeconds: actualRemoved,
    crossfadeFrames: result.crossfadeFrames,
    crossfadeMsActual: result.crossfadeMsActual,
    ...(result.warning ? { warning: result.warning } : {}),
  };
}

// ------------------------------------------------------------- normalize_loudness

export async function normalizeLoudness(
  ctx: ToolContext,
  args: { sequenceId?: string; targetLufs: number; audioTrackIndices?: number[]; dryRun: boolean; backup: boolean },
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
  let backupPath: string | undefined;
  let backedUp = args.dryRun || !args.backup;
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
      if (!backedUp) {
        // Taken lazily so a sequence with nothing to change is never saved or copied.
        const backup = await backupProject(ctx);
        if ('error' in backup) return { success: false, error: `Backup failed, nothing was changed: ${backup.error}${BACKUP_FAILED_HINT}` };
        backupPath = backup.path;
        backedUp = true;
      }
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
    backupPath,
    clips: results,
    note: "Gain replaces the clip's current Volume level. Loudness is measured on each clip's trimmed source range, before any other effect on the clip.",
  };
}

// ------------------------------------------------------------------- declarations

const sequenceIdArg = z.string().optional().describe('Sequence ID. Defaults to the active sequence.');
const backupArg = z
  .boolean()
  .default(true)
  .describe('Save the project and copy it to a premiere-mcp-backups folder beside it before changing anything (default true). Ignored on a dry run. Set false to skip.');
const crossfadeArg = z
  .number()
  .min(0)
  .max(1000)
  .default(30)
  .describe('Constant Power audio crossfade at each new join, in ms (default 30; 0 turns it off). Premiere cannot make one shorter than a frame, so the real length is max(crossfadeMs, 1 frame) rounded to frames.');

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
      crossfadeMs: crossfadeArg,
      dryRun: z.boolean().default(false).describe('When true, report the planned cuts and change nothing.'),
      backup: backupArg,
    }),
    run: (ctx, args) => removeSilenceFromSequence(ctx, args),
  },
  {
    name: 'remove_ranges',
    description:
      "Cuts the given time ranges (sequence seconds) out of a sequence on all tracks and closes the gaps: razors both edges, ripple-deletes back to front, re-reads the sequence and reports verified=false with a warning if tracks drifted (locked tracks or sync lock off). With invert=true the ranges are the parts to KEEP and everything else is removed. Ranges are sorted and merged when closer than mergeGapSec, and kept stretches shorter than minKeepSec are removed too. Puts a Constant Power audio crossfade (crossfadeMs, at least one frame) on each join; a crossfade failure only adds a warning. Use dryRun=true to see the removed ranges first.",
    inputSchema: z.object({
      sequenceId: sequenceIdArg,
      ranges: z.array(z.object({ start: z.number().min(0), end: z.number().min(0) })).min(1).describe('Time ranges in sequence seconds.'),
      invert: z.boolean().default(false).describe('When true, ranges are the parts to keep and the rest is removed.'),
      crossfadeMs: crossfadeArg,
      mergeGapSec: z.number().min(0).default(0.4).describe('Cuts closer together than this are merged (default 0.4).'),
      minKeepSec: z.number().min(0).default(0.4).describe('A kept stretch shorter than this is removed too, so no sliver is left (default 0.4).'),
      dryRun: z.boolean().default(false).describe('When true, report the ranges that would be removed and change nothing.'),
      backup: backupArg,
    }),
    run: (ctx, args) => removeRanges(ctx, args),
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
      backup: backupArg,
    }),
    run: (ctx, args) => normalizeLoudness(ctx, args),
  },
  {
    name: 'detect_scenes',
    description:
      'Finds shot boundaries in a video file with ffmpeg (scene-change score) and returns the shots as contiguous start/end seconds plus the raw cut times. A shot shorter than minShotSec is merged into the previous one. Detection only: nothing is changed. Requires ffmpeg.',
    inputSchema: z
      .object({
        mediaPath: z.string().optional().describe('Direct filesystem path to the media file'),
        projectItemId: z.string().optional().describe('Project item ID to resolve to a media path instead of mediaPath'),
        threshold: z.number().min(0).max(1).default(0.3).describe('Scene-change score above which a frame starts a new shot (default 0.3; lower finds more cuts).'),
        minShotSec: z.number().min(0).default(0.5).describe('Shortest shot to keep; shorter ones are merged into the previous shot (default 0.5).'),
      })
      .refine((d) => Boolean(d.mediaPath) || Boolean(d.projectItemId), { message: 'Provide either mediaPath or projectItemId' }),
    run: async (ctx, args) => {
      const resolved = await resolveMediaPath(ctx, args.mediaPath, args.projectItemId);
      if (!resolved.path) return { success: false, error: resolved.error };
      const result = await detectScenes(resolved.path, { threshold: args.threshold, minShotSec: args.minShotSec });
      if ('failure' in result) return result.failure;
      return { success: true, mediaPath: resolved.path, shotCount: result.shots.length, ...result };
    },
  },
];
