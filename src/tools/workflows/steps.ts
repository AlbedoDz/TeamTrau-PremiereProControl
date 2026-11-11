/**
 * Shared frame of the workflow_* tools: a step runner that reports progress and stops
 * cleanly on cancel, a transcript wait that polls the background job, and the helpers
 * for naming the sequences a workflow creates. Workflows never modify the source sequence.
 */
import { throwIfAborted, type ToolContext } from '../context.js';
import { loadTranscript, type TranscriptArgs, type TranscriptReady } from '../domains/shorts.js';

export interface StepOutcome {
  ok: boolean;
  detail?: unknown;
  nextStep?: string;
  /** Sequence this step created; renamed with a suffix when the run is cancelled later. */
  createdSequenceId?: string;
}

export interface WorkflowStep {
  label: string;
  run: () => Promise<StepOutcome>;
}

export interface WorkflowResult {
  success: boolean;
  steps: Array<{ label: string; ok: boolean; detail?: unknown }>;
  summary: Record<string, unknown>;
  outputSequenceIds: string[];
  warnings: string[];
  cancelled?: boolean;
  nextStep?: string;
}

/** Suffix of a sequence left behind by a cancelled run. */
export const CANCELLED_SUFFIX = ' (đã hủy)';
export const PANEL_CLOSED_SUFFIX = ' (dang dở)';
export const TRANSCRIPT_POLL_MS = 3000;

const isCancel = (error: unknown): boolean => error instanceof Error && error.message === 'cancelled';

/** The step being run per context, so awaitTranscript can report progress against it. */
const currentStep = new WeakMap<ToolContext, { index: number; count: number }>();

/** Appends `suffix` to the name of a sequence. Best effort: returns false when it could not. */
export async function renameSequenceWithSuffix(ctx: ToolContext, sequenceId: string, suffix: string): Promise<boolean> {
  try {
    const result: any = await ctx.bridge.executeScript(`
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found" });
        sequence.name = String(sequence.name) + ${JSON.stringify(suffix)};
        return JSON.stringify({ success: true, name: String(sequence.name) });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `);
    return result?.success !== false;
  } catch {
    return false;
  }
}

/**
 * Runs the steps in order. Before each step it reports progress and checks the signal; it stops
 * at the first step that is not ok. A cancel never throws out of here: it returns
 * `cancelled: true`, and any sequence the run already created is renamed so it is not mistaken
 * for a finished result.
 */
export async function runSteps(ctx: ToolContext, steps: WorkflowStep[]): Promise<WorkflowResult> {
  const result: WorkflowResult = { success: true, steps: [], summary: {}, outputSequenceIds: [], warnings: [] };
  const created: string[] = [];
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      throwIfAborted(ctx.signal);
      currentStep.set(ctx, { index: i + 1, count: steps.length });
      ctx.progress?.(i + 1, steps.length, step.label);
      let outcome: StepOutcome;
      try {
        outcome = await step.run();
      } catch (error) {
        if (isCancel(error)) throw error;
        outcome = {
          ok: false,
          detail: { error: error instanceof Error ? error.message : String(error) },
        };
      }
      if (outcome.createdSequenceId) {
        created.push(outcome.createdSequenceId);
        result.outputSequenceIds.push(outcome.createdSequenceId);
      }
      result.steps.push({ label: step.label, ok: outcome.ok, ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}) });
      if (!outcome.ok) {
        result.success = false;
        result.nextStep = outcome.nextStep ?? `Bước "${step.label}" lỗi. Sửa lỗi rồi chạy lại.`;
        break;
      }
    }
  } catch (error) {
    if (!isCancel(error)) throw error;
    result.success = false;
    result.cancelled = true;
    result.nextStep = 'Đã hủy theo yêu cầu.';
    const suffix = ctx.signal?.reason === 'panel-closed' ? PANEL_CLOSED_SUFFIX : CANCELLED_SUFFIX;
    for (const id of created) {
      if (!(await renameSequenceWithSuffix(ctx, id, suffix))) {
        result.warnings.push(`Không đổi tên được sequence ${id}; kiểm tra và xóa tay nếu không cần.`);
      }
    }
  } finally {
    currentStep.delete(ctx);
  }
  return result;
}

/** Waits `ms`, or throws `cancelled` as soon as the signal aborts. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Loads the transcript, waiting while the background job runs: polls every `pollMs` (3 s),
 * reports `"<label> NN%"` as the step label and honours the signal.
 */
export async function awaitTranscript(
  ctx: ToolContext,
  args: TranscriptArgs,
  label: string,
  opts: { pollMs?: number } = {},
): Promise<TranscriptReady | { success: false; error: string }> {
  const pollMs = opts.pollMs ?? TRANSCRIPT_POLL_MS;
  for (;;) {
    throwIfAborted(ctx.signal);
    const loaded = await loadTranscript(ctx, args);
    if ('success' in loaded) return loaded;
    if (loaded.status === 'done') return loaded;
    const step = currentStep.get(ctx) ?? { index: 1, count: 1 };
    ctx.progress?.(step.index, step.count, `${label} ${Math.round(loaded.progress * 100)}%`);
    await wait(pollMs, ctx.signal);
  }
}

/** A sequence name not used yet: "name", then "name (2)", "name (3)", ... Accents, "/" and ":" are kept. */
export async function uniqueSequenceName(ctx: ToolContext, wanted: string): Promise<string> {
  const result: any = await ctx.bridge.executeScript(`
    try {
      var names = [];
      for (var i = 0; i < app.project.sequences.numSequences; i++) names.push(String(app.project.sequences[i].name));
      return JSON.stringify({ success: true, names: names });
    } catch (e) {
      return JSON.stringify({ success: false, error: e.toString() });
    }
  `);
  const taken = new Set<string>(Array.isArray(result?.names) ? result.names : []);
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const candidate = `${wanted} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}
