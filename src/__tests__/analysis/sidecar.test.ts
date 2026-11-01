import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  let killed: Set<number>;

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
          spawn: (_cmd: string, args: string[], opts: unknown) => {
            spawnCount++;
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
    killed = new Set();
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
    expect(String(sidecarMissingResult('x').nextStep)).toContain('3 GB');
    expect(modelPaths().whisper).toBe(join(home, 'models', 'faster-whisper-large-v3'));
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
});
