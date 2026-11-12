import { createInterface } from 'node:readline';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PremiereProTools } from '../tools/index.js';
import { PACKAGE_VERSION } from '../version.js';

type RunnerTools = Pick<PremiereProTools, 'executeTool'>;

interface RunMessage {
  id: string;
  tool: string;
  args: Record<string, any>;
}

/**
 * Line protocol for the CEP panel: one JSON message per line on stdio.
 * stdout belongs to the protocol, so nothing else may write to it.
 */
export function startPanelRunner(
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream },
  tools: RunnerTools,
): { done: Promise<void> } {
  // A panel that went away leaves a broken stdout pipe: stop writing, never crash the runner.
  let outputBroken = false;
  const markBroken = (error: unknown): void => {
    if (outputBroken) return;
    outputBroken = true;
    process.stderr.write(`[panel-runner] output closed: ${error instanceof Error ? error.message : String(error)}\n`);
  };
  io.output.on('error', markBroken);
  const send = (message: Record<string, unknown>): void => {
    if (outputBroken) return;
    try {
      io.output.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      markBroken(error);
    }
  };
  const log = (level: 'info' | 'warn' | 'error', message: string): void => send({ type: 'log', level, message });

  const queue: RunMessage[] = [];
  const controllers = new Map<string, AbortController>();
  let current: Promise<void> | null = null;
  let closed = false;

  async function execute(run: RunMessage, controller: AbortController): Promise<void> {
    try {
      const result = await tools.executeTool(run.tool, run.args, {
        // `progress` is the amount done (rises, may be fractional); `step` is the 1-based step being run.
        progress: (progress, stepCount, label) =>
          send({ type: 'progress', id: run.id, step: Math.min(stepCount, Math.floor(progress) + 1), progress, stepCount, label }),
        signal: controller.signal,
      });
      send({ type: 'result', id: run.id, result });
    } catch (error) {
      send({
        type: 'result',
        id: run.id,
        result: { success: false, error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      controllers.delete(run.id);
    }
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const run = queue.shift()!;
      const controller = controllers.get(run.id)!;
      if (controller.signal.aborted) {
        send({ type: 'result', id: run.id, result: { success: false, cancelled: true } });
        controllers.delete(run.id);
        continue;
      }
      await execute(run, controller);
    }
    current = null;
  }

  function onRun(message: any): void {
    if (typeof message.id !== 'string' || typeof message.tool !== 'string') {
      log('error', 'run message needs a string id and tool');
      return;
    }
    if (controllers.has(message.id)) {
      log('error', `run id ${message.id} is already in use`);
      return;
    }
    const args = message.args && typeof message.args === 'object' && !Array.isArray(message.args) ? message.args : {};
    controllers.set(message.id, new AbortController());
    queue.push({ id: message.id, tool: message.tool, args });
    current ??= drain();
  }

  function onCancel(message: any): void {
    const controller = typeof message.id === 'string' ? controllers.get(message.id) : undefined;
    if (!controller) {
      log('info', `cancel ignored: no run with id ${String(message.id)}`);
      return;
    }
    controller.abort('cancelled');
  }

  send({ type: 'ready', version: PACKAGE_VERSION });

  const rl = createInterface({ input: io.input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (closed || !line.trim()) return;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      log('error', 'invalid JSON line ignored');
      return;
    }
    if (!message || typeof message !== 'object') {
      log('error', 'message must be a JSON object');
      return;
    }
    if (message.type === 'run') onRun(message);
    else if (message.type === 'cancel') onCancel(message);
    else log('error', `unknown message type: ${String(message.type)}`);
  });

  const done = new Promise<void>((resolve) => {
    rl.on('close', () => {
      closed = true;
      for (const controller of controllers.values()) controller.abort('panel-closed');
      void (async () => {
        while (current) await current;
        resolve();
      })();
    });
  });

  return { done };
}

/**
 * Bridge temp dir the runner must share with the panel (mirrors
 * getDefaultTempPath in cep-plugin/bridge-cep.js): PREMIERE_TEMP_DIR, then the
 * config's tempDirectory, then <TEMP|TMP|C:\\Temp>\\premiere-mcp-bridge (win32) or
 * /tmp/premiere-mcp-bridge. Trailing separators are trimmed.
 */
export function resolveRunnerTempDir(
  env: NodeJS.ProcessEnv,
  configTempDir: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  const chosen =
    env.PREMIERE_TEMP_DIR ||
    (typeof configTempDir === 'string' && configTempDir ? configTempDir : '') ||
    (platform === 'win32'
      ? `${env.TEMP || env.TMP || 'C:\\Temp'}\\premiere-mcp-bridge`
      : '/tmp/premiere-mcp-bridge');
  return chosen.replace(/[\\/]+$/, '');
}

export function defaultPanelConfigPath(): string {
  return join(homedir(), '.premiere-mcp-bridge', 'config.json');
}

export async function readPanelConfig(configPath: string = defaultPanelConfigPath()): Promise<Record<string, any>> {
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge `runner: { nodePath, cliPath }` into the panel config, keeping every other key. A config
 * that exists but is not a JSON object is copied to `config.json.bak-<timestamp>` first (and that
 * is printed to stderr) instead of being silently replaced.
 */
export async function registerPanelRunner(
  cliPath: string,
  nodePath: string = process.execPath,
  configPath: string = defaultPanelConfigPath(),
): Promise<string> {
  let config: Record<string, any> = {};
  let raw: string | null = null;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    raw = null;
  }
  if (raw !== null && raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, any>;
    } else {
      const backupPath = `${configPath}.bak-${new Date().toISOString().replace(/[-:.]/g, '')}`;
      await copyFile(configPath, backupPath);
      process.stderr.write(`Panel config ${configPath} was not valid JSON; copied it to ${backupPath} before writing a new one.
`);
    }
  }
  config.runner = { nodePath, cliPath };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}
