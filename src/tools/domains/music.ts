/**
 * Cutting to music: analyze_music finds tempo, beats, bars and sections of a song,
 * assemble_beat_cut lays the best footage onto a sequence with cuts on those beats.
 * The song is analysed from a loudness envelope measured by ffmpeg
 * (src/analysis/music.ts); cut points and shot assignment are in src/analysis/beatcut.ts.
 */
import { z } from 'zod';
import { access } from 'node:fs/promises';
import type { ToolContext, ToolModule } from '../context.js';
import { cached } from '../../analysis/cache.js';
import { ffmpegMissingResult, findFfTool, runFf } from '../../analysis/ffmpeg.js';
import { analyseRhythm, envelopeFromSamples, parseRmsSamples, type Rhythm } from '../../analysis/music.js';
import { assignShots, cutSlots } from '../../analysis/beatcut.js';
import { bestWindows, type Candidate } from '../../analysis/roughcut.js';
import { backupProject, BACKUP_FAILED_HINT, isError, readSequence } from './cleanup.js';
import { ensureProjectItems, listFootage, scoreAll } from './roughcut.js';

const ENVELOPE_FILTER = 'aresample=22050,asetnsamples=n=221:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-';

async function rhythmOf(
  musicPath: string,
  beatsPerBar: number,
  toolName: string,
): Promise<{ rhythm: Rhythm } | { failure: Record<string, unknown> }> {
  try {
    await access(musicPath);
  } catch {
    return { failure: { success: false, error: `Music file not found: ${musicPath}` } };
  }
  const ffmpeg = await findFfTool('ffmpeg');
  if (!ffmpeg) return { failure: ffmpegMissingResult(toolName) };
  try {
    const rhythm = await cached(musicPath, 'rhythm', { beatsPerBar }, async () => {
      const run = await runFf(ffmpeg, ['-hide_banner', '-nostats', '-i', musicPath, '-vn', '-ac', '1', '-af', ENVELOPE_FILTER, '-f', 'null', '-']);
      if (run.code !== 0) throw new Error(`ffmpeg could not read ${musicPath}: ${run.stderr.slice(-300)}`);
      return analyseRhythm(envelopeFromSamples(parseRmsSamples(run.stdout)), { beatsPerBar, minBpm: 70, maxBpm: 180 });
    });
    if (!rhythm) return { failure: { success: false, error: 'Could not find a beat: the file is silent or shorter than 8 seconds.' } };
    return { rhythm };
  } catch (err) {
    return { failure: { success: false, error: err instanceof Error ? err.message : String(err) } };
  }
}

const confidenceNote = (r: Rhythm): string | undefined =>
  r.confidence < 0.3
    ? 'Low confidence: the beat is weak or the tempo drifts, so the grid is a best guess. Check it against the music before cutting to it.'
    : undefined;

// -------------------------------------------------------------- analyze_music

async function analyzeMusic(_ctx: ToolContext, args: { musicPath: string; beatsPerBar: number; includeBeats: boolean }): Promise<any> {
  const result = await rhythmOf(args.musicPath, args.beatsPerBar, 'analyze_music');
  if ('failure' in result) return result.failure;
  const { rhythm } = result;
  const warning = confidenceNote(rhythm);
  return {
    success: true,
    musicPath: args.musicPath,
    durationSeconds: rhythm.durationSeconds,
    bpm: rhythm.bpm,
    confidence: rhythm.confidence,
    beatsPerBar: rhythm.beatsPerBar,
    beatCount: rhythm.beats.length,
    barCount: rhythm.downbeats.length,
    firstDownbeat: rhythm.downbeats[0],
    sections: rhythm.sections,
    downbeats: rhythm.downbeats,
    ...(args.includeBeats ? { beats: rhythm.beats } : {}),
    ...(warning ? { warning } : {}),
    note: 'Assumes a steady tempo. Sections are split where the loudness of a bar changes by a quarter or more.',
  };
}

// ----------------------------------------------------------- assemble_beat_cut

async function assembleBeatCut(
  ctx: ToolContext,
  args: {
    musicPath: string;
    mediaPaths?: string[];
    folderPath?: string;
    recursive: boolean;
    preset: 'calm' | 'balanced' | 'energetic';
    cutEveryBeats?: number;
    beatsPerBar: number;
    durationSeconds?: number;
    sequenceId?: string;
    videoTrackIndex: number;
    musicAudioTrackIndex: number;
    addMusic: boolean;
    startTime: number;
    linkAudio: boolean;
    overwrite: boolean;
    dryRun: boolean;
    backup: boolean;
  },
): Promise<any> {
  const before = await readSequence(ctx, args.sequenceId);
  if (isError(before)) return { success: false, error: before.error };
  const heard = await rhythmOf(args.musicPath, args.beatsPerBar, 'assemble_beat_cut');
  if ('failure' in heard) return heard.failure;
  const { rhythm } = heard;
  const listed = await listFootage(args);
  if ('error' in listed) return { success: false, error: listed.error };

  const length = Math.min(args.durationSeconds ?? rhythm.durationSeconds, rhythm.durationSeconds);
  const slots = cutSlots(rhythm, { preset: args.preset, cutEveryBeats: args.cutEveryBeats, durationSeconds: length, frameDuration: before.frameDuration });
  if (slots.length === 0) return { success: false, error: 'No cut points fit in the requested length.' };

  // Score windows as long as the longest slot, so any slot can be filled from any window.
  const windowSeconds = Math.max(1, Math.ceil(Math.max(...slots.map((s) => s.end - s.start))));
  const all = await scoreAll(listed.paths, windowSeconds, 'assemble_beat_cut');
  if ('failure' in all) return all.failure;
  const perFile = Math.ceil(slots.length / Math.max(1, all.scored.length)) + 1;
  const candidates: Candidate[] = all.scored.flatMap((f) =>
    bestWindows(f.windows, perFile, 0).map((w) => ({ mediaPath: f.mediaPath, sourceDuration: f.sourceDuration, start: w.start, end: w.end, score: w.score })),
  );
  const { shots, reused } = assignShots(slots, candidates, before.frameDuration);
  if (shots.length === 0) return { success: false, error: 'No usable footage to build a cut from.' };

  const warning = confidenceNote(rhythm);
  const summary = {
    sequenceName: before.sequenceName,
    bpm: rhythm.bpm,
    confidence: rhythm.confidence,
    preset: args.preset,
    cutSeconds: length,
    shotCount: shots.length,
    reusedShots: reused,
    slots: slots.map((s) => ({ start: s.start, end: s.end, beats: s.beats, section: s.label })),
    shots,
    ...(all.failed.length ? { skippedFiles: all.failed } : {}),
    ...(warning ? { warning } : {}),
  };

  const endsAt = args.startTime + length;
  const occupied = before.clips.filter((c) => c.trackType === 'video' && c.trackIndex === args.videoTrackIndex && c.end > args.startTime && c.start < endsAt);
  if (occupied.length > 0 && !args.overwrite) {
    return { success: false, error: `Video track ${args.videoTrackIndex + 1} already has ${occupied.length} clip(s) between ${args.startTime}s and ${endsAt}s. Choose another track or startTime, or pass overwrite=true.`, ...summary };
  }
  if (args.dryRun) return { success: true, dryRun: true, applied: false, ...summary, note: 'Dry run: nothing was changed.' };

  let backupPath: string | undefined;
  if (args.backup) {
    const backup = await backupProject(ctx);
    if ('error' in backup) return { success: false, error: `Backup failed, nothing was changed: ${backup.error}${BACKUP_FAILED_HINT}`, ...summary };
    backupPath = backup.path;
  }

  const items = await ensureProjectItems(ctx, [...shots.map((s) => s.mediaPath), ...(args.addMusic ? [args.musicPath] : [])]);
  if ('error' in items) return { success: false, error: items.error, backupPath, ...summary };

  const round = (n: number): number => Math.round(n * 1000) / 1000;
  const specs = [
    ...shots.map((s) => ({
      projectItemId: items.ids.get(s.mediaPath)!,
      trackIndex: args.videoTrackIndex,
      time: round(args.startTime + s.timelineStart),
      linkAudio: args.linkAudio,
      sourceInPoint: s.in,
      sourceOutPoint: s.out,
    })),
    ...(args.addMusic
      ? [{ projectItemId: items.ids.get(args.musicPath)!, trackIndex: args.musicAudioTrackIndex, time: args.startTime, linkAudio: true, sourceInPoint: 0, sourceOutPoint: round(length) }]
      : []),
  ];
  const placed: any = await ctx.bridge.addToTimelineBatch(before.sequenceId, specs);
  const failures = (placed?.results ?? []).filter((r: { success?: boolean }) => r.success === false);
  if (placed?.success === false || failures.length) {
    return { success: false, error: `${failures.length || 'Some'} item(s) could not be placed.`, failures, backupPath, ...summary };
  }

  const after = await readSequence(ctx, before.sequenceId);
  if (isError(after)) return { success: false, error: `Items were placed but the result could not be re-read: ${after.error}`, backupPath, ...summary };
  const videoEnd = Math.max(0, ...after.clips.filter((c) => c.trackType === 'video' && c.trackIndex === args.videoTrackIndex).map((c) => c.end));
  const verified = Math.abs(videoEnd - endsAt) <= before.frameDuration * (shots.length + 1);
  return {
    success: true,
    dryRun: false,
    applied: true,
    verified,
    backupPath,
    ...summary,
    videoTrackEndsAt: round(videoEnd),
    ...(verified ? {} : { verificationWarning: `The video track ends at ${videoEnd}s but the cut should end at ${endsAt}s. Check for locked tracks or items that were not placed.` }),
  };
}

// -------------------------------------------------------------- declarations

export const musicTools: ToolModule[] = [
  {
    name: 'analyze_music',
    description:
      'Finds the tempo (BPM), beat grid, bars and sections (low, mid, high energy) of a music file from its loudness, measured with ffmpeg. Read-only; cached on disk. Assumes a steady tempo, as in produced music, and reports a confidence; below 0.3 treat the grid as a guess. Use the beats to place markers or cut to music, or assemble_beat_cut to do it for you. Requires ffmpeg.',
    inputSchema: z.object({
      musicPath: z.string().describe('Absolute path to the audio or video file with the music.'),
      beatsPerBar: z.number().int().min(2).max(7).default(4).describe('Beats in a bar (default 4).'),
      includeBeats: z.boolean().default(false).describe('Also return every beat time (default false: bars only).'),
    }),
    run: (ctx, args) => analyzeMusic(ctx, args),
  },
  {
    name: 'assemble_beat_cut',
    description:
      'Builds a music-driven cut: analyses the song, cuts on its beats (every 4, 2 or 1 beats depending on how loud that section is and the preset), gives the best-scored footage from a folder to the loudest sections, places the shots back to back on a video track and puts the music on an audio track. Cut points are snapped to the sequence frame grid. Footage is reused (and reported) if there are fewer good stretches than cuts. Refuses to overwrite existing clips on the track unless overwrite=true. Use dryRun=true to see the cut list first. Requires ffmpeg.',
    inputSchema: z.object({
      musicPath: z.string().describe('Absolute path to the music file.'),
      mediaPaths: z.array(z.string()).optional().describe('Video files to choose from. Use this or folderPath.'),
      folderPath: z.string().optional().describe('Folder of video files to choose from. Use this or mediaPaths.'),
      recursive: z.boolean().default(false).describe('Include subfolders of folderPath (default false).'),
      preset: z.enum(['calm', 'balanced', 'energetic']).default('balanced').describe('How fast the cut is: calm 8/8/4 beats per shot in low/mid/high sections, balanced 4/4/2, energetic 4/2/1 (default balanced).'),
      cutEveryBeats: z.number().int().min(1).max(16).optional().describe('Fixed beats per shot, overriding the preset.'),
      beatsPerBar: z.number().int().min(2).max(7).default(4).describe('Beats in a bar (default 4).'),
      durationSeconds: z.number().positive().optional().describe('Cut only this much of the song from its start. Defaults to the whole song.'),
      sequenceId: z.string().optional().describe('Target sequence ID. Defaults to the active sequence, whose frame rate sets the frame grid.'),
      videoTrackIndex: z.number().int().min(0).default(0).describe('Zero-based video track for the shots (default 0).'),
      musicAudioTrackIndex: z.number().int().min(0).default(1).describe('Zero-based audio track for the music (default 1, leaving track 0 for footage audio).'),
      addMusic: z.boolean().default(true).describe('Place the music on the timeline (default true).'),
      startTime: z.number().min(0).default(0).describe('Timeline position in seconds where the cut starts (default 0).'),
      linkAudio: z.boolean().default(false).describe("Keep each shot's own audio (default false: the music carries the cut)."),
      overwrite: z.boolean().default(false).describe('Allow placing over existing clips on the track (default false).'),
      dryRun: z.boolean().default(false).describe('When true, report the cut list and change nothing.'),
      backup: z.boolean().default(true).describe('Save the project and copy it to a premiere-mcp-backups folder beside it before changing anything (default true). Ignored on a dry run.'),
    }),
    run: (ctx, args) => assembleBeatCut(ctx, args),
  },
];
