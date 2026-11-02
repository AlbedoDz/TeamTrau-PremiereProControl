import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeCodex,
  mergeDeepSeek,
  mergeMcpServers,
  mergeOpencode,
  mergeVsCode,
  syncClients,
  type Runner,
  type ServerSpec,
} from '../../setup/clients.js';

const spec: ServerSpec = {
  command: 'C:\\Tools\\node.exe',
  args: ['C:\\Tools\\dist\\index.js'],
  env: { PREMIERE_TEMP_DIR: 'C:\\Temp\\bridge' },
};

describe('JSON mergers', () => {
  it('adds the server to an empty file', () => {
    expect(JSON.parse(mergeMcpServers('', spec))).toEqual({ mcpServers: { 'premiere-pro': spec } });
  });

  it('keeps comments and other servers in a JSONC file, and is idempotent', () => {
    const before = '{\n  // my servers\n  "mcp": {\n    "blender": { "type": "local", "command": ["uvx"] }\n  },\n}\n';
    const once = mergeOpencode(before, spec);
    expect(once).toContain('// my servers');
    const parsed = JSON.parse(once.replace(/\/\/.*\n/, '').replace(/,(\s*})/g, '$1'));
    expect(parsed.mcp.blender.command).toEqual(['uvx']);
    expect(parsed.mcp['premiere-pro']).toEqual({
      type: 'local',
      command: [spec.command, ...spec.args],
      environment: spec.env,
      enabled: true,
    });
    expect(mergeOpencode(once, spec)).toBe(once);
  });

  it('writes the VS Code shape with type stdio', () => {
    expect(JSON.parse(mergeVsCode('{"servers":{"x":{}}}', spec)).servers).toEqual({
      x: {},
      'premiere-pro': { type: 'stdio', ...spec },
    });
  });

  it('removes only its own entry', () => {
    const added = mergeMcpServers('{"mcpServers":{"keep":{"command":"a"}}}', spec);
    expect(JSON.parse(mergeMcpServers(added, null))).toEqual({ mcpServers: { keep: { command: 'a' } } });
  });

  it('refuses a file that is not JSON instead of overwriting it', () => {
    expect(() => mergeMcpServers('{ not json', spec)).toThrow('not valid JSON');
  });
});

describe('Codex TOML merger', () => {
  const before = '# keep me\nmodel = "x"\n\n[mcp_servers.other]\ncommand = "o"\n\n[mcp_servers.premiere-pro]\ncommand = "old"\n\n[mcp_servers.premiere-pro.env]\nA = "1"\n\n[projects]\nk = 1\n';

  it('replaces its tables and leaves the rest alone', () => {
    const next = mergeCodex(before, spec);
    expect(next).toContain('# keep me');
    expect(next).toContain('[mcp_servers.other]\ncommand = "o"');
    expect(next).toContain('[projects]\nk = 1');
    expect(next).not.toContain('"old"');
    expect(next).toContain('command = "C:\\\\Tools\\\\node.exe"');
    expect(next.match(/\[mcp_servers\.premiere-pro\]/g)).toHaveLength(1);
    expect(mergeCodex(next, spec)).toBe(next);
  });

  it('removes its tables', () => {
    const next = mergeCodex(before, null);
    expect(next).not.toContain('premiere-pro');
    expect(next).toContain('[projects]');
  });
});

describe('DeepSeek Harness YAML merger', () => {
  const before = [
    '# patches',
    '- id: llm-a',
    '  config:',
    '    x: 1',
    '- insert:',
    '    # rea server',
    '    - id: mcp-rea',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: rea',
    '    - id: mcp-premiere-pro',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: premiere_pro',
    '        command: old',
    '',
  ].join('\n');

  it('replaces its row in place and keeps comments and other rows', () => {
    const next = mergeDeepSeek(before, spec);
    expect(next).toContain('# patches');
    expect(next).toContain('# rea server');
    expect(next).toContain('id: mcp-rea');
    expect(next).not.toContain('command: old');
    expect(next).toContain('failOnStartupError: false');
    expect(next.match(/id: mcp-premiere-pro/g)).toHaveLength(1);
    expect(mergeDeepSeek(next, spec)).toBe(next);
  });

  it('adds a new insert block when the file has none', () => {
    const next = mergeDeepSeek('- id: llm-a\n  config:\n    x: 1\n', spec);
    expect(next).toContain('insert:');
    expect(next).toContain('id: mcp-premiere-pro');
  });

  it('removes its row', () => {
    const next = mergeDeepSeek(before, null);
    expect(next).not.toContain('mcp-premiere-pro');
    expect(next).toContain('id: mcp-rea');
  });

  it('register then remove returns the file to how it was', () => {
    const original = '- id: llm-a\n  config:\n    x: 1\n';
    expect(mergeDeepSeek(mergeDeepSeek(original, spec), null)).toBe(original);
  });

  it('leaves a file without our row untouched on remove', () => {
    expect(mergeDeepSeek('- id: llm-a\n', null)).toBe('- id: llm-a\n');
  });
});

describe('syncClients', () => {
  let home: string;
  let appData: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clients-home-'));
    appData = join(home, 'AppData', 'Roaming');
    mkdirSync(appData, { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const absent: Runner = async () => {
    throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  };
  const stateOf = (results: Awaited<ReturnType<typeof syncClients>>, id: string) => results.find((r) => r.id === id)?.state;

  it('skips clients that are not installed', async () => {
    const results = await syncClients(spec, 'register', { home, appData, run: absent });
    expect(results.every((r) => r.state === 'not-installed')).toBe(true);
    expect(existsSync(join(home, '.gemini'))).toBe(false);
  });

  it('registers installed clients, backs up once, and is idempotent', async () => {
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    const antigravity = join(home, '.gemini', 'config', 'mcp_config.json');
    writeFileSync(antigravity, '{"mcpServers":{"rea":{"command":"r"}}}');
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    mkdirSync(join(home, '.dsh', 'profiles', 'desktop'), { recursive: true });

    const first = await syncClients(spec, 'register', { home, appData, run: absent });
    expect(stateOf(first, 'antigravity')).toBe('changed');
    expect(stateOf(first, 'opencode')).toBe('changed');
    expect(stateOf(first, 'deepseek-harness')).toBe('changed');
    expect(stateOf(first, 'codex')).toBe('not-installed');
    expect(stateOf(first, 'claude-code')).toBe('not-installed');

    const servers = JSON.parse(readFileSync(antigravity, 'utf8')).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(['premiere-pro', 'rea']);
    expect(readFileSync(antigravity + '.bak-premiere', 'utf8')).toBe('{"mcpServers":{"rea":{"command":"r"}}}');

    const second = await syncClients(spec, 'register', { home, appData, run: absent });
    expect(stateOf(second, 'antigravity')).toBe('unchanged');
    expect(stateOf(second, 'opencode')).toBe('unchanged');
    expect(stateOf(second, 'deepseek-harness')).toBe('unchanged');
    expect(readFileSync(antigravity + '.bak-premiere', 'utf8')).toBe('{"mcpServers":{"rea":{"command":"r"}}}');
  });

  it('check reports without writing, and remove undoes register', async () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    const config = join(home, '.codex', 'config.toml');

    expect(stateOf(await syncClients(spec, 'check', { home, appData, run: absent }), 'codex')).toBe('would-change');
    expect(existsSync(config)).toBe(false);

    await syncClients(spec, 'register', { home, appData, run: absent });
    expect(readFileSync(config, 'utf8')).toContain('[mcp_servers.premiere-pro]');
    expect(stateOf(await syncClients(spec, 'check', { home, appData, run: absent }), 'codex')).toBe('unchanged');

    await syncClients(spec, 'remove', { home, appData, run: absent });
    expect(readFileSync(config, 'utf8')).not.toContain('premiere-pro');
  });

  it('reports a broken file as an error and keeps the other clients going', async () => {
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), '{ broken');
    mkdirSync(join(home, '.codex'), { recursive: true });

    const results = await syncClients(spec, 'register', { home, appData, run: absent });
    expect(stateOf(results, 'antigravity')).toBe('error');
    expect(stateOf(results, 'codex')).toBe('changed');
    expect(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8')).toBe('{ broken');
  });

  it('registers Claude Code through its CLI, replacing an old entry', async () => {
    const calls: string[][] = [];
    const run: Runner = async (_command, args) => {
      calls.push(args);
      return { code: 0, stdout: '' };
    };
    const results = await syncClients(spec, 'register', { home, appData, run });
    expect(stateOf(results, 'claude-code')).toBe('changed');
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['mcp get', 'mcp remove', 'mcp add-json']);
    expect(JSON.parse(calls[2]?.[3] ?? '{}')).toEqual(spec);
  });
});
