/**
 * Native Premiere captions for a full episode, built from the transcript transcribe_sequence
 * already cached: the cues go to an SRT file, which is imported and turned into a caption track.
 */
import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { ToolContext, ToolModule } from '../context.js';
import { premiereMcpHome } from '../../analysis/sidecar.js';
import { ENGINE_IDS } from '../../analysis/asr-engines.js';
import { safeFileName } from '../../analysis/captions.js';
import { buildSubtitleCues, toSrt } from '../../analysis/subtitles.js';
import { ensureBackup } from './editing.js';
import { importMedia } from './media.js';
import { createCaptionTrack } from './sequence.js';
import { loadTranscript, probeScript } from './shorts.js';
import { subtitleLineLimits } from '../../analysis/caption-looks.js';
import { ensureRootBin } from './project.js';

export interface CaptionsArgs {
  sequenceId?: string | undefined;
  dialogueTrackIndices?: number[] | undefined;
  glossary?: string[] | undefined;
  engine?: string | undefined;
  startTime?: number | undefined;
  endTime?: number | undefined;
  /** Omit to size lines to the sequence frame (see subtitleLineLimits). */
  maxCharsPerLine?: number | undefined;
  outputPath?: string | undefined;
  overwrite?: boolean | undefined;
  dryRun: boolean;
  backup: boolean;
  /** Stop after writing the SRT: no import, no caption track, the project is not touched. */
  srtOnly?: boolean | undefined;
}

const FALLBACK_LIMITS = { maxCharsPerLine: 42, maxLines: 2, layout: '16:9' as const };

function frameFallbackWarning(explicit: number | undefined): string {
  return explicit !== undefined
    ? `Không đọc được khung hình của sequence, dùng ${explicit} ký tự x 2 dòng theo maxCharsPerLine.`
    : 'Không đọc được khung hình của sequence, dùng 42 ký tự x 2 dòng.';
}

/** Line limits for the sequence frame; an explicit maxCharsPerLine wins over the frame's. */
async function resolveLineLimits(ctx: ToolContext, sequenceId: string, explicit: number | undefined, warnings: string[]) {
  let base: { maxCharsPerLine: number; maxLines: number; layout: string } = FALLBACK_LIMITS;
  try {
    const probe: any = await ctx.bridge.executeScript(probeScript(sequenceId));
    const w = Number(probe?.frameSizeHorizontal);
    const h = Number(probe?.frameSizeVertical);
    if (probe && probe.success !== false && w > 0 && h > 0) base = subtitleLineLimits(w, h);
    else warnings.push(frameFallbackWarning(explicit));
  } catch {
    warnings.push(frameFallbackWarning(explicit));
  }
  return explicit !== undefined ? { ...base, maxCharsPerLine: explicit } : base;
}

export async function createCaptionsFromTranscript(ctx: ToolContext, args: CaptionsArgs): Promise<unknown> {
  const loaded = await loadTranscript(ctx, args);
  if ('success' in loaded) return loaded;
  if (loaded.status === 'running') {
    return {
      success: true,
      ...loaded,
      nextStep: 'Transcription is running in the background. Call transcribe_sequence (or this tool) again with the same arguments until it is done.',
    };
  }

  const warnings = [...loaded.warnings];
  const from = args.startTime ?? 0;
  const to = args.endTime ?? Infinity;
  const words = loaded.words.filter((w) => w.start >= from && w.start < to);
  const limits = await resolveLineLimits(ctx, loaded.sequenceId, args.maxCharsPerLine, warnings);
  const cues = buildSubtitleCues(words, { maxCharsPerLine: limits.maxCharsPerLine, maxLines: limits.maxLines });
  if (cues.length === 0) return { success: false, error: 'No words fall in this range, so there are no captions to create.', warnings };
  const preview = cues.slice(0, 5);

  if (args.dryRun) {
    return { success: true, dryRun: true, sequenceId: loaded.sequenceId, cueCount: cues.length, lineLimits: limits, preview, warnings };
  }

  if (args.outputPath !== undefined) {
    if (extname(args.outputPath).toLowerCase() !== '.srt') {
      return { success: false, error: `outputPath must end in .srt (got ${args.outputPath}).`, warnings };
    }
    if (existsSync(args.outputPath) && args.overwrite !== true) {
      return { success: false, error: `${args.outputPath} already exists. Pass overwrite: true to replace it, or choose another outputPath.`, warnings };
    }
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const srtPath = args.outputPath ?? join(premiereMcpHome(), 'renders', `${safeFileName(loaded.sequenceId)}-captions-${stamp}.srt`);
  try {
    await mkdir(dirname(srtPath), { recursive: true });
    await writeFile(srtPath, `\uFEFF${toSrt(cues)}`, 'utf8');
  } catch (error) {
    return { success: false, failedStep: 'write_srt', error: error instanceof Error ? error.message : String(error), warnings };
  }

  if (args.srtOnly) {
    return { success: true, sequenceId: loaded.sequenceId, cueCount: cues.length, lineLimits: limits, srtPath, preview, warnings };
  }

  let backupPath: string | undefined;
  let step = 'backup';
  const fail = (failedStep: string, error: string): Record<string, unknown> => ({
    success: false, failedStep, error, srtPath, ...(backupPath ? { backupPath } : {}), warnings,
  });
  try {
    const backup = await ensureBackup(ctx, args.backup);
    if ('failure' in backup) return { ...backup.failure, failedStep: step, srtPath, warnings };
    backupPath = backup.path;

    step = 'import_srt';
    const bin = await ensureRootBin(ctx, 'Captions');
    if (!bin.success) return fail(step, bin.error ?? 'The Captions bin could not be created.');
    const imported = await importMedia(ctx, srtPath, 'Captions');
    if (!imported?.success || !imported.id) return fail(step, imported?.error ?? 'The SRT file was not imported.');

    step = 'create_caption_track';
    const track = await createCaptionTrack(ctx, loaded.sequenceId, String(imported.id), 0);
    if (!track || track.success === false) return fail(step, track?.error ?? 'The caption track was not created.');

    return {
      success: true,
      sequenceId: loaded.sequenceId,
      cueCount: cues.length,
      lineLimits: limits,
      srtPath,
      projectItemId: String(imported.id),
      captionTrack: track,
      ...(backupPath ? { backupPath } : {}),
      preview,
      warnings,
    };
  } catch (error) {
    return fail(step, error instanceof Error ? error.message : String(error));
  }
}

export const subtitlesTools: ToolModule[] = [
  {
    name: 'create_captions_from_transcript',
    description:
      'Creates native, editable Premiere captions for a whole sequence from the word-level Vietnamese transcript that transcribe_sequence cached (no new speech recognition). Builds readable subtitle cues (max 2 lines, 42 characters wide for 16:9 and narrower for vertical or square frames, split at sentences and pauses), writes them to a UTF-8 SRT file, imports it into bin Captions and creates a caption track from it, which can be styled in the Captions and Essential Graphics panels. Returns status "running" until the transcript is done. dryRun=true returns the cue count and the first cues and writes nothing. Needs the analysis sidecar.',
    inputSchema: z.object({
      sequenceId: z.string().optional().describe('Sequence ID. Defaults to the active sequence.'),
      dialogueTrackIndices: z.array(z.number().int().min(0)).optional().describe('Audio track indices that carry speech; use the same value as transcribe_sequence. Defaults to every audio track that has a clip with a media file.'),
      glossary: z.array(z.string()).optional().describe('Names and terms to bias recognition toward; use the same list as transcribe_sequence.'),
      engine: z.enum(ENGINE_IDS).optional().describe('Speech engine; use the same value as transcribe_sequence. Defaults to the configured engine, then zipformer-68m (about 80 MB, Apache-2.0). zipformer-30m and rover are non-commercial; whisper-turbo is 1.6 GB (MIT). An engine that is not installed is never downloaded here: the result asks the user to approve it.'),
      startTime: z.number().min(0).optional().describe('Only words starting at or after this sequence time in seconds. Caption times stay in sequence time.'),
      endTime: z.number().min(0).optional().describe('Only words starting before this sequence time in seconds.'),
      maxCharsPerLine: z.number().int().min(10).optional().describe('Maximum characters per caption line. Default: sized to the sequence frame (42 for 16:9, 22 for 9:16, 30 for 1:1, 28 for 4:5).'),
      outputPath: z.string().optional().describe('Where to write the .srt; must end in .srt and must not exist unless overwrite is true. Defaults to <premiere-mcp home>/renders/<sequence>-captions-<timestamp>.srt.'),
      overwrite: z.boolean().default(false).describe('Replace outputPath when that file already exists (default false: an existing file is refused).'),
      dryRun: z.boolean().default(false).describe('Return the cue count and a preview without writing a file or changing the project.'),
      backup: z.boolean().default(true).describe('Save the project and copy it to a premiere-mcp-backups folder beside it before changing anything (default true). Ignored on a dry run.'),
    }),
    run: (ctx, args) => createCaptionsFromTranscript(ctx, args),
  },
];
