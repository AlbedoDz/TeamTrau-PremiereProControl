/**
 * Editing helpers that decide from the timeline and the audio, then apply through
 * tools Premiere already supports: auto_duck_music, qa_sequence,
 * apply_dialogue_chain and auto_punch_in. Decisions live in src/analysis/editing.ts.
 */
import { z } from 'zod';
import { access } from 'node:fs/promises';
import type { ToolContext, ToolModule } from '../context.js';
import { analysisConcurrency, mapLimit } from '../../analysis/pool.js';
import { ffmpegMissingResult, findFfTool } from '../../analysis/ffmpeg.js';
import {
  duckingWindowsFor,
  punchInTargets,
  speechOnTimeline,
  structuralFindings,
  type QaFinding,
} from '../../analysis/editing.js';
import { analyseSilence, backupProject, BACKUP_FAILED_HINT, isError, normalizeLoudness, readSequence, uniquePaths } from './cleanup.js';
import { applyAudioEffect, setupDucking } from './audio.js';

const sequenceIdArg = z.string().optional().describe('Sequence ID. Defaults to the active sequence.');
const trackIndices = (what: string) => z.array(z.number().int().min(0)).min(1).describe(`${what} Zero-based audio track indices, e.g. [0].`);
const backupArg = z
  .boolean()
  .default(true)
  .describe('Save the project and copy it to a premiere-mcp-backups folder beside it before changing anything (default true). Ignored on a dry run.');

/** Takes the project backup, or returns the failure result to hand straight back. */
async function ensureBackup(ctx: ToolContext, wanted: boolean): Promise<{ path?: string } | { failure: Record<string, unknown> }> {
  if (!wanted) return {};
  const backup = await backupProject(ctx);
  if ('error' in backup) return { failure: { success: false, error: `Backup failed, nothing was changed: ${backup.error}${BACKUP_FAILED_HINT}` } };
  return { path: backup.path };
}

// ------------------------------------------------------------- auto_duck_music

async function autoDuckMusic(
  ctx: ToolContext,
  args: {
    sequenceId?: string;
    dialogueTrackIndices: number[];
    musicTrackIndices: number[];
    baseDb: number;
    duckedDb: number;
    fadeSeconds: number;
    silenceDb: number;
    minPauseSeconds: number;
    mergeGapSeconds: number;
    minSpeechSeconds: number;
    dryRun: boolean;
    backup: boolean;
  },
): Promise<any> {
  const snapshot = await readSequence(ctx, args.sequenceId);
  if (isError(snapshot)) return { success: false, error: snapshot.error };
  const dialogue = snapshot.clips.filter((c) => c.trackType === 'audio' && args.dialogueTrackIndices.includes(c.trackIndex));
  const music = snapshot.clips.filter((c) => c.trackType === 'audio' && args.musicTrackIndices.includes(c.trackIndex));
  if (dialogue.length === 0) return { success: false, error: `No audio clips on dialogue track(s) ${args.dialogueTrackIndices.join(', ')}.` };
  if (music.length === 0) return { success: false, error: `No audio clips on music track(s) ${args.musicTrackIndices.join(', ')}.` };
  const overlap = args.dialogueTrackIndices.filter((i) => args.musicTrackIndices.includes(i));
  if (overlap.length) return { success: false, error: `Track(s) ${overlap.join(', ')} are listed as both dialogue and music.` };

  const ffmpeg = await findFfTool('ffmpeg');
  if (!ffmpeg) return ffmpegMissingResult('auto_duck_music');
  const analysed = await analyseSilence(ffmpeg, uniquePaths(dialogue), args.silenceDb, args.minPauseSeconds);
  if ('failure' in analysed) return analysed.failure;

  const { speech, assumedSpeech } = speechOnTimeline(dialogue, analysed.silenceByMedia, {
    mergeGapSeconds: args.mergeGapSeconds,
    minSpeechSeconds: args.minSpeechSeconds,
  });
  const plan = music.map((clip) => ({ clip, windows: duckingWindowsFor(clip, speech, args.duckedDb) }));
  const summary = {
    sequenceName: snapshot.sequenceName,
    speechRanges: speech.length,
    speechSeconds: Math.round(speech.reduce((sum, s) => sum + s.duration, 0) * 1000) / 1000,
    assumedSpeechClips: assumedSpeech,
    clips: plan.map(({ clip, windows }) => ({ clipId: clip.id, trackIndex: clip.trackIndex, duckingWindows: windows.length, windows })),
  };
  if (args.dryRun) return { success: true, dryRun: true, applied: false, ...summary, note: 'Dry run: nothing was changed.' };
  if (speech.length === 0) return { success: true, dryRun: false, applied: false, ...summary, note: 'No speech found on the dialogue tracks, so the music was left alone.' };

  const backup = await ensureBackup(ctx, args.backup);
  if ('failure' in backup) return { ...backup.failure, ...summary };

  const results: Array<Record<string, unknown>> = [];
  for (const { clip, windows } of plan) {
    const done: any = await setupDucking(ctx, clip.id, args.baseDb, windows, args.fadeSeconds, clip.inPoint, clip.outPoint);
    results.push({ clipId: clip.id, applied: done?.success !== false, ...(done?.success === false ? { error: done.error } : { keyframes: done?.keyframes_emitted }) });
  }
  const failed = results.filter((r) => r.applied === false).length;
  return { success: failed === 0, dryRun: false, applied: true, backupPath: backup.path, baseDb: args.baseDb, duckedDb: args.duckedDb, ...summary, results };
}

// ---------------------------------------------------------------- qa_sequence

async function qaSequence(
  ctx: ToolContext,
  args: { sequenceId?: string; minClipFrames: number; checkMedia: boolean },
): Promise<any> {
  const snapshot = await readSequence(ctx, args.sequenceId);
  if (isError(snapshot)) return { success: false, error: snapshot.error };
  const findings: QaFinding[] = structuralFindings(snapshot.clips, {
    frameDuration: snapshot.frameDuration,
    minClipFrames: args.minClipFrames,
  });

  if (args.checkMedia) {
    const paths = uniquePaths(snapshot.clips);
    const missing = (
      await mapLimit(paths, analysisConcurrency(), async (p) => {
        try {
          await access(p);
          return null;
        } catch {
          return p;
        }
      })
    ).filter((p): p is string => p !== null);
    for (const path of missing) {
      for (const clip of snapshot.clips.filter((c) => c.mediaPath === path)) {
        findings.push({
          code: 'MEDIA_MISSING', severity: 'error', trackType: clip.trackType, trackIndex: clip.trackIndex, clipId: clip.id,
          at: Math.round(clip.start * 1000) / 1000, message: `Media file is missing: ${path}`,
        });
      }
    }
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;
  return {
    success: true,
    sequenceName: snapshot.sequenceName,
    clipCount: snapshot.clips.length,
    durationSeconds: Math.round(snapshot.endTime * 1000) / 1000,
    errors,
    warnings,
    clean: findings.length === 0,
    findings,
  };
}

// ------------------------------------------------------- apply_dialogue_chain

async function applyDialogueChain(
  ctx: ToolContext,
  args: {
    sequenceId?: string;
    dialogueTrackIndices: number[];
    effects: string[];
    normalize: boolean;
    targetLufs: number;
    dryRun: boolean;
    backup: boolean;
  },
): Promise<any> {
  const snapshot = await readSequence(ctx, args.sequenceId);
  if (isError(snapshot)) return { success: false, error: snapshot.error };
  const clips = snapshot.clips.filter((c) => c.trackType === 'audio' && args.dialogueTrackIndices.includes(c.trackIndex));
  if (clips.length === 0) return { success: false, error: `No audio clips on dialogue track(s) ${args.dialogueTrackIndices.join(', ')}.` };
  const summary = { sequenceName: snapshot.sequenceName, clipCount: clips.length, effects: args.effects, normalize: args.normalize ? args.targetLufs : false };
  if (args.dryRun) return { success: true, dryRun: true, applied: false, ...summary, clipIds: clips.map((c) => c.id), note: 'Dry run: nothing was changed.' };

  const backup = await ensureBackup(ctx, args.backup);
  if ('failure' in backup) return { ...backup.failure, ...summary };

  const results: Array<Record<string, unknown>> = [];
  for (const clip of clips) {
    const applied: string[] = [];
    const failed: Array<{ effect: string; error: string }> = [];
    for (const effect of args.effects) {
      const r: any = await applyAudioEffect(ctx, clip.id, effect);
      if (r?.success === false) failed.push({ effect, error: String(r.error ?? 'unknown error') });
      else applied.push(effect);
    }
    results.push({ clipId: clip.id, applied, failed });
  }

  let loudness: unknown;
  if (args.normalize) {
    loudness = await normalizeLoudness(ctx, {
      ...(args.sequenceId ? { sequenceId: args.sequenceId } : {}),
      targetLufs: args.targetLufs,
      audioTrackIndices: args.dialogueTrackIndices,
      dryRun: false,
      backup: false,
    });
  }
  const failures = results.reduce((n, r) => n + (r.failed as unknown[]).length, 0);
  return {
    success: failures === 0 && (loudness === undefined || (loudness as { success?: boolean }).success !== false),
    dryRun: false,
    applied: true,
    backupPath: backup.path,
    ...summary,
    results,
    loudness,
    ...(failures ? { note: 'Some effects were not applied. Effect names follow the Premiere UI language; pass the names your install shows via `effects`.' } : {}),
  };
}

// ----------------------------------------------------------- auto_punch_in

async function setStaticScale(ctx: ToolContext, clipId: string, scale: number): Promise<any> {
  return ctx.bridge.executeScript(`
    try {
      var info = __findClip(${JSON.stringify(clipId)});
      if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
      var resolved = __resolveClipProperty(info.clip, "Motion", "Scale");
      if (!resolved.ok) return JSON.stringify({ success: false, error: resolved.error });
      resolved.property.setValue(${scale}, true);
      return JSON.stringify({ success: true });
    } catch (e) {
      return JSON.stringify({ success: false, error: e.toString() });
    }
  `);
}

async function autoPunchIn(
  ctx: ToolContext,
  args: {
    sequenceId?: string;
    videoTrackIndex: number;
    punchScale: number;
    everyNth: number;
    skip: number;
    minClipSeconds: number;
    resetOthers: boolean;
    dryRun: boolean;
    backup: boolean;
  },
): Promise<any> {
  const snapshot = await readSequence(ctx, args.sequenceId);
  if (isError(snapshot)) return { success: false, error: snapshot.error };
  const onTrack = snapshot.clips.filter((c) => c.trackType === 'video' && c.trackIndex === args.videoTrackIndex);
  if (onTrack.length === 0) return { success: false, error: `No video clips on track ${args.videoTrackIndex}.` };

  const targets = punchInTargets(snapshot.clips, args.videoTrackIndex, args);
  const others = args.resetOthers ? onTrack.filter((c) => !targets.includes(c.id)).map((c) => c.id) : [];
  const summary = { sequenceName: snapshot.sequenceName, videoTrackIndex: args.videoTrackIndex, punchScale: args.punchScale, punchedClips: targets, resetClips: others };
  if (args.dryRun) return { success: true, dryRun: true, applied: false, ...summary, note: 'Dry run: nothing was changed.' };

  const backup = await ensureBackup(ctx, args.backup);
  if ('failure' in backup) return { ...backup.failure, ...summary };

  const errors: Array<{ clipId: string; error: string }> = [];
  for (const [ids, scale] of [[targets, args.punchScale], [others, 100]] as const) {
    for (const clipId of ids) {
      const r = await setStaticScale(ctx, clipId, scale);
      if (r?.success === false) errors.push({ clipId, error: String(r.error ?? 'unknown error') });
    }
  }
  return { success: errors.length === 0, dryRun: false, applied: true, backupPath: backup.path, ...summary, ...(errors.length ? { errors } : {}) };
}

// -------------------------------------------------------------- declarations

export const editingTools: ToolModule[] = [
  {
    name: 'auto_duck_music',
    description:
      'Finds where dialogue is spoken (ffmpeg silencedetect on the dialogue tracks) and lowers the music clips during it with volume keyframes, then lets the music return. Name the dialogue and music audio tracks explicitly. Phrases closer than mergeGapSeconds are one phrase so the music does not pump between words. Use dryRun=true to see the ducking windows. Replaces keyframes written by earlier ducking. Requires ffmpeg.',
    inputSchema: z.object({
      sequenceId: sequenceIdArg,
      dialogueTrackIndices: trackIndices('Audio tracks that hold speech.'),
      musicTrackIndices: trackIndices('Audio tracks that hold music.'),
      baseDb: z.number().max(15).default(-12).describe('Music level between phrases in dB on the Effects Controls scale (default -12).'),
      duckedDb: z.number().max(15).default(-24).describe('Music level under speech in dB (default -24).'),
      fadeSeconds: z.number().min(0).default(0.3).describe('Ramp time into and out of each duck (default 0.3).'),
      silenceDb: z.number().max(0).default(-40).describe('Dialogue quieter than this counts as a pause (default -40 dBFS).'),
      minPauseSeconds: z.number().positive().default(0.3).describe('Shortest pause that counts as silence (default 0.3).'),
      mergeGapSeconds: z.number().min(0).default(0.6).describe('Speech separated by less than this is treated as one phrase (default 0.6).'),
      minSpeechSeconds: z.number().min(0).default(0.3).describe('Speech shorter than this is ignored (default 0.3).'),
      dryRun: z.boolean().default(false).describe('When true, report the ducking windows and change nothing.'),
      backup: backupArg,
    }),
    run: (ctx, args) => autoDuckMusic(ctx, args),
  },
  {
    name: 'qa_sequence',
    description:
      'Read-only quality check of a sequence before export: flash frames (very short video clips), gaps and overlaps on every track, and missing media files. Returns findings with timeline positions. Complements validate_project_for_export, which checks project settings.',
    inputSchema: z.object({
      sequenceId: sequenceIdArg,
      minClipFrames: z.number().int().min(1).default(6).describe('Video clips shorter than this many frames are flagged as flash frames (default 6).'),
      checkMedia: z.boolean().default(true).describe('Also check that every media file still exists (default true).'),
    }),
    run: (ctx, args) => qaSequence(ctx, args),
  },
  {
    name: 'apply_dialogue_chain',
    description:
      'Applies a dialogue processing chain to every clip on the named audio tracks (default DeNoise then Dynamics), then normalises their loudness to targetLufs. Each effect is applied with apply_audio_effect at its default settings; effect names follow the Premiere UI language, so pass your own via `effects` if the defaults are not found. Use dryRun=true to see what would run. Requires ffmpeg for the loudness step.',
    inputSchema: z.object({
      sequenceId: sequenceIdArg,
      dialogueTrackIndices: trackIndices('Audio tracks that hold speech.'),
      effects: z.array(z.string()).min(1).default(['DeNoise', 'Dynamics']).describe('Audio effect names to apply in order (default DeNoise, Dynamics).'),
      normalize: z.boolean().default(true).describe('Normalise loudness after the effects (default true).'),
      targetLufs: z.number().min(-60).max(0).default(-16).describe('Target integrated loudness when normalising (default -16, web dialogue).'),
      dryRun: z.boolean().default(false).describe('When true, report the plan and change nothing.'),
      backup: backupArg,
    }),
    run: (ctx, args) => applyDialogueChain(ctx, args),
  },
  {
    name: 'auto_punch_in',
    description:
      'Adds visual rhythm to a talking-head or single-camera cut by scaling every nth clip on a video track up (default every second clip to 112%), so consecutive shots from the same angle read as two cameras. Skips the first clip and clips shorter than minClipSeconds. Sets a static Motion Scale; resetOthers=true also sets the remaining clips to 100%. Use dryRun=true to see which clips change.',
    inputSchema: z.object({
      sequenceId: sequenceIdArg,
      videoTrackIndex: z.number().int().min(0).default(0).describe('Zero-based video track (default 0).'),
      punchScale: z.number().min(100).max(300).default(112).describe('Scale in percent for punched-in clips (default 112).'),
      everyNth: z.number().int().min(1).default(2).describe('Punch in every nth clip (default 2).'),
      skip: z.number().int().min(0).default(1).describe('Clips left alone at the start (default 1).'),
      minClipSeconds: z.number().min(0).default(1).describe('Clips shorter than this keep their framing (default 1).'),
      resetOthers: z.boolean().default(false).describe('Set the other clips on the track to 100% (default false).'),
      dryRun: z.boolean().default(false).describe('When true, report the clips that would change and change nothing.'),
      backup: backupArg,
    }),
    run: (ctx, args) => autoPunchIn(ctx, args),
  },
];
