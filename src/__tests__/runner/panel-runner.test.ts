import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerPanelRunner, resolveRunnerTempDir, startPanelRunner } from '../../runner/panel-runner.js';
import { PACKAGE_VERSION } from '../../version.js';

type Exec = (name: string, args: any, options?: { progress?: any; signal?: AbortSignal }) => Promise<any>;

function setup(executeTool: Exec) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: any[] = [];
  let buffer = '';
  const waiters: Array<() => void> = [];
  output.on('data', (chunk) => {
    buffer += chunk.toString();
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
    waiters.splice(0).forEach((w) => w());
  });
  const waitFor = async (predicate: (l: any) => boolean): Promise<any> => {
    for (;;) {
      const hit = lines.find(predicate);
      if (hit) return hit;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  const runner = startPanelRunner({ input, output }, { executeTool } as any);
  const send = (m: unknown) => input.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`);
  return { input, lines, waitFor, send, runner };
}

describe('startPanelRunner', () => {
  it('writes ready first', async () => {
    const t = setup(async () => ({}));
    const ready = await t.waitFor(() => true);
    expect(ready).toEqual({ type: 'ready', version: PACKAGE_VERSION });
    t.input.end();
    await t.runner.done;
  });

  it('runs a tool and returns the result with the same id, forwarding progress', async () => {
    const t = setup(async (name, args, options) => {
      options?.progress?.(0, 2, 'Buoc 1');
      options?.progress?.(0.4, 2, 'Buoc 1 40%');
      options?.progress?.(1, 2, 'Buoc 2');
      return { success: true, name, args };
    });
    t.send({ type: 'run', id: 'a', tool: 'search_tools', args: { query: 'x' } });
    const result = await t.waitFor((l) => l.type === 'result');
    expect(result).toEqual({ type: 'result', id: 'a', result: { success: true, name: 'search_tools', args: { query: 'x' } } });
    // progress is the amount done; step is the 1-based step being run.
    expect(t.lines.filter((l) => l.type === 'progress')).toEqual([
      { type: 'progress', id: 'a', step: 1, progress: 0, stepCount: 2, label: 'Buoc 1' },
      { type: 'progress', id: 'a', step: 1, progress: 0.4, stepCount: 2, label: 'Buoc 1 40%' },
      { type: 'progress', id: 'a', step: 2, progress: 1, stepCount: 2, label: 'Buoc 2' },
    ]);
    t.input.end();
    await t.runner.done;
  });

  it('cancel aborts the signal of that run only', async () => {
    const signals: Record<string, AbortSignal> = {};
    const t = setup((name, args, options) => {
      signals[args.tag] = options!.signal!;
      return new Promise((resolve) => options!.signal!.addEventListener('abort', () => resolve({ success: false, cancelled: true })));
    });
    t.send({ type: 'run', id: '1', tool: 't', args: { tag: 'one' } });
    t.send({ type: 'run', id: '2', tool: 't', args: { tag: 'two' } });
    t.send({ type: 'cancel', id: '2' });
    t.send({ type: 'cancel', id: 'nope' });
    await t.waitFor((l) => l.type === 'log' && String(l.message).includes('nope'));
    expect(signals.one.aborted).toBe(false);
    t.send({ type: 'cancel', id: '1' });
    await t.waitFor((l) => l.type === 'result' && l.id === '1');
    expect(signals.one.aborted).toBe(true);
    const two = await t.waitFor((l) => l.type === 'result' && l.id === '2');
    expect(two.result.cancelled).toBe(true);
    expect(signals.two).toBeUndefined(); // cancelled before it started
    t.input.end();
    await t.runner.done;
  });

  it('processes runs one at a time in arrival order', async () => {
    const order: string[] = [];
    const t = setup(async (name, args) => {
      order.push(`start ${args.n}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end ${args.n}`);
      return { n: args.n };
    });
    t.send({ type: 'run', id: 'a', tool: 't', args: { n: 1 } });
    t.send({ type: 'run', id: 'b', tool: 't', args: { n: 2 } });
    await t.waitFor((l) => l.type === 'result' && l.id === 'b');
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
    t.input.end();
    await t.runner.done;
  });

  it('closing input aborts the running task with panel-closed and resolves done', async () => {
    let signal: AbortSignal | undefined;
    const t = setup((name, args, options) => {
      signal = options!.signal;
      return new Promise((resolve) => signal!.addEventListener('abort', () => resolve({ success: false, cancelled: true })));
    });
    t.send({ type: 'run', id: 'a', tool: 't', args: {} });
    await t.waitFor((l) => l.type === 'ready');
    while (!signal) await new Promise((r) => setTimeout(r, 5));
    t.input.end();
    await t.runner.done;
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('panel-closed');
  });

  it('logs on malformed lines and keeps running', async () => {
    const t = setup(async () => ({ ok: true }));
    t.send('not json');
    const log = await t.waitFor((l) => l.type === 'log');
    expect(log.level).toBe('error');
    t.send({ type: 'run', id: 'a', tool: 't', args: {} });
    await t.waitFor((l) => l.type === 'result');
    t.input.end();
    await t.runner.done;
  });

  it('survives a broken output pipe: no throw, later sends are dropped, the run still completes', async () => {
    const input = new PassThrough();
    let writes = 0;
    const output = new Writable({
      write(_chunk, _enc, callback) {
        writes++;
        callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      },
    });
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let finished = false;
    try {
      const runner = startPanelRunner({ input, output }, {
        executeTool: async (_n: string, _a: unknown, options?: { progress?: any }) => {
          await new Promise((r) => setTimeout(r, 5));
          options?.progress?.(0, 1, 'x');
          finished = true;
          return { success: true };
        },
      } as any);
      input.write(`${JSON.stringify({ type: 'run', id: 'a', tool: 't', args: {} })}\n`);
      while (!finished) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 10));
      input.end();
      await runner.done;
    } finally {
      stderr.mockRestore();
    }
    expect(finished).toBe(true);
    expect(writes).toBe(1); // only "ready" reached the broken pipe
  });

  it('turns a thrown tool error into a failed result', async () => {
    const t = setup(async () => {
      throw new Error('boom');
    });
    t.send({ type: 'run', id: 'a', tool: 't', args: {} });
    const result = await t.waitFor((l) => l.type === 'result');
    expect(result.result).toEqual({ success: false, error: 'boom' });
    t.input.end();
    await t.runner.done;
  });
});

describe('registerPanelRunner', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'panel-runner-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps existing keys when adding runner', async () => {
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ tempDirectory: 'C:/temp/x', other: 1 }));
    await registerPanelRunner('/app/dist/cli.js', '/usr/bin/node', configPath);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      tempDirectory: 'C:/temp/x',
      other: 1,
      runner: { nodePath: '/usr/bin/node', cliPath: '/app/dist/cli.js' },
    });
  });

  it('backs up an unparseable config before replacing it, and says so', async () => {
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, '{ not json');
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await registerPanelRunner('/c.js', '/n', configPath);
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(/config\.json\.bak-/);
    } finally {
      stderr.mockRestore();
    }
    const backups = (await readdir(dir)).filter((f) => f.startsWith('config.json.bak-'));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(dir, backups[0]!), 'utf8')).toBe('{ not json');
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ runner: { nodePath: '/n', cliPath: '/c.js' } });
  });

  it('creates the directory and file when missing', async () => {
    const configPath = join(dir, 'nested', 'config.json');
    await registerPanelRunner('/c.js', '/n', configPath);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ runner: { nodePath: '/n', cliPath: '/c.js' } });
  });
});

describe('resolveRunnerTempDir', () => {
  it('prefers PREMIERE_TEMP_DIR', () => {
    expect(resolveRunnerTempDir({ PREMIERE_TEMP_DIR: 'C:/env', TEMP: 'C:/t' }, 'C:/cfg', 'win32')).toBe('C:/env');
  });
  it('then the config tempDirectory', () => {
    expect(resolveRunnerTempDir({ TEMP: 'C:/t' }, 'C:/cfg', 'win32')).toBe('C:/cfg');
  });
  it('then the platform default like the panel', () => {
    expect(resolveRunnerTempDir({ TEMP: 'C:\\Users\\u\\Temp' }, undefined, 'win32')).toBe('C:\\Users\\u\\Temp\\premiere-mcp-bridge');
    expect(resolveRunnerTempDir({ TMP: 'D:\\tmp' }, '', 'win32')).toBe('D:\\tmp\\premiere-mcp-bridge');
    expect(resolveRunnerTempDir({}, undefined, 'win32')).toBe('C:\\Temp\\premiere-mcp-bridge');
    expect(resolveRunnerTempDir({}, undefined, 'linux')).toBe('/tmp/premiere-mcp-bridge');
  });
  it('trims trailing separators', () => {
    expect(resolveRunnerTempDir({ PREMIERE_TEMP_DIR: 'C:\\a\\b\\/' }, undefined, 'win32')).toBe('C:\\a\\b');
    expect(resolveRunnerTempDir({}, 'C:/cfg//', 'win32')).toBe('C:/cfg');
  });
});
