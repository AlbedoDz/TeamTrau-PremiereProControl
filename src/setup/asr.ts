import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { premiereMcpHome, runSidecar, sidecarPython } from '../analysis/sidecar.js';
import { readAsrEngine, writeAsrEngine } from '../analysis/asr-config.js';
import {
  DEFAULT_ENGINE,
  ENGINES,
  VAD_MB,
  downloadMb,
  installedEngines,
  usesZipformer,
  type CheckReport,
  type EngineId,
} from '../analysis/asr-engines.js';

export interface AsrStatus {
  installed: boolean;
  cuda?: boolean;
  models?: {
    whisper: boolean;
    yunet: boolean;
  };
  /** The engine used when a tool gets no `engine`: the configured one, else zipformer-68m. */
  defaultEngine: EngineId;
  /** Which engines have every model installed. Absent when the sidecar check failed. */
  engines?: Record<EngineId, boolean>;
  nextStep?: string;
}

export interface AsrStatusOptions {
  timeoutMs?: number;
  maxAgeMs?: number;
}

export interface SetupAsrOptions {
  pkgPythonDir: string;
  spawnFn?: typeof spawn;
  home?: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  nvidiaProbeTimeoutMs?: number;
  /** Engine to install after asking for consent. Without it only the default engine is installed. */
  engine?: EngineId;
  /** Consent already given on the command line (--yes). */
  yes?: boolean;
  /** Keep the current default engine instead of switching to `engine` (--no-default). */
  noDefault?: boolean;
  isTTY?: boolean;
  /** Asks the user a yes/no question; defaults to a readline prompt. */
  confirm?: (question: string) => Promise<boolean>;
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/** Sidecar engine ids to download; rover is both zipformers. */
function downloadEngines(engine: EngineId): string[] {
  return engine === 'rover' ? ['zipformer-68m', 'zipformer-30m'] : [engine];
}

function runCommand(
  cmd: string,
  args: string[],
  log: (line: string) => void,
  spawnFn: typeof spawn = spawn
): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to spawn ${cmd}: ${msg}`);
      return resolve(1);
    }

    let settled = false;
    const settle = (code: number) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };

    const attach = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      let buffer = '';
      stream.on('data', (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          log(line);
        }
      });
      stream.on('end', () => {
        if (buffer) {
          log(buffer);
          buffer = '';
        }
      });
    };

    attach(child.stdout);
    attach(child.stderr);

    child.on('error', (err) => {
      log(`Error running ${cmd}: ${err.message}`);
      settle(1);
    });

    child.on('exit', (code) => {
      setImmediate(() => settle(code ?? 1));
    });

    child.on('close', (code) => {
      settle(code ?? 1);
    });
  });
}

async function isUvAvailable(spawnFn: typeof spawn = spawn): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (val: boolean) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };
    try {
      const child = spawnFn('uv', ['--version'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => settle(false));
      child.on('exit', (code) => settle(code === 0));
      child.on('close', (code) => settle(code === 0));
    } catch {
      settle(false);
    }
  });
}

async function hasNvidiaGpu(
  spawnFn: typeof spawn = spawn,
  timeoutMs = 15_000
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const settle = (val: boolean) => {
      cleanup();
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };

    try {
      const child = spawnFn('nvidia-smi', [], {
        stdio: 'ignore',
        windowsHide: true,
      });

      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore kill error
        }
        settle(false);
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      child.on('error', () => settle(false));
      child.on('exit', (code) => settle(code === 0));
      child.on('close', (code) => settle(code === 0));
    } catch {
      settle(false);
    }
  });
}

export async function setupAsr(
  log: (line: string) => void,
  options: SetupAsrOptions
): Promise<number> {
  const plat = options.platform ?? process.platform;
  const spawnFn = options.spawnFn ?? spawn;
  const home = options.home ?? premiereMcpHome();
  const pkgPythonDir = options.pkgPythonDir;
  const exists = options.exists ?? existsSync;

  const venvDir = join(home, 'venv');
  const py = plat === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');

  const reqTxt = join(pkgPythonDir, 'requirements.txt');
  const cudaTxt = join(pkgPythonDir, 'requirements-cuda.txt');
  const engine: EngineId = options.engine ?? DEFAULT_ENGINE;
  const explicit = options.engine !== undefined;

  // CUDA libraries only for whisper-turbo, and only when nvidia-smi finds a GPU (probed once).
  let installCuda = false;
  if (explicit) {
    const info = ENGINES[engine];
    let cudaNote = '';
    if (info.needsCuda && (plat === 'win32' || plat === 'linux')) {
      installCuda = await hasNvidiaGpu(spawnFn, options.nvidiaProbeTimeoutMs);
      cudaNote = installCuda ? ' plus about 2 GB of CUDA libraries' : '';
      log(installCuda
        ? 'NVIDIA GPU found: installing CUDA libraries (about 2 GB).'
        : 'No NVIDIA GPU found: skipping CUDA libraries; transcription will run on the CPU.');
    }
    log(`Engine ${engine}: ${info.label}`);
    log(`Download: about ${downloadMb(engine)} MB${usesZipformer(engine) ? ` (includes a ${VAD_MB} MB voice-activity model)` : ''}${cudaNote}.`);
    log(`License: ${info.license}${info.nonCommercial ? ' (non-commercial use only)' : ''}.`);
    if (!options.yes) {
      const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
      if (!isTTY) {
        log(`This download needs your approval. Re-run with --yes to approve it: premiere-pro-mcp --setup-asr --engine ${engine} --yes`);
        return 2;
      }
      const approved = await (options.confirm ?? askYesNo)(`Download ${engine} now?`);
      if (!approved) {
        log('Cancelled: nothing was downloaded.');
        return 1;
      }
    }
  }

  const venvExists = exists(py);
  if (venvExists) {
    log(`Reusing the existing Python environment at ${py}`);
  }

  const uv = await isUvAvailable(spawnFn);

  if (uv) {
    let code = 0;
    if (!venvExists) {
      code = await runCommand('uv', ['venv', '-p', '3.12', venvDir], log, spawnFn);
    }
    if (code !== 0) return code;

    code = await runCommand('uv', ['pip', 'install', '-p', py, '-r', reqTxt], log, spawnFn);
    if (code !== 0) return code;

    if (installCuda) {
      code = await runCommand('uv', ['pip', 'install', '-p', py, '-r', cudaTxt], log, spawnFn);
      if (code !== 0) return code;
    }

    code = await runCommand('uv', ['pip', 'install', '-p', py, pkgPythonDir], log, spawnFn);
    if (code !== 0) return code;
  } else {
    if (!venvExists) {
      let venvCode = -1;
    if (plat === 'win32') {
      const pyCode = await runCommand('py', ['-3.12', '-m', 'venv', venvDir], log, spawnFn);
      if (pyCode === 0) {
        venvCode = 0;
      }
    } else {
      const py3Code = await runCommand('python3', ['-m', 'venv', venvDir], log, spawnFn);
      if (py3Code === 0) {
        venvCode = 0;
      }
    }
    if (venvCode !== 0) {
      venvCode = await runCommand('python', ['-m', 'venv', venvDir], log, spawnFn);
      if (venvCode !== 0) return venvCode;
    }
    }

    let code = await runCommand(py, ['-m', 'pip', 'install', '-r', reqTxt], log, spawnFn);
    if (code !== 0) return code;

    if (installCuda) {
      code = await runCommand(py, ['-m', 'pip', 'install', '-r', cudaTxt], log, spawnFn);
      if (code !== 0) return code;
    }

    code = await runCommand(py, ['-m', 'pip', 'install', pkgPythonDir], log, spawnFn);
    if (code !== 0) return code;
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'premiere-setup-asr-'));
  try {
    const downloadInput = join(tmpDir, 'download-input.json');
    const downloadOutput = join(tmpDir, 'download-output.json');
    await mkdir(join(home, 'models'), { recursive: true });
    await writeFile(
      downloadInput,
      JSON.stringify({
        modelsDir: join(home, 'models'),
        engines: downloadEngines(engine),
      })
    );

    let code = await runCommand(
      py,
      ['-m', 'premiere_mcp_sidecar', 'download-models', '--input', downloadInput, '--output', downloadOutput],
      log,
      spawnFn
    );
    if (code !== 0) return code;

    const checkInput = join(tmpDir, 'check-input.json');
    const checkOutput = join(tmpDir, 'check-output.json');
    await writeFile(checkInput, JSON.stringify({}));

    code = await runCommand(
      py,
      ['-m', 'premiere_mcp_sidecar', 'check', '--input', checkInput, '--output', checkOutput],
      log,
      spawnFn
    );
    if (code !== 0) return code;

    try {
      const checkText = await readFile(checkOutput, 'utf8');
      if (checkText.trim()) {
        log(checkText.trim());
      }
    } catch {
      // ignore read error
    }

    if (explicit ? !options.noDefault : (await readAsrEngine(home)) === undefined) {
      await writeAsrEngine(engine, home);
    }
    resetAsrStatusCache();
    return 0;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface CachedAsrStatus {
  result: AsrStatus;
  timestamp: number;
}

let cachedStatus: CachedAsrStatus | null = null;
let inFlightStatus: Promise<AsrStatus> | null = null;

export function resetAsrStatusCache(): void {
  cachedStatus = null;
  inFlightStatus = null;
}

export async function asrStatus(opts?: AsrStatusOptions): Promise<AsrStatus> {
  const maxAgeMs = opts?.maxAgeMs ?? 60_000;
  const timeoutMs = opts?.timeoutMs ?? 60_000;

  const now = Date.now();
  if (maxAgeMs > 0 && cachedStatus && now - cachedStatus.timestamp < maxAgeMs) {
    return cachedStatus.result;
  }

  if (inFlightStatus) {
    return inFlightStatus;
  }

  const promise = (async (): Promise<AsrStatus> => {
    const configured = readAsrEngine();
    const python = await sidecarPython();
    if (!python) {
      return {
        installed: false,
        defaultEngine: (await configured) ?? DEFAULT_ENGINE,
        nextStep:
          'Run premiere-pro-mcp --setup-asr (about 150 MB: the Python environment and the default Zipformer-68M model). Other engines are installed only on request with --engine <id>.',
      };
    }

    try {
      const reportPromise = runSidecar<CheckReport & {
        cuda?: boolean;
        models?: { whisper: boolean; yunet: boolean };
      }>('check', {}, timeoutMs);
      const report = await reportPromise;
      const defaultEngine = (await configured) ?? DEFAULT_ENGINE;

      const result: AsrStatus = { installed: true, defaultEngine, engines: installedEngines(report) };
      if (report?.cuda !== undefined) result.cuda = Boolean(report.cuda);
      if (report?.models !== undefined) result.models = report.models;
      cachedStatus = { result, timestamp: Date.now() };
      return result;
    } catch (error: unknown) {
      const result: AsrStatus = {
        installed: true,
        defaultEngine: (await configured) ?? DEFAULT_ENGINE,
        nextStep: error instanceof Error ? error.message : String(error),
      };
      cachedStatus = { result, timestamp: Date.now() };
      return result;
    }
  })().finally(() => {
    if (inFlightStatus === promise) {
      inFlightStatus = null;
    }
  });

  inFlightStatus = promise;
  return promise;
}
