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
import { isError, readSequence, type SequenceSnapshot } from './cleanup.js';
import { scoreAll } from './roughcut.js';
import { loadTranscript, median, timelineLoudness, type TranscriptArgs, type TranscriptPending } from './shorts.js';

export type PlanRecapArgs = TranscriptArgs & {
  targetSec: number;
  mode: 'auto' | 'speech' | 'shots';
  minSegmentSec: number;
  maxSegmentSec: number;
};

export interface PlanRecapResult {
  success: true;
  mode: 'speech' | 'shots';
  segments: RecapSegment[];
  candidates: RecapSegment[];
  totalSec: number;
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

const roundSegment = (s: RecapSegment): RecapSegment => ({ ...s, start: round3(s.start), end: round3(s.end), score: round3(s.score) });

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
      const run = bestShotRun(windows, from, to, opts.minSegmentSec, opts.maxSegmentSec);
      if (!run) continue;
      scored.push({
        start: clip.start + run.start - clip.inPoint,
        end: Math.min(clip.end, clip.start + run.end - clip.inPoint),
        score: run.score,
      });
    }
  }
  if (scored.length === 0) warnings.push('Không có shot nào nằm trong phần clip đang dùng; không đề xuất được đoạn nào.');

  const total = snapshot.endTime;
  const segments = planShotRecap(scored, total, opts);
  const candidates = recapCandidates(shotPool(scored, opts), segments, opts);
  const fingerprint = createHash('sha1')
    .update(video.map((c) => [c.id, c.start, c.end, c.inPoint, c.outPoint, c.mediaPath ?? ''].join('|')).sort().join('\n') + '\nrecap-shots')
    .digest('hex');
  return {
    success: true,
    mode: 'shots',
    segments: segments.map(roundSegment),
    candidates: candidates.map(roundSegment),
    totalSec: total,
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
  const shotOpts: RecapOpts = { ...opts, maxSegmentSec: Math.min(opts.maxSegmentSec, SHOT_MAX_SEC) };

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
  const scored = scoreCandidates(windows.map((w) => ({
    ...w,
    text: textOf(w.startSentenceId, w.endSentenceId),
    signals: signalsFor(w, loaded.words, loudness, medianLufs, []),
  })));

  const segments = planSpeechRecap(scored, total, opts);
  if (segments.length === 0 && windows.length > 0) warnings.push('Không chọn được đoạn nào trong giới hạn thời lượng.');
  const candidates = recapCandidates(speechPool(scored), segments, opts);
  return {
    success: true,
    mode: 'speech',
    segments: segments.map(roundSegment),
    candidates: candidates.map(roundSegment),
    totalSec: total,
    fingerprint: loaded.fingerprint,
    warnings: [...new Set(warnings)],
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
];
