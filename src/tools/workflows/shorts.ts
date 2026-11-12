/**
 * workflow_shorts: transcribe, find highlight windows, take the N best that do not overlap in
 * time and build one vertical short from each. Sources are never touched; every short is a new
 * sequence, and when one fails the earlier ones are kept.
 */
import type { ToolContext } from '../context.js';
import type { CaptionPosition, CaptionSize, CaptionStyleId } from '../../analysis/caption-looks.js';
import { isError } from '../domains/cleanup.js';
import { ensureBackup } from '../domains/editing.js';
import { buildShort, findHighlightCandidates, type TranscriptArgs } from '../domains/shorts.js';
import { awaitTranscript, failure, resolveSource, runSteps, uniqueSequenceName, type WorkflowResult, type WorkflowStep } from './steps.js';

export interface ShortsArgs extends TranscriptArgs {
  count: number;
  minSec: number;
  maxSec: number;
  captionStyle: CaptionStyleId;
  captionAccent?: string | undefined;
  captionPosition?: CaptionPosition | undefined;
  captionSize?: CaptionSize | undefined;
  dryRun: boolean;
  backup: boolean;
}

const SHORT_LUFS = -14;
// Many windows end mid-sentence or on a hand-over and are dropped, so draw from a wide pool.
const MIN_CANDIDATE_POOL = 60;

interface Pickable {
  start: number;
  end: number;
  rawScore: number;
}

/**
 * Up to `n` picks in total: the highest rawScore candidates, best first, skipping any that
 * overlaps one already taken (including those in `taken`). Returns `taken` plus the new picks.
 */
export function pickNonOverlapping<T extends Pickable>(cands: T[], n: number, taken: T[] = []): T[] {
  const picked: T[] = [...taken];
  for (const cand of [...cands].sort((a, b) => b.rawScore - a.rawScore || a.start - b.start)) {
    if (picked.length >= n) break;
    if (picked.some((p) => cand.start < p.end && p.start < cand.end)) continue;
    picked.push(cand);
  }
  return picked;
}

/**
 * A short may open on a question (a good hook) but must not end on one, mid-sentence, or on the host
 * handing over to a guest. Live on FINAL_01, short 1 ended on "Xin được mời … bác sĩ …
 * giải đáp cho khán giả ạ" with the answer cut off.
 */
export function endsIncomplete(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.normalize('NFC').trim();
  // A final question, or a sentence cut mid-way on a comma.
  if (/[?,;:][^\p{L}\p{N}]*$/u.test(t)) return true;
  // Last sentence only, and at most its last 30 words when ASR left no punctuation.
  const tail = (t.split(/(?<=[.!?…])\s+/u).pop() ?? t).split(/\s+/u).slice(-30).join(' ');
  // "giải đáp" is often heard as "dạy đáp" / "giải giáp".
  const answer = '(giải đáp|dạy đáp|giải giáp|trả lời|chia sẻ|phân tích|cho biết|nói rõ)';
  const asking = new RegExp(`(^|\\s)(mời|nhờ|đề nghị)\\s.*${answer}`, 'iu');
  const toAudience = new RegExp(`${answer}\\s.*(cho|với)\\s(quý vị\\s)?(khán giả|người xem)`, 'iu');
  return asking.test(tail) || toAudience.test(tail);
}

/**
 * Ends on a full stop. ASR punctuates unevenly (on FINAL_01 only 6 of 60 windows end on one), so
 * an unpunctuated end is not proof of a cut sentence; these windows are simply preferred.
 */
export function endsOnSentence(text: string | undefined): boolean {
  return /[.!…][^\p{L}\p{N}]*$/u.test((text ?? '').normalize('NFC').trim());
}

interface ShortCandidate extends Pickable {
  startSentenceId: number;
  endSentenceId: number;
  text?: string;
}

export async function workflowShorts(ctx: ToolContext, args: ShortsArgs): Promise<WorkflowResult> {
  const warnings: string[] = [];
  const summary: Record<string, unknown> = {};
  let sourceId = args.sequenceId;
  let sourceName = '';
  let fingerprint: string | undefined;
  let picks: ShortCandidate[] = [];

  const transcribe: WorkflowStep = {
    label: 'Nhận dạng giọng nói',
    run: async () => {
      const source = await resolveSource(ctx, args);
      if (isError(source)) return failure(source.error);
      sourceId = source.sequenceId;
      sourceName = source.sequenceName;
      const transcript = await awaitTranscript(ctx, { ...args, sequenceId: sourceId }, 'Nhận dạng giọng nói');
      if ('success' in transcript) return failure(transcript.error);
      if (transcript.words.length === 0) return failure('Transcript rỗng (không có lời thoại), không tìm được đoạn nổi bật.');
      return { ok: true, detail: { words: transcript.words.length } };
    },
  };

  const find: WorkflowStep = {
    label: 'Tìm đoạn nổi bật',
    run: async () => {
      const found: any = await findHighlightCandidates(ctx, {
        sequenceId: sourceId,
        dialogueTrackIndices: args.dialogueTrackIndices,
        glossary: args.glossary,
        engine: args.engine,
        minSec: args.minSec,
        maxSec: args.maxSec,
        limit: Math.max(MIN_CANDIDATE_POOL, args.count * 4),
        detectFaces: false,
      });
      if (!found || found.success === false) return failure(found?.error ?? 'Không tìm được đoạn nổi bật.');
      if (!Array.isArray(found.candidates)) return failure('Transcript chưa sẵn sàng.');
      if (Array.isArray(found.warnings)) warnings.push(...found.warnings);
      fingerprint = found.fingerprint;
      const candidates = found.candidates as ShortCandidate[];
      // Prefer windows that end on a full stop, then any that do not end incomplete; take an
      // incomplete one only when nothing else fits.
      const complete = candidates.filter((c) => !endsIncomplete(c.text));
      picks = pickNonOverlapping(complete.filter((c) => endsOnSentence(c.text)), args.count);
      picks = pickNonOverlapping(complete, args.count, picks);
      const before = picks.length;
      picks = pickNonOverlapping(candidates, args.count, picks);
      if (picks.length > before) {
        warnings.push('Không đủ đoạn trọn ý; có short kết thúc bằng câu hỏi, giữa câu hoặc lời mời trả lời.');
      }
      if (picks.length === 0) return failure(`Không có đoạn nào dài ${args.minSec}-${args.maxSec} giây.`);
      if (picks.length < args.count) warnings.push(`Chỉ chọn được ${picks.length}/${args.count} đoạn không chồng thời gian.`);
      summary.candidates = candidates.length;
      summary.picks = picks.map((p) => ({
        start: p.start,
        end: p.end,
        rawScore: p.rawScore,
        startSentenceId: p.startSentenceId,
        endSentenceId: p.endSentenceId,
        text: p.text,
      }));
      return { ok: true, detail: { candidates: candidates.length, picked: picks.length } };
    },
  };

  const backup: WorkflowStep = {
    label: 'Sao lưu project',
    run: async () => {
      const saved = await ensureBackup(ctx, args.backup);
      if ('failure' in saved) return failure(saved.failure);
      if (saved.path) summary.backupPath = saved.path;
      return { ok: true, detail: { backupPath: saved.path } };
    },
  };

  const builds: WorkflowStep[] = Array.from({ length: args.count }, (_, i) => ({
    label: `Dựng short ${i + 1}/${args.count}`,
    run: async () => {
      const pick = picks[i];
      if (!pick) return { ok: true, detail: { skipped: 'không còn đoạn nào để dựng' } };
      const name = await uniqueSequenceName(ctx, `${sourceName} - short ${i + 1}`);
      const built: any = await buildShort(ctx, {
        sequenceId: sourceId,
        dialogueTrackIndices: args.dialogueTrackIndices,
        glossary: args.glossary,
        engine: args.engine,
        expectedFingerprint: fingerprint,
        startSentenceId: pick.startSentenceId,
        endSentenceId: pick.endSentenceId,
        name,
        captionStyle: args.captionStyle,
        captionAccent: args.captionAccent,
        captionPosition: args.captionPosition,
        captionSize: args.captionSize,
        targetLufs: SHORT_LUFS,
        detectFaces: false,
        dryRun: false,
        backup: false,
      });
      const created = built?.shortSequenceId ? { createdSequenceId: String(built.shortSequenceId) } : {};
      if (Array.isArray(built?.warnings)) warnings.push(...built.warnings.map((w: string) => `Short ${i + 1}: ${w}`));
      if (!built || built.success === false) {
        return {
          ...failure(built?.error ?? `Không dựng được short ${i + 1}.`),
          ...created,
          nextStep: `Short ${i + 1} lỗi; các short trước đó vẫn được giữ.`,
        };
      }
      if (built.verified === false) warnings.push(`Short ${i + 1}: không xác nhận được kết quả sau khi dựng.`);
      const shorts = (summary.shorts as unknown[] | undefined) ?? [];
      shorts.push({ name, sequenceId: built.shortSequenceId, durationSec: built.durationSec, verified: built.verified });
      summary.shorts = shorts;
      return { ok: true, detail: { name, sequenceId: built.shortSequenceId, durationSec: built.durationSec, verified: built.verified }, ...created, complete: true };
    },
  }));

  const result = await runSteps(ctx, args.dryRun ? [transcribe, find] : [transcribe, find, backup, ...builds]);
  result.summary = { ...summary, ...(args.dryRun ? { dryRun: true } : {}) };
  result.warnings = [...new Set([...warnings, ...result.warnings])];
  return result;
}
