import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
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
}

function makeFakeChild(opts: FakeChildOpts = {}) {
  const { exitCode = 0, stdout = '', stderr = '', error } = opts;
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

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
  return child;
}

describe('setupAsr and asrStatus', () => {
  const fakeHome = join(tmpdir(), 'fake-premiere-home');
  let spawned: Array<{ cmd: string; args: string[] }>;
  let uvAvailable: boolean;
  let pyLauncherSuccess: boolean;
  let failTarget: string | null;
  let failExitCode: number;

  afterAll(async () => {
    await rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetAsrStatusCache();
    spawned = [];
    uvAvailable = true;
    pyLauncherSuccess = true;
    failTarget = null;
    failExitCode = 1;

    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      spawned.push({ cmd, args: [...args] });

      if (cmd === 'uv' && args[0] === '--version') {
        if (!uvAvailable) {
          return makeFakeChild({ error: new Error('spawn uv ENOENT') });
        }
        return makeFakeChild({ exitCode: 0, stdout: 'uv 0.5.0\n' });
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

    it('uses uv when available', async () => {
      uvAvailable = true;
      const logsWin: string[] = [];
      const codeWin = await setupAsr((l) => logsWin.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'win32',
        home: fakeHome,
      });

      expect(codeWin).toBe(0);
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

      // On darwin, CUDA requirements file must NOT be installed
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

      // On linux, CUDA requirements file MUST be installed
      spawned = [];
      const logsLinux: string[] = [];
      const codeLinux = await setupAsr((l) => logsLinux.push(l), {
        pkgPythonDir: fakePkgPythonDir,
        platform: 'linux',
        home: fakeHome,
      });

      expect(codeLinux).toBe(0);
      const linuxHasCuda = spawned.some((s) => s.args.some((a) => a.includes('requirements-cuda.txt')));
      expect(linuxHasCuda).toBe(true);
      expect(spawned).toHaveLength(7);
      expect(spawned[1]).toEqual({
        cmd: 'uv',
        args: ['venv', '-p', '3.12', join(fakeHome, 'venv')],
      });
      expect(spawned[2].args[3]).toMatch(/bin[\\/]python$/);
      expect(spawned[2].args[3]).toContain(fakeHome);
      expect(spawned.every((s) => !JSON.stringify(s).includes('.premiere-mcp'))).toBe(true);
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
      });

      expect(codeWin).toBe(0);
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
  });

  describe('asrStatus', () => {
    it('asrStatus reports not installed with the setup nextStep', async () => {
      (sidecar.sidecarPython as jest.Mock).mockResolvedValue(null);

      const status = await asrStatus();

      expect(status.installed).toBe(false);
      expect(status.nextStep).toContain('premiere-pro-mcp --setup-asr');
      expect(status.nextStep).toContain('large-v3-turbo');
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

      expect(status).toEqual({
        installed: true,
        cuda: true,
        models: { whisper: true, yunet: true },
      });
      expect(sidecar.runSidecar).toHaveBeenCalledWith('check', {}, 60_000);
    });

    it('reports installed with nextStep when sidecar check throws', async () => {
      (sidecar.sidecarPython as jest.Mock).mockResolvedValue('C:\\premiere-mcp\\venv\\Scripts\\python.exe');
      (sidecar.runSidecar as jest.Mock).mockRejectedValue(new Error('Model weights corrupted'));

      const status = await asrStatus();

      expect(status).toEqual({
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

      expect(first).toEqual({
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
      expect(first).toEqual({
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
      expect(res1).toEqual({
        installed: true,
        cuda: true,
        models: { whisper: true, yunet: true },
      });
      expect(res2).toEqual(res1);
      expect(sidecar.runSidecar).toHaveBeenCalledTimes(1);
    });
  });
});
