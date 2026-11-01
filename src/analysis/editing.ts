/**
 * Pure decisions for the editing helpers: where speech is, where music should
 * duck, what is wrong with a timeline, and which clips get a punch-in. Premiere
 * and ffmpeg are not touched here, so every rule is testable with plain data.
 */
import type { Interval } from './ffmpeg.js';
import { subtractIntervals, unionIntervals, type SequenceClip } from './cleanup.js';

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const mk = (start: number, end: number): Interval => ({ start: round3(start), end: round3(end), duration: round3(end - start) });

const SPEED_TOLERANCE = 0.01;

/** True when the clip plays at 100%: timeline length equals source length. */
export const playsAtNormalSpeed = (c: SequenceClip): boolean =>
  Math.abs((c.end - c.start) - (c.outPoint - c.inPoint)) <= SPEED_TOLERANCE * Math.max(1, c.end - c.start);

// ------------------------------------------------------------------ ducking

export interface SpeechOptions {
  /** Speech separated by less than this is one phrase, so music does not pump between words. */
  mergeGapSeconds: number;
  /** Speech shorter than this is a cough or click, not worth ducking for. */
  minSpeechSeconds: number;
}

/**
 * Timeline ranges where any dialogue clip has sound. Source silence is mapped
 * through each clip's in-point; clips that are not at 100% speed are reported and
 * treated as speech for their whole length, the safe side for ducking.
 */
export function speechOnTimeline(
  dialogue: SequenceClip[],
  silenceByMedia: Map<string, Interval[]>,
  opts: SpeechOptions,
): { speech: Interval[]; assumedSpeech: string[] } {
  const raw: Interval[] = [];
  const assumedSpeech: string[] = [];
  for (const clip of dialogue) {
    if (!playsAtNormalSpeed(clip) || !clip.mediaPath) {
      assumedSpeech.push(clip.id);
      raw.push(mk(clip.start, clip.end));
      continue;
    }
    const silence = silenceByMedia.get(clip.mediaPath) ?? [];
    for (const live of subtractIntervals([mk(clip.inPoint, clip.outPoint)], silence)) {
      raw.push(mk(clip.start + (live.start - clip.inPoint), clip.start + (live.end - clip.inPoint)));
    }
  }
  const merged: Interval[] = [];
  for (const i of unionIntervals(raw)) {
    const last = merged[merged.length - 1];
    if (last && i.start - last.end < opts.mergeGapSeconds) merged[merged.length - 1] = mk(last.start, i.end);
    else merged.push(i);
  }
  return { speech: merged.filter((i) => i.duration >= opts.minSpeechSeconds), assumedSpeech };
}

/** Speech inside one music clip, expressed in that clip's source time as setup_ducking expects. */
export function duckingWindowsFor(
  music: SequenceClip,
  speech: Interval[],
  duckedDb: number,
): Array<{ startTime: number; endTime: number; duckedDb: number }> {
  const windows: Array<{ startTime: number; endTime: number; duckedDb: number }> = [];
  for (const s of speech) {
    const start = Math.max(s.start, music.start);
    const end = Math.min(s.end, music.end);
    if (end <= start) continue;
    windows.push({
      startTime: round3(music.inPoint + (start - music.start)),
      endTime: round3(music.inPoint + (end - music.start)),
      duckedDb,
    });
  }
  return windows;
}

// ---------------------------------------------------------------------- QA

export type QaCode = 'FLASH_FRAME' | 'GAP' | 'MEDIA_MISSING' | 'OVERLAP';

export interface QaFinding {
  code: QaCode;
  severity: 'error' | 'warning';
  message: string;
  trackType?: 'audio' | 'video';
  trackIndex?: number;
  clipId?: string;
  at?: number;
  duration?: number;
}

export interface QaOptions {
  frameDuration: number;
  /** Video clips shorter than this many frames are flagged as flash frames. */
  minClipFrames: number;
}

/** Structural problems found from clip positions alone. Media existence is checked by the caller. */
export function structuralFindings(clips: SequenceClip[], opts: QaOptions): QaFinding[] {
  const findings: QaFinding[] = [];
  const half = opts.frameDuration / 2;

  for (const c of clips) {
    const frames = (c.end - c.start) / opts.frameDuration;
    if (c.trackType === 'video' && frames < opts.minClipFrames - 1e-6) {
      findings.push({
        code: 'FLASH_FRAME', severity: 'warning', trackType: 'video', trackIndex: c.trackIndex, clipId: c.id,
        at: round3(c.start), duration: round3(c.end - c.start),
        message: `Video clip is ${Math.max(1, Math.round(frames))} frame(s) long, likely a leftover from a cut.`,
      });
    }
  }

  const tracks = new Map<string, SequenceClip[]>();
  for (const c of clips) {
    const key = `${c.trackType}:${c.trackIndex}`;
    tracks.set(key, [...(tracks.get(key) ?? []), c]);
  }
  for (const [key, list] of tracks) {
    const [trackType, index] = key.split(':') as ['audio' | 'video', string];
    const sorted = [...list].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const next = sorted[i]!;
      const delta = next.start - prev.end;
      if (delta > half) {
        findings.push({
          code: 'GAP', severity: 'warning', trackType, trackIndex: Number(index), at: round3(prev.end), duration: round3(delta),
          message: `${round3(delta)}s gap on ${trackType} track ${Number(index) + 1} (black or silence).`,
        });
      } else if (delta < -half) {
        findings.push({
          code: 'OVERLAP', severity: 'error', trackType, trackIndex: Number(index), clipId: next.id, at: round3(next.start), duration: round3(-delta),
          message: `Clips overlap by ${round3(-delta)}s on ${trackType} track ${Number(index) + 1}.`,
        });
      }
    }
  }
  return findings.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

// -------------------------------------------------------------- punch-in

export interface PunchOptions {
  /** Every nth video clip is punched in. 2 alternates wide and tight. */
  everyNth: number;
  /** Skip this many clips first, so the opening shot stays wide. */
  skip: number;
  /** Clips shorter than this keep their framing: a cut that fast reads as a jump already. */
  minClipSeconds: number;
}

/** Ids of the video clips on one track that should be scaled up, in timeline order. */
export function punchInTargets(clips: SequenceClip[], trackIndex: number, opts: PunchOptions): string[] {
  const track = clips
    .filter((c) => c.trackType === 'video' && c.trackIndex === trackIndex)
    .sort((a, b) => a.start - b.start);
  return track
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => i >= opts.skip && (i - opts.skip) % opts.everyNth === opts.everyNth - 1 && c.end - c.start >= opts.minClipSeconds)
    .map(({ c }) => c.id);
}
