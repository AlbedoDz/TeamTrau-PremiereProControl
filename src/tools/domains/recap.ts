/**
 * plan_recap: read-only. Proposes the segments of a recap of a sequence, either whole-sentence
 * stretches of the speech or the best stretches of the shots. build_recap keeps exactly the
 * segments returned here, in order.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ToolContext, ToolModule } from '../context.js';
import { ENGINE_IDS } from '../../analysis/asr-engines.js';
import { detectScenes } from '../../analysis/scenes.js';
import { ffmpegMissingResult, findFfTool } from '../../analysis/ffmpeg.js';
import { candidateWindows, scoreCandidates, signalsFor } from '../../analysis/highlights.js';
import {
  bestShotRun,
  planShotRecap,
  planSpeechRecap,
  recapCandidates,
  shotPool,
  speechCoverage,
  speechPool,
  type RecapOpts,
  type RecapSegment,
  type ScoredShot,
} from '../../analysis/recap.js';
import type { SequenceClip } from '../../analysis/cleanup.js';
import { isError, normalizeLoudness, readSequence, removeRanges, type SequenceSnapshot } from './cleanup.js';
import { ensureBackup, qaSequence } from './editing.js';
import { duplicateSequence } from './sequence.js';
import { uniqueSequenceName } from '../workflows/steps.js';
import { sidecarMissingResult, sidecarPython } from '../../analysis/sidecar.js';
import { scoreAll } from './roughcut.js';
import {
  addAlphaCaptions,
  loadTranscript,
  median,
  reframeToVertical,
  timelineLoudness,
  type TranscriptArgs,
  type TranscriptPending,
  type TranscriptReady,
} from './shorts.js';

export type PlanRecapArgs = TranscriptArgs & {
  targetSec: number;
  mode: 'auto' | 'speech' | 'shots';
  minSegmentSec: number;
  maxSegmentSec: number;
};

export interface PlanRecapResult {
  success: true;
  mode: 'speech' | 'shots';
  segments: Array<{ id?: string | undefined; start: number; end: number; text?: string | undefined; score?: number | undefined }>;
  candidates: RecapSegment[];
  /** Length of the planned recap: the sum of the segments. */
  totalSec: number;
  /** Length of the source sequence. */
  sequenceSec: number;
  fingerprint: string;
  warnings: string[];
}

/** A shot segment is at most this long. */
const SHOT_MAX_SEC = 6;
const SHOT_WINDOW_SEC = 2;
const SCENE_OPTS = { threshold: 0.3, minShotSec: 0.5 };
const MIN_SPEECH_COVERAGE = 0.3;
const SPEED_TOLERANCE = 0.01;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Warns (Vietnamese) when the plan is more than 10% under the target. */
function shortfallWarning(segments: RecapSegment[], targetSec: number, warnings: string[]): void {
  const planned = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  if (planned < targetSec * 0.9) {
    warnings.push(`Chỉ chọn được ${round3(planned)} giây, thấp hơn mục tiêu ${targetSec} giây (dưới 90%).`);
  }
}

const roundSegment = (s: RecapSegment): RecapSegment => ({ ...s, start: round3(s.start), end: round3(s.end), score: round3(s.score) });

/** plan_recap's shots-mode fingerprint: the video clips (ids, positions, source ranges, media). */
function shotsFingerprint(video: SequenceClip[]): string {
  return createHash('sha1')
    .update(video.map((c) => [c.id, c.start, c.end, c.inPoint, c.outPoint, c.mediaPath ?? ''].join('|')).sort().join('\n') + '\nrecap-shots')
    .digest('hex');
}

async function planShots(
  snapshot: SequenceSnapshot,
  opts: RecapOpts,
  warnings: string[],
): Promise<PlanRecapResult | { success: false; error: string } | Record<string, unknown>> {
  const video = snapshot.clips.filter((c) => c.trackType === 'video');
  const lowest = video.length > 0 ? Math.min(...video.map((c) => c.trackIndex)) : null;
  const track = lowest === null ? [] : video.filter((c) => c.trackIndex === lowest);
  const usable: SequenceClip[] = [];
  let noMedia = 0;
  let speedChanged = 0;
  for (const clip of track) {
    const length = clip.end - clip.start;
    if (!clip.mediaPath) noMedia++;
    else if (length <= 0 || Math.abs((clip.outPoint - clip.inPoint) / length - 1) > SPEED_TOLERANCE) speedChanged++;
    else usable.push(clip);
  }
  if (noMedia > 0) warnings.push(`Bỏ qua ${noMedia} clip video không có file media.`);
  if (speedChanged > 0) warnings.push(`Bỏ qua ${speedChanged} clip video đổi tốc độ; không map được thời gian nguồn sang sequence.`);
  if (usable.length === 0) {
    return { success: false, error: 'Không có clip video nào trên track video thấp nhất để chọn shot. Kiểm tra sequence có video.' };
  }

  const paths = [...new Set(usable.map((c) => c.mediaPath!))];
  const all = await scoreAll(paths, SHOT_WINDOW_SEC, 'plan_recap');
  if ('failure' in all) return all.failure;
  for (const f of all.failed) warnings.push(`Không chấm điểm được ${f.mediaPath}: ${f.error}`);
  const windowsByPath = new Map(all.scored.map((f) => [f.mediaPath, f.windows]));

  const shotsByPath = new Map<string, Array<{ start: number; end: number }>>();
  for (const mediaPath of paths) {
    if (!windowsByPath.has(mediaPath)) continue;
    const found = await detectScenes(mediaPath, SCENE_OPTS);
    if ('failure' in found) {
      warnings.push(`Không tách được shot của ${mediaPath}: ${String((found.failure as { error?: unknown }).error ?? 'lỗi không rõ')}`);
      continue;
    }
    shotsByPath.set(mediaPath, found.shots);
  }

  const scored: ScoredShot[] = [];
  for (const clip of [...usable].sort((a, b) => a.start - b.start)) {
    const windows = windowsByPath.get(clip.mediaPath!);
    const shots = shotsByPath.get(clip.mediaPath!);
    if (!windows || !shots) continue;
    for (const shot of shots) {
      // Only the part of the shot the clip actually shows.
      const from = Math.max(shot.start, clip.inPoint);
      const to = Math.min(shot.end, clip.outPoint);
      if (!(to - from > 0)) continue;
      // A short shot is kept whole (so neighbours stay time-adjacent and can form a run); a long
      // one is cut to its best stretch. The score comes from the windows inside it.
      const whole = to - from <= opts.maxSegmentSec;
      const run = bestShotRun(windows, from, to, whole ? to - from : opts.minSegmentSec, opts.maxSegmentSec);
      if (!run) continue;
      const [a, b] = whole ? [from, to] : [run.start, run.end];
      scored.push({
        start: clip.start + a - clip.inPoint,
        end: Math.min(clip.end, clip.start + b - clip.inPoint),
        score: run.score,
      });
    }
  }
  if (scored.length === 0) warnings.push('Không có shot nào nằm trong phần clip đang dùng; không đề xuất được đoạn nào.');

  const total = snapshot.endTime;
  const segments = planShotRecap(scored, total, opts);
  shortfallWarning(segments, opts.targetSec, warnings);
  const candidates = recapCandidates(shotPool(scored, opts), segments, opts);
  const fingerprint = shotsFingerprint(video);
  return {
    success: true,
    mode: 'shots',
    segments: segments.map(roundSegment),
    candidates: candidates.map(roundSegment),
    totalSec: Math.round(segments.reduce((sum, s) => sum + (s.end - s.start), 0) * 1000) / 1000,
    sequenceSec: total,
    fingerprint,
    warnings: [...new Set(warnings)],
  };
}

export async function planRecap(
  ctx: ToolContext,
  args: PlanRecapArgs,
): Promise<PlanRecapResult | TranscriptPending | { success: false; error: string }> {
  const opts: RecapOpts = { targetSec: args.targetSec, minSegmentSec: args.minSegmentSec, maxSegmentSec: args.maxSegmentSec };
  const snapshot = await readSequence(ctx, args.sequenceId);
  if (isError(snapshot)) return { success: false, error: snapshot.error };
  const shotOpts: RecapOpts = { ...opts, maxSegmentSec: Math.min(opts.maxSegmentSec, SHOT_MAX_SEC), frameSec: snapshot.frameDuration };

  if (args.mode === 'shots') return (await planShots(snapshot, shotOpts, [])) as never;

  const audio = snapshot.clips.filter((c) => c.trackType === 'audio');
  const indices = args.dialogueTrackIndices ?? [...new Set(audio.filter((c) => c.mediaPath).map((c) => c.trackIndex))];
  const hasDialogue = audio.some((c) => c.mediaPath && indices.includes(c.trackIndex));
  if (args.mode === 'auto' && !hasDialogue) {
    return (await planShots(snapshot, shotOpts, ['Sequence không có lời thoại; chuyển sang chế độ shots.'])) as never;
  }

  const loaded = await loadTranscript(ctx, args);
  if ('success' in loaded) return loaded;
  if (loaded.status === 'running') {
    return {
      success: true,
      ...loaded,
      nextStep: 'Đang phiên âm nền. Gọi lại plan_recap với cùng tham số để xem tiến độ.',
    } as never;
  }

  const total = loaded.endTime;
  const coverage = speechCoverage(loaded.sentences, total);
  const warnings = [...loaded.warnings];
  if (args.mode === 'auto' && (loaded.sentences.length === 0 || coverage < MIN_SPEECH_COVERAGE)) {
    warnings.push(`Lời thoại chỉ phủ ${Math.round(coverage * 100)}% sequence (dưới 30%); chuyển sang chế độ shots.`);
    return (await planShots(snapshot, shotOpts, warnings)) as never;
  }

  const ffmpeg = await findFfTool('ffmpeg');
  if (!ffmpeg) return ffmpegMissingResult('plan_recap') as never;
  const dialogue = audio.filter((c) => loaded.dialogueTrackIndices.includes(c.trackIndex));
  const windows = candidateWindows(loaded.sentences, opts.minSegmentSec, opts.maxSegmentSec);
  if (windows.length === 0) warnings.push(`Không có cụm câu trọn vẹn nào dài ${opts.minSegmentSec}-${opts.maxSegmentSec} giây.`);
  const loudness = await timelineLoudness(ffmpeg, dialogue, warnings);
  const medianLufs = median(loudness.map((s) => s.v));

  const indexOf = new Map(loaded.sentences.map((s, i) => [s.id, i]));
  const textOf = (startId: number, endId: number): string =>
    loaded.sentences.slice(indexOf.get(startId)!, indexOf.get(endId)! + 1).map((s) => s.text).join(' ');
  // A recap retells content, so a question is only worth keeping with its answer. The
  // highlight scorer rewards questions (good hooks for a short); here that reward is
  // removed, and a window that ENDS on a question is dropped: live on a 69-minute talk
  // show, 11 of 16 picks were the host's unanswered questions.
  const endsOnQuestion = (text: string): boolean => /\?[^\p{L}\p{N}]*$/u.test(text.trim());
  const scored = scoreCandidates(windows
    .map((w) => ({ ...w, text: textOf(w.startSentenceId, w.endSentenceId) }))
    .filter((w) => !endsOnQuestion(w.text))
    .map((w) => ({
      ...w,
      signals: { ...signalsFor(w, loaded.words, loudness, medianLufs, []), hasQuestion: false },
    })));

  const segments = planSpeechRecap(scored, total, opts);
  if (segments.length === 0 && windows.length > 0) warnings.push('Không chọn được đoạn nào trong giới hạn thời lượng.');
  shortfallWarning(segments, opts.targetSec, warnings);
  const candidates = recapCandidates(speechPool(scored), segments, opts);
  return {
    success: true,
    mode: 'speech',
    segments: segments.map(roundSegment),
    candidates: candidates.map(roundSegment),
    totalSec: Math.round(segments.reduce((sum, s) => sum + (s.end - s.start), 0) * 1000) / 1000,
    sequenceSec: total,
    fingerprint: loaded.fingerprint,
    warnings: [...new Set(warnings)],
  };
}

// ---------------------------------------------------------------------------- build_recap

export interface BuildRecapArgs extends TranscriptArgs {
  segments: Array<{ id?: string | undefined; start: number; end: number; text?: string | undefined; score?: number | undefined }>;
  expectedFingerprint?: string | undefined;
  name: string;
  aspect: '16:9' | '9:16';
  captionStyle: 'none' | 'clean' | 'pop' | 'karaoke';
  audioLeadSec: number;
  targetLufs: number;
  dryRun: boolean;
  backup: boolean;
}

export interface BuildRecapResult {
  success: boolean;
  sequenceId?: string;
  durationSec?: number;
  warnings: string[];
  audioLeadSupported: boolean;
  verified?: boolean;
  error?: string;
  dryRun?: boolean;
  backupPath?: string | undefined;
  failedStep?: string;
  qa?: unknown;
}

/** J-cut placement (audio starting before its picture) is not implemented: Task 1's spike was deferred. */
const JCUT_SUPPORTED = false;
const RECAP_CROSSFADE_MS = 30;
const RECAP_MERGE_GAP_SEC = 0.4;
const RECAP_MIN_KEEP_SEC = 0.4;
const MUSIC_MIN_SEC = 30;
const MUSIC_CHOPPED_CUTS = 3;

/** The stretches of [0, total] that the kept segments leave out. */
function gapsBetween(segments: Array<{ start: number; end: number }>, total: number): Array<{ start: number; end: number }> {
  const gaps: Array<{ start: number; end: number }> = [];
  let at = 0;
  for (const s of segments) {
    if (s.start > at) gaps.push({ start: at, end: s.start });
    at = Math.max(at, s.end);
  }
  if (total > at) gaps.push({ start: at, end: total });
  return gaps;
}

/** Source time to recap time, given the removed stretches (sorted); null inside a removed stretch. */
function mapAfterRemoval(removed: Array<{ start: number; end: number }>): (t: number) => number | null {
  return (t) => {
    let shift = 0;
    for (const r of removed) {
      if (t > r.start && t < r.end) return null;
      if (r.end <= t) shift += r.end - r.start;
    }
    return t - shift;
  };
}

/** Deletes a sequence, as the Auto Reframe script deletes its subsequence; true when it is gone. */
async function deleteSequenceById(ctx: ToolContext, sequenceId: string): Promise<boolean> {
  try {
    const result: any = await ctx.bridge.executeScript(`
      // build_recap:delete_copy
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: true, deleted: true });
        return JSON.stringify({ success: true, deleted: app.project.deleteSequence(seq) !== false });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `);
    return !!result && result.success !== false && result.deleted !== false;
  } catch {
    return false;
  }
}

export async function buildRecap(ctx: ToolContext, args: BuildRecapArgs): Promise<BuildRecapResult> {
  const warnings: string[] = [];
  const fail = (error: string, extra: Partial<BuildRecapResult> = {}): BuildRecapResult => ({
    success: false,
    audioLeadSupported: JCUT_SUPPORTED,
    error,
    warnings: [...new Set(warnings)],
    ...extra,
  });

  const snapshot = await readSequence(ctx, args.sequenceId);
  if (isError(snapshot)) return fail(snapshot.error);

  const segments = args.segments;
  if (segments.length === 0) return fail('Danh sách segments rỗng. Gọi plan_recap trước và truyền nguyên các đoạn nó trả về.');
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (!(s.start >= 0) || !(s.end > s.start) || (i > 0 && s.start < segments[i - 1]!.end)) {
      return fail('segments phải theo thứ tự thời gian, không chồng nhau, mỗi đoạn có end > start >= 0. Truyền nguyên các đoạn plan_recap trả về.');
    }
  }

  // Fingerprint: plan_recap returns the transcript fingerprint (speech) or a hash of the video
  // clips (shots). Captions need the transcript anyway, so it is loaded first when wanted.
  const needWords = args.captionStyle !== 'none';
  // Captions are rendered by the sidecar late in the run; check it before anything is changed.
  if (needWords && !(await sidecarPython())) return sidecarMissingResult('build_recap') as unknown as BuildRecapResult;
  let transcript: TranscriptReady | null = null;
  const loadWords = async (): Promise<BuildRecapResult | null> => {
    const loaded = await loadTranscript(ctx, args);
    if ('success' in loaded) return fail((loaded as { error?: string }).error ?? 'Không đọc được transcript.');
    if (loaded.status === 'running') {
      return fail('Transcript chưa xong. Gọi transcribe_sequence với cùng tham số cho đến khi status là "done", rồi gọi lại build_recap.');
    }
    transcript = loaded;
    return null;
  };
  if (needWords) {
    const failure = await loadWords();
    if (failure) return failure;
  }
  if (args.expectedFingerprint === undefined) {
    warnings.push('Nên truyền expectedFingerprint từ plan_recap để phát hiện sequence đã bị sửa sau khi chọn đoạn.');
  } else if (args.expectedFingerprint !== shotsFingerprint(snapshot.clips.filter((c) => c.trackType === 'video'))) {
    if (!transcript) {
      const failure = await loadWords();
      if (failure) return failure;
    }
    if ((transcript as TranscriptReady | null)?.fingerprint !== args.expectedFingerprint) {
      return fail('Sequence đã thay đổi kể từ khi chạy plan_recap. Chạy lại plan_recap.');
    }
  }

  const removedPlan = gapsBetween(segments, snapshot.endTime);
  // Speech is meant to be cut: only non-dialogue audio counts as chopped music. The dialogue tracks
  // are the transcript's, else the caller's, else what the transcript would auto-detect.
  const audioClips = snapshot.clips.filter((c) => c.trackType === 'audio');
  const speechTracks = (transcript as TranscriptReady | null)?.dialogueTrackIndices
    ?? args.dialogueTrackIndices
    ?? [...new Set(audioClips.filter((c) => c.mediaPath).map((c) => c.trackIndex))];
  const chopped = audioClips.filter((c) => {
    if (speechTracks.includes(c.trackIndex) || c.end - c.start <= MUSIC_MIN_SEC) return false;
    return removedPlan.filter((r) => r.start > c.start && r.end < c.end).length >= MUSIC_CHOPPED_CUTS;
  });
  if (chopped.length > 0) {
    warnings.push(`music-chopped: ${chopped.length} clip audio dài trên ${MUSIC_MIN_SEC} giây (nhạc nền) bị cắt thành nhiều đoạn; nhạc sẽ bị ngắt quãng. Cân nhắc đặt nhạc riêng lên recap sau khi dựng.`);
  }
  if (args.audioLeadSec > 0) {
    warnings.push('Chưa hỗ trợ J-cut (âm thanh vào trước hình): audioLeadSec bị bỏ qua, recap dùng cắt thẳng có crossfade âm thanh.');
  }
  const planned = round3(segments.reduce((sum, s) => sum + (s.end - s.start), 0));

  if (args.dryRun) {
    return { success: true, dryRun: true, durationSec: planned, audioLeadSupported: JCUT_SUPPORTED, warnings: [...new Set(warnings)] };
  }

  const backup = await ensureBackup(ctx, args.backup);
  if ('failure' in backup) return fail(String((backup.failure as { error?: unknown }).error ?? 'Không sao lưu được project.'), { failedStep: 'backup' });
  const backupPath = backup.path;
  const withBackup = (extra: Partial<BuildRecapResult>): Partial<BuildRecapResult> => ({ ...(backupPath ? { backupPath } : {}), ...extra });

  const finalName = await uniqueSequenceName(ctx, args.name);
  const vertical = args.aspect === '9:16';
  // The 9:16 reframe makes its own sequence from the cut copy; the copy keeps a plain name.
  const copyName = vertical ? await uniqueSequenceName(ctx, `${finalName} (16:9)`) : finalName;

  // 1. Copy the sequence; the original is never touched.
  const copy: any = await duplicateSequence(ctx, snapshot.sequenceId, copyName);
  if (!copy || copy.success === false || !copy.newSequenceId) {
    return fail(copy?.error ?? 'Không nhân bản được sequence.', withBackup({ failedStep: 'duplicate' }));
  }
  let sequenceId = String(copy.newSequenceId);

  // 2. One remove_ranges call: keep exactly the segments.
  const cut = await removeRanges(ctx, {
    sequenceId,
    ranges: segments.map((s) => ({ start: s.start, end: s.end })),
    invert: true,
    crossfadeMs: RECAP_CROSSFADE_MS,
    mergeGapSec: RECAP_MERGE_GAP_SEC,
    minKeepSec: RECAP_MIN_KEEP_SEC,
    dryRun: false,
    backup: false,
  });
  if (!cut.success) return fail(cut.error ?? 'Không cắt được các khoảng ngoài segments.', withBackup({ failedStep: 'remove_ranges', sequenceId }));
  if (cut.warning) warnings.push(cut.warning);
  const timeMap = mapAfterRemoval([...(cut.removed ?? [])].sort((a, b) => a.start - b.start));

  // 3. 9:16 reframe of the whole cut copy.
  if (vertical) {
    const reframed = await reframeToVertical(ctx, sequenceId, finalName);
    if ('error' in reframed) return fail(reframed.error, withBackup({ failedStep: 'reframe', sequenceId }));
    sequenceId = reframed.sequenceId;
    if (!(await deleteSequenceById(ctx, String(copy.newSequenceId)))) {
      warnings.push(`Không xóa được sequence trung gian "${copyName}"; xóa tay trong project nếu không cần.`);
    }
    if (!reframed.deleted) warnings.push('Không xóa được subsequence trung gian của Auto Reframe; xóa tay trong project.');
  }

  // 4. Captions from the transcript words, moved to recap time.
  const ready = transcript as TranscriptReady | null;
  if (needWords && ready) {
    const captioned = await addAlphaCaptions(ctx, sequenceId, ready.words, args.captionStyle as 'clean' | 'pop' | 'karaoke', timeMap);
    if ('error' in captioned) return fail(captioned.error, withBackup({ failedStep: 'captions', sequenceId }));
    for (const w of captioned.warnings ?? []) warnings.push(w);
  }

  // 5. Loudness and QA on the result.
  // Dialogue tracks only (as build_short), so music is not pushed to the target.
  const dialogueTracks = ready?.dialogueTrackIndices ?? args.dialogueTrackIndices;
  if (!dialogueTracks || dialogueTracks.length === 0) {
    warnings.push('Không biết track thoại nào, nên bỏ qua chỉnh loudness để không đẩy nhạc nền lên mức đích. Truyền dialogueTrackIndices để chỉnh loudness.');
  } else {
    const loudness = await normalizeLoudness(ctx, {
      sequenceId,
      targetLufs: args.targetLufs,
      audioTrackIndices: dialogueTracks,
      dryRun: false,
      backup: false,
    });
    if (!loudness || loudness.success === false) {
      warnings.push(`Chưa chỉnh được loudness về ${args.targetLufs} LUFS: ${loudness?.error ?? 'lỗi không rõ'}`);
    }
  }
  const qa: any = await qaSequence(ctx, { sequenceId, minClipFrames: 6, checkMedia: true });
  if (!qa || qa.success === false) warnings.push(`qa_sequence lỗi: ${qa?.error ?? 'lỗi không rõ'}`);
  else if (qa.errors > 0) warnings.push(`qa_sequence thấy ${qa.errors} lỗi trên recap; xem qa.findings.`);

  // 6. Read the result back.
  const after = await readSequence(ctx, sequenceId);
  if (isError(after)) return fail(after.error, withBackup({ failedStep: 'readback', sequenceId }));
  const durationOk = cut.durationAfter === undefined || Math.abs(after.endTime - cut.durationAfter) <= 2 * after.frameDuration + (vertical ? 0.1 : 0);
  if (!durationOk) warnings.push(`Recap dài ${round3(after.endTime)} giây, dự kiến ${round3(cut.durationAfter ?? 0)} giây.`);
  return {
    success: true,
    sequenceId,
    durationSec: round3(after.endTime),
    audioLeadSupported: JCUT_SUPPORTED,
    verified: cut.verified !== false && durationOk,
    warnings: [...new Set(warnings)],
    ...withBackup({}),
    ...(qa && qa.success !== false ? { qa } : {}),
  };
}

export const recapTools: ToolModule[] = [
  {
    name: 'plan_recap',
    description:
      'Plans a recap of a sequence: returns the segments to keep, in time order, plus extra candidates. Mode "speech" picks runs of whole transcribed sentences (4-20 s each) spread over chapters of about 12 s of the target, dropping near-duplicate passages; mode "shots" picks the best stretch (at most 6 s) of each shot of the clips on the lowest video track, scored by exposure and sharpness. "auto" (default) uses speech when the dialogue covers at least 30% of the sequence, otherwise shots. The total lands within targetSec +/-10%. Speech uses the transcript from transcribe_sequence (returns status "running" until it is done) and ffmpeg loudness; shots need ffmpeg. Segment times are sequence seconds; pass the segments unchanged to build_recap with the returned fingerprint. Read-only.',
    inputSchema: z.object({
      sequenceId: z.string().optional().describe('Sequence ID. Defaults to the active sequence.'),
      dialogueTrackIndices: z.array(z.number().int().min(0)).optional().describe('Audio track indices that carry speech; use the same value as transcribe_sequence. Defaults to every audio track that has a clip with a media file.'),
      glossary: z.array(z.string()).optional().describe('Names and terms to bias recognition toward; use the same list as transcribe_sequence.'),
      engine: z.enum(ENGINE_IDS).optional().describe('Speech engine; use the same value as transcribe_sequence.'),
      targetSec: z.number().positive().default(90).describe('Length of the recap in seconds (default 90).'),
      mode: z.enum(['auto', 'speech', 'shots']).default('auto').describe('auto (default) picks speech when the dialogue covers at least 30% of the sequence, else shots.'),
      minSegmentSec: z.number().positive().default(4).describe('Shortest segment in seconds (default 4).'),
      maxSegmentSec: z.number().positive().default(20).describe('Longest segment in seconds (default 20; shot segments are capped at 6).'),
    }).refine((a) => a.minSegmentSec <= a.maxSegmentSec, { message: 'minSegmentSec must not exceed maxSegmentSec.' }),
    run: (ctx, args) => planRecap(ctx, args),
  },
  {
    name: 'build_recap',
    description:
      'Builds a recap sequence from the segments of plan_recap. Never edits the original: backs up the project, duplicates the sequence, keeps exactly the given segments with one remove_ranges call (30 ms audio crossfades), optionally Auto Reframes to 9:16 (aspect "9:16"), burns transcript captions (captionStyle clean/pop/karaoke; needs transcribe_sequence done), normalises loudness to targetLufs and runs qa_sequence, then reads the result back (verified). Pass the segments and fingerprint from plan_recap unchanged; a changed sequence is refused. Warns with "music-chopped" when a long audio clip (background music) would be cut into 3+ pieces. audioLeadSec (J-cut) is not supported yet: the result has audioLeadSupported false and builds hard cuts. The new sequence name gets " (2)", " (3)" ... when taken. dryRun=true only validates and reports the planned length.',
    inputSchema: z.object({
      sequenceId: z.string().optional().describe('Sequence ID. Defaults to the active sequence.'),
      dialogueTrackIndices: z.array(z.number().int().min(0)).optional().describe('Audio track indices that carry speech; use the same value as plan_recap. Also the tracks loudness is applied to.'),
      glossary: z.array(z.string()).optional().describe('Names and terms; use the same list as plan_recap.'),
      engine: z.enum(ENGINE_IDS).optional().describe('Speech engine; use the same value as plan_recap.'),
      segments: z.array(z.object({
        id: z.string().optional(),
        start: z.number(),
        end: z.number(),
        text: z.string().optional(),
        score: z.number().default(0),
      })).min(1).describe('The segments from plan_recap (sequence seconds), in time order. Pass them unchanged, or drop ones you do not want.'),
      expectedFingerprint: z.string().optional().describe('fingerprint returned by plan_recap. If the sequence changed since, build_recap refuses.'),
      name: z.string().min(1).describe('Name of the new sequence.'),
      aspect: z.enum(['16:9', '9:16']).default('16:9').describe('"9:16" reframes the recap to vertical with Auto Reframe; "16:9" (default) keeps the source frame.'),
      captionStyle: z.enum(['none', 'clean', 'pop', 'karaoke']).default('none').describe('Burned-in alpha captions from the transcript. Default none.'),
      audioLeadSec: z.number().min(0).max(2).default(0).describe('J-cut lead in seconds. Not supported yet: values above 0 are ignored with a warning.'),
      targetLufs: z.number().min(-30).max(-6).default(-14).describe('Loudness target (default -14).'),
      dryRun: z.boolean().default(false).describe('Only validate and report the planned length; changes nothing.'),
      backup: z.boolean().default(true).describe('Back up the project first (default true).'),
    }),
    run: (ctx, args) => buildRecap(ctx, args),
  },
];
