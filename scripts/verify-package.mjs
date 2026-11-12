import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const requiredPaths = [
  'dist/index.js',
  'dist/cli.js',
  'cep-plugin/CSXS/manifest.xml',
  'cep-plugin/bridge-cep.js',
  'cep-plugin/gui/gui-core.js',
  'cep-plugin/gui/gui.js',
  'cep-plugin/gui/workflows.json',
  'cep-plugin/gui/gui.css',
  'scripts/install-macos.sh',
  'scripts/install-windows.ps1',
  'scripts/doctor-macos.sh',
  'scripts/doctor-windows.ps1',
  'README.md',
  'LICENSE.md',
];

const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json'], { maxBuffer: 1024 * 1024, shell: process.platform === 'win32' });
const [pack] = JSON.parse(stdout);
const packagedPaths = new Set(pack.files.map((file) => file.path));
const missing = requiredPaths.filter((path) => !packagedPaths.has(path));

if (missing.length > 0) {
  console.error(`npm package is missing required files: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`npm package verified: ${pack.name}@${pack.version} (${pack.files.length} files)`);
