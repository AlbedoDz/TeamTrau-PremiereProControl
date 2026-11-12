/**
 * Shared frame of the workflow_* tools: a step runner that reports progress and stops
 * cleanly on cancel, a transcript wait that polls the background job, and the helpers
 * for naming the sequences a workflow creates. Workflows never modify the source sequence.
 */
import { throwIfAborted, type ToolContext } from '../context.js';
import { readSequence, type SequenceSnapshot } from '../domains/cleanup.js';
import { loadTranscript, type TranscriptArgs, type TranscriptReady } from '../domains/shorts.js';

export interface StepOutcome {
  ok: boolean;
  detail?: unknown;
  nextStep?: string;
  /**
   * Sequence this step created. Unless it is `complete`, it is renamed with a suffix when the
   * run is cancelled or fails later. A later step may name the same id again with
   * `complete: true` once it has finished building it.
   */
  createdSequenceId?: string;
  /** The sequence is a finished output (a built short, a recap, a cut copy). */
  complete?: boolean;
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
  /** Created sequences that were left unfinished by a cancel or a failure (renamed). */
  partialSequenceIds: string[];
  warnings: string[];
  cancelled?: boolean;
  nextStep?: string;
}

/** Suffix of a sequence left behind by a cancelled run. */
export const CANCELLED_SUFFIX = ' (đã hủy)';
export const PANEL_CLOSED_SUFFIX = ' (dang dở)';
/** Suffix of a sequence left behind by a step that failed after creating it. */
export const FAILED_SUFFIX = ' (lỗi)';
export const TRANSCRIPT_POLL_MS = 3000;

const isCancel = (error: unknown): boolean => error instanceof Error && error.message === 'cancelled';

/**
 * The step being run per context, so awaitTranscript can report progress against it, and the
 * last progress value sent (MCP progress must rise with every notification).
 */
const currentStep = new WeakMap<ToolContext, { index: number; count: number; last: number }>();

/** Highest fraction of a step a wait may report, so the next step's start is still higher. */
const MAX_STEP_FRACTION = 0.99;

/**
 * Reports a wait inside the current step: progress `index - 1 + fraction` (fraction capped below
 * 1), always above the value sent before; the label carries the percentage.
 */
function reportWait(ctx: ToolContext, label: string, fraction: number): void {
  const step = currentStep.get(ctx) ?? { index: 1, count: 1, last: -1 };
  const base = step.index - 1;
  const ceiling = base + MAX_STEP_FRACTION;
  const f = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0;
  let value = base + Math.min(f, MAX_STEP_FRACTION);
  // A wait that has not advanced still has to send a higher number than the last one.
  if (value <= step.last) value = step.last + (ceiling - step.last) / 100;
  if (value <= step.last) return;
  step.last = value;
  ctx.progress?.(value, step.count, `${label} ${Math.round(f * 100)}%`);
}

/**
 * The source sequence of a workflow, resolved once: `args.sequenceId`, else the sequence active
 * now. Every later call gets the resolved id, so a sequence the editor opens while the workflow
 * waits is never picked up.
 */
export async function resolveSource(
  ctx: ToolContext,
  args: { sequenceId?: string | undefined },
): Promise<SequenceSnapshot | { error: string }> {
  return readSequence(ctx, args.sequenceId);
}

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
 * Runs the steps in order. Before each step it reports progress (the number of steps already
 * done) and checks the signal; it stops at the first step that is not ok. A cancel never throws
 * out of here: it returns `cancelled: true`. On a cancel or a failure every created sequence that
 * is not `complete` is renamed (" (đã hủy)", " (dang dở)" or " (lỗi)") so it is not mistaken for a
 * finished result, and listed in `partialSequenceIds`.
 */
export async function runSteps(ctx: ToolContext, steps: WorkflowStep[]): Promise<WorkflowResult> {
  const result: WorkflowResult = { success: true, steps: [], summary: {}, outputSequenceIds: [], partialSequenceIds: [], warnings: [] };
  const created: Array<{ id: string; complete: boolean }> = [];
  let suffix: string | null = null;
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      throwIfAborted(ctx.signal);
      currentStep.set(ctx, { index: i + 1, count: steps.length, last: i });
      ctx.progress?.(i, steps.length, step.label);
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
        const known = created.find((c) => c.id === outcome.createdSequenceId);
        if (known) {
          known.complete ||= outcome.ok && outcome.complete === true;
        } else {
          created.push({ id: outcome.createdSequenceId, complete: outcome.ok && outcome.complete === true });
          result.outputSequenceIds.push(outcome.createdSequenceId);
        }
      }
      result.steps.push({ label: step.label, ok: outcome.ok, ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}) });
      if (!outcome.ok) {
        result.success = false;
        result.nextStep = outcome.nextStep ?? `Bước "${step.label}" lỗi. Sửa lỗi rồi chạy lại.`;
        suffix = FAILED_SUFFIX;
        break;
      }
    }
  } catch (error) {
    if (!isCancel(error)) throw error;
    result.success = false;
    result.cancelled = true;
    result.nextStep = 'Đã hủy theo yêu cầu.';
    suffix = ctx.signal?.reason === 'panel-closed' ? PANEL_CLOSED_SUFFIX : CANCELLED_SUFFIX;
  } finally {
    currentStep.delete(ctx);
  }
  if (suffix !== null) {
    for (const { id, complete } of created) {
      if (complete) continue;
      result.partialSequenceIds.push(id);
      if (!(await renameSequenceWithSuffix(ctx, id, suffix))) {
        result.warnings.push(`Không đổi tên được sequence ${id}; kiểm tra và xóa tay nếu không cần.`);
      }
    }
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
    reportWait(ctx, label, loaded.progress);
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

/** A failed step outcome from an error string or an `{ error }` result. */
export function failure(error: unknown): StepOutcome {
  return {
    ok: false,
    detail: { error: typeof error === 'string' ? error : String((error as { error?: unknown })?.error ?? 'Lỗi không rõ.') },
  };
}

/**
 * Calls `fn` until its result no longer says `status: "running"` (a background transcription
 * that a planner started), reporting `"<label> NN%"` and honouring the signal while it waits.
 */
export async function awaitPending<T>(
  ctx: ToolContext,
  label: string,
  fn: () => Promise<T>,
  opts: { pollMs?: number } = {},
): Promise<T> {
  const pollMs = opts.pollMs ?? TRANSCRIPT_POLL_MS;
  for (;;) {
    throwIfAborted(ctx.signal);
    const result: any = await fn();
    if (result?.status !== 'running') return result;
    reportWait(ctx, label, Number(result.progress ?? 0));
    await wait(pollMs, ctx.signal);
  }
}
