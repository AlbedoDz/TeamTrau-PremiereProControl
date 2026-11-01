/**
 * Runner for the Python sidecar (`python -m premiere_mcp_sidecar`) that hosts the heavy
 * models (speech recognition, face counting). The sidecar lives in its own venv under the
 * data home, so a machine without it keeps every other tool working.
 *
 * Long work runs as detached background jobs whose state lives entirely on disk, so a job
 * outlives an MCP restart and can be polled by key afterwards.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, openSync, statSync, writeFileSync } from 'node:fs';
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
    whisper: join(models, 'faster-whisper-large-v3-turbo'),
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
    nextStep: `The analysis sidecar is not installed. Run this in a terminal on this machine (it downloads about 2 GB of models and Python packages, so allow roughly 2 GB of free disk), then retry ${tool} once: ${SETUP_COMMAND}`,
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

const NO_PID_GRACE_MS = 10_000;
const STALE_MS = 10 * 60_000;
const KILL_GRACE_MS = 2_000;
const STDERR_DRAIN_MS = 500;

/** Kill a child and its descendants: taskkill /T on Windows, SIGTERM then SIGKILL elsewhere. */
function killTree(proc: ChildProcess): void {
  if (platform() === 'win32' && proc.pid) {
    const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => { try { proc.kill(); } catch { /* already gone */ } });
    return;
  }
  try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, KILL_GRACE_MS).unref();
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
      let settled = false;
      const settle = (timedOutFlag: boolean, exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.stderr?.destroy();
        resolve({ code: exitCode, stderr: stderrText, timedOut: timedOutFlag });
      };
      const timer = setTimeout(() => { killTree(proc); settle(true, null); }, timeoutMs);
      proc.stderr?.on('data', (chunk) => { stderrText = tail(stderrText + chunk.toString()); });
      proc.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new SidecarError(`Could not start the sidecar: ${error.message}`));
      });
      proc.on('exit', (exitCode) => {
        // Let buffered stderr drain (capped) so the failure tail is not lost.
        const stream = proc.stderr;
        if (!stream || stream.destroyed || stream.readableEnded) return settle(false, exitCode);
        const drained = (): void => settle(false, exitCode);
        stream.once('close', drained);
        stream.once('end', drained);
        setTimeout(drained, STDERR_DRAIN_MS).unref();
      });
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
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
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

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** The pid file holds {pid, startedAt}; a bare number from an older writer is accepted too. */
async function readPid(dir: string): Promise<number | null> {
  const text = (await readText(join(dir, 'pid'))).trim();
  if (!text) return null;
  let pid: unknown = Number(text);
  if (Number.isNaN(pid)) {
    try { pid = JSON.parse(text)?.pid; } catch { return null; }
  }
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
}

export async function jobStatus(key: string): Promise<JobState | null> {
  const dir = jobDir(key);
  const inputPath = join(dir, 'input.json');
  if (!existsSync(inputPath)) return null;

  const output = await readJson(join(dir, 'output.json'));
  if (output !== undefined) return finished(output);

  const progress = await readJson(join(dir, 'progress.json'));
  const done = typeof progress?.done === 'number' ? progress.done : 0;
  const failed = (error: string): JobState => ({ status: 'failed', progress: done, error });
  const stderr = tail(await readText(join(dir, 'stderr.log'))).trim();

  const spawnError = (await readText(join(dir, 'spawn-error'))).trim();
  if (spawnError) return failed(`The sidecar could not be started: ${spawnError}`);

  const pid = await readPid(dir);
  const now = Date.now();
  if (pid === null) {
    // startJob writes the pid right after spawning; a long-missing pid means it never got that far.
    if (now - mtimeMs(inputPath) > NO_PID_GRACE_MS) return failed('The sidecar job never started (no process id was recorded).');
    return { status: 'running', progress: done };
  }

  if (pidAlive(pid)) {
    const lastActivity = Math.max(mtimeMs(join(dir, 'progress.json')), mtimeMs(join(dir, 'stderr.log')), mtimeMs(inputPath));
    if (now - lastActivity > STALE_MS) {
      return failed('The sidecar job made no progress for 10 minutes; the process is presumed gone (its pid may have been recycled).');
    }
    const state: JobState = { status: 'running', progress: done };
    if (typeof progress?.etaSec === 'number') state.etaSec = progress.etaSec;
    return state;
  }

  // The process is gone; output.json may have landed between the reads.
  const late = await readJson(join(dir, 'output.json'));
  if (late !== undefined) return finished(late);
  if (existsSync(join(dir, 'output.json'))) return failed('The sidecar exited and its output unreadable: output.json is not valid JSON.');
  return failed(`The sidecar process exited without producing a result.${stderr ? ` ${stderr}` : ''}`);
}

const inflight = new Map<string, Promise<JobState>>();

/**
 * Start a detached background job, or report the existing one. A running or finished job for the
 * same key is reused; a failed one is replaced by a fresh run. Concurrent calls (in this process
 * or another) for one key spawn once.
 */
export function startJob(key: string, command: string, input: object): Promise<JobState> {
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = startJobOnce(key, command, input).finally(() => { inflight.delete(key); });
  inflight.set(key, run);
  return run;
}

async function startJobOnce(key: string, command: string, input: object): Promise<JobState> {
  const existing = await jobStatus(key);
  if (existing && existing.status !== 'failed') return existing;

  const python = await sidecarPython();
  if (!python) throw new SidecarError(`The analysis sidecar is not installed. Run: ${SETUP_COMMAND}`);

  const dir = jobDir(key);
  if (existing) {
    // Replace the failed job. A dir whose pid is still alive (stale/recycled) is moved aside, never deleted.
    const pid = await readPid(dir);
    try {
      if (pid !== null && pidAlive(pid)) await rename(dir, `${dir}.stale-${Date.now()}`);
      else await rm(dir, { recursive: true, force: true });
    } catch { /* another process replaced it first */ }
  }
  await mkdir(join(premiereMcpHome(), 'jobs'), { recursive: true });
  try {
    await mkdir(dir); // non-recursive: acts as the lock
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return (await jobStatus(key)) ?? { status: 'running', progress: 0 };
    }
    throw error;
  }
  const files = { input: join(dir, 'input.json'), output: join(dir, 'output.json'), progress: join(dir, 'progress.json') };
  await writeJsonAtomic(files.input, input);

  const recordSpawnError = (message: string): void => {
    try {
      writeFileSync(join(dir, 'spawn-error'), message);
      appendFileSync(join(dir, 'stderr.log'), `${message}\n`);
    } catch { /* job dir vanished */ }
  };

  const errFd = openSync(join(dir, 'stderr.log'), 'a');
  try {
    const proc = spawn(python, sidecarArgs(command, files), {
      detached: true,
      stdio: ['ignore', 'ignore', errFd],
      windowsHide: true,
    });
    proc.on('error', (error) => recordSpawnError(error.message));
    proc.unref();
    if (proc.pid) await writeJsonAtomic(join(dir, 'pid'), { pid: proc.pid, startedAt: new Date().toISOString() });
    else recordSpawnError('the process could not be spawned (no process id)');
  } catch (error) {
    recordSpawnError((error as Error).message);
  } finally {
    closeSync(errFd);
  }
  return { status: 'running', progress: 0 };
}
