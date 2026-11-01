/**
 * ffmpeg / ffprobe access shared by every tool that analyses media outside Premiere.
 *
 * Premiere's scripting surface cannot read audio levels or pixels, so analysis
 * runs here against the media file on disk. Both binaries are optional; callers
 * turn a missing one into an actionable nextStep instead of a spawn failure.
 */
import { spawn } from 'child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { delimiter, join } from 'node:path';

export type FfTool = 'ffmpeg' | 'ffprobe';

export interface FfmpegRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function ffmpegInstallHint(retryTool = 'the tool'): { command: string; nextStep: string } {
  if (platform() === 'win32') {
    return {
      command: 'winget install --id Gyan.FFmpeg -e',
      nextStep: `ffmpeg is not installed. Run this in a terminal on this machine, then retry ${retryTool} once: winget install --id Gyan.FFmpeg -e`,
    };
  }
  if (platform() === 'darwin') {
    return {
      command: 'brew install ffmpeg',
      nextStep: `ffmpeg is not installed. Run this in a terminal on this machine, then retry ${retryTool} once: brew install ffmpeg`,
    };
  }
  return {
    command: 'sudo apt-get install -y ffmpeg',
    nextStep: `ffmpeg is not installed. Install ffmpeg with your package manager, then retry ${retryTool} once.`,
  };
}

function resolveBinary(tool: FfTool): string | null {
  const names = platform() === 'win32' ? [`${tool}.exe`, tool] : [tool];
  const dirs = (process.env.PATH || '').split(delimiter);
  if (platform() === 'darwin') {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  } else if (platform() === 'win32') {
    dirs.push(join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links'));
    dirs.push('C:\\ffmpeg\\bin');
  }
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Locate a binary: PATH first (what a shell would find), then well-known
 * install folders. Under jest only the bare-name probe is trusted so a
 * developer's local install cannot change a test result.
 */
export function findFfTool(tool: FfTool): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(tool, ['-version']);
    const fallback = (): string | null => (process.env.JEST_WORKER_ID ? null : resolveBinary(tool));
    proc.on('error', () => resolve(fallback()));
    proc.on('close', (code) => resolve(code === 0 ? tool : fallback()));
  });
}

export function runFf(bin: string, args: string[]): Promise<FfmpegRun> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export function ffmpegMissingResult(tool: string): Record<string, unknown> {
  const install = ffmpegInstallHint(tool);
  return {
    success: false,
    retry: false,
    status: 'not_found',
    errorCode: 'ffmpeg.not_found',
    error: `ffmpeg was not found on this machine. ${tool} analyses the media file with ffmpeg because Premiere cannot read audio levels or pixels. Install ffmpeg, then retry ${tool} once.`,
    installCommand: install.command,
    nextStep: install.nextStep,
  };
}

export interface Interval {
  start: number;
  end: number;
  duration: number;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Pair `<prefix>_start` / `<prefix>_end` lines emitted by silencedetect, blackdetect, freezedetect. */
export function parseIntervals(stderr: string, startKey: string, endKey: string): Interval[] {
  const read = (key: string): number[] => {
    const re = new RegExp(`${key}:\\s*(-?[\\d.]+)`, 'g');
    const out: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(stderr)) !== null) out.push(parseFloat(match[1]!));
    return out;
  };
  const starts = read(startKey);
  const ends = read(endKey);
  const count = Math.min(starts.length, ends.length);
  const intervals: Interval[] = [];
  for (let i = 0; i < count; i++) {
    intervals.push({ start: starts[i]!, end: ends[i]!, duration: round3(ends[i]! - starts[i]!) });
  }
  return intervals;
}

export const parseSilenceIntervals = (stderr: string): Interval[] =>
  parseIntervals(stderr, 'silence_start', 'silence_end');

/** blackdetect prints `black_start:1.2 black_end:3.4 black_duration:2.2` on one line. */
export const parseBlackIntervals = (stderr: string): Interval[] =>
  parseIntervals(stderr, 'black_start', 'black_end');

export const parseFreezeIntervals = (stderr: string): Interval[] =>
  parseIntervals(stderr, 'lavfi\\.freezedetect\\.freeze_start', 'lavfi\\.freezedetect\\.freeze_end');

/** Integrated loudness (LUFS) from the final `Summary:` block of the ebur128 filter. */
export function parseIntegratedLoudness(stderr: string): number | null {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const match = /I:\s*(-?[\d.]+)\s*LUFS/.exec(summary);
  if (!match) return null;
  const value = parseFloat(match[1]!);
  return Number.isFinite(value) ? value : null;
}

export interface ProbedStream {
  type: 'video' | 'audio';
  codec?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  /** Nominal rate from the container (`r_frame_rate`). */
  rFrameRate?: number | undefined;
  /** Measured mean rate (`avg_frame_rate`); differs from rFrameRate for variable-frame-rate files. */
  avgFrameRate?: number | undefined;
  channels?: number | undefined;
  sampleRate?: number | undefined;
}

export interface ProbedMedia {
  durationSeconds: number | null;
  streams: ProbedStream[];
}

function parseRate(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const [num, den] = value.split('/').map(Number);
  if (!num || !den) return undefined;
  return num / den;
}

export function parseProbe(json: string): ProbedMedia {
  const raw = JSON.parse(json) as { streams?: any[]; format?: { duration?: string } };
  const streams: ProbedStream[] = [];
  for (const s of raw.streams ?? []) {
    if (s.codec_type === 'video') {
      streams.push({
        type: 'video',
        codec: s.codec_name,
        width: s.width,
        height: s.height,
        rFrameRate: parseRate(s.r_frame_rate),
        avgFrameRate: parseRate(s.avg_frame_rate),
      });
    } else if (s.codec_type === 'audio') {
      streams.push({
        type: 'audio',
        codec: s.codec_name,
        channels: s.channels,
        sampleRate: s.sample_rate ? Number(s.sample_rate) : undefined,
      });
    }
  }
  const duration = raw.format?.duration ? parseFloat(raw.format.duration) : NaN;
  return { durationSeconds: Number.isFinite(duration) ? duration : null, streams };
}

export async function probeMedia(ffprobeBin: string, mediaPath: string): Promise<ProbedMedia> {
  const run = await runFf(ffprobeBin, [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', mediaPath,
  ]);
  if (run.code !== 0) {
    throw new Error(`ffprobe could not read ${mediaPath}: ${run.stderr.slice(-300).trim() || `exit ${run.code}`}`);
  }
  return parseProbe(run.stdout);
}
