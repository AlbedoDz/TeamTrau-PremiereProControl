/**
 * Registers the premiere-pro MCP server with the AI clients installed on this machine.
 *
 * Each client keeps its MCP servers in its own file and format, so the mergers below take the
 * file text and return the new text. They touch only the premiere-pro entry and keep comments and
 * every other server as they were. `syncClients` decides which clients exist, backs a file up once
 * before the first change, and reports one result per client.
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { isMap, isSeq, parseDocument, type YAMLSeq } from 'yaml';

export const SERVER_NAME = 'premiere-pro';
const DEEPSEEK_ENTRY_ID = 'mcp-premiere-pro';
const BACKUP_SUFFIX = '.bak-premiere';

export interface ServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type SyncMode = 'register' | 'remove' | 'check';
export type ClientState = 'changed' | 'unchanged' | 'would-change' | 'not-installed' | 'error';

export interface ClientResult {
  id: string;
  label: string;
  state: ClientState;
  detail?: string;
}

export interface Runner {
  (command: string, args: string[]): Promise<{ code: number; stdout: string }>;
}

export interface SyncOptions {
  home?: string;
  appData?: string;
  run?: Runner;
}

export function defaultServerSpec(packageRoot: string, tempDir = join(tmpdir(), 'premiere-mcp-bridge')): ServerSpec {
  return {
    command: process.execPath,
    args: [join(packageRoot, 'dist', 'index.js')],
    env: { PREMIERE_TEMP_DIR: tempDir },
  };
}

// ---------------------------------------------------------------- mergers

function editJson(text: string, path: string[], value: unknown): string {
  const source = text.trim() === '' ? '{}' : text;
  const errors: ParseError[] = [];
  parseJsonc(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error('the file is not valid JSON');
  const edits = modify(source, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } });
  const next = applyEdits(source, edits);
  return next.endsWith('\n') ? next : `${next}\n`;
}

/** Claude Desktop and Antigravity: `mcpServers.<name> = { command, args, env }`. */
export function mergeMcpServers(text: string, spec: ServerSpec | null): string {
  return editJson(text, ['mcpServers', SERVER_NAME], spec ?? undefined);
}

/** VS Code: `servers.<name> = { type: "stdio", command, args, env }`. */
export function mergeVsCode(text: string, spec: ServerSpec | null): string {
  return editJson(text, ['servers', SERVER_NAME], spec ? { type: 'stdio', ...spec } : undefined);
}

/** opencode: `mcp.<name> = { type: "local", command: [...], environment, enabled }`. */
export function mergeOpencode(text: string, spec: ServerSpec | null): string {
  const entry = spec
    ? { type: 'local', command: [spec.command, ...spec.args], environment: spec.env, enabled: true }
    : undefined;
  return editJson(text, ['mcp', SERVER_NAME], entry);
}

function tomlBlock(spec: ServerSpec): string {
  const lines = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(spec.command)}`,
    `args = [${spec.args.map((a) => JSON.stringify(a)).join(', ')}]`,
    '',
    `[mcp_servers.${SERVER_NAME}.env]`,
    ...Object.entries(spec.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
  ];
  return `${lines.join('\n')}\n`;
}

/** Codex: `[mcp_servers.<name>]` and `[mcp_servers.<name>.env]` tables in config.toml. */
export function mergeCodex(text: string, spec: ServerSpec | null): string {
  const own = `mcp_servers.${SERVER_NAME}`;
  let skipping = false;
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
    if (header) {
      const name = (header[1] ?? '').trim();
      skipping = name === own || name.startsWith(`${own}.`);
    }
    if (!skipping) kept.push(line);
  }
  const rest = kept.join('\n').replace(/\s+$/, '');
  if (!spec) return rest === '' ? '' : `${rest}\n`;
  return `${rest === '' ? '' : `${rest}\n\n`}${tomlBlock(spec)}`;
}

/** DeepSeek Harness: a row inside an `insert:` list of a profile's cordis.patch.yml. */
export function mergeDeepSeek(text: string, spec: ServerSpec | null): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(doc.errors[0]?.message ?? 'the file is not valid YAML');
  if (doc.contents !== null && !isSeq(doc.contents)) throw new Error('the patch file is not a YAML list');
  const root = (doc.contents ?? doc.createNode([])) as YAMLSeq;
  doc.contents = root as unknown as typeof doc.contents;

  const inserts: YAMLSeq[] = [];
  for (const item of root.items) {
    const rows = isMap(item) ? item.get('insert', true) : undefined;
    if (isSeq(rows)) inserts.push(rows);
  }

  const entry = spec
    ? {
        id: DEEPSEEK_ENTRY_ID,
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          serverName: 'premiere_pro',
          transport: 'stdio',
          command: spec.command,
          args: spec.args,
          env: spec.env,
          toolCallTimeoutMs: 120000,
          failOnStartupError: false,
        },
      }
    : null;

  let found = false;
  for (const rows of inserts) {
    for (let i = rows.items.length - 1; i >= 0; i--) {
      const row = rows.items[i];
      if (!isMap(row) || row.get('id') !== DEEPSEEK_ENTRY_ID) continue;
      found = true;
      if (entry) rows.items[i] = doc.createNode(entry);
      else rows.items.splice(i, 1);
    }
  }
  if (entry && !found) {
    const first = inserts[0];
    if (first) first.items.push(doc.createNode(entry));
    else root.items.push(doc.createNode({ insert: [entry] }));
  }
  if (!entry && !found) return text;
  if (!entry) {
    // Drop an `insert:` block this removal emptied, so register then remove leaves the file as it was.
    root.items = root.items.filter((item) => {
      if (!isMap(item) || item.items.length !== 1) return true;
      const rows = item.get('insert', true);
      return !(isSeq(rows) && rows.items.length === 0);
    });
  }
  return doc.toString({ lineWidth: 0 });
}

// ---------------------------------------------------------------- clients

interface FileTarget {
  dir: string;
  file: string;
}

interface FileClient {
  id: string;
  label: string;
  targets: FileTarget[];
  merge: (text: string, spec: ServerSpec | null) => string;
}

function fileClients(home: string, appData: string): FileClient[] {
  const dsh = (profile: string): FileTarget => {
    const dir = join(home, '.dsh', 'profiles', profile);
    return { dir, file: join(dir, 'cordis.patch.yml') };
  };
  return [
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      targets: [{ dir: join(appData, 'Claude'), file: join(appData, 'Claude', 'claude_desktop_config.json') }],
      merge: mergeMcpServers,
    },
    {
      id: 'vscode',
      label: 'VS Code Copilot',
      targets: [{ dir: join(appData, 'Code', 'User'), file: join(appData, 'Code', 'User', 'mcp.json') }],
      merge: mergeVsCode,
    },
    {
      id: 'codex',
      label: 'Codex',
      targets: [{ dir: join(home, '.codex'), file: join(home, '.codex', 'config.toml') }],
      merge: mergeCodex,
    },
    {
      // Antigravity 2 desktop, its CLI and its IDE keep their servers in this one file.
      id: 'antigravity',
      label: 'Antigravity (desktop, CLI, IDE)',
      targets: [{ dir: join(home, '.gemini'), file: join(home, '.gemini', 'config', 'mcp_config.json') }],
      merge: mergeMcpServers,
    },
    {
      id: 'opencode',
      label: 'opencode (CLI, desktop)',
      targets: [{ dir: join(home, '.config', 'opencode'), file: join(home, '.config', 'opencode', 'opencode.jsonc') }],
      merge: mergeOpencode,
    },
    {
      id: 'deepseek-harness',
      label: 'DeepSeek Harness',
      targets: [dsh('desktop'), dsh('headless')],
      merge: mergeDeepSeek,
    },
  ];
}

const defaultRun: Runner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30000, windowsHide: true }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout });
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return reject(error);
      resolve({ code: typeof code === 'number' ? code : 1, stdout });
    });
  });

function syncFileClient(client: FileClient, spec: ServerSpec, mode: SyncMode): ClientResult {
  const base = { id: client.id, label: client.label };
  const present = client.targets.filter((t) => existsSync(t.dir));
  if (present.length === 0) return { ...base, state: 'not-installed' };

  let changed = 0;
  for (const target of present) {
    const text = existsSync(target.file) ? readFileSync(target.file, 'utf8') : '';
    const next = client.merge(text, mode === 'remove' ? null : spec);
    if (next === text) continue;
    changed += 1;
    if (mode === 'check') continue;
    if (existsSync(target.file) && !existsSync(target.file + BACKUP_SUFFIX)) {
      copyFileSync(target.file, target.file + BACKUP_SUFFIX);
    }
    mkdirSync(dirname(target.file), { recursive: true });
    writeFileSync(target.file, next);
  }
  if (changed === 0) return { ...base, state: 'unchanged' };
  return { ...base, state: mode === 'check' ? 'would-change' : 'changed' };
}

async function syncClaudeCode(spec: ServerSpec, mode: SyncMode, run: Runner): Promise<ClientResult> {
  const base = { id: 'claude-code', label: 'Claude Code' };
  try {
    const current = await run('claude', ['mcp', 'get', SERVER_NAME]);
    const registered = current.code === 0;
    if (mode === 'check') return { ...base, state: registered ? 'unchanged' : 'would-change' };
    if (mode === 'remove') {
      if (!registered) return { ...base, state: 'unchanged' };
      await run('claude', ['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
      return { ...base, state: 'changed' };
    }
    if (registered) await run('claude', ['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
    const added = await run('claude', ['mcp', 'add-json', SERVER_NAME, JSON.stringify(spec), '--scope', 'user']);
    if (added.code !== 0) return { ...base, state: 'error', detail: 'claude mcp add-json failed' };
    return { ...base, state: 'changed' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...base, state: 'not-installed' };
    return { ...base, state: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Registers, removes or checks the premiere-pro entry in every client found on this machine. */
export async function syncClients(spec: ServerSpec, mode: SyncMode, options: SyncOptions = {}): Promise<ClientResult[]> {
  const home = options.home ?? homedir();
  const appData =
    options.appData ??
    (process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : process.env.APPDATA ?? join(home, '.config'));
  const results: ClientResult[] = [];
  for (const client of fileClients(home, appData)) {
    try {
      results.push(syncFileClient(client, spec, mode));
    } catch (error) {
      results.push({ id: client.id, label: client.label, state: 'error', detail: error instanceof Error ? error.message : String(error) });
    }
  }
  results.push(await syncClaudeCode(spec, mode, options.run ?? defaultRun));
  return results;
}
