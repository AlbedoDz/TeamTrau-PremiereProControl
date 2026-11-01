import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { setupAsr, asrStatus, resetAsrStatusCache } from '../../setup/asr.js';
import * as sidecar from '../../analysis/sidecar.js';

jest.mock('node:child_process');
jest.mock('../../analysis/sidecar.js', () => {
  const actual = jest.requireActual('../../analysis/sidecar.js');
  return {
    ...actual,
    sidecarPython: jest.fn(),
    runSidecar: jest.fn(),
  };
});

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

interface FakeChildOpts {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
  neverExit?: boolean;
}

function makeFakeChild(opts: FakeChildOpts = {}) {
  const { exitCode = 0, stdout = '', stderr = '', error, neverExit = false } = opts;
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn();

  if (!neverExit) {
    setImmediate(() => {
      if (error) {
        child.emit('error', error);
        return;
      }
      if (stdout) child.stdout.write(stdout);
      child.stdout.end();
      if (stderr) child.stderr.write(stderr);
      child.stderr.end();
      child.emit('exit', exitCode);
      child.emit('close', exitCode);
    });
  }
  return child;
}

describe('setupAsr and asrStatus', () => {
  const fakeHome = join(tmpdir(), 'fake-premiere-home');
  let spawned: Array<{ cmd: string; args: string[] }>;
  let uvAvailable: boolean;
  let pyLauncherSuccess: boolean;
  let failTarget: string | null;
  let failExitCode: number;
  let nvidiaSmiExitCode: number;
  let nvidiaSmiError: Error | null;
  let nvidiaSmiHangs: boolean;
  let lastNvidiaSmiChild: any;
  let downloadInputs: any[];

  afterAll(async () => {
    await rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
  });

  const savedHome = process.env.PREMIERE_MCP_HOME;
  afterAll(() => {
    if (savedHome === undefined) delete process.env.PREMIERE_MCP_HOME; else process.env.PREMIERE_MCP_HOME = savedHome;
  });

  beforeEach(() => {
    process.env.PREMIERE_MCP_HOME = fakeHome;
    rmSync(join(fakeHome, 'config.json'), { force: true });
    jest.clearAllMocks();
    resetAsrStatusCache();
    spawned = [];
    downloadInputs = [];
    uvAvailable = true;
    pyLauncherSuccess = true;
    failTarget = null;
    failExitCode = 1;
    nvidiaSmiExitCode = 0;
    nvidiaSmiError = null;
    nvidiaSmiHangs = false;
    lastNvidiaSmiChild = null;

    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      spawned.push({ cmd, args: [...args] });
      if (args.includes('download-models')) {
        downloadInputs.push(JSON.parse(readFileSync(args[args.indexOf('--input') + 1]!, 'utf8')));
      }

      if (cmd === 'uv' && args[0] === '--version') {
        if (!uvAvailable) {
          return makeFakeChild({ error: new Error('spawn uv ENOENT') });
        }
        return makeFakeChild({ exitCode: 0, stdout: 'uv 0.5.0\n' });
      }

      if (cmd === 'nvidia-smi') {
        if (nvidiaSmiHangs) {
          lastNvidiaSmiChild = makeFakeChild({ neverExit: true });
          return lastNvidiaSmiChild;
        }
        if (nvidiaSmiError) {
          return makeFakeChild({ error: nvidiaSmiError });
        }
        if (nvidiaSmiExitCode !== 0) {
          return makeFakeChild({ exitCode: nvidiaSmiExitCode, stderr: 'nvidia-smi error\n' });
        }
        return makeFakeChild({ exitCode: 0, stdout: 'nvidia-smi ok\n' });
      }

      if (failTarget && (cmd === failTarget || args.includes(failTarget))) {
        return makeFakeChild({ exitCode: failExitCode, stderr: `error at ${failTarget}\n` });
      }

      if (cmd === 'py') {
        if (!pyLauncherSuccess) {
          return makeFakeChild({ exitCode: 1, stderr: 'Python 3.12 not found\n' });
        }
        return makeFakeChild({ exitCode: 0, stdout: 'py launcher ok\n' });
      }

      return makeFakeChild({ exitCode: 0, stdout: `${cmd} ok\n` });
    });
  });

  describe('setupAsr', () => {
    const fakePkgPythonDir = '/fake/python';

    it('reuses an existing venv', async () => {
      const logs: string[] = [];
      const code = await setupAsr((l) => logs.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'win32',
        home: fakeHome,
        exists: () => true,
      });

      expect(code).toBe(0);
      expect(logs).toContain(
        `Reusing the existing Python environment at ${join(fakeHome, 'venv', 'Scripts', 'python.exe')}`
      );
      const hasVenv = spawned.some(
        (s) => (s.cmd === 'uv' && s.args[0] === 'venv') || s.args.includes('venv')
      );
      expect(hasVenv).toBe(false);
      expect(spawned.some((s) => s.args.includes('pip') && s.args.includes('install'))).toBe(true);
      expect(spawned.some((s) => s.args.includes('download-models'))).toBe(true);
      expect(spawned.some((s) => s.args.includes('check'))).toBe(true);

      uvAvailable = false;
      spawned = [];
      const logsFallback: string[] = [];
      const codeFallback = await setupAsr((l) => logsFallback.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'win32',
        home: fakeHome,
        exists: () => true,
      });

      expect(codeFallback).toBe(0);
      expect(logsFallback).toContain(
        `Reusing the existing Python environment at ${join(fakeHome, 'venv', 'Scripts', 'python.exe')}`
      );
      const hasVenvFallback = spawned.some(
        (s) => (s.cmd === 'uv' && s.args[0] === 'venv') || s.args.includes('venv')
      );
      expect(hasVenvFallback).toBe(false);
      expect(spawned.some((s) => s.args.includes('pip') && s.args.includes('install'))).toBe(true);
      expect(spawned.some((s) => s.args.includes('download-models'))).toBe(true);
      expect(spawned.some((s) => s.args.includes('check'))).toBe(true);
    });

    it('uses uv when available', async () => {
      uvAvailable = true;
      const logsWin: string[] = [];
      const codeWin = await setupAsr((l) => logsWin.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'win32',
        home: fakeHome,
        engine: 'whisper-turbo',
        yes: true,
      });

      expect(codeWin).toBe(0);
      expect(spawned[0]).toEqual({ cmd: 'nvidia-smi', args: [] });
      spawned = spawned.slice(1);
      expect(spawned[0]).toEqual({ cmd: 'uv', args: ['--version'] });
      expect(spawned[1]).toEqual({
        cmd: 'uv',
        args: ['venv', '-p', '3.12', join(fakeHome, 'venv')],
      });
      expect(spawned[2]).toEqual({
        cmd: 'uv',
        args: ['pip', 'install', '-p', expect.stringMatching(/Scripts[\\/]python\.exe$/), '-r', expect.stringContaining('requirements.txt')],
      });
      expect(spawned[3]).toEqual({
        cmd: 'uv',
        args: ['pip', 'install', '-p', expect.stringMatching(/Scripts[\\/]python\.exe$/), '-r', expect.stringContaining('requirements-cuda.txt')],
      });
      expect(spawned[4]).toEqual({
        cmd: 'uv',
        args: ['pip', 'install', '-p', expect.stringMatching(/Scripts[\\/]python\.exe$/), expect.stringMatching(/python$/)],
      });
      expect(spawned[5]).toEqual({
        cmd: expect.stringMatching(/Scripts[\\/]python\.exe$/),
        args: ['-m', 'premiere_mcp_sidecar', 'download-models', '--input', expect.any(String), '--output', expect.any(String)],
      });
      expect(spawned[6]).toEqual({
        cmd: expect.stringMatching(/Scripts[\\/]python\.exe$/),
        args: ['-m', 'premiere_mcp_sidecar', 'check', '--input', expect.any(String), '--output', expect.any(String)],
      });
      expect(spawned[2].args[3]).toContain(fakeHome);
      expect(spawned[3].args[3]).toContain(fakeHome);
      expect(spawned[4].args[3]).toContain(fakeHome);
      expect(spawned[5].cmd).toContain(fakeHome);
      expect(spawned[6].cmd).toContain(fakeHome);
      expect(spawned.every((s) => !JSON.stringify(s).includes('.premiere-mcp'))).toBe(true);
      expect(logsWin).toContain('NVIDIA GPU found: installing CUDA libraries (about 2 GB).');

      // On darwin, CUDA requirements file must NOT be installed and nvidia-smi never probed
      spawned = [];
      const logsDarwin: string[] = [];
      const codeDarwin = await setupAsr((l) => logsDarwin.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'darwin',
        home: fakeHome,
      });

      expect(codeDarwin).toBe(0);
      const darwinHasCuda = spawned.some((s) => s.args.some((a) => a.includes('requirements-cuda.txt')));
      expect(darwinHasCuda).toBe(false);
      expect(spawned.some((s) => s.cmd === 'nvidia-smi')).toBe(false);
      expect(logsDarwin.some((l) => l.includes('CUDA'))).toBe(false);
      expect(spawned).toHaveLength(6);
      expect(spawned[0].cmd).toBe('uv');
      expect(spawned[1]).toEqual({
        cmd: 'uv',
        args: ['venv', '-p', '3.12', join(fakeHome, 'venv')],
      });
      expect(spawned[2]).toEqual({
        cmd: 'uv',
        args: ['pip', 'install', '-p', expect.stringMatching(/bin[\\/]python$/), '-r', expect.stringContaining('requirements.txt')],
      });
      expect(spawned[3]).toEqual({
        cmd: 'uv',
        args: ['pip', 'install', '-p', expect.stringMatching(/bin[\\/]python$/), expect.stringMatching(/python$/)],
      });
      expect(spawned[4].args).toContain('download-models');
      expect(spawned[5].args).toContain('check');
      expect(spawned[2].args[3]).toContain(fakeHome);
      expect(spawned[3].args[3]).toContain(fakeHome);
      expect(spawned[4].cmd).toContain(fakeHome);
      expect(spawned[4].cmd).toMatch(/bin[\\/]python$/);
      expect(spawned[5].cmd).toContain(fakeHome);
      expect(spawned[5].cmd).toMatch(/bin[\\/]python$/);
      expect(spawned.every((s) => !JSON.stringify(s).includes('.premiere-mcp'))).toBe(true);

      // On linux, CUDA requirements file MUST be installed when nvidia-smi succeeds
      spawned = [];
      const logsLinux: string[] = [];
      const codeLinux = await setupAsr((l) => logsLinux.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'linux',
        home: fakeHome,
        engine: 'whisper-turbo',
        yes: true,
      });

      expect(codeLinux).toBe(0);
      const linuxHasCuda = spawned.some((s) => s.args.some((a) => a.includes('requirements-cuda.txt')));
      expect(linuxHasCuda).toBe(true);
      expect(spawned.some((s) => s.cmd === 'nvidia-smi')).toBe(true);
      expect(spawned).toHaveLength(8);
      expect(spawned[0].cmd).toBe('nvidia-smi');
      spawned = spawned.slice(1);
      expect(spawned[1]).toEqual({
        cmd: 'uv',
        args: ['venv', '-p', '3.12', join(fakeHome, 'venv')],
      });
      expect(spawned[2].args[3]).toMatch(/bin[\\/]python$/);
      expect(spawned[2].args[3]).toContain(fakeHome);
      expect(spawned.every((s) => !JSON.stringify(s).includes('.premiere-mcp'))).toBe(true);
      expect(logsLinux).toContain('NVIDIA GPU found: installing CUDA libraries (about 2 GB).');
    });

    it('installs CUDA libraries when nvidia-smi succeeds', async () => {
      nvidiaSmiExitCode = 0;
      const logs: string[] = [];
      const code = await setupAsr((l) => logs.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'win32',
        home: fakeHome,
        engine: 'whisper-turbo',
        yes: true,
      });

      expect(code).toBe(0);
      expect(spawned.some((s) => s.cmd === 'nvidia-smi')).toBe(true);
      const hasCuda = spawned.some((s) => s.args.some((a) => a.includes('requirements-cuda.txt')));
      expect(hasCuda).toBe(true);
      expect(logs).toContain('NVIDIA GPU found: installing CUDA libraries (about 2 GB).');
    });

    it('skips CUDA libraries when nvidia-smi fails', async () => {
      nvidiaSmiExitCode = 1;
      const logs: string[] = [];
      const code = await setupAsr((l) => logs.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'win32',
        home: fakeHome,
        engine: 'whisper-turbo',
        yes: true,
      });

      expect(code).toBe(0);
      expect(spawned.some((s) => s.cmd === 'nvidia-smi')).toBe(true);
      const hasCuda = spawned.some((s) => s.args.some((a) => a.includes('requirements-cuda.txt')));
      expect(hasCuda).toBe(false);
      expect(logs).toContain('No NVIDIA GPU found: skipping CUDA libraries; transcription will run on the CPU.');
    });

    it('skips CUDA libraries when nvidia-smi is missing', async () => {
      nvidiaSmiError = Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });
      const logs: string[] = [];
      const code = await setupAsr((l) => logs.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'win32',
        home: fakeHome,
        engine: 'whisper-turbo',
        yes: true,
      });

      expect(code).toBe(0);
      expect(spawned.some((s) => s.cmd === 'nvidia-smi')).toBe(true);
      const hasCuda = spawned.some((s) => s.args.some((a) => a.includes('requirements-cuda.txt')));
      expect(hasCuda).toBe(false);
      expect(logs).toContain('No NVIDIA GPU found: skipping CUDA libraries; transcription will run on the CPU.');
    });

    it('skips CUDA libraries when nvidia-smi hangs and kills the child', async () => {
      nvidiaSmiHangs = true;
      const logs: string[] = [];
      const code = await setupAsr((l) => logs.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'win32',
        home: fakeHome,
        engine: 'whisper-turbo',
        yes: true,
        nvidiaProbeTimeoutMs: 10,
      });

      expect(code).toBe(0);
      expect(spawned.some((s) => s.cmd === 'nvidia-smi')).toBe(true);
      const hasCuda = spawned.some((s) => s.args.some((a) => a.includes('requirements-cuda.txt')));
      expect(hasCuda).toBe(false);
      expect(logs).toContain('No NVIDIA GPU found: skipping CUDA libraries; transcription will run on the CPU.');
      expect(lastNvidiaSmiChild?.kill).toHaveBeenCalled();
    });

    it('falls back to python -m venv and pip when uv is missing', async () => {
      uvAvailable = false;
      const logsDarwin: string[] = [];
      const codeDarwin = await setupAsr((l) => logsDarwin.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'darwin',
        home: fakeHome,
      });

      expect(codeDarwin).toBe(0);
      expect(spawned[0]).toEqual({ cmd: 'uv', args: ['--version'] });
      expect(spawned[1]).toEqual({
        cmd: 'python3',
        args: ['-m', 'venv', join(fakeHome, 'venv')],
      });
      expect(spawned[2]).toEqual({
        cmd: expect.stringMatching(/bin[\\/]python$/),
        args: ['-m', 'pip', 'install', '-r', expect.stringContaining('requirements.txt')],
      });
      expect(spawned[3]).toEqual({
        cmd: expect.stringMatching(/bin[\\/]python$/),
        args: ['-m', 'pip', 'install', expect.stringMatching(/python$/)],
      });
      expect(spawned[4].args).toContain('download-models');
      expect(spawned[5].args).toContain('check');
      expect(spawned[2].cmd).toContain(fakeHome);
      expect(spawned[3].cmd).toContain(fakeHome);
      expect(spawned[4].cmd).toContain(fakeHome);
      expect(spawned[4].cmd).toMatch(/bin[\\/]python$/);
      expect(spawned[5].cmd).toContain(fakeHome);
      expect(spawned[5].cmd).toMatch(/bin[\\/]python$/);
      expect(spawned.every((s) => !JSON.stringify(s).includes('.premiere-mcp'))).toBe(true);

      // On non-win32 when python3 fails, fall back to python -m venv
      spawned = [];
      failTarget = 'python3';
      failExitCode = 1;
      const logsDarwinFallback: string[] = [];
      const codeDarwinFallback = await setupAsr((l) => logsDarwinFallback.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'darwin',
        home: fakeHome,
      });

      expect(codeDarwinFallback).toBe(0);
      expect(spawned[0]).toEqual({ cmd: 'uv', args: ['--version'] });
      expect(spawned[1]).toEqual({
        cmd: 'python3',
        args: ['-m', 'venv', join(fakeHome, 'venv')],
      });
      expect(spawned[2]).toEqual({
        cmd: 'python',
        args: ['-m', 'venv', join(fakeHome, 'venv')],
      });
      expect(spawned[3]).toEqual({
        cmd: expect.stringMatching(/bin[\\/]python$/),
        args: ['-m', 'pip', 'install', '-r', expect.stringContaining('requirements.txt')],
      });
      failTarget = null;

      // On Windows when py -3.12 fails, fall back to python -m venv
      spawned = [];
      pyLauncherSuccess = false;
      const logsWin: string[] = [];
      const codeWin = await setupAsr((l) => logsWin.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'win32',
        home: fakeHome,
        engine: 'whisper-turbo',
        yes: true,
      });

      expect(codeWin).toBe(0);
      expect(spawned[0]).toEqual({ cmd: 'nvidia-smi', args: [] });
      spawned = spawned.slice(1);
      expect(spawned[0]).toEqual({ cmd: 'uv', args: ['--version'] });
      expect(spawned[1]).toEqual({
        cmd: 'py',
        args: ['-3.12', '-m', 'venv', join(fakeHome, 'venv')],
      });
      expect(spawned[2]).toEqual({
        cmd: 'python',
        args: ['-m', 'venv', join(fakeHome, 'venv')],
      });
      expect(spawned[3]).toEqual({
        cmd: expect.stringMatching(/Scripts[\\/]python\.exe$/),
        args: ['-m', 'pip', 'install', '-r', expect.stringContaining('requirements.txt')],
      });
      expect(spawned[4]).toEqual({
        cmd: expect.stringMatching(/Scripts[\\/]python\.exe$/),
        args: ['-m', 'pip', 'install', '-r', expect.stringContaining('requirements-cuda.txt')],
      });
      expect(spawned[5]).toEqual({
        cmd: expect.stringMatching(/Scripts[\\/]python\.exe$/),
        args: ['-m', 'pip', 'install', expect.stringMatching(/python$/)],
      });
      expect(spawned[6].args).toContain('download-models');
      expect(spawned[7].args).toContain('check');
      expect(spawned[3].cmd).toContain(fakeHome);
      expect(spawned[4].cmd).toContain(fakeHome);
      expect(spawned[5].cmd).toContain(fakeHome);
      expect(spawned[6].cmd).toContain(fakeHome);
      expect(spawned[6].cmd).toMatch(/Scripts[\\/]python\.exe$/);
      expect(spawned[7].cmd).toContain(fakeHome);
      expect(spawned[7].cmd).toMatch(/Scripts[\\/]python\.exe$/);
      expect(spawned.every((s) => !JSON.stringify(s).includes('.premiere-mcp'))).toBe(true);
    });

    it('stops at the first failing command and returns its exit code', async () => {
      uvAvailable = true;
      failTarget = 'venv';
      failExitCode = 42;

      const logs: string[] = [];
      const code = await setupAsr((l) => logs.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'win32',
        home: fakeHome,
      });

      expect(code).toBe(42);
      expect(spawned).toHaveLength(2); // uv --version, uv venv
      expect(spawned[1]).toEqual({
        cmd: 'uv',
        args: ['venv', '-p', '3.12', join(fakeHome, 'venv')],
      });
      expect(spawned.some((s) => s.args.includes('pip'))).toBe(false);
      expect(spawned.some((s) => s.args.includes('download-models'))).toBe(false);
      expect(spawned.every((s) => !JSON.stringify(s).includes('.premiere-mcp'))).toBe(true);

      // Failure during download-models
      spawned = [];
      failTarget = 'download-models';
      failExitCode = 5;
      const code2 = await setupAsr((l) => logs.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'win32',
        home: fakeHome,
      });

      expect(code2).toBe(5);
      expect(spawned.some((s) => s.args.includes('check'))).toBe(false);
      expect(spawned.every((s) => !JSON.stringify(s).includes('.premiere-mcp'))).toBe(true);
    });

    it('resets asr status cache when setupAsr finishes with exit code 0', async () => {
      (sidecar.sidecarPython as jest.Mock).mockResolvedValue('C:\\premiere-mcp\\venv\\Scripts\\python.exe');
      (sidecar.runSidecar as jest.Mock).mockResolvedValue({
        cuda: false,
        models: { whisper: true, yunet: true },
      });

      await asrStatus();
      expect(sidecar.runSidecar).toHaveBeenCalledTimes(1);

      const logs: string[] = [];
      const code = await setupAsr((l) => logs.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'win32',
        home: fakeHome,
      });
      expect(code).toBe(0);

      await asrStatus();
      expect(sidecar.runSidecar).toHaveBeenCalledTimes(2);
    });

    it('does not reset asr status cache when setupAsr finishes with non-zero exit code', async () => {
      (sidecar.sidecarPython as jest.Mock).mockResolvedValue('C:\\premiere-mcp\\venv\\Scripts\\python.exe');
      (sidecar.runSidecar as jest.Mock).mockResolvedValue({
        cuda: false,
        models: { whisper: true, yunet: true },
      });

      await asrStatus();
      expect(sidecar.runSidecar).toHaveBeenCalledTimes(1);

      failTarget = 'download-models';
      failExitCode = 3;
      const logs: string[] = [];
      const code = await setupAsr((l) => logs.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'win32',
        home: fakeHome,
      });
      expect(code).toBe(3);

      await asrStatus();
      expect(sidecar.runSidecar).toHaveBeenCalledTimes(1);
    });

    describe('engines and consent', () => {
      const base = { pkgPythonDir: '/fake/python', platform: 'win32' as const, home: fakeHome };
      const configFile = join(fakeHome, 'config.json');
      const readConfig = () => JSON.parse(readFileSync(configFile, 'utf8'));
      const installed = () => spawned.some((s) => s.args.includes('pip') || s.args.includes('download-models'));

      it('default setup downloads only zipformer-68m, never probes or installs CUDA, and sets the default', async () => {
        const code = await setupAsr(() => undefined, base);
        expect(code).toBe(0);
        expect(downloadInputs).toHaveLength(1);
        expect(downloadInputs[0]).toEqual({ modelsDir: join(fakeHome, 'models'), engines: ['zipformer-68m'] });
        expect(spawned.some((s) => s.cmd === 'nvidia-smi')).toBe(false);
        expect(spawned.some((s) => s.args.some((a) => a.includes('requirements-cuda.txt')))).toBe(false);
        expect(readConfig()).toEqual({ asrEngine: 'zipformer-68m' });
      });

      it('default setup keeps an engine the user already chose', async () => {
        const { writeAsrEngine } = await import('../../analysis/asr-config.js');
        await writeAsrEngine('whisper-turbo', fakeHome);
        expect(await setupAsr(() => undefined, base)).toBe(0);
        expect(readConfig().asrEngine).toBe('whisper-turbo');
      });

      it('--engine whisper-turbo --yes probes nvidia-smi, installs CUDA only when found, and sets the default', async () => {
        const logs: string[] = [];
        expect(await setupAsr((l) => logs.push(l), { ...base, engine: 'whisper-turbo', yes: true })).toBe(0);
        expect(spawned[0]).toEqual({ cmd: 'nvidia-smi', args: [] });
        expect(spawned.some((s) => s.args.some((a) => a.includes('requirements-cuda.txt')))).toBe(true);
        expect(downloadInputs[0].engines).toEqual(['whisper-turbo']);
        expect(logs.join(' ')).toContain('1600 MB');
        expect(logs.join(' ')).toContain('MIT');
        expect(readConfig().asrEngine).toBe('whisper-turbo');

        spawned = [];
        nvidiaSmiExitCode = 1;
        expect(await setupAsr(() => undefined, { ...base, engine: 'whisper-turbo', yes: true })).toBe(0);
        expect(spawned.some((s) => s.cmd === 'nvidia-smi')).toBe(true);
        expect(spawned.some((s) => s.args.some((a) => a.includes('requirements-cuda.txt')))).toBe(false);
      });

      it('other engines never touch nvidia-smi or CUDA; rover downloads both zipformers; the license is shown', async () => {
        const logs: string[] = [];
        expect(await setupAsr((l) => logs.push(l), { ...base, engine: 'rover', yes: true })).toBe(0);
        expect(spawned.some((s) => s.cmd === 'nvidia-smi')).toBe(false);
        expect(spawned.some((s) => s.args.some((a) => a.includes('requirements-cuda.txt')))).toBe(false);
        expect(downloadInputs[0].engines).toEqual(['zipformer-68m', 'zipformer-30m']);
        expect(logs.join(' ')).toContain('non-commercial');
      });

      it('exits 2 and downloads nothing without --yes when stdin is not a terminal', async () => {
        const logs: string[] = [];
        const code = await setupAsr((l) => logs.push(l), { ...base, engine: 'zipformer-30m', isTTY: false });
        expect(code).toBe(2);
        expect(installed()).toBe(false);
        expect(logs.join(' ')).toContain('--yes');
        expect(existsSync(configFile)).toBe(false);
      });

      it('asks on a terminal: declining downloads nothing, accepting proceeds', async () => {
        const no = jest.fn().mockResolvedValue(false);
        expect(await setupAsr(() => undefined, { ...base, engine: 'zipformer-30m', isTTY: true, confirm: no })).toBe(1);
        expect(no).toHaveBeenCalledTimes(1);
        expect(installed()).toBe(false);

        const yes = jest.fn().mockResolvedValue(true);
        expect(await setupAsr(() => undefined, { ...base, engine: 'zipformer-30m', isTTY: true, confirm: yes })).toBe(0);
        expect(downloadInputs[0].engines).toEqual(['zipformer-30m']);
      });

      it('--no-default installs without changing the default engine', async () => {
        expect(await setupAsr(() => undefined, base)).toBe(0);
        expect(await setupAsr(() => undefined, { ...base, engine: 'zipformer-30m', yes: true, noDefault: true })).toBe(0);
        expect(readConfig().asrEngine).toBe('zipformer-68m');
      });
    });
  });

  describe('asrStatus', () => {
    it('asrStatus reports not installed with the setup nextStep', async () => {
      (sidecar.sidecarPython as jest.Mock).mockResolvedValue(null);

      const status = await asrStatus();

      expect(status.installed).toBe(false);
      expect(status.nextStep).toContain('premiere-pro-mcp --setup-asr');
      expect(status.nextStep).toContain('Zipformer-68M');
      expect(status.defaultEngine).toBe('zipformer-68m');
      expect(status.cuda).toBeUndefined();
      expect(status.models).toBeUndefined();
    });

    it('reports installed with mapped cuda and models on check success', async () => {
      (sidecar.sidecarPython as jest.Mock).mockResolvedValue('C:\\premiere-mcp\\venv\\Scripts\\python.exe');
      (sidecar.runSidecar as jest.Mock).mockResolvedValue({
        cuda: true,
        models: { whisper: true, yunet: true },
      });

      const status = await asrStatus();

      expect(status).toMatchObject({
        installed: true,
        cuda: true,
        models: { whisper: true, yunet: true },
      });
      expect(sidecar.runSidecar).toHaveBeenCalledWith('check', {}, 60_000);
    });

    it('reports defaultEngine and which engines are installed', async () => {
      (sidecar.sidecarPython as jest.Mock).mockResolvedValue('C:\premiere-mcp\venv\Scripts\python.exe');
      (sidecar.runSidecar as jest.Mock).mockResolvedValue({
        cuda: false, sherpaOnnx: true, fasterWhisper: true,
        models: { whisper: false, yunet: true, zipformer68m: true, zipformer30m: false, vad: true },
      });
      const status = await asrStatus();
      expect(status.defaultEngine).toBe('zipformer-68m');
      expect(status.engines).toEqual({ 'zipformer-68m': true, 'zipformer-30m': false, rover: false, 'whisper-turbo': false });
    });

    it('reports installed with nextStep when sidecar check throws', async () => {
      (sidecar.sidecarPython as jest.Mock).mockResolvedValue('C:\\premiere-mcp\\venv\\Scripts\\python.exe');
      (sidecar.runSidecar as jest.Mock).mockRejectedValue(new Error('Model weights corrupted'));

      const status = await asrStatus();

      expect(status).toMatchObject({
        installed: true,
        nextStep: 'Model weights corrupted',
      });
    });

    it('runs sidecar once when called twice within maxAge', async () => {
      (sidecar.sidecarPython as jest.Mock).mockResolvedValue('C:\\premiere-mcp\\venv\\Scripts\\python.exe');
      (sidecar.runSidecar as jest.Mock).mockResolvedValue({
        cuda: true,
        models: { whisper: true, yunet: true },
      });

      const first = await asrStatus();
      const second = await asrStatus();

      expect(first).toMatchObject({
        installed: true,
        cuda: true,
        models: { whisper: true, yunet: true },
      });
      expect(second).toEqual(first);
      expect(sidecar.runSidecar).toHaveBeenCalledTimes(1);
    });

    it('runs sidecar again after maxAge expires using maxAgeMs: 0', async () => {
      (sidecar.sidecarPython as jest.Mock).mockResolvedValue('C:\\premiere-mcp\\venv\\Scripts\\python.exe');
      (sidecar.runSidecar as jest.Mock).mockResolvedValue({
        cuda: true,
        models: { whisper: true, yunet: true },
      });

      const first = await asrStatus();
      expect(sidecar.runSidecar).toHaveBeenCalledTimes(1);

      const second = await asrStatus({ maxAgeMs: 0 });
      expect(second).toEqual(first);
      expect(sidecar.runSidecar).toHaveBeenCalledTimes(2);
    });

    it('memoises error and timeout results like any other result', async () => {
      (sidecar.sidecarPython as jest.Mock).mockResolvedValue('C:\\premiere-mcp\\venv\\Scripts\\python.exe');
      (sidecar.runSidecar as jest.Mock).mockRejectedValue(new Error('Sidecar timeout after 10000ms'));

      const first = await asrStatus({ timeoutMs: 10_000 });
      expect(first).toMatchObject({
        installed: true,
        nextStep: 'Sidecar timeout after 10000ms',
      });
      expect(sidecar.runSidecar).toHaveBeenCalledWith('check', {}, 10_000);
      expect(sidecar.runSidecar).toHaveBeenCalledTimes(1);

      const second = await asrStatus();
      expect(second).toEqual(first);
      expect(sidecar.runSidecar).toHaveBeenCalledTimes(1);
    });

    it('clears cache when resetAsrStatusCache is called', async () => {
      (sidecar.sidecarPython as jest.Mock).mockResolvedValue('C:\\premiere-mcp\\venv\\Scripts\\python.exe');
      (sidecar.runSidecar as jest.Mock).mockResolvedValue({
        cuda: false,
        models: { whisper: true, yunet: true },
      });

      await asrStatus();
      expect(sidecar.runSidecar).toHaveBeenCalledTimes(1);

      resetAsrStatusCache();

      await asrStatus();
      expect(sidecar.runSidecar).toHaveBeenCalledTimes(2);
    });

    it('does not memoise not installed result and runs sidecar check once python exists', async () => {
      (sidecar.sidecarPython as jest.Mock).mockResolvedValueOnce(null);
      (sidecar.sidecarPython as jest.Mock).mockResolvedValue('C:\\premiere-mcp\\venv\\Scripts\\python.exe');
      (sidecar.runSidecar as jest.Mock).mockResolvedValue({
        cuda: true,
        models: { whisper: true, yunet: true },
      });

      const first = await asrStatus();
      expect(first.installed).toBe(false);
      expect(first.nextStep).toContain('premiere-pro-mcp --setup-asr');
      expect(sidecar.runSidecar).not.toHaveBeenCalled();

      const second = await asrStatus();
      expect(second.installed).toBe(true);
      expect(second.cuda).toBe(true);
      expect(sidecar.runSidecar).toHaveBeenCalledTimes(1);
    });

    it('runs sidecar once when two asrStatus calls are concurrent', async () => {
      (sidecar.sidecarPython as jest.Mock).mockResolvedValue('C:\\premiere-mcp\\venv\\Scripts\\python.exe');
      let resolveSidecar!: (val: unknown) => void;
      (sidecar.runSidecar as jest.Mock).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSidecar = resolve;
          })
      );

      const p1 = asrStatus();
      const p2 = asrStatus();

      await new Promise((r) => setImmediate(r));
      expect(sidecar.runSidecar).toHaveBeenCalledTimes(1);

      resolveSidecar({
        cuda: true,
        models: { whisper: true, yunet: true },
      });

      const [res1, res2] = await Promise.all([p1, p2]);
      expect(res1).toMatchObject({
        installed: true,
        cuda: true,
        models: { whisper: true, yunet: true },
      });
      expect(res2).toEqual(res1);
      expect(sidecar.runSidecar).toHaveBeenCalledTimes(1);
    });
  });
});
