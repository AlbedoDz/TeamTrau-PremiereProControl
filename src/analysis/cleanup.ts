/**
 * Pure decision logic for footage cleanup: no I/O, no Premiere, no ffmpeg.
 * The tools in tools/domains/cleanup.ts gather inputs and apply the results;
 * everything that decides *what* to cut or flag lives here so it can be tested
 * with synthetic numbers.
 */
import type { Interval, ProbedMedia } from './ffmpeg.js';

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const mk = (start: number, end: number): Interval => ({ start: round3(start), end: round3(end), duration: round3(end - start) });

/** Sorted, non-overlapping union. */
export function unionIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) {
      if (i.end > last.end) out[out.length - 1] = mk(last.start, i.end);
    } else {
      out.push(mk(i.start, i.end));
    }
  }
  return out;
}

/** Parts of `base` not covered by `holes`. */
export function subtractIntervals(base: Interval[], holes: Interval[]): Interval[] {
  const cuts = unionIntervals(holes);
  const out: Interval[] = [];
  for (const b of unionIntervals(base)) {
    let cursor = b.start;
    for (const h of cuts) {
      if (h.end <= cursor) continue;
      if (h.start >= b.end) break;
      if (h.start > cursor) out.push(mk(cursor, h.start));
      cursor = Math.max(cursor, h.end);
    }
    if (cursor < b.end) out.push(mk(cursor, b.end));
  }
  return out;
}

/** The stretches of [0, total] not covered by `dead`. */
export function liveSegments(dead: Interval[], total: number): Interval[] {
  return subtractIntervals([mk(0, total)], dead);
}

export interface SequenceClip {
  id: string;
  trackType: 'audio' | 'video';
  trackIndex: number;
  start: number;
  end: number;
  inPoint: number;
  outPoint: number;
  mediaPath: string | null;
}

export interface SilencePlanOptions {
  /** Seconds of silence kept on each side of a cut so speech is not clipped. */
  paddingSeconds: number;
  /** Cuts shorter than this after padding are dropped. */
  minCutSeconds: number;
  frameDuration: number;
  /** Audio track indices that decide what counts as sound. Omit for all audio tracks. */
  audioTrackIndices?: number[] | undefined;
}

export interface SilencePlan {
  cuts: Interval[];
  skippedClips: Array<{ clipId: string; reason: string }>;
}

const SPEED_TOLERANCE = 0.01;

/**
 * Turn per-file silence (in source time) into timeline ranges that are silent on
 * every deciding audio track and covered by at least one audio clip. Ranges with
 * no audio clip at all are never cut: a video-only B-roll must survive.
 */
export function planSilenceCuts(
  clips: SequenceClip[],
  silenceByMedia: Map<string, Interval[]>,
  opts: SilencePlanOptions,
): SilencePlan {
  const skippedClips: SilencePlan['skippedClips'] = [];
  const audio = clips.filter(
    (c) =>
      c.trackType === 'audio' &&
      (!opts.audioTrackIndices || opts.audioTrackIndices.includes(c.trackIndex)),
  );

  const covered: Interval[] = [];
  const sound: Interval[] = [];
  for (const clip of audio) {
    const length = clip.end - clip.start;
    const sourceLength = clip.outPoint - clip.inPoint;
    if (!clip.mediaPath || !silenceByMedia.has(clip.mediaPath)) {
      skippedClips.push({ clipId: clip.id, reason: 'no analysable media file' });
      continue;
    }
    if (length <= 0 || Math.abs(sourceLength / length - 1) > SPEED_TOLERANCE) {
      skippedClips.push({ clipId: clip.id, reason: 'clip speed is not 100%, so source silence cannot be mapped onto the timeline' });
      continue;
    }
    const range = mk(clip.start, clip.end);
    covered.push(range);
    const silent = silenceByMedia
      .get(clip.mediaPath)!
      .map((s) => mk(
        clip.start + Math.max(s.start, clip.inPoint) - clip.inPoint,
        clip.start + Math.min(s.end, clip.outPoint) - clip.inPoint,
      ))
      .filter((s) => s.end > s.start);
    sound.push(...subtractIntervals([range], silent));
  }

  const removable = subtractIntervals(covered, sound);
  const fps = opts.frameDuration;
  const cuts: Interval[] = [];
  for (const r of removable) {
    // Pad inward, then snap inward to the frame grid so a razor lands on a frame.
    const start = Math.ceil((r.start + opts.paddingSeconds) / fps - 1e-6) * fps;
    const end = Math.floor((r.end - opts.paddingSeconds) / fps + 1e-6) * fps;
    if (end - start >= Math.max(opts.minCutSeconds, fps)) cuts.push(mk(start, end));
  }
  return { cuts, skippedClips };
}

export type PreflightCode =
  | 'MEDIA_MISSING'
  | 'MEDIA_UNREADABLE'
  | 'VFR_SOURCE'
  | 'FPS_MISMATCH'
  | 'AUDIO_MONO'
  | 'AUDIO_MULTICHANNEL'
  | 'AUDIO_RATE_MISMATCH';

export interface PreflightIssue {
  code: PreflightCode;
  severity: 'error' | 'warning';
  message: string;
}

export interface PreflightOptions {
  sequenceFps?: number | undefined;
  targetSampleRate?: number | undefined;
}

const VFR_RATIO = 0.02;
const FPS_EPSILON = 0.01;

export function preflightIssues(probe: ProbedMedia, opts: PreflightOptions): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const video = probe.streams.find((s) => s.type === 'video');
  const audio = probe.streams.find((s) => s.type === 'audio');

  if (video?.rFrameRate && video.avgFrameRate) {
    const drift = Math.abs(video.rFrameRate - video.avgFrameRate) / video.rFrameRate;
    if (drift > VFR_RATIO) {
      issues.push({
        code: 'VFR_SOURCE',
        severity: 'warning',
        message: `Variable frame rate (nominal ${video.rFrameRate.toFixed(3)} fps, measured ${video.avgFrameRate.toFixed(3)} fps). Premiere may drift out of sync; transcode to constant frame rate first.`,
      });
    }
  }
  const fps = video?.avgFrameRate ?? video?.rFrameRate;
  if (fps && opts.sequenceFps && Math.abs(fps - opts.sequenceFps) > FPS_EPSILON) {
    issues.push({
      code: 'FPS_MISMATCH',
      severity: 'warning',
      message: `Source is ${fps.toFixed(3)} fps but the sequence is ${opts.sequenceFps.toFixed(3)} fps; Premiere will resample and cuts may land off-frame.`,
    });
  }
  if (audio?.channels === 1) {
    issues.push({ code: 'AUDIO_MONO', severity: 'warning', message: 'Mono audio: it will sit in the left channel only unless duplicated to stereo.' });
  } else if (audio?.channels && audio.channels > 2) {
    issues.push({ code: 'AUDIO_MULTICHANNEL', severity: 'warning', message: `${audio.channels}-channel audio: it will import as a multichannel clip, not stereo.` });
  }
  if (audio?.sampleRate && opts.targetSampleRate && audio.sampleRate !== opts.targetSampleRate) {
    issues.push({
      code: 'AUDIO_RATE_MISMATCH',
      severity: 'warning',
      message: `Audio is ${audio.sampleRate} Hz but the target is ${opts.targetSampleRate} Hz; Premiere will conform it.`,
    });
  }
  return issues;
}

/** Gain in dB that brings a measured loudness to the target, bounded by what a clip's Volume can express. */
export function loudnessGainDb(measuredLufs: number, targetLufs: number): number {
  const MAX_GAIN_DB = 15;
  const MIN_GAIN_DB = -40;
  return round3(Math.min(MAX_GAIN_DB, Math.max(MIN_GAIN_DB, targetLufs - measuredLufs)));
}

export interface NormalizeRangesOptions {
  /** Sequence length in seconds; ranges are clamped to [0, total]. */
  total: number;
  frameDuration: number;
  /** Cuts closer together than this are merged into one. */
  mergeGapSec: number;
  /** A kept stretch shorter than this is cut too, so no sliver is left behind. */
  minKeepSec: number;
  /** When true, `ranges` is the set to KEEP and everything else is cut. */
  invert: boolean;
}

/**
 * The stretches to cut, sorted, merged and snapped to the frame grid.
 * `ranges` are cuts, or with `invert` the stretches to keep (the result is the cut set either way).
 */
export function normalizeRanges(ranges: Interval[], opts: NormalizeRangesOptions): Interval[] {
  const { total, frameDuration: fd } = opts;
  if (!(total > 0) || !(fd > 0)) return [];
  const snap = (t: number): number => round3(Math.round(t / fd - 1e-9) * fd) + 0;
  const clamped = ranges
    .map((r) => mk(Math.max(0, r.start), Math.min(total, r.end)))
    .filter((r) => r.end > r.start);
  const whole = mk(0, total);
  const cuts = opts.invert ? subtractIntervals([whole], clamped) : unionIntervals(clamped);
  const snapped = unionIntervals(cuts.map((c) => mk(snap(c.start), snap(c.end))));

  const out: Interval[] = [];
  for (const cut of snapped) {
    const last = out[out.length - 1];
    if (last && cut.start - last.end < Math.max(opts.mergeGapSec, opts.minKeepSec) - 1e-9) {
      out[out.length - 1] = mk(last.start, cut.end);
    } else {
      out.push(cut);
    }
  }
  // Slivers kept at the very start or end of the sequence.
  if (out.length > 0) {
    const first = out[0]!;
    if (first.start > 0 && first.start < opts.minKeepSec - 1e-9) out[0] = mk(0, first.end);
    const tail = out[out.length - 1]!;
    if (tail.end < total && total - tail.end < opts.minKeepSec - 1e-9) out[out.length - 1] = mk(tail.start, total);
  }
  return out.filter((c) => c.end - c.start >= fd - 1e-9);
}

/** Frames of audio crossfade for a requested length: 0 when off, otherwise at least 1 frame. */
export function crossfadeFrames(crossfadeMs: number, frameDuration: number): number {
  if (!(crossfadeMs > 0)) return 0;
  return Math.max(1, Math.round(crossfadeMs / 1000 / frameDuration));
}
