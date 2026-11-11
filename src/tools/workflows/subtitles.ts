/**
 * workflow_subtitles: transcript to subtitle cues to an SRT file, and optionally a caption
 * track. The caption track goes onto a copy of the sequence; the source is never touched.
 */
import type { ToolContext } from '../context.js';
import { isError, readSequence } from '../domains/cleanup.js';
import { ensureBackup } from '../domains/editing.js';
import { importMedia } from '../domains/media.js';
import { ensureRootBin } from '../domains/project.js';
import { createCaptionTrack, duplicateSequence } from '../domains/sequence.js';
import { createCaptionsFromTranscript } from '../domains/subtitles.js';
import type { TranscriptArgs } from '../domains/shorts.js';
import { awaitTranscript, runSteps, uniqueSequenceName, type StepOutcome, type WorkflowResult, type WorkflowStep } from './steps.js';

export interface SubtitlesArgs extends TranscriptArgs {
  name?: string | undefined;
  output: 'srt' | 'caption_track';
  maxCharsPerLine: number;
  outputPath?: string | undefined;
  dryRun: boolean;
  backup: boolean;
}

const failure = (error: unknown): StepOutcome => ({
  ok: false,
  detail: { error: typeof error === 'string' ? error : String((error as { error?: unknown })?.error ?? 'Lỗi không rõ.') },
});

export async function workflowSubtitles(ctx: ToolContext, args: SubtitlesArgs): Promise<WorkflowResult> {
  const warnings: string[] = [];
  const summary: Record<string, unknown> = {};
  let sourceId = args.sequenceId;
  let srtPath = '';
  let copyId = '';
  let projectItemId = '';

  const transcribe: WorkflowStep = {
    label: 'Nhận dạng giọng nói',
    run: async () => {
      const transcript = await awaitTranscript(ctx, args, 'Nhận dạng giọng nói');
      if ('success' in transcript) return failure(transcript.error);
      sourceId = transcript.sequenceId;
      if (transcript.words.length === 0) return failure('Transcript rỗng (không có lời thoại), không có phụ đề để tạo.');
      return { ok: true, detail: { words: transcript.words.length } };
    },
  };

  const writeSrt: WorkflowStep = {
    label: 'Tạo file phụ đề (SRT)',
    run: async () => {
      const result: any = await createCaptionsFromTranscript(ctx, {
        ...(sourceId ? { sequenceId: sourceId } : {}),
        dialogueTrackIndices: args.dialogueTrackIndices,
        glossary: args.glossary,
        engine: args.engine,
        maxCharsPerLine: args.maxCharsPerLine,
        outputPath: args.outputPath,
        dryRun: args.dryRun,
        backup: false,
        srtOnly: true,
      });
      if (!result || result.success === false) return failure(result?.error ?? 'Không tạo được file SRT.');
      if (Array.isArray(result.warnings)) warnings.push(...result.warnings);
      summary.cueCount = result.cueCount;
      summary.preview = result.preview;
      if (result.srtPath) {
        srtPath = String(result.srtPath);
        summary.srtPath = srtPath;
      }
      return { ok: true, detail: { cueCount: result.cueCount, srtPath: result.srtPath } };
    },
  };

  const duplicate: WorkflowStep = {
    label: 'Nhân bản sequence',
    run: async () => {
      const backup = await ensureBackup(ctx, args.backup);
      if ('failure' in backup) return failure(backup.failure);
      if (backup.path) summary.backupPath = backup.path;
      const source = await readSequence(ctx, sourceId);
      if (isError(source)) return failure(source.error);
      const name = await uniqueSequenceName(ctx, args.name ?? `${source.sequenceName} - phụ đề`);
      const copy: any = await duplicateSequence(ctx, source.sequenceId, name);
      if (!copy || copy.success === false || !copy.newSequenceId) return failure(copy?.error ?? 'Không nhân bản được sequence.');
      copyId = String(copy.newSequenceId);
      summary.outputName = name;
      return { ok: true, detail: { sequenceId: copyId, name }, createdSequenceId: copyId };
    },
  };

  const importSrt: WorkflowStep = {
    label: 'Nhập SRT vào project',
    run: async () => {
      const bin = await ensureRootBin(ctx, 'Captions');
      if (!bin.success) return failure(bin.error ?? 'Không tạo được bin Captions.');
      const imported = await importMedia(ctx, srtPath, 'Captions');
      if (!imported?.success || !imported.id) return failure(imported?.error ?? 'Không nhập được file SRT.');
      projectItemId = String(imported.id);
      return { ok: true, detail: { projectItemId } };
    },
  };

  const track: WorkflowStep = {
    label: 'Tạo track caption',
    run: async () => {
      const created = await createCaptionTrack(ctx, copyId, projectItemId, 0);
      if (!created || created.success === false) return failure(created?.error ?? 'Không tạo được track caption.');
      return { ok: true, detail: created };
    },
  };

  const steps = [transcribe, writeSrt, ...(args.output === 'caption_track' && !args.dryRun ? [duplicate, importSrt, track] : [])];
  const result = await runSteps(ctx, steps);
  result.summary = { ...summary, ...(args.dryRun ? { dryRun: true } : {}) };
  result.warnings = [...new Set([...warnings, ...result.warnings])];
  return result;
}
