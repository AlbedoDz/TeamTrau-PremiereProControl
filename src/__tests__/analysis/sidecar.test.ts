import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fake "python": a node script that parses the sidecar CLI arguments and writes the output file.
const FAKE = `
const fs = require('fs');
const a = process.argv.slice(2);
const get = (f) => { const i = a.indexOf(f); return i < 0 ? undefined : a[i + 1]; };
const input = JSON.parse(fs.readFileSync(get('--input'), 'utf8'));
const out = get('--output');
const prog = get('--progress');
if (prog) fs.writeFileSync(prog, JSON.stringify({ done: 0.5, etaSec: 3 }));
const finish = () => {
  if (input.mode === 'die') { process.stderr.write('boom line 1\\nboom line 2\\n'); process.exit(3); }
  if (input.mode === 'error') { fs.writeFileSync(out, JSON.stringify({ error: 'model exploded' })); process.exit(1); }
  fs.writeFileSync(out, JSON.stringify({ echo: input, command: a[1] }));
};
setTimeout(finish, input.delayMs || 0);
`;

describe('sidecar runner', () => {
  let home: string;
  let spawnCount: number;
  let spawnMode: 'normal' | 'hang' | 'noPid' | 'errorEvent' | 'lateStderr';
  let hangKill: jest.Mock;
  let taskkillArgs: string[][];

  const load = () => {
    const script = join(home, 'fake.js');
    writeFileSync(script, FAKE);
    spawnCount = 0;
    let mod!: typeof import('../../analysis/sidecar.js');
    jest.isolateModules(() => {
      jest.doMock('node:child_process', () => {
        const actual = jest.requireActual('node:child_process');
        return {
          ...actual,
          spawn: (cmd: string, args: string[], opts: unknown) => {
            if (cmd === 'taskkill') {
              taskkillArgs.push(args);
              return new EventEmitter();
            }
            spawnCount++;
            if (spawnMode !== 'normal') {
              const child: any = new EventEmitter();
              child.stderr = new PassThrough();
              child.kill = hangKill;
              child.unref = () => undefined;
              child.pid = spawnMode === 'hang' ? 424242 : undefined;
              if (spawnMode === 'lateStderr') {
                setImmediate(() => {
                  child.emit('exit', 1);
                  child.stderr.write('late stderr: model missing');
                  child.stderr.end();
                  child.emit('close', 1);
                });
              }
              if (spawnMode === 'errorEvent') setImmediate(() => child.emit('error', new Error('spawn ENOENT')));
              return child;
            }
            return actual.spawn(process.execPath, [script, ...args.slice(1)], opts);
          },
        };
      });
      mod = require('../../analysis/sidecar.js');
    });
    return mod;
  };

  const installVenv = () => {
    const bin = process.platform === 'win32' ? join(home, 'venv', 'Scripts') : join(home, 'venv', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
  };

  const waitFor = async (fn: () => Promise<boolean>, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timed out');
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'premiere-mcp-home-'));
    process.env.PREMIERE_MCP_HOME = home;
    spawnMode = 'normal';
    hangKill = jest.fn();
    taskkillArgs = [];
  });

  it('returns null and the install result when no venv exists', async () => {
    const { sidecarPython, sidecarMissingResult, modelPaths } = load();
    expect(await sidecarPython()).toBeNull();
    expect(sidecarMissingResult('transcribe_sequence')).toMatchObject({
      success: false,
      retry: false,
      userActionRequired: true,
      errorCode: 'asr.not_installed',
      command: 'premiere-pro-mcp --setup-asr',
    });
    expect(String(sidecarMissingResult('x').nextStep)).toContain('2 GB');
    expect(modelPaths().whisper).toBe(join(home, 'models', 'faster-whisper-large-v3-turbo'));
    expect(modelPaths().yunet).toBe(join(home, 'models', 'face_detection_yunet_2023mar.onnx'));
  });

  it('startJob then jobStatus reaches done with the result', async () => {
    installVenv();
    const { startJob, jobStatus } = load();
    const first = await startJob('k1', 'transcribe', { mode: 'ok', delayMs: 200 });
    expect(first.status).toBe('running');
    await waitFor(async () => (await jobStatus('k1'))?.status === 'done');
    const done = (await jobStatus('k1'))!;
    expect(done.progress).toBe(1);
    expect(done.result).toMatchObject({ command: 'transcribe' });
    expect(await jobStatus('nope')).toBeNull();
  });

  it('same key while running does not start a second process', async () => {
    installVenv();
    const { startJob, jobStatus } = load();
    await startJob('k2', 'transcribe', { delayMs: 1500 });
    const again = await startJob('k2', 'transcribe', { delayMs: 1500 });
    expect(again.status).toBe('running');
    expect(spawnCount).toBe(1);
    await waitFor(async () => (await jobStatus('k2'))?.status === 'done');
  });

  it('dead pid without output.json is failed with the stderr tail', async () => {
    installVenv();
    const { startJob, jobStatus } = load();
    await startJob('k3', 'transcribe', { mode: 'die' });
    await waitFor(async () => (await jobStatus('k3'))?.status === 'failed');
    const failed = (await jobStatus('k3'))!;
    expect(failed.error).toContain('boom line 2');
    await startJob('k3', 'transcribe', { mode: 'ok' });
    expect(spawnCount).toBe(2);
    await waitFor(async () => (await jobStatus('k3'))?.status === 'done');
  });

  it('runSidecar rejects with SidecarError when output has error', async () => {
    installVenv();
    const { runSidecar, SidecarError } = load();
    const err = await runSidecar('faces', { mode: 'error' }).catch((e) => e);
    expect(err).toBeInstanceOf(SidecarError);
    expect(err.message).toContain('model exploded');
    await expect(runSidecar('faces', { mode: 'ok' })).resolves.toMatchObject({ command: 'faces' });
  });

  it('runSidecar rejects when the sidecar is not installed', async () => {
    const { runSidecar, SidecarError } = load();
    await expect(runSidecar('faces', {})).rejects.toBeInstanceOf(SidecarError);
  });

  const jobDirOf = (key: string) => join(home, 'jobs', createHash('sha1').update(key).digest('hex'));
  const age = (path: string, ms: number) => {
    const t = new Date(Date.now() - ms);
    utimesSync(path, t, t);
  };

  it('fails a job whose process could not be spawned (error event)', async () => {
    installVenv();
    spawnMode = 'errorEvent';
    const { startJob, jobStatus } = load();
    await startJob('spawn-err', 'transcribe', {});
    await waitFor(async () => (await jobStatus('spawn-err'))?.status === 'failed');
    expect((await jobStatus('spawn-err'))!.error).toContain('spawn ENOENT');
  });

  it('fails a job with no pid file once input.json is older than 10 s, but not before', async () => {
    installVenv();
    spawnMode = 'noPid';
    const { startJob, jobStatus } = load();
    await startJob('nopid', 'transcribe', {});
    // spawn-error file records the missing pid straight away
    expect((await jobStatus('nopid'))!.status).toBe('failed');

    const dir = jobDirOf('crashed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'input.json'), '{}');
    expect((await jobStatus('crashed'))!.status).toBe('running');
    age(join(dir, 'input.json'), 11_000);
    const state = (await jobStatus('crashed'))!;
    expect(state.status).toBe('failed');
    expect(state.error).toContain('never started');
  });

  it('two concurrent startJob calls spawn once', async () => {
    installVenv();
    const { startJob, jobStatus } = load();
    const [a, b] = await Promise.all([
      startJob('race', 'transcribe', { delayMs: 300 }),
      startJob('race', 'transcribe', { delayMs: 300 }),
    ]);
    expect(a.status).toBe('running');
    expect(b.status).toBe('running');
    expect(spawnCount).toBe(1);
    await waitFor(async () => (await jobStatus('race'))?.status === 'done');
  });

  it('treats a live pid with no activity for 10 minutes as failed and replaces it without deleting the dir', async () => {
    installVenv();
    const { startJob, jobStatus } = load();
    const dir = jobDirOf('recycled');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'input.json'), '{}');
    writeFileSync(join(dir, 'pid'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    expect((await jobStatus('recycled'))!.status).toBe('running');
    for (const f of ['input.json', 'pid']) age(join(dir, f), 11 * 60_000);
    const state = (await jobStatus('recycled'))!;
    expect(state.status).toBe('failed');
    expect(state.error).toContain('no progress');
    await startJob('recycled', 'transcribe', {});
    expect(spawnCount).toBe(1);
    expect(existsSync(dir)).toBe(true);
    await waitFor(async () => (await jobStatus('recycled'))?.status === 'done');
  });

  it('reports unreadable output for a dead pid', async () => {
    installVenv();
    const { jobStatus } = load();
    const dir = jobDirOf('badout');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'input.json'), '{}');
    writeFileSync(join(dir, 'pid'), JSON.stringify({ pid: 2147483646, startedAt: 'x' }));
    writeFileSync(join(dir, 'output.json'), '{"half');
    expect((await jobStatus('badout'))!.error).toContain('output unreadable');
  });

  it('runSidecar times out a child that never exits and kills it', async () => {
    installVenv();
    spawnMode = 'hang';
    const { runSidecar, SidecarError } = load();
    const err = await runSidecar('faces', {}, 100).catch((e) => e);
    expect(err).toBeInstanceOf(SidecarError);
    expect(err.message).toContain('timed out');
    if (process.platform === 'win32') {
      expect(taskkillArgs).toContainEqual(['/pid', '424242', '/T', '/F']);
    } else {
      expect(hangKill).toHaveBeenCalledWith('SIGTERM');
    }
  });

  it('handles spaces and Vietnamese characters in the home path and the input', async () => {
    home = mkdtempSync(join(tmpdir(), 'premiere mcp Việt Nam '));
    process.env.PREMIERE_MCP_HOME = home;
    installVenv();
    const { runSidecar, startJob, jobStatus } = load();
    const input = { glossary: ['Trưng Trắc', 'Vietcetera'], text: 'Chào các bạn' };
    const out: any = await runSidecar('transcribe', input);
    expect(out.echo).toEqual(input);
    await startJob('khóa tiếng Việt', 'transcribe', input);
    await waitFor(async () => (await jobStatus('khóa tiếng Việt'))?.status === 'done');
    expect(((await jobStatus('khóa tiếng Việt'))!.result as any).echo).toEqual(input);
  });

  it('keeps stderr that arrives after the exit event in the error tail', async () => {
    installVenv();
    spawnMode = 'lateStderr';
    const { runSidecar, SidecarError } = load();
    const err = await runSidecar('faces', {}).catch((e) => e);
    expect(err).toBeInstanceOf(SidecarError);
    expect(err.stderrTail).toContain('late stderr: model missing');
    expect(err.message).toContain('late stderr');
  });
});
