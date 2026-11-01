/**
 * Runner for the Python sidecar (`python -m premiere_mcp_sidecar`) that hosts the heavy
 * models (speech recognition, face counting). The sidecar lives in its own venv under the
 * data home, so a machine without it keeps every other tool working.
 *
 * Long work runs as detached background jobs whose state lives entirely on disk, so a job
 * outlives an MCP restart and can be polled by key afterwards.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export interface JobState {
  status: 'running' | 'done' | 'failed';
  progress: number;
  etaSec?: number;
  result?: unknown;
  error?: string;
}

export class SidecarError extends Error {
  stderrTail: string;
  constructor(message: string, stderrTail = '') {
    super(message);
    this.name = 'SidecarError';
    this.stderrTail = stderrTail;
  }
}

const STDERR_TAIL_CHARS = 2000;
const SETUP_COMMAND = 'premiere-pro-mcp --setup-asr';

export function premiereMcpHome(): string {
  return process.env.PREMIERE_MCP_HOME || join(homedir(), '.premiere-mcp');
}

export async function sidecarPython(): Promise<string | null> {
  const python = platform() === 'win32'
    ? join(premiereMcpHome(), 'venv', 'Scripts', 'python.exe')
    : join(premiereMcpHome(), 'venv', 'bin', 'python');
  return existsSync(python) ? python : null;
}

export function modelPaths(): { whisper: string; yunet: string } {
  const models = join(premiereMcpHome(), 'models');
  return {
    whisper: join(models, 'faster-whisper-large-v3'),
    yunet: join(models, 'face_detection_yunet_2023mar.onnx'),
  };
}

export function sidecarMissingResult(tool: string): Record<string, unknown> {
  return {
    success: false,
    retry: false,
    status: 'not_installed',
    userActionRequired: true,
    errorCode: 'asr.not_installed',
    error: `The speech and face analysis sidecar is not installed, and ${tool} needs it.`,
    command: SETUP_COMMAND,
    nextStep: `The analysis sidecar is not installed. Run this in a terminal on this machine (it downloads about 3 GB of models and Python packages, so allow roughly 3 GB of free disk), then retry ${tool} once: ${SETUP_COMMAND}`,
  };
}

function tail(text: string): string {
  return text.length > STDERR_TAIL_CHARS ? text.slice(-STDERR_TAIL_CHARS) : text;
}

async function readJson(path: string): Promise<any | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function sidecarArgs(command: string, files: { input: string; output: string; progress?: string }): string[] {
  const args = ['-m', 'premiere_mcp_sidecar', command, '--input', files.input, '--output', files.output];
  if (files.progress) args.push('--progress', files.progress);
  return args;
}

/** Write via a temp file and rename so a reader never sees a half-written file. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, path);
}

/** Run a sidecar command and wait for it. Failures throw SidecarError with the stderr tail. */
export async function runSidecar<T>(command: string, input: object, timeoutMs = 600_000): Promise<T> {
  const python = await sidecarPython();
  if (!python) throw new SidecarError(`The analysis sidecar is not installed. Run: ${SETUP_COMMAND}`);
  const runs = join(premiereMcpHome(), 'jobs');
  await mkdir(runs, { recursive: true });
  const dir = await mkdtemp(join(runs, 'run-'));
  try {
    const files = { input: join(dir, 'input.json'), output: join(dir, 'output.json') };
    await writeJsonAtomic(files.input, input);
    const { code, stderr, timedOut } = await new Promise<{ code: number | null; stderr: string; timedOut: boolean }>((resolve, reject) => {
      const proc = spawn(python, sidecarArgs(command, files), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let stderrText = '';
      let timedOutFlag = false;
      const timer = setTimeout(() => { timedOutFlag = true; proc.kill(); }, timeoutMs);
      proc.stderr!.on('data', (chunk) => { stderrText = tail(stderrText + chunk.toString()); });
      proc.on('error', (error) => { clearTimeout(timer); reject(new SidecarError(`Could not start the sidecar: ${error.message}`)); });
      proc.on('close', (exitCode) => { clearTimeout(timer); resolve({ code: exitCode, stderr: stderrText, timedOut: timedOutFlag }); });
    });
    if (timedOut) throw new SidecarError(`The sidecar command ${command} timed out after ${timeoutMs} ms.`, stderr);
    const output = await readJson(files.output);
    if (output && typeof output.error === 'string') throw new SidecarError(output.error, stderr);
    if (code !== 0 || output === undefined) {
      const last = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
      throw new SidecarError(`The sidecar command ${command} failed (exit ${code}).${last ? ` ${last}` : ''}`, stderr);
    }
    return output as T;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function jobDir(key: string): string {
  return join(premiereMcpHome(), 'jobs', createHash('sha1').update(key).digest('hex'));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function finished(output: any): JobState {
  return output && typeof output.error === 'string'
    ? { status: 'failed', progress: 0, error: output.error }
    : { status: 'done', progress: 1, result: output };
}

export async function jobStatus(key: string): Promise<JobState | null> {
  const dir = jobDir(key);
  if (!existsSync(join(dir, 'input.json'))) return null;

  const output = await readJson(join(dir, 'output.json'));
  if (output !== undefined) return finished(output);

  const pidText = (await readText(join(dir, 'pid'))).trim();
  const pid = Number(pidText);
  const progress = await readJson(join(dir, 'progress.json'));
  const done = typeof progress?.done === 'number' ? progress.done : 0;
  // No pid yet means startJob is still between spawn and writing it.
  if (!pidText || (Number.isInteger(pid) && pid > 0 && pidAlive(pid))) {
    const state: JobState = { status: 'running', progress: done };
    if (typeof progress?.etaSec === 'number') state.etaSec = progress.etaSec;
    return state;
  }
  // The process is gone; output.json may have landed between the two reads.
  const late = await readJson(join(dir, 'output.json'));
  if (late !== undefined) return finished(late);
  const stderr = tail(await readText(join(dir, 'stderr.log'))).trim();
  return {
    status: 'failed',
    progress: done,
    error: `The sidecar process exited without producing a result.${stderr ? ` ${stderr}` : ''}`,
  };
}

/**
 * Start a detached background job, or report the existing one. A running or finished job for the
 * same key is reused; a failed one is replaced by a fresh run.
 */
export async function startJob(key: string, command: string, input: object): Promise<JobState> {
  const existing = await jobStatus(key);
  if (existing && existing.status !== 'failed') return existing;

  const python = await sidecarPython();
  if (!python) throw new SidecarError(`The analysis sidecar is not installed. Run: ${SETUP_COMMAND}`);

  const dir = jobDir(key);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const files = { input: join(dir, 'input.json'), output: join(dir, 'output.json'), progress: join(dir, 'progress.json') };
  await writeJsonAtomic(files.input, input);

  const errFd = openSync(join(dir, 'stderr.log'), 'a');
  try {
    const proc = spawn(python, sidecarArgs(command, files), {
      detached: true,
      stdio: ['ignore', 'ignore', errFd],
      windowsHide: true,
    });
    proc.on('error', () => undefined);
    proc.unref();
    if (proc.pid) await writeFile(join(dir, 'pid'), String(proc.pid));
  } finally {
    closeSync(errFd);
  }
  return { status: 'running', progress: 0 };
}
