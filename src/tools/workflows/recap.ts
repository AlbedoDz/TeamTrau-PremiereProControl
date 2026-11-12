/**
 * workflow_recap: plan_recap then build_recap. build_recap makes the new sequence (the source is
 * never touched) and already runs qa_sequence and the readback, so its result stands for the
 * last step.
 */
import type { ToolContext } from '../context.js';
import type { CaptionPosition, CaptionSize, CaptionStyleId } from '../../analysis/caption-looks.js';
import { isError } from '../domains/cleanup.js';
import { buildRecap, planRecap, type PlanRecapResult } from '../domains/recap.js';
import type { TranscriptArgs } from '../domains/shorts.js';
import { awaitPending, failure, resolveSource, runSteps, uniqueSequenceName, type WorkflowResult, type WorkflowStep } from './steps.js';

export interface RecapArgs extends TranscriptArgs {
  name?: string | undefined;
  targetSec: number;
  /** Given together (the schema checks): the recap lands in [minSec, maxSec] and never exceeds maxSec. */
  minSec?: number | undefined;
  maxSec?: number | undefined;
  aspect: '16:9' | '9:16' | '1:1' | '4:5';
  captionStyle: 'none' | CaptionStyleId;
  captionAccent?: string | undefined;
  captionPosition?: CaptionPosition | undefined;
  captionSize?: CaptionSize | undefined;
  audioLeadSec: number;
  dryRun: boolean;
  backup: boolean;
}

const MAX_SEGMENT_SEC = 20;
const RECAP_LUFS = -14;

export async function workflowRecap(ctx: ToolContext, args: RecapArgs): Promise<WorkflowResult> {
  const warnings: string[] = [];
  const summary: Record<string, unknown> = {};
  let sourceId = args.sequenceId;
  let sourceName = '';
  let frameSec = 0;
  let plan: PlanRecapResult | undefined;

  const planStep: WorkflowStep = {
    label: 'Lập kế hoạch recap',
    run: async () => {
      const source = await resolveSource(ctx, args);
      if (isError(source)) return failure(source.error);
      sourceId = source.sequenceId;
      sourceName = source.sequenceName;
      frameSec = source.frameDuration;
      const planned: any = await awaitPending(ctx, 'Nhận dạng giọng nói', () =>
        planRecap(ctx, {
          sequenceId: sourceId,
          dialogueTrackIndices: args.dialogueTrackIndices,
          glossary: args.glossary,
          engine: args.engine,
          targetSec: args.targetSec,
          minSec: args.minSec,
          maxSec: args.maxSec,
          mode: 'auto',
          maxSegmentSec: MAX_SEGMENT_SEC,
        }),
      );
      if (!planned || planned.success === false) return failure(planned?.error ?? 'Không lập được kế hoạch recap.');
      plan = planned as PlanRecapResult;
      warnings.push(...plan.warnings);
      summary.mode = plan.mode;
      summary.segmentCount = plan.segments.length;
      summary.totalSec = plan.totalSec;
      if (plan.segments.length === 0) return failure('Không chọn được đoạn nào cho recap.');
      return { ok: true, detail: { mode: plan.mode, segments: plan.segments.length, totalSec: plan.totalSec } };
    },
  };

  const build: WorkflowStep = {
    label: 'Dựng recap',
    run: async () => {
      const name = await uniqueSequenceName(ctx, args.name ?? `${sourceName} - recap`);
      const built = await buildRecap(ctx, {
        sequenceId: sourceId,
        dialogueTrackIndices: args.dialogueTrackIndices,
        glossary: args.glossary,
        engine: args.engine,
        segments: plan!.segments,
        expectedFingerprint: plan!.fingerprint,
        name,
        aspect: args.aspect,
        captionStyle: args.captionStyle,
        captionAccent: args.captionAccent,
        captionPosition: args.captionPosition,
        captionSize: args.captionSize,
        audioLeadSec: args.audioLeadSec,
        targetLufs: RECAP_LUFS,
        dryRun: false,
        backup: args.backup,
      });
      warnings.push(...built.warnings);
      if (built.backupPath) summary.backupPath = built.backupPath;
      const created = built.sequenceId ? { createdSequenceId: String(built.sequenceId) } : {};
      if (!built.success) {
        return {
          ...failure(built.error ?? 'Không dựng được recap.'),
          ...created,
          ...(built.failedStep ? { nextStep: `Bước "${built.failedStep}" lỗi; kiểm tra sequence dang dở và bản backup.` } : {}),
        };
      }
      summary.outputName = name;
      summary.durationSec = built.durationSec;
      summary.verified = built.verified;
      if (built.qa !== undefined) summary.qa = built.qa;
      if (built.verified === false) warnings.push('Không xác nhận được độ dài recap sau khi dựng.');
      // maxSec is a hard ceiling: a built recap more than a frame over it is not accepted as verified.
      const durationSec = Number(built.durationSec);
      if (args.maxSec !== undefined && Number.isFinite(durationSec) && durationSec > args.maxSec + (frameSec > 0 ? frameSec : 1 / 24)) {
        summary.verified = false;
        warnings.push(`Recap sau khi dựng dài ${durationSec} giây, vượt mức tối đa ${args.maxSec} giây.`);
      }
      return { ok: true, detail: { sequenceId: built.sequenceId, durationSec: built.durationSec, verified: built.verified }, ...created, complete: true };
    },
  };

  const result = await runSteps(ctx, args.dryRun ? [planStep] : [planStep, build]);
  result.summary = {
    ...summary,
    ...(args.dryRun && plan ? { dryRun: true, segments: plan.segments } : {}),
  };
  result.warnings = [...new Set([...warnings, ...result.warnings])];
  return result;
}
