/**
 * workflow_clean_voiceover: one call that cuts silences, filler words and retakes out of a
 * voice-over and polishes the dialogue. Everything to remove is measured on the source sequence
 * first (all ranges are in its time, which the copy shares), the sequence is copied, and
 * remove_ranges runs once on the copy. The source is never touched.
 */
import type { ToolContext } from '../context.js';
import { ffmpegMissingResult, findFfTool, type Interval } from '../../analysis/ffmpeg.js';
import { planSilenceCuts, unionIntervals } from '../../analysis/cleanup.js';
import {
  analyseSilence,
  isError,
  readSequence,
  removeRanges,
  uniquePaths,
  type SequenceSnapshot,
} from '../domains/cleanup.js';
import { applyDialogueChain, ensureBackup, qaSequence } from '../domains/editing.js';
import { findFillersAndRetakes, type FindFillersArgs } from '../domains/fillers.js';
import { duplicateSequence } from '../domains/sequence.js';
import type { TranscriptArgs } from '../domains/shorts.js';
import { awaitTranscript, runSteps, uniqueSequenceName, type StepOutcome, type WorkflowResult, type WorkflowStep } from './steps.js';

export interface CleanVoiceoverArgs extends TranscriptArgs {
  name?: string | undefined;
  dryRun: boolean;
  backup: boolean;
  cutSilence: boolean;
  cutFillers: boolean;
  fillerTiers?: Array<'A' | 'B'> | undefined;
  cutRetakes: boolean;
  dialogueChain: boolean;
  targetLufs: number;
  crossfadeMs: number;
}

// The defaults of remove_silence_from_sequence.
const SILENCE_DB = -35;
const SILENCE_MIN_SEC = 0.5;
const SILENCE_PADDING_SEC = 0.1;
const MERGE_GAP_SEC = 0.4;
const MIN_KEEP_SEC = 0.4;
const MIN_PAUSE_MS = 150;
const DIALOGUE_EFFECTS = ['DeNoise', 'Dynamics'];

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const failure = (error: unknown): StepOutcome => ({
  ok: false,
  detail: { error: typeof error === 'string' ? error : String((error as { error?: unknown })?.error ?? 'Lỗi không rõ.') },
});

export async function workflowCleanVoiceover(ctx: ToolContext, args: CleanVoiceoverArgs): Promise<WorkflowResult> {
  const warnings: string[] = [];
  const summary: Record<string, unknown> = {};
  let snapshot: SequenceSnapshot | undefined;
  let dialogueTracks: number[] = [];
  let silenceCuts: Interval[] = [];
  let fillerRanges: Array<{ start: number; end: number; reason: string; text?: string }> = [];
  let merged: Interval[] = [];
  let copyId = '';
  let backupPath: string | undefined;

  const analyse: WorkflowStep = {
    label: 'Phân tích khoảng lặng, từ đệm và câu vấp',
    run: async () => {
      const read = await readSequence(ctx, args.sequenceId);
      if (isError(read)) return failure(read.error);
      snapshot = read;
      const audio = read.clips.filter((c) => c.trackType === 'audio');
      dialogueTracks = args.dialogueTrackIndices
        ?? [...new Set(audio.filter((c) => c.mediaPath).map((c) => c.trackIndex))].sort((a, b) => a - b);
      if (dialogueTracks.length === 0) return failure('Sequence không có clip âm thanh nào có file media để phân tích.');

      if (args.cutSilence) {
        const ffmpeg = await findFfTool('ffmpeg');
        if (!ffmpeg) return failure((ffmpegMissingResult('workflow_clean_voiceover') as { error?: string }).error ?? 'Thiếu ffmpeg.');
        const paths = uniquePaths(audio.filter((c) => dialogueTracks.includes(c.trackIndex)), 'audio');
        const analysed = await analyseSilence(ffmpeg, paths, SILENCE_DB, SILENCE_MIN_SEC);
        if ('failure' in analysed) return failure(analysed.failure);
        const plan = planSilenceCuts(read.clips, analysed.silenceByMedia, {
          paddingSeconds: SILENCE_PADDING_SEC,
          minCutSeconds: SILENCE_MIN_SEC / 2,
          frameDuration: read.frameDuration,
          audioTrackIndices: dialogueTracks,
        });
        silenceCuts = plan.cuts;
        if (plan.skippedClips.length > 0) warnings.push(`Bỏ qua ${plan.skippedClips.length} clip (tốc độ khác 100% hoặc không có media) khi tìm khoảng lặng.`);
      }

      if (args.cutFillers || args.cutRetakes) {
        const transcript = await awaitTranscript(ctx, { ...args, dialogueTrackIndices: dialogueTracks }, 'Nhận dạng giọng nói');
        if ('success' in transcript) return failure(transcript.error);
        if (transcript.words.length === 0) {
          warnings.push('Transcript rỗng (không có lời thoại), nên chỉ cắt khoảng lặng.');
        } else {
          const findArgs: FindFillersArgs = {
            sequenceId: read.sequenceId,
            dialogueTrackIndices: dialogueTracks,
            glossary: args.glossary,
            engine: args.engine,
            tiers: args.fillerTiers,
            retakes: args.cutRetakes,
            minPauseMs: MIN_PAUSE_MS,
          };
          const found = await findFillersAndRetakes(ctx, findArgs);
          if (!('ranges' in found)) return failure('error' in found ? found : 'Transcript chưa sẵn sàng.');
          fillerRanges = found.ranges.filter((r) => (r.reason === 'retake' ? args.cutRetakes : args.cutFillers));
          warnings.push(...found.warnings);
          if (found.skippedClips.length > 0) summary.skippedClips = found.skippedClips;
        }
      }
      return {
        ok: true,
        detail: {
          silenceCuts: silenceCuts.length,
          fillers: fillerRanges.filter((r) => r.reason !== 'retake').length,
          retakes: fillerRanges.filter((r) => r.reason === 'retake').length,
        },
      };
    },
  };

  const merge: WorkflowStep = {
    label: 'Gộp các khoảng cần bỏ',
    run: async () => {
      merged = unionIntervals([
        ...silenceCuts,
        ...fillerRanges.map((r) => ({ start: r.start, end: r.end, duration: r.end - r.start })),
      ]);
      summary.cuts = [
        ...silenceCuts.map((r) => ({ start: round3(r.start), end: round3(r.end), reason: 'silence' })),
        ...fillerRanges.map((r) => ({ start: r.start, end: r.end, reason: r.reason, ...(r.text !== undefined ? { text: r.text } : {}) })),
      ].sort((a, b) => a.start - b.start);
      summary.cutCount = merged.length;
      summary.plannedRemovedSeconds = round3(merged.reduce((sum, r) => sum + r.duration, 0));
      if (merged.length === 0) warnings.push('Không có khoảng nào cần cắt.');
      return { ok: true, detail: { ranges: merged.length, seconds: summary.plannedRemovedSeconds } };
    },
  };

  const duplicate: WorkflowStep = {
    label: 'Nhân bản sequence',
    run: async () => {
      const backup = await ensureBackup(ctx, args.backup);
      if ('failure' in backup) return failure(backup.failure);
      backupPath = backup.path;
      const name = await uniqueSequenceName(ctx, args.name ?? `${snapshot!.sequenceName} - clean`);
      const copy: any = await duplicateSequence(ctx, snapshot!.sequenceId, name);
      if (!copy || copy.success === false || !copy.newSequenceId) return failure(copy?.error ?? 'Không nhân bản được sequence.');
      copyId = String(copy.newSequenceId);
      summary.outputName = name;
      return { ok: true, detail: { sequenceId: copyId, name }, createdSequenceId: copyId };
    },
  };

  const cut: WorkflowStep = {
    label: 'Cắt các khoảng (một lần)',
    run: async () => {
      if (merged.length === 0) return { ok: true, detail: { skipped: 'không có khoảng nào để cắt' } };
      const result = await removeRanges(ctx, {
        sequenceId: copyId,
        ranges: merged.map((r) => ({ start: r.start, end: r.end })),
        invert: false,
        crossfadeMs: args.crossfadeMs,
        mergeGapSec: MERGE_GAP_SEC,
        minKeepSec: MIN_KEEP_SEC,
        dryRun: false,
        backup: false,
      });
      if (!result.success) return failure(result.error ?? 'Không cắt được các khoảng.');
      if (result.warning) warnings.push(result.warning);
      if (result.verified === false) warnings.push('Không xác nhận được độ dài sequence sau khi cắt (track bị khóa hoặc sync lock tắt?).');
      summary.verified = result.verified;
      summary.durationBefore = result.durationBefore;
      summary.durationAfter = result.durationAfter;
      summary.removedSeconds = round3(result.removed.reduce((sum, r) => sum + r.duration, 0));
      return { ok: true, detail: { removed: result.removed.length, verified: result.verified } };
    },
  };

  const chain: WorkflowStep = {
    label: 'Xử lý thoại và chuẩn loudness',
    run: async () => {
      const result: any = await applyDialogueChain(ctx, {
        sequenceId: copyId,
        dialogueTrackIndices: dialogueTracks,
        effects: DIALOGUE_EFFECTS,
        normalize: true,
        targetLufs: args.targetLufs,
        dryRun: false,
        backup: false,
      });
      summary.targetLufs = args.targetLufs;
      if (result?.success === false) {
        // Effect names follow the Premiere UI language: report it, keep the cut result.
        if (!Array.isArray(result.results)) return failure(result.error ?? 'Không xử lý được thoại.');
        warnings.push(String(result.note ?? 'Một số hiệu ứng thoại chưa áp dụng được.'));
      }
      return { ok: true, detail: result };
    },
  };

  const qa: WorkflowStep = {
    label: 'Kiểm tra chất lượng',
    run: async () => {
      const result: any = await qaSequence(ctx, { sequenceId: copyId, minClipFrames: 6, checkMedia: true });
      if (result?.success === false) return failure(result.error ?? 'Không kiểm tra được sequence.');
      const findings = Array.isArray(result?.findings) ? result.findings.length : 0;
      summary.qaFindings = findings;
      if (findings > 0) warnings.push(`qa_sequence báo ${findings} điểm cần xem lại trên sequence mới.`);
      return { ok: true, detail: { clean: findings === 0, findings } };
    },
  };

  const steps = args.dryRun ? [analyse, merge] : [analyse, merge, duplicate, cut, ...(args.dialogueChain ? [chain] : []), qa];
  const result = await runSteps(ctx, steps);
  result.summary = { ...summary, ...(args.dryRun ? { dryRun: true, plan: merged } : {}), ...(backupPath ? { backupPath } : {}) };
  result.warnings = [...new Set([...warnings, ...result.warnings])];
  return result;
}
