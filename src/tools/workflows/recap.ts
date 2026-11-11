/**
 * workflow_recap: plan_recap then build_recap. build_recap makes the new sequence (the source is
 * never touched) and already runs qa_sequence and the readback, so its result stands for the
 * last step.
 */
import type { ToolContext } from '../context.js';
import { isError, readSequence } from '../domains/cleanup.js';
import { buildRecap, planRecap, type PlanRecapResult } from '../domains/recap.js';
import type { TranscriptArgs } from '../domains/shorts.js';
import { awaitPending, failure, runSteps, uniqueSequenceName, type WorkflowResult, type WorkflowStep } from './steps.js';

export interface RecapArgs extends TranscriptArgs {
  name?: string | undefined;
  targetSec: number;
  aspect: '16:9' | '9:16';
  captionStyle: 'none' | 'clean' | 'pop' | 'karaoke';
  audioLeadSec: number;
  dryRun: boolean;
  backup: boolean;
}

const MIN_SEGMENT_SEC = 4;
const MAX_SEGMENT_SEC = 20;
const RECAP_LUFS = -14;

export async function workflowRecap(ctx: ToolContext, args: RecapArgs): Promise<WorkflowResult> {
  const warnings: string[] = [];
  const summary: Record<string, unknown> = {};
  let sourceId = args.sequenceId;
  let sourceName = '';
  let plan: PlanRecapResult | undefined;

  const planStep: WorkflowStep = {
    label: 'Lập kế hoạch recap',
    run: async () => {
      const source = await readSequence(ctx, args.sequenceId);
      if (isError(source)) return failure(source.error);
      sourceId = source.sequenceId;
      sourceName = source.sequenceName;
      const planned: any = await awaitPending(ctx, 'Nhận dạng giọng nói', () =>
        planRecap(ctx, {
          sequenceId: sourceId,
          dialogueTrackIndices: args.dialogueTrackIndices,
          glossary: args.glossary,
          engine: args.engine,
          targetSec: args.targetSec,
          mode: 'auto',
          minSegmentSec: MIN_SEGMENT_SEC,
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
      return { ok: true, detail: { sequenceId: built.sequenceId, durationSec: built.durationSec, verified: built.verified }, ...created };
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
