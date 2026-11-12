/**
 * find_fillers_and_retakes: read-only. Lists the filler words and stumbled
 * sentences (retakes) of a transcribed sequence that are safe to cut, with each
 * cut edge moved onto the quietest nearby audio so a cut lands in a gap.
 * Detection is pure (src/analysis/fillers.ts); this file adds the transcript,
 * the clip mapping and the RMS measurement.
 */
import { z } from 'zod';
import type { ToolContext, ToolModule } from '../context.js';
import { cached } from '../../analysis/cache.js';
import { ffmpegMissingResult, findFfTool, runFf } from '../../analysis/ffmpeg.js';
import { findFillerRanges, findIsolatedUtterances, findRetakeRanges, snapEdges, type FillerRange } from '../../analysis/fillers.js';
import { loadFillerLexicon } from '../../analysis/fillers-vi.js';
import { parseMetric, type FrameSample } from '../../analysis/roughcut.js';
import { ENGINE_IDS } from '../../analysis/asr-engines.js';
import type { SequenceClip } from '../../analysis/cleanup.js';
import { isError, readSequence } from './cleanup.js';
import { loadTranscript, type TranscriptArgs, type TranscriptPending } from './shorts.js';

/** Longer than this, a single recognised word is almost surely swallowed speech. */
const LONG_WORD_SEC = 1.5;

export type FindFillersArgs = TranscriptArgs & {
  tiers?: Array<'A' | 'B'> | undefined;
  retakes: boolean;
  minPauseMs: number;
};

export interface FindFillersResult {
  success: true;
  sequenceId: string;
  fingerprint: string;
  tiers: Array<'A' | 'B'>;
  ranges: FillerRange[];
  removedSeconds: number;
  skippedClips: Array<{ clipId: string; reason: string }>;
  warnings: string[];
}

const SNAP_WINDOW_SEC = 0.08;
/** Extra media read around a clip's ranges so the snap window is always covered. */
const RMS_PAD_SEC = 0.2;
const SPEED_TOLERANCE = 0.01;
/** Window of astats: 221 samples at 22.05 kHz is 10 ms. */
const RMS_FILTER = 'aresample=22050,asetnsamples=n=221:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-';
const RMS_KEY = 'lavfi.astats.Overall.RMS_level';
const SILENT_DB = -120;

/** RMS in source time over [from, to] of one media file, cached per whole-second span. */
async function sourceRms(ffmpeg: string, mediaPath: string, from: number, to: number): Promise<FrameSample[]> {
  const a = Math.max(0, Math.floor(from));
  const b = Math.ceil(to);
  return cached(mediaPath, 'rms10ms', { from: a, to: b }, async () => {
    const run = await runFf(ffmpeg, [
      '-hide_banner', '-nostats', '-ss', String(a), '-t', String(b - a), '-i', mediaPath, '-vn', '-ac', '1', '-af', RMS_FILTER, '-f', 'null', '-',
    ]);
    if (run.code !== 0) throw new Error(`ffmpeg could not read ${mediaPath}: ${run.stderr.slice(-200)}`);
    // Digital silence prints "-inf"; read it as a very low level.
    return parseMetric(run.stdout.replace(/=-?inf/gi, `=${SILENT_DB}`), RMS_KEY).map((s) => ({ t: s.t + a, v: s.v }));
  });
}

const unionLength = (ranges: FillerRange[]): number => {
  let total = 0;
  let end = -Infinity;
  for (const r of [...ranges].sort((x, y) => x.start - y.start)) {
    const from = Math.max(r.start, end);
    if (r.end > from) total += r.end - from;
    end = Math.max(end, r.end);
  }
  return total;
};

export async function findFillersAndRetakes(
  ctx: ToolContext,
  args: FindFillersArgs,
): Promise<FindFillersResult | TranscriptPending | { success: false; error: string }> {
  const loaded = await loadTranscript(ctx, args);
  if ('success' in loaded) return loaded;
  if (loaded.status === 'running') {
    return {
      success: true,
      ...loaded,
      nextStep: 'Transcription is running in the background. Call find_fillers_and_retakes again with the same arguments to check progress.',
    } as never;
  }

  const snapshot = await readSequence(ctx, args.sequenceId);
  if (isError(snapshot)) return { success: false, error: snapshot.error };

  const warnings = [...loaded.warnings];
  const hasVideo = snapshot.clips.some((c) => c.trackType === 'video');
  const tiers: Array<'A' | 'B'> = args.tiers && args.tiers.length > 0 ? args.tiers : hasVideo ? ['A'] : ['A', 'B'];

  const lexicon = await loadFillerLexicon();
  if (lexicon.warning) warnings.push(lexicon.warning);
  let ranges: FillerRange[] = findFillerRanges(loaded.words, loaded.sentences, lexicon, { tiers, minPauseSec: args.minPauseMs / 1000 });
  if (args.retakes) ranges.push(...findRetakeRanges(loaded.sentences, loaded.words, { windowSec: 10, jaccard: 0.6 }));
  // Narration only (no video): a lone short word between long pauses is a stray sound.
  if (!hasVideo) ranges.push(...findIsolatedUtterances(loaded.words, loaded.sentences, { maxSec: 0.6, minGapSec: 0.5 }));
  // A "word" lasting seconds means the recogniser swallowed speech, typically a
  // re-read passage (live: Whisper stretched "như" over 9.18 s across a retake).
  for (const w of loaded.words) {
    if (w.end - w.start > LONG_WORD_SEC) {
      const at = `${Math.floor(w.start / 60)}:${String(Math.floor(w.start % 60)).padStart(2, '0')}`;
      warnings.push(`Nhận dạng giọng nói có thể đã bỏ sót lời quanh ${at} (từ "${w.w.trim()}" kéo dài ${(w.end - w.start).toFixed(1)} giây). Nghe lại đoạn này; nếu có câu đọc lặp, chạy lại với engine zipformer-68m.`);
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);

  const found = [...ranges];
  // Each range belongs to the dialogue clip that holds it; a clip we cannot map exactly is never cut.
  const dialogue = snapshot.clips.filter((c) => c.trackType === 'audio' && loaded.dialogueTrackIndices.includes(c.trackIndex));
  const tolerance = snapshot.frameDuration;
  const skipped = new Map<string, string>();
  const byClip = new Map<string, { clip: SequenceClip; ranges: FillerRange[] }>();
  let unmapped = 0;
  const kept: FillerRange[] = [];
  for (const range of ranges) {
    const clip = dialogue.find((c) => range.start >= c.start - tolerance && range.end <= c.end + tolerance);
    if (!clip) { unmapped++; continue; }
    const length = clip.end - clip.start;
    const sourceLength = clip.outPoint - clip.inPoint;
    if (!clip.mediaPath) { skipped.set(clip.id, 'no analysable media file'); continue; }
    if (length <= 0 || Math.abs(sourceLength / length - 1) > SPEED_TOLERANCE) { skipped.set(clip.id, 'speed changed'); continue; }
    kept.push(range);
    const entry = byClip.get(clip.id) ?? { clip, ranges: [] };
    entry.ranges.push(range);
    byClip.set(clip.id, entry);
  }
  if (skipped.size > 0) {
    warnings.push(`Bỏ qua ${skipped.size} clip có tốc độ khác 100% hoặc không có file media; không cắt gì trên các clip này.`);
  }
  if (unmapped > 0) {
    warnings.push(`Bỏ ${unmapped} khoảng nằm vắt qua ranh giới clip thoại; không cắt các khoảng này.`);
  }
  ranges = kept;

  if (ranges.length > 0) {
    const ffmpeg = await findFfTool('ffmpeg');
    if (!ffmpeg) return ffmpegMissingResult('find_fillers_and_retakes') as never;
    // Words that stay in the audio: an edge never snaps into one of them.
    const keptWords = loaded.words.filter((w) => {
      const mid = (w.start + w.end) / 2;
      return !found.some((r) => mid >= r.start && mid <= r.end);
    });
    const boundsFor = (r: FillerRange): { lo: number; hi: number } => ({
      lo: Math.max(-Infinity, ...keptWords.filter((w) => w.start < r.start).map((w) => w.end)),
      hi: Math.min(Infinity, ...keptWords.filter((w) => w.end > r.end).map((w) => w.start)),
    });
    // Only the media around each clip's ranges is measured, not the whole file. Each range snaps
    // against the samples of the clip that owns it, never another mic's.
    const snapped = new Map<FillerRange, FillerRange>();
    for (const { clip, ranges: mine } of byClip.values()) {
      const toSource = (t: number): number => clip.inPoint + (t - clip.start);
      const from = Math.max(clip.inPoint, toSource(Math.min(...mine.map((r) => r.start))) - RMS_PAD_SEC);
      const to = Math.min(clip.outPoint, toSource(Math.max(...mine.map((r) => r.end))) + RMS_PAD_SEC);
      const samples: FrameSample[] = [];
      try {
        const rms = await sourceRms(ffmpeg, clip.mediaPath!, from, to);
        for (const s of rms) {
          if (s.t < clip.inPoint || s.t > clip.outPoint) continue; // snap only inside this clip's media
          samples.push({ t: clip.start + (s.t - clip.inPoint), v: s.v });
        }
      } catch (error) {
        warnings.push(`Không đo được mức âm thanh của ${clip.mediaPath}, giữ nguyên mép cắt: ${error instanceof Error ? error.message : String(error)}`);
      }
      const result = snapEdges(mine, samples, SNAP_WINDOW_SEC, mine.map(boundsFor));
      mine.forEach((r, i) => snapped.set(r, result[i]!));
    }
    ranges = ranges.map((r) => snapped.get(r) ?? r);
  }

  return {
    success: true,
    sequenceId: loaded.sequenceId,
    fingerprint: loaded.fingerprint,
    tiers,
    ranges,
    removedSeconds: Math.round(unionLength(ranges) * 1000) / 1000,
    skippedClips: [...skipped].map(([clipId, reason]) => ({ clipId, reason })),
    warnings: [...new Set(warnings)],
  };
}

export const fillersTools: ToolModule[] = [
  {
    name: 'find_fillers_and_retakes',
    description:
      'Finds Vietnamese filler words and retakes (a sentence the speaker restarts within 10 s) that are safe to cut, from the transcript of transcribe_sequence (returns status "running" until it is done). Words that carry meaning (tier C) are never returned. Tiers default to ["A"] when the sequence has a video clip, otherwise ["A","B"]. Each range edge is moved to the quietest audio within 80 ms (ffmpeg RMS, 10 ms window). Clips with changed speed or no media file are listed in skippedClips and none of their ranges are returned. Read-only: pass the ranges to remove_ranges to cut them. Needs the analysis sidecar and ffmpeg.',
    inputSchema: z.object({
      sequenceId: z.string().optional().describe('Sequence ID. Defaults to the active sequence.'),
      dialogueTrackIndices: z.array(z.number().int().min(0)).optional().describe('Audio track indices that carry speech; use the same value as transcribe_sequence. Defaults to every audio track that has a clip with a media file.'),
      glossary: z.array(z.string()).optional().describe('Names and terms to bias recognition toward; use the same list as transcribe_sequence.'),
      engine: z.enum(ENGINE_IDS).optional().describe('Speech engine; use the same value as transcribe_sequence.'),
      tiers: z.array(z.enum(['A', 'B'])).optional().describe('Filler tiers to cut. Default ["A"] when the sequence has a video clip, otherwise ["A","B"]. Tier B words are cut only before a pause or when repeated.'),
      retakes: z.boolean().default(true).describe('Also return sentences the speaker restarts (default true).'),
      minPauseMs: z.number().int().min(0).default(150).describe('Pause in ms next to a filler that makes it safe to cut (default 150).'),
    }),
    run: (ctx, args) => findFillersAndRetakes(ctx, args),
  },
];
