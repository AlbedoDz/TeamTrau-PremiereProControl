/**
 * Podcast to shorts. transcribe_sequence turns the dialogue audio of a sequence into a
 * word-level Vietnamese transcript on sequence time. Speech recognition runs in the Python
 * sidecar as one background job per media file; the tool is polled until every job is done.
 */
import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext, ToolModule } from '../context.js';
import {
  modelPaths,
  premiereMcpHome,
  sidecarMissingResult,
  sidecarPython,
  startJob,
  type JobState,
} from '../../analysis/sidecar.js';
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
import { isError, readSequence, uniquePaths } from './cleanup.js';

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

const fileStamp = (path: string): string => {
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return '0:0';
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
  let jobs: JobState[];
  try {
    jobs = await Promise.all(paths.map((mediaPath) => startJob(
      `transcribe|${mediaPath}|${fileStamp(mediaPath)}|${ASR_MODEL}|${glossary.join('\n')}`,
      'transcribe',
      { mediaPath, modelDir: modelPaths().whisper, language: 'vi', glossary, device: 'auto', model: ASR_MODEL },
    )));
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }

  const failed = jobs.map((job, i) => ({ job, path: paths[i]! })).filter((x) => x.job.status === 'failed');
  if (failed.length > 0) {
    return {
      success: false,
      error: `Transcription failed for ${failed.map((f) => `${f.path}: ${f.job.error ?? 'unknown error'}`).join('; ')}. Call transcribe_sequence again to retry.`,
    };
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
  const wordsFile = join(renders, `transcript-${loaded.sequenceId}-${loaded.fingerprint}.json`);
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
];
