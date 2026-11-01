#!/usr/bin/env node
/**
 * Builds the zip to hand to someone else: the npm package as a .tgz, an installer
 * for Windows and for macOS, and the install guide (share/).
 *
 *   npm run share:package
 *
 * Output: release-artifacts/TeamTrau-PremiereProControl-<version>-share.zip
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.platform === 'win32';
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const staging = join(root, '.share-staging');
const outDir = join(root, 'release-artifacts');
const baseName = `TeamTrau-PremiereProControl-${version}`;
const zipPath = join(outDir, `${baseName}-share.zip`);

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await mkdir(outDir, { recursive: true });

// The package, built by the prepare script that npm pack runs.
await execFileAsync('npm', ['pack', '--pack-destination', staging], { cwd: root, maxBuffer: 8 * 1024 * 1024, shell });
const packed = (await readdir(staging)).find((f) => f.endsWith('.tgz'));
if (!packed) throw new Error('npm pack produced no .tgz');
await rename(join(staging, packed), join(staging, `${baseName}.tgz`));

// Installers and guide. Windows batch files need CRLF line endings.
for (const file of await readdir(join(root, 'share'))) {
  const text = await readFile(join(root, 'share', file), 'utf8');
  if (file.endsWith('.cmd')) await writeFile(join(staging, file), text.replace(/\r?\n/g, '\r\n'));
  else await copyFile(join(root, 'share', file), join(staging, file));
}

await rm(zipPath, { force: true });
// Windows ships bsdtar, which writes zip. A GNU tar earlier on PATH (Git Bash) cannot.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
await execFileAsync(tar, ['-a', '-c', '-f', zipPath, '-C', staging, '.'], { cwd: root });
await rm(staging, { recursive: true, force: true });
console.log(`Share package created: ${zipPath}`);
