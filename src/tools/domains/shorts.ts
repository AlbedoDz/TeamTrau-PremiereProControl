/**
 * Podcast to shorts. transcribe_sequence turns the dialogue audio of a sequence into a
 * word-level Vietnamese transcript on sequence time. Speech recognition runs in the Python
 * sidecar as one background job per media file; the tool is polled until every job is done.
 */
import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ToolContext, ToolModule } from '../context.js';
import {
  jobStatus,
  modelPaths,
  premiereMcpHome,
  sidecarMissingResult,
  sidecarPython,
  startJob,
  runSidecar,
  type JobState,
} from '../../analysis/sidecar.js';
import { cached } from '../../analysis/cache.js';
import { ffmpegMissingResult, findFfTool, parseShortTermLoudness, runFf } from '../../analysis/ffmpeg.js';
import { candidateWindows, pickDiverse, scoreCandidates, signalsFor } from '../../analysis/highlights.js';
import type { FrameSample } from '../../analysis/roughcut.js';
import {
  clipFingerprint,
  dedupeOverlaps,
  mapWordsToTimeline,
  repairTimestamps,
  splitSentences,
  type AsrWord,
  type Sentence,
  type TimelineWord,
} from '../../analysis/transcript.js';
import { isError, readSequence, uniquePaths, type SequenceSnapshot } from './cleanup.js';

/** The speech model; part of every transcription job key so changing it never reuses an old result. */
export const ASR_MODEL = 'large-v3-turbo';

export interface TranscriptArgs {
  sequenceId?: string | undefined;
  dialogueTrackIndices?: number[] | undefined;
  glossary?: string[] | undefined;
}

export interface TranscriptReady {
  status: 'done';
  sequenceId: string;
  fingerprint: string;
  words: TimelineWord[];
  sentences: Sentence[];
  warnings: string[];
  endTime: number;
  frameDuration: number;
}

export interface TranscriptPending {
  status: 'running';
  progress: number;
  etaSec?: number;
  files: number;
}

interface TranscribeResult {
  words?: AsrWord[];
  device?: string;
  computeType?: string;
  durationSec?: number;
}

const fileStamp = (path: string): string | null => {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
};

const SKIP_REASON: Record<string, string> = {
  speed_changed: 'its speed is not 100%',
  no_media: 'it has no media file',
};

export async function loadTranscript(
  ctx: ToolContext,
  args: TranscriptArgs,
): Promise<TranscriptReady | TranscriptPending | { success: false; error: string }> {
  if (!(await sidecarPython())) return sidecarMissingResult('transcribe_sequence') as never;

  const snapshot = await readSequence(ctx, args.sequenceId);
  if (isError(snapshot)) return { success: false, error: snapshot.error };

  const audio = snapshot.clips.filter((c) => c.trackType === 'audio');
  const indices = args.dialogueTrackIndices
    ?? [...new Set(audio.filter((c) => c.mediaPath).map((c) => c.trackIndex))].sort((a, b) => a - b);
  const clips = audio.filter((c) => indices.includes(c.trackIndex));
  const paths = uniquePaths(clips, 'audio');
  if (paths.length === 0) {
    return {
      success: false,
      error: `The dialogue audio tracks (${indices.length ? indices.join(', ') : 'none found'}) have no clips with a media file. Pass dialogueTrackIndices for tracks that hold the speech.`,
    };
  }

  const glossary = args.glossary ?? [];
  const keys: string[] = [];
  for (const mediaPath of paths) {
    const stamp = fileStamp(mediaPath);
    if (stamp === null) return { success: false, error: `Media file not found: ${mediaPath}` };
    keys.push(`transcribe|${mediaPath}|${stamp}|${ASR_MODEL}|${glossary.join('\n')}`);
  }

  // startJob replaces a failed job without reporting it, so read the state first.
  let jobs: JobState[];
  const failures: string[] = [];
  try {
    const before = await Promise.all(keys.map((key) => jobStatus(key)));
    before.forEach((job, i) => {
      if (job?.status === 'failed') failures.push(`${paths[i]}: ${job.error ?? 'unknown error'}`);
    });
    jobs = await Promise.all(paths.map((mediaPath, i) => startJob(
      keys[i]!,
      'transcribe',
      { mediaPath, modelDir: modelPaths().whisper, language: 'vi', glossary, device: 'auto', model: ASR_MODEL },
    )));
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (failures.length > 0) {
    return {
      success: false,
      error: failures.join('\n'),
      retry: true,
      nextStep: 'Call transcribe_sequence again to retry; the failed file(s) were restarted.',
    } as never;
  }

  const failed = jobs.map((job, i) => ({ job, path: paths[i]! })).filter((x) => x.job.status === 'failed');
  if (failed.length > 0) {
    return { success: false, error: failed.map((f) => `${f.path}: ${f.job.error ?? 'unknown error'}`).join('\n') };
  }

  if (jobs.some((job) => job.status === 'running')) {
    const progress = jobs.reduce((sum, job) => sum + (job.status === 'done' ? 1 : job.progress), 0) / jobs.length;
    const etas = jobs.filter((job) => job.status === 'running' && typeof job.etaSec === 'number').map((job) => job.etaSec!);
    return { status: 'running', progress, ...(etas.length ? { etaSec: Math.max(...etas) } : {}), files: paths.length };
  }

  const wordsByMedia = new Map<string, AsrWord[]>();
  const warnings: string[] = [];
  jobs.forEach((job, i) => {
    const result = (job.result ?? {}) as TranscribeResult;
    wordsByMedia.set(paths[i]!, result.words ?? []);
    if (result.device === 'cpu') warnings.push('CPU fallback: transcription is 3-4× slower');
  });

  const mapped = mapWordsToTimeline(clips, wordsByMedia, snapshot.frameDuration);
  const repaired = repairTimestamps(mapped.words);
  const words = dedupeOverlaps(repaired.words);
  if (mapped.skippedClips.length > 0) {
    const reasons = [...new Set(mapped.skippedClips.map((s) => SKIP_REASON[s.reason] ?? s.reason))].join('; ');
    warnings.push(`Skipped ${mapped.skippedClips.length} clip(s): ${reasons}.`);
  }
  if (repaired.repaired > 0) warnings.push(`Repaired ${repaired.repaired} word timestamp(s) that had no duration.`);
  if (words.length === 0) warnings.push('No speech was recognised in the dialogue tracks.');

  return {
    status: 'done',
    sequenceId: snapshot.sequenceId,
    fingerprint: clipFingerprint(clips),
    words,
    sentences: splitSentences(words),
    warnings: [...new Set(warnings)],
    endTime: snapshot.endTime,
    frameDuration: snapshot.frameDuration,
  };
}

async function transcribeSequence(
  ctx: ToolContext,
  args: TranscriptArgs & { page: number; pageSize: number },
): Promise<unknown> {
  const loaded = await loadTranscript(ctx, args);
  if ('success' in loaded) return loaded;
  if (loaded.status === 'running') {
    return {
      success: true,
      ...loaded,
      nextStep: 'Transcription is running in the background. Call transcribe_sequence again with the same arguments to check progress.',
    };
  }
  const renders = join(premiereMcpHome(), 'renders');
  await mkdir(renders, { recursive: true });
  const safeId = loaded.sequenceId.replace(/[^\w.-]/g, '_');
  const wordsFile = join(renders, `transcript-${safeId}-${loaded.fingerprint}.json`);
  await writeFile(wordsFile, JSON.stringify(loaded.words));
  const from = args.page * args.pageSize;
  return {
    success: true,
    status: 'done',
    sequenceId: loaded.sequenceId,
    fingerprint: loaded.fingerprint,
    totalWords: loaded.words.length,
    totalSentences: loaded.sentences.length,
    page: args.page,
    pageSize: args.pageSize,
    sentences: loaded.sentences.slice(from, from + args.pageSize),
    wordsFile,
    warnings: loaded.warnings,
    endTime: loaded.endTime,
  };
}

/**
 * Face counts (about one sample per second) on timeline time, from the top-most video track
 * that has clips. Runs the sidecar once per unique file over its clip ranges; results are cached.
 */
export async function timelineFaces(
  snapshot: SequenceSnapshot,
  range?: { start: number; end: number },
  warnings?: string[],
): Promise<Array<{ t: number; count: number }>> {
  const video = snapshot.clips.filter((c) => c.trackType === 'video' && c.mediaPath);
  if (video.length === 0) return [];
  const top = Math.max(...video.map((c) => c.trackIndex));
  const clips = video.filter((c) => c.trackIndex === top);
  const out: Array<{ t: number; count: number }> = [];
  for (const mediaPath of uniquePaths(clips, 'video')) {
    const mine = clips.filter((c) => c.mediaPath === mediaPath);
    const ranges = mine.map((c) => ({ start: c.inPoint, end: c.outPoint }));
    let result: { samples?: Array<{ t: number; count: number }> };
    try {
      result = await cached(mediaPath, 'faces-yunet', ranges, () =>
        runSidecar<{ samples?: Array<{ t: number; count: number }> }>('faces', {
          mediaPath, modelPath: modelPaths().yunet, ranges, fps: 1,
        }));
    } catch (error) {
      warnings?.push(`Face detection unavailable for ${basename(mediaPath)}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const sample of result.samples ?? []) {
      for (const clip of mine) {
        if (sample.t < clip.inPoint || sample.t >= clip.outPoint) continue;
        const t = clip.start + sample.t - clip.inPoint;
        if (range && (t < range.start || t > range.end)) continue;
        out.push({ t, count: sample.count });
        break;
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Short-term loudness (LUFS) of the dialogue audio files, on timeline time. */
export async function timelineLoudness(
  ffmpeg: string,
  clips: SequenceSnapshot['clips'],
  warnings?: string[],
): Promise<FrameSample[]> {
  const out: FrameSample[] = [];
  for (const mediaPath of uniquePaths(clips, 'audio')) {
    let samples: FrameSample[];
    try {
      // Throw inside the compute so a failed run is never cached as an empty result.
      samples = await cached(mediaPath, 'ebur128-short', {}, async () => {
        const run = await runFf(ffmpeg, [
          '-hide_banner', '-nostats', '-i', mediaPath, '-map', '0:a:0',
          '-af', 'ebur128=framelog=verbose', '-f', 'null', '-',
        ]);
        if (run.code !== 0) {
          const tail = run.stderr.trim().split(/\r?\n/).pop() ?? '';
          throw new Error(`ffmpeg exited with code ${run.code}${tail ? `: ${tail}` : ''}`);
        }
        const parsed = parseShortTermLoudness(run.stderr);
        if (parsed.length === 0) throw new Error('no loudness samples were produced (no audio stream or too short)');
        return parsed;
      });
    } catch (error) {
      warnings?.push(`Loudness unavailable for ${basename(mediaPath)}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const clip of clips.filter((c) => c.mediaPath === mediaPath)) {
      for (const sample of samples) {
        if (sample.t < clip.inPoint || sample.t >= clip.outPoint) continue;
        out.push({ t: clip.start + sample.t - clip.inPoint, v: sample.v });
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

async function findHighlightCandidates(
  ctx: ToolContext,
  args: TranscriptArgs & { minSec: number; maxSec: number; limit: number; detectFaces: boolean },
): Promise<unknown> {
  const loaded = await loadTranscript(ctx, args);
  if ('success' in loaded) return loaded;
  if (loaded.status === 'running') {
    return {
      success: true,
      ...loaded,
      nextStep: 'Transcription is running in the background. Call find_highlight_candidates again with the same arguments to check progress.',
    };
  }
  const ffmpeg = await findFfTool('ffmpeg');
  if (!ffmpeg) return ffmpegMissingResult('find_highlight_candidates');

  const snapshot = await readSequence(ctx, args.sequenceId);
  if (isError(snapshot)) return { success: false, error: snapshot.error };
  const audio = snapshot.clips.filter((c) => c.trackType === 'audio');
  const indices = args.dialogueTrackIndices
    ?? [...new Set(audio.filter((c) => c.mediaPath).map((c) => c.trackIndex))];
  const dialogue = audio.filter((c) => indices.includes(c.trackIndex));

  const warnings = [...loaded.warnings];
  const windows = candidateWindows(loaded.sentences, args.minSec, args.maxSec);
  if (windows.length === 0) warnings.push(`No window of whole sentences fits ${args.minSec}-${args.maxSec} s.`);

  const loudness = await timelineLoudness(ffmpeg, dialogue, warnings);
  const medianLufs = median(loudness.map((s) => s.v));
  const faces = args.detectFaces && windows.length > 0 ? await timelineFaces(snapshot, undefined, warnings) : [];
  if (args.detectFaces && windows.length > 0 && faces.length === 0) warnings.push('No face samples were found; multiFaceRatio is 0.');

  const scored = scoreCandidates(windows.map((w) => ({
    ...w,
    text: '',
    signals: signalsFor(w, loaded.words, loudness, medianLufs, faces),
  })));
  const candidates = pickDiverse(scored, args.limit, loaded.endTime).map((c) => ({
    ...c,
    text: loaded.words.filter((x) => x.start >= c.start && x.start < c.end).map((x) => x.w).join(' '),
  }));
  return {
    success: true,
    sequenceId: loaded.sequenceId,
    totalCandidates: windows.length,
    candidates,
    detectFaces: args.detectFaces,
    warnings,
  };
}

export const shortsTools: ToolModule[] = [
  {
    name: 'transcribe_sequence',
    description:
      'Transcribes the dialogue audio of a sequence into a word-level Vietnamese transcript on sequence time, split into sentences. Runs speech recognition (faster-whisper) in a background job per media file: the first call starts it and returns status "running" with progress; call again with the same arguments until status is "done". Words heard on several mics are de-duplicated. Returns paged sentences plus wordsFile, a JSON file holding every word. Read-only. If the analysis sidecar is not installed the result has nextStep/command.',
    inputSchema: z.object({
      sequenceId: z.string().optional().describe('Sequence ID. Defaults to the active sequence.'),
      dialogueTrackIndices: z.array(z.number().int().min(0)).optional().describe('Audio track indices that carry speech. Defaults to every audio track that has a clip with a media file.'),
      glossary: z.array(z.string()).optional().describe('Names and terms to bias recognition toward, e.g. guest names or brands.'),
      page: z.number().int().min(0).default(0).describe('Sentence page to return (default 0).'),
      pageSize: z.number().int().min(1).default(200).describe('Sentences per page (default 200).'),
    }),
    run: (ctx, args) => transcribeSequence(ctx, args),
  },
  {
    name: 'find_highlight_candidates',
    description:
      'Proposes 20-90 s windows of whole sentences from the transcribed dialogue of a sequence as short-form highlight candidates, each with its text, objective signals (words per second, loudness relative to the median, question/exclamation, filler rate, longest pause, multi-face ratio) and a rawScore. Candidates never overlap and are spread across the episode. Uses the transcript from transcribe_sequence (returns status "running" until it is done) and ffmpeg for loudness. Face counting is off by default (detectFaces) to save CPU/GPU. Read-only. The agent reads the text and picks the best.',
    inputSchema: z.object({
      sequenceId: z.string().optional().describe('Sequence ID. Defaults to the active sequence.'),
      dialogueTrackIndices: z.array(z.number().int().min(0)).optional().describe('Audio track indices that carry speech. Defaults to every audio track that has a clip with a media file.'),
      glossary: z.array(z.string()).optional().describe('Names and terms to bias recognition toward; use the same list as transcribe_sequence.'),
      minSec: z.number().positive().default(20).describe('Shortest window in seconds (default 20).'),
      maxSec: z.number().positive().default(90).describe('Longest window in seconds (default 90).'),
      limit: z.number().int().min(1).default(20).describe('Maximum candidates to return (default 20).'),
      detectFaces: z.boolean().default(false).describe('Count faces (YuNet) to set multiFaceRatio. Uses more CPU/GPU; default false, then multiFaceRatio is 0.'),
    }),
    run: (ctx, args) => findHighlightCandidates(ctx, args),
  },
];
