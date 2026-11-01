/**
 * Podcast to shorts. transcribe_sequence turns the dialogue audio of a sequence into a
 * word-level Vietnamese transcript on sequence time. Speech recognition runs in the Python
 * sidecar as one background job per media file; the tool is polled until every job is done.
 */
import { z } from 'zod';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ToolContext, ToolModule } from '../context.js';
import {
  jobStatus,
  modelPaths,
  premiereMcpHome,
  sidecarMissingResult,
  engineMissingResult,
  sidecarPython,
  startJob,
  runSidecar,
  writeJsonAtomic,
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
import { resolveEngine } from '../../analysis/asr-config.js';
import { ENGINE_IDS, usesZipformer } from '../../analysis/asr-engines.js';
import { restoreCasing } from '../../analysis/casing.js';
import { asrStatus } from '../../setup/asr.js';
import { applyCaptionOverrides, groupCaptions, safeFileName, SAFE_AREA } from '../../analysis/captions.js';
import { isError, normalizeLoudness, readSequence, uniquePaths, type SequenceSnapshot } from './cleanup.js';
import { ensureBackup, qaSequence } from './editing.js';
import { importMedia } from './media.js';

export interface TranscriptArgs {
  sequenceId?: string | undefined;
  dialogueTrackIndices?: number[] | undefined;
  glossary?: string[] | undefined;
  /** Speech engine; defaults to the configured one, then zipformer-68m. */
  engine?: string | undefined;
}

export interface TranscriptReady {
  status: 'done';
  sequenceId: string;
  fingerprint: string;
  /** The audio track indices the transcript was made from. */
  dialogueTrackIndices: number[];
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

/** The audio clips on the dialogue tracks; by default every audio track that has a clip with media. */
function dialogueClips(
  snapshot: SequenceSnapshot,
  dialogueTrackIndices?: number[],
): { indices: number[]; clips: SequenceSnapshot['clips'] } {
  const audio = snapshot.clips.filter((c) => c.trackType === 'audio');
  const indices = dialogueTrackIndices
    ?? [...new Set(audio.filter((c) => c.mediaPath).map((c) => c.trackIndex))].sort((a, b) => a - b);
  return { indices, clips: audio.filter((c) => indices.includes(c.trackIndex)) };
}

const MAX_GLOSSARY_ENTRIES = 200;
const glossaryIndexPath = (): string => join(premiereMcpHome(), 'jobs', 'glossary-index.json');

async function readGlossaryIndex(): Promise<Record<string, string[]>> {
  try {
    const parsed = JSON.parse(await readFile(glossaryIndexPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Remember the last glossary used per media file + engine (best effort, atomic write). */
async function recordGlossaries(entries: ReadonlyArray<readonly [string, string[]]>): Promise<void> {
  try {
    const index = await readGlossaryIndex();
    for (const [id, glossary] of entries) { delete index[id]; index[id] = glossary; }
    // Drop entries whose media is gone, then keep only the newest MAX_GLOSSARY_ENTRIES.
    const live = Object.entries(index).filter(([id]) => existsSync(id.split('|')[0]!));
    for (const k of Object.keys(index)) delete index[k];
    for (const [id, g] of live.slice(-MAX_GLOSSARY_ENTRIES)) index[id] = g;
    await mkdir(join(premiereMcpHome(), 'jobs'), { recursive: true });
    await writeJsonAtomic(glossaryIndexPath(), index);
  } catch { /* the index is only a convenience */ }
}

export async function loadTranscript(
  ctx: ToolContext,
  args: TranscriptArgs,
): Promise<TranscriptReady | TranscriptPending | { success: false; error: string }> {
  if (!(await sidecarPython())) return sidecarMissingResult('transcribe_sequence') as never;
  const engine = await resolveEngine(args.engine);
  // Never downloads: a missing engine is reported so the user can approve it first.
  const status = await asrStatus();
  if (status.engines && status.engines[engine] === false) return engineMissingResult('transcribe_sequence', engine) as never;

  const snapshot = await readSequence(ctx, args.sequenceId);
  if (isError(snapshot)) return { success: false, error: snapshot.error };

  const { indices, clips } = dialogueClips(snapshot, args.dialogueTrackIndices);
  const paths = uniquePaths(clips, 'audio');
  if (paths.length === 0) {
    return {
      success: false,
      error: `The dialogue audio tracks (${indices.length ? indices.join(', ') : 'none found'}) have no clips with a media file. Pass dialogueTrackIndices for tracks that hold the speech.`,
    };
  }

  const callGlossary = args.glossary ?? [];
  const sendsGlossary = !usesZipformer(engine);
  const index = sendsGlossary ? await readGlossaryIndex() : {};
  const keys: string[] = [];
  const glossaries: string[][] = [];
  const indexIds: string[] = [];
  for (const mediaPath of paths) {
    const stamp = fileStamp(mediaPath);
    if (stamp === null) return { success: false, error: `Media file not found: ${mediaPath}` };
    // Zipformer engines never see the glossary (casing is applied below), so it stays out of the key.
    const keyFor = (g: string[]): string => `transcribe-v2|${mediaPath}|${stamp}|${engine}${sendsGlossary ? `|${g.join('\n')}` : '|'}`;
    const indexId = `${mediaPath}|${stamp}|${engine}`;
    let glossaryForJob = callGlossary;
    // whisper: a call without a glossary reuses the finished job made with the last one used.
    const last = index[indexId];
    if (sendsGlossary && args.glossary === undefined && last && last.length > 0) {
      try {
        if ((await jobStatus(keyFor(last)))?.status === 'done') glossaryForJob = last;
      } catch { /* fall back to a plain key */ }
    }
    keys.push(keyFor(glossaryForJob));
    glossaries.push(glossaryForJob);
    indexIds.push(indexId);
  }

  // startJob replaces a failed job without reporting it, so read the state first.
  let jobs: JobState[];
  const failures: string[] = [];
  try {
    const before = await Promise.all(keys.map((key) => jobStatus(key)));
    before.forEach((job, i) => {
      if (job?.status === 'failed') failures.push(`${paths[i]}: ${job.error ?? 'unknown error'}`);
    });
    // One decode and one model in memory at a time: a file's job starts only when no earlier file
    // of this request is still running. Done or failed earlier jobs do not block.
    jobs = [];
    for (let i = 0; i < paths.length; i++) {
      const wouldSpawn = !before[i] || before[i]!.status === 'failed';
      if (wouldSpawn && jobs.some((job) => job.status === 'running')) {
        jobs.push({ status: 'running', progress: 0 });
        continue;
      }
      jobs.push(await startJob(
        keys[i]!,
        'transcribe',
        { mediaPath: paths[i]!, modelDir: modelPaths().whisper, modelsDir: join(premiereMcpHome(), 'models'), language: 'vi', glossary: glossaries[i]!, device: 'auto', engine },
      ));
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (sendsGlossary && args.glossary !== undefined) {
    await recordGlossaries(indexIds.map((id) => [id, callGlossary] as const));
  }
  if (failures.length > 0) {
    return {
      success: false,
      error: failures.join('\n'),
      retry: true,
      nextStep: 'Call transcribe_sequence again to retry; the failed file(s) are restarted, one file at a time.',
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
    const heard = result.words ?? [];
    wordsByMedia.set(paths[i]!, usesZipformer(engine) ? restoreCasing(heard, callGlossary) : heard);
    if (result.device === 'cpu' && !usesZipformer(engine)) warnings.push('CPU fallback: transcription is 3-4× slower');
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
    dialogueTrackIndices: indices,
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
          '-hide_banner', '-nostats', '-v', 'verbose', '-i', mediaPath, '-map', '0:a:0',
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
    fingerprint: loaded.fingerprint,
    totalCandidates: windows.length,
    candidates,
    detectFaces: args.detectFaces,
    warnings,
  };
}

// ------------------------------------------------------------------ build_short

const TICKS_PER_SECOND = 254016000000;
const MULTI_FACE_MARKER = 'Cảnh nhiều người — kiểm tra khung reframe';
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const samePath = (a: string, b: string): boolean =>
  a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

/** How long the readback waits for Auto Reframe's subject-tracking keyframes. Tests shorten it. */
export const buildShortTiming = { pollMs: 2000, timeoutMs: 30000 };

interface BuildShortArgs extends TranscriptArgs {
  expectedFingerprint?: string | undefined;
  startSentenceId: number;
  endSentenceId: number;
  name: string;
  captionStyle: 'clean' | 'pop' | 'karaoke';
  captions?: Array<{ start: number; end: number; text: string }> | undefined;
  font?: string | undefined;
  targetLufs: number;
  detectFaces: boolean;
  dryRun: boolean;
  backup: boolean;
}

/** One marker per run of consecutive (about 1 s apart) samples with two or more faces, on short time. */
function multiFaceStretches(
  faces: Array<{ t: number; count: number }>,
  start: number,
  end: number,
): Array<{ start: number; end: number; name: string }> {
  const out: Array<{ start: number; end: number; name: string }> = [];
  let first: number | null = null;
  let last = 0;
  const flush = (): void => {
    if (first === null) return;
    out.push({ start: round3(first - start), end: round3(Math.min(last + 1, end) - start), name: MULTI_FACE_MARKER });
    first = null;
  };
  for (const sample of faces) {
    if (sample.count < 2) { flush(); continue; }
    if (first !== null && sample.t - last > 1.5) flush();
    if (first === null) first = sample.t;
    last = sample.t;
  }
  flush();
  return out;
}

const probeScript = (sequenceId: string): string => `
  // build_short:probe
  try {
    var seq = __findSequence(${JSON.stringify(sequenceId)});
    if (!seq) return JSON.stringify({ success: false, error: "Sequence not found: " + ${JSON.stringify(sequenceId)} });
    return JSON.stringify({ success: true, frameSizeHorizontal: Number(seq.frameSizeHorizontal), frameSizeVertical: Number(seq.frameSizeVertical) });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.toString() });
  }
`;

const reframeScript = (sequenceId: string, start: number, end: number, name: string): string => `
  // build_short:reframe
  try {
    var seq = __findSequence(${JSON.stringify(sequenceId)});
    if (!seq) return JSON.stringify({ success: false, error: "Sequence not found: " + ${JSON.stringify(sequenceId)} });
    var prevIn = null, prevOut = null;
    try { prevIn = seq.getInPointAsTime().ticks; prevOut = seq.getOutPointAsTime().ticks; } catch (eRead) {}
    var sub = null, r = null, err = null, deleted = false;
    try {
      seq.setInPoint(__secondsToTicks(${start}));
      seq.setOutPoint(__secondsToTicks(${end}));
      sub = seq.createSubsequence(true);
      if (!sub) throw new Error("createSubsequence returned no sequence");
      r = sub.autoReframeSequence(9, 16, "default", ${JSON.stringify(name)}, false);
    } catch (e1) { err = e1.toString(); }
    if (sub) { try { deleted = app.project.deleteSequence(sub) !== false; } catch (eDel) {} }
    try {
      if (prevIn !== null) seq.setInPoint(prevIn);
      if (prevOut !== null) seq.setOutPoint(prevOut);
    } catch (eRestore) {}
    if (err) return JSON.stringify({ success: false, error: err });
    if (!r) return JSON.stringify({ success: false, error: "autoReframeSequence returned no sequence" });
    return JSON.stringify({
      success: true, sequenceID: String(r.sequenceID), name: String(r.name),
      frameSizeHorizontal: Number(r.frameSizeHorizontal), frameSizeVertical: Number(r.frameSizeVertical),
      end: String(r.end), deleted: deleted
    });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.toString() });
  }
`;

const placeScript = (sequenceId: string, itemId: string, binName: string): string => `
  // build_short:place
  var __priorActive = null;
  try {
    var seq = __findSequence(${JSON.stringify(sequenceId)});
    if (!seq) return JSON.stringify({ success: false, error: "Short sequence not found: " + ${JSON.stringify(sequenceId)} });
    var item = __findProjectItem(${JSON.stringify(itemId)});
    if (!item) return JSON.stringify({ success: false, error: "Imported caption item not found: " + ${JSON.stringify(itemId)} });
    var childBin = function (parent, name) {
      for (var i = 0; i < parent.children.numItems; i++) {
        var c = parent.children[i];
        if (c && String(c.name) === name && c.type === ProjectItemType.BIN) return c;
      }
      return parent.createBin(name);
    };
    var bin = childBin(childBin(app.project.rootItem, "Shorts"), ${JSON.stringify(binName)});
    var binMoved = true;
    try { item.moveBin(bin); } catch (eMove) { binMoved = false; }
    __priorActive = app.project.activeSequence;
    app.project.activeSequence = seq;
    var qeSeq = __qeSequenceFor(seq);
    if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address the short through the QE API to add a track." });
    var before = seq.videoTracks.numTracks;
    qeSeq.addTracks(1, before, 0, 1, seq.audioTracks.numTracks, 0, 0);
    if (seq.videoTracks.numTracks < before + 1) return JSON.stringify({ success: false, error: "Premiere did not add a video track for the captions." });
    var topIndex = seq.videoTracks.numTracks - 1;
    var top = seq.videoTracks[topIndex];
    top.overwriteClip(item, 0);
    if (top.clips.numItems < 1) return JSON.stringify({ success: false, error: "The caption clip was not placed on the top video track." });
    return JSON.stringify({ success: true, trackIndex: topIndex, binMoved: binMoved });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.toString() });
  } finally {
    try {
      if (__priorActive && app.project.activeSequence && app.project.activeSequence.sequenceID !== __priorActive.sequenceID) {
        app.project.activeSequence = __priorActive;
      }
    } catch (eRestore) {}
  }
`;

const markersScript = (sequenceId: string, markers: Array<{ start: number; end: number }>): string => `
  // build_short:markers
  try {
    var seq = __findSequence(${JSON.stringify(sequenceId)});
    if (!seq) return JSON.stringify({ success: false, error: "Short sequence not found: " + ${JSON.stringify(sequenceId)} });
    var NAME = ${JSON.stringify(MULTI_FACE_MARKER)};
    var list = ${JSON.stringify(markers)};
    for (var i = 0; i < list.length; i++) {
      var m = seq.markers.createMarker(list[i].start);
      m.name = NAME;
      m.end = list[i].end;
    }
    return JSON.stringify({ success: true, added: list.length });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.toString() });
  }
`;

const readbackScript = (sequenceId: string): string => `
  // build_short:readback
  try {
    var seq = __findSequence(${JSON.stringify(sequenceId)});
    if (!seq) return JSON.stringify({ success: false, error: "Short sequence not found: " + ${JSON.stringify(sequenceId)} });
    var vt = seq.videoTracks;
    var topIndex = vt.numTracks - 1;
    var paths = [];
    if (topIndex >= 0) {
      for (var i = 0; i < vt[topIndex].clips.numItems; i++) {
        try { paths.push(String(vt[topIndex].clips[i].projectItem.getMediaPath())); } catch (ePath) {}
      }
    }
    var keys = 0;
    for (var t = 0; t < topIndex; t++) {
      for (var j = 0; j < vt[t].clips.numItems; j++) {
        var comps = vt[t].clips[j].components;
        for (var c = 0; c < comps.numItems; c++) {
          if (String(comps[c].displayName) !== "Auto Reframe") continue;
          for (var p = 0; p < comps[c].properties.numItems; p++) {
            var prop = comps[c].properties[p];
            if (String(prop.displayName) !== "Generated Keyframes") continue;
            try { var k = prop.getKeys(); if (k && k.length > keys) keys = k.length; } catch (eKeys) {}
          }
        }
      }
    }
    return JSON.stringify({
      success: true, frameSizeHorizontal: Number(seq.frameSizeHorizontal), frameSizeVertical: Number(seq.frameSizeVertical),
      endSeconds: Number(seq.end) / ${TICKS_PER_SECOND}, topTrackIndex: topIndex, topTrackPaths: paths, reframeKeys: keys
    });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.toString() });
  }
`;

async function buildShort(ctx: ToolContext, args: BuildShortArgs): Promise<unknown> {
  if (!(await sidecarPython())) return sidecarMissingResult('build_short');
  const loaded = await loadTranscript(ctx, args);
  if ('success' in loaded) return loaded;
  if (loaded.status === 'running') {
    return {
      success: false,
      ...loaded,
      error: 'The transcript is not ready yet.',
      nextStep: 'Call transcribe_sequence with the same arguments until status is "done", then call build_short again.',
    };
  }

  const warnings = [...loaded.warnings];
  if (args.expectedFingerprint !== undefined) {
    if (args.expectedFingerprint !== loaded.fingerprint) {
      return { success: false, error: 'The sequence changed since it was transcribed. Run transcribe_sequence again.' };
    }
  } else {
    warnings.push('Pass expectedFingerprint from find_highlight_candidates so edits made after selection are detected.');
  }

  const total = loaded.sentences.length;
  const first = loaded.sentences.find((s) => s.id === args.startSentenceId);
  const last = loaded.sentences.find((s) => s.id === args.endSentenceId);
  if (!first || !last || args.startSentenceId > args.endSentenceId) {
    return {
      success: false,
      totalSentences: total,
      error: `Sentence range ${args.startSentenceId}-${args.endSentenceId} is not valid: startSentenceId must not exceed endSentenceId and both must be between 0 and ${total - 1} (totalSentences: ${total}).`,
    };
  }

  // Whole frames: start snaps down, end snaps up, so the short and the captions agree on its length.
  const fd = loaded.frameDuration;
  const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
  const start = round6(Math.floor(first.start / fd + 1e-6) * fd);
  const end = round6(Math.ceil(last.end / fd - 1e-6) * fd);
  const durationSec = round3(end - start);
  const inRange = loaded.words.filter((w) => w.start >= start && w.start < end);
  const captions = applyCaptionOverrides(groupCaptions(inRange, start), args.captions ?? []);
  if (args.dryRun) {
    return { success: true, dryRun: true, start, end, durationSec, name: args.name, captions, warnings };
  }

  const ffmpeg = await findFfTool('ffmpeg');
  if (!ffmpeg) return ffmpegMissingResult('build_short');

  // Auto Reframe keeps the source height: width = round(height × 9 / 16). Read only, before any change.
  const probe: any = await ctx.bridge.executeScript(probeScript(loaded.sequenceId));
  if (!probe || probe.success === false || !(probe.frameSizeVertical > 0)) {
    return { success: false, error: probe?.error ?? 'Could not read the sequence frame size.' };
  }
  const height = Math.round(Number(probe.frameSizeVertical));
  const width = Math.round(height * 9 / 16);
  if (captions.length === 0) warnings.push('No words fall in this range, so the caption track is empty.');

  // 1. Render the captions first: a failure here leaves the project untouched.
  const renders = join(premiereMcpHome(), 'renders');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const outPath = join(renders, `${safeFileName(args.name)}-${stamp}.mov`);
  let captionFile: string;
  try {
    await mkdir(renders, { recursive: true });
    const rendered = await runSidecar<{ path?: string; frames?: number }>('captions', {
      groups: captions,
      style: args.captionStyle,
      width,
      height,
      fps: round3(1 / fd),
      duration: durationSec,
      ...(args.font ? { font: args.font } : {}),
      safeArea: SAFE_AREA,
      outPath,
    });
    captionFile = rendered.path ?? outPath;
  } catch (error) {
    return {
      success: false,
      verified: false,
      failedStep: 'render_captions',
      error: `Caption render failed, nothing in the project was changed: ${error instanceof Error ? error.message : String(error)}`,
      warnings,
    };
  }

  let backupPath: string | undefined;
  let shortSequenceId: string | undefined;
  let step = 'backup';
  const fail = (failedStep: string, error: string): Record<string, unknown> => ({
    success: false, verified: false, failedStep, error, backupPath, shortSequenceId, captionFile, warnings,
  });

  try {
    // 2. Backup.
    const backup = await ensureBackup(ctx, args.backup);
    if ('failure' in backup) return { ...backup.failure, verified: false, failedStep: 'backup', captionFile, warnings };
    backupPath = backup.path;

    // 3. Subsequence of the range, Auto Reframe to 9:16, drop the intermediate subsequence.
    step = 'reframe';
    const reframe: any = await ctx.bridge.executeScript(reframeScript(loaded.sequenceId, start, end, args.name));
    if (!reframe || reframe.success === false || !reframe.sequenceID) return fail(step, reframe?.error ?? 'Auto Reframe did not return a sequence.');
    shortSequenceId = String(reframe.sequenceID);
    if (reframe.deleted === false) warnings.push('The intermediate subsequence could not be deleted; remove it from the project by hand.');
    if (Number(reframe.frameSizeHorizontal) !== width || Number(reframe.frameSizeVertical) !== height) {
      warnings.push(`Captions were rendered at ${width}×${height} but the short is ${reframe.frameSizeHorizontal}×${reframe.frameSizeVertical}; Premiere scales the caption overlay.`);
    }

    // 4. Import the caption file and place it on a new top video track at 0, in bin Shorts/<name>.
    step = 'import_captions';
    const imported = await importMedia(ctx, captionFile);
    if (!imported?.success || !imported.id) return fail(step, imported?.error ?? 'The caption file was not imported.');
    step = 'place_captions';
    const placed: any = await ctx.bridge.executeScript(placeScript(shortSequenceId, String(imported.id), safeFileName(args.name)));
    if (!placed || placed.success === false) return fail(step, placed?.error ?? 'The caption clip was not placed.');
    if (placed.binMoved === false) warnings.push('The caption file could not be moved into the Shorts bin.');

    // 5. Loudness, on the dialogue tracks only so music is not pushed to the target.
    step = 'loudness';
    const loudness = await normalizeLoudness(ctx, {
      sequenceId: shortSequenceId,
      targetLufs: args.targetLufs,
      audioTrackIndices: args.dialogueTrackIndices ?? loaded.dialogueTrackIndices,
      dryRun: false,
      backup: false,
    });
    if (!loudness || loudness.success === false) {
      return fail(step, loudness?.error ?? 'Loudness could not be applied to every audio clip of the short.');
    }

    // 6. QA.
    step = 'qa';
    const qa = await qaSequence(ctx, { sequenceId: shortSequenceId, minClipFrames: 6, checkMedia: true });
    if (!qa || qa.success === false) return fail(step, qa?.error ?? 'qa_sequence failed on the short.');
    if (qa.errors > 0) warnings.push(`qa_sequence found ${qa.errors} error(s) on the short; see qa.findings.`);

    // 7. Multi-face warning markers (only when faces were asked for).
    step = 'markers';
    let markers: Array<{ start: number; end: number; name: string }> = [];
    if (args.detectFaces) {
      const snapshot = await readSequence(ctx, loaded.sequenceId);
      if (isError(snapshot)) return fail(step, snapshot.error);
      const faces = await timelineFaces(snapshot, { start, end }, warnings);
      markers = multiFaceStretches(faces, start, end);
      if (markers.length > 0) {
        const added: any = await ctx.bridge.executeScript(markersScript(shortSequenceId, markers.map(({ start: s, end: e }) => ({ start: s, end: e }))));
        if (!added || added.success === false) return fail(step, added?.error ?? 'The warning markers were not added.');
      }
    }

    // 8. Readback; wait for Auto Reframe's subject-tracking keyframes.
    step = 'readback';
    const began = Date.now();
    let read: any;
    for (;;) {
      read = await ctx.bridge.executeScript(readbackScript(shortSequenceId));
      if (!read || read.success === false) return fail(step, read?.error ?? 'Could not read the short back.');
      if (Number(read.reframeKeys) > 0 || Date.now() - began >= buildShortTiming.timeoutMs) break;
      await sleep(buildShortTiming.pollMs);
    }
    if (!(Number(read.reframeKeys) > 0)) {
      warnings.push(`Auto Reframe had no subject-tracking keyframes after ${Math.round(buildShortTiming.timeoutMs / 1000)} s; check the framing in Premiere.`);
    }
    const w = Number(read.frameSizeHorizontal);
    const h = Number(read.frameSizeVertical);
    const aspectOk = h > 0 && Math.abs(w - Math.round(h * 9 / 16)) <= 1;
    const actualDuration = Number(read.endSeconds);
    const durationOk = Math.abs(actualDuration - (end - start)) <= fd + 1e-6;
    const captionOk = Array.isArray(read.topTrackPaths) && read.topTrackPaths.some((p: string) => samePath(String(p), captionFile));
    if (!aspectOk) warnings.push(`The short is ${w}×${h}, not 9:16.`);
    if (!durationOk) warnings.push(`The short lasts ${round3(actualDuration)} s, expected ${durationSec} s.`);
    if (!captionOk) warnings.push('The caption clip was not found on the top video track.');

    return {
      success: true,
      verified: aspectOk && durationOk && captionOk,
      shortSequenceId,
      name: args.name,
      durationSec: round3(actualDuration),
      width: w,
      height: h,
      captionFile,
      ...(backupPath ? { backupPath } : {}),
      qa,
      warnings: [...new Set(warnings)],
      markers,
    };
  } catch (error) {
    return fail(step, error instanceof Error ? error.message : String(error));
  }
}

const ENGINE_SCHEMA = z.enum(ENGINE_IDS).optional().describe(
  'Speech engine; use the same value as transcribe_sequence. Defaults to the configured engine, then zipformer-68m (about 80 MB, Apache-2.0, CPU, no punctuation). Others: zipformer-30m (30 MB, CC-BY-NC-ND-4.0 non-commercial), rover (both zipformers, non-commercial), whisper-turbo (1.6 GB, MIT, punctuation, GPU recommended). An engine that is not installed is never downloaded here: the result asks the user to approve it.',
);

export const shortsTools: ToolModule[] = [
  {
    name: 'transcribe_sequence',
    description:
      'Transcribes the dialogue audio of a sequence into a word-level Vietnamese transcript on sequence time, split into sentences. Runs speech recognition (Zipformer-68M on the CPU by default; engine selects another that the user installed) in a background job per media file: the first call starts it and returns status "running" with progress; call again with the same arguments until status is "done". Words heard on several mics are de-duplicated. Returns paged sentences plus wordsFile, a JSON file holding every word. Read-only. If the analysis sidecar or the chosen engine is not installed the result has nextStep/command; an engine is never downloaded by a tool, the user must approve it. Zipformer engines output no punctuation: sentences end at pauses.',
    inputSchema: z.object({
      sequenceId: z.string().optional().describe('Sequence ID. Defaults to the active sequence.'),
      dialogueTrackIndices: z.array(z.number().int().min(0)).optional().describe('Audio track indices that carry speech. Defaults to every audio track that has a clip with a media file.'),
      glossary: z.array(z.string()).optional().describe('Names and terms to bias recognition toward, e.g. guest names or brands.'),
      engine: ENGINE_SCHEMA,
      page: z.number().int().min(0).default(0).describe('Sentence page to return (default 0).'),
      pageSize: z.number().int().min(1).default(200).describe('Sentences per page (default 200).'),
    }),
    run: (ctx, args) => transcribeSequence(ctx, args),
  },
  {
    name: 'find_highlight_candidates',
    description:
      'Proposes 20-90 s windows of whole sentences from the transcribed dialogue of a sequence as short-form highlight candidates, each with its text, objective signals (words per second, loudness relative to the median, question/exclamation, filler rate, longest pause, multi-face ratio) and a rawScore. Candidates never overlap and are spread across the episode. Uses the transcript from transcribe_sequence (returns status "running" until it is done) and ffmpeg for loudness. Face counting is off by default (detectFaces) to save CPU/GPU. Also returns the transcript fingerprint: pass it to build_short as expectedFingerprint so edits made after selection are detected. Read-only. The agent reads the text and picks the best.',
    inputSchema: z.object({
      sequenceId: z.string().optional().describe('Sequence ID. Defaults to the active sequence.'),
      dialogueTrackIndices: z.array(z.number().int().min(0)).optional().describe('Audio track indices that carry speech. Defaults to every audio track that has a clip with a media file.'),
      glossary: z.array(z.string()).optional().describe('Names and terms to bias recognition toward; use the same list as transcribe_sequence.'),
      engine: ENGINE_SCHEMA,
      minSec: z.number().positive().default(20).describe('Shortest window in seconds (default 20).'),
      maxSec: z.number().positive().default(90).describe('Longest window in seconds (default 90).'),
      limit: z.number().int().min(1).default(20).describe('Maximum candidates to return (default 20).'),
      detectFaces: z.boolean().default(false).describe('Count faces (YuNet) to set multiFaceRatio. Uses more CPU/GPU; default false, then multiFaceRatio is 0.'),
    }),
    run: (ctx, args) => findHighlightCandidates(ctx, args),
  },
  {
    name: 'build_short',
    description:
      'Builds a vertical 9:16 short from a range of transcribed sentences (ids from transcribe_sequence): renders the captions to an alpha .mov first, then backs up the project, makes a subsequence of the range, runs Auto Reframe (9:16, its height follows the source), imports the captions into bin Shorts/<name> on a new top video track, normalises loudness to targetLufs, runs qa_sequence and reads the result back (verified). Use dryRun=true first to get the caption groups; edit their text and pass them back as `captions` (an empty text removes a group). Pass expectedFingerprint (the fingerprint returned by find_highlight_candidates or transcribe_sequence) so a sequence edited after selection is refused; without it a warning is returned. On a failure after the render it stops, keeps what was built and returns failedStep and backupPath. Needs the analysis sidecar and ffmpeg.',
    inputSchema: z.object({
      sequenceId: z.string().optional().describe('Sequence ID. Defaults to the active sequence.'),
      dialogueTrackIndices: z.array(z.number().int().min(0)).optional().describe('Audio track indices that carry speech; use the same value as transcribe_sequence. Defaults to every audio track that has a clip with a media file.'),
      glossary: z.array(z.string()).optional().describe('Names and terms to bias recognition toward; use the same list as transcribe_sequence.'),
      engine: ENGINE_SCHEMA,
      expectedFingerprint: z.string().optional().describe('fingerprint from find_highlight_candidates (or transcribe_sequence). If the sequence has changed since, build_short refuses instead of cutting the wrong range.'),
      startSentenceId: z.number().int().min(0).describe('Id of the first sentence of the short.'),
      endSentenceId: z.number().int().min(0).describe('Id of the last sentence of the short (inclusive).'),
      name: z.string().min(1).describe('Name of the new sequence. Any characters are kept; the caption file name is made safe.'),
      captionStyle: z.enum(['clean', 'pop', 'karaoke']).default('clean').describe('Caption look (default clean).'),
      captions: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })).optional()
        .describe('Caption text overrides from a dryRun, matched by start/end (seconds from 0 of the short). Empty text removes that caption.'),
      font: z.string().optional().describe('Path to a .ttf font. Defaults to Be Vietnam Pro.'),
      targetLufs: z.number().default(-14).describe('Loudness target for the short (default -14).'),
      detectFaces: z.boolean().default(false).describe('Count faces and add a warning marker on each multi-person stretch. Uses more CPU/GPU; default false.'),
      dryRun: z.boolean().default(false).describe('Return the plan and caption groups without rendering or changing the project.'),
      backup: z.boolean().default(true).describe('Save the project and copy it to a premiere-mcp-backups folder beside it before changing anything (default true). Ignored on a dry run.'),
    }),
    run: (ctx, args) => buildShort(ctx, args),
  },
];
