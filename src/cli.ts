#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ENGINE_IDS, isEngineId } from './analysis/asr-engines.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(packageRoot, 'dist', 'index.js');

function printHelp(): void {
  console.log(`Premiere Pro MCP

Usage:
  premiere-pro-mcp                 Start the MCP stdio server
  premiere-pro-mcp --install-cep   Install the CEP bridge and configure supported MCP clients
  premiere-pro-mcp --doctor        Check the local server, CEP bridge, and client configuration
  premiere-pro-mcp --setup-asr     Install the Python analysis sidecar and the default Zipformer-68M model (about 150 MB)
  premiere-pro-mcp --setup-asr --engine <id> [--yes] [--no-default]
                                   Also install another engine after you approve the download:
                                   zipformer-68m, zipformer-30m, rover, whisper-turbo
  premiere-pro-mcp asr-status      Print speech and face analysis sidecar status as JSON
  premiere-pro-mcp --version       Print the installed package version
  premiere-pro-mcp --help          Show this help

Telemetry is on by default. Set PREMIERE_MCP_TELEMETRY=0 to opt out.
Update checks are on by default. Set PREMIERE_MCP_UPDATE_CHECK=0 to opt out.
Tool search is on by default (search_tools + invoke_tool). Set PREMIERE_MCP_TOOLSET=full to advertise every Premiere tool to the MCP host.
`);
}

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function runPlatformScript(macScript: string, windowsScript: string, windowsArgs: string[] = []): Promise<void> {
  let code: number;
  if (process.platform === 'darwin') {
    code = await run('bash', [join(packageRoot, 'scripts', macScript), '--skip-build']);
  } else if (process.platform === 'win32') {
    code = await run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(packageRoot, 'scripts', windowsScript),
      ...windowsArgs,
    ]);
  } else {
    throw new Error('Premiere Pro MCP setup is supported on macOS and Windows only.');
  }

  if (code !== 0) process.exitCode = code;
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case 'serve':
      process.exitCode = await run(process.execPath, [serverEntry]);
      return;
    case '--install-cep':
    case 'install-cep':
    case 'setup':
      await runPlatformScript('install-macos.sh', 'install-windows.ps1', ['-SkipBuild']);
      return;
    case '--setup-asr':
    case 'setup-asr': {
      const { setupAsr } = await import('./setup/asr.js');
      const rest = process.argv.slice(3);
      const at = rest.indexOf('--engine');
      const inline = rest.find((a) => a.startsWith('--engine='));
      const engineArg = at >= 0 ? rest[at + 1] : inline?.slice('--engine='.length);
      if ((at >= 0 || inline !== undefined) && !isEngineId(engineArg)) {
        console.error(`Unknown engine "${engineArg ?? ''}". Choose one of: ${ENGINE_IDS.join(', ')}.`);
        process.exitCode = 1;
        return;
      }
      const exitCode = await setupAsr(console.log, {
        pkgPythonDir: join(packageRoot, 'python'),
        ...(isEngineId(engineArg) ? { engine: engineArg } : {}),
        yes: rest.includes('--yes') || rest.includes('-y'),
        noDefault: rest.includes('--no-default'),
      });
      if (exitCode !== 0) {
        process.exitCode = exitCode;
      }
      return;
    }
    case 'asr-status':
    case '--asr-status': {
      const { asrStatus } = await import('./setup/asr.js');
      const status = await asrStatus();
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    case '--doctor':
    case 'doctor':
      await runPlatformScript('doctor-macos.sh', 'doctor-windows.ps1');
      return;
    case '--version':
    case '-v': {
      const packageJson = await import('../package.json', { with: { type: 'json' } });
      console.log(packageJson.default.version);
      return;
    }
    case '--help':
    case '-h':
    case 'help':
      printHelp();
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
