#!/usr/bin/env node
/**
 * Builds the Windows installer (Inno Setup) with everything bundled: the server, a Node runtime,
 * ffmpeg (Gyan full), uv with Python 3.12, the sidecar's Python wheels, and the default
 * Zipformer-68M, VAD and face models. Whisper and CUDA are not bundled; the installer offers them
 * as a download after install.
 *
 *   npm run build:installer             stage everything, then compile with Inno Setup
 *   npm run build:installer -- --stage-only
 *
 * Needs on this machine: uv, the models already fetched (`premiere-pro-mcp --setup-asr`), Windows
 * tar, and Inno Setup 6 (`winget install --id JRSoftware.InnoSetup -e`) unless --stage-only.
 * Downloads are cached in .installer-cache/.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, '.installer-staging');
const cache = join(root, '.installer-cache');
const outDir = join(root, 'release-artifacts');
const stageOnly = process.argv.includes('--stage-only');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const mcpHome = process.env.PREMIERE_MCP_HOME || join(homedir(), '.premiere-mcp');
const winTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
const MODELS = ['zipformer-vi-68m-int8', 'silero_vad.onnx', 'face_detection_yunet_2023mar.onnx'];

if (process.platform !== 'win32') throw new Error('The installer is built on Windows.');

const log = (line) => console.log(`[installer] ${line}`);

async function run(command, args, options = {}) {
  // npm is a .cmd shim on Windows, which execFile cannot start without a shell.
  const shell = command === 'npm';
  const { stdout } = await execFileAsync(command, args, { maxBuffer: 64 * 1024 * 1024, shell, ...options });
  return stdout;
}

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline((await import('node:fs')).createReadStream(file), hash);
  return hash.digest('hex');
}

async function download(url, name) {
  const target = join(cache, name);
  if (existsSync(target)) {
    log(`cached ${name}`);
    return target;
  }
  log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  await mkdir(cache, { recursive: true });
  const partial = `${target}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  await rename(partial, target);
  return target;
}

async function bundleNode() {
  log('node');
  await mkdir(join(stage, 'node'), { recursive: true });
  await cp(process.execPath, join(stage, 'node', 'node.exe'));
}

async function bundleUvAndPython() {
  log('uv and Python 3.12');
  const uvPath = (await run('where', ['uv'])).split(/\r?\n/)[0].trim();
  if (!uvPath) throw new Error('uv was not found on PATH.');
  await mkdir(join(stage, 'uv'), { recursive: true });
  await cp(uvPath, join(stage, 'uv', 'uv.exe'));
  await run(uvPath, ['python', 'install', '3.12', '--install-dir', join(stage, 'uvpython')]);
  const [distribution] = (await readdir(join(stage, 'uvpython'))).filter((d) => d.startsWith('cpython-3.12'));
  if (!distribution) throw new Error('uv installed no Python 3.12.');
}

// Any Python with pip will do: --platform/--python-version fetch the wheels for the bundled 3.12.
async function bundleWheels() {
  log('Python wheels (sidecar requirements and its build backend)');
  const wheels = join(stage, 'wheels');
  await mkdir(wheels, { recursive: true });
  await run('python', [
    '-m', 'pip', 'download', '--only-binary=:all:', '--platform', 'win_amd64', '--python-version', '3.12',
    '--implementation', 'cp', '-r', join(stage, 'app', 'python', 'requirements.txt'), 'hatchling', '-d', wheels,
  ], { env: { ...process.env, PIP_REQUIRE_VIRTUALENV: '0' } });
}

async function bundleFfmpeg() {
  log('ffmpeg (latest Gyan full build)');
  // Gyan publishes every build to GitHub with a SHA-256 digest; gyan.dev serves the full build only as 7z.
  const release = await (await fetch('https://api.github.com/repos/GyanD/codexffmpeg/releases/latest')).json();
  const asset = release.assets?.find((x) => /-full_build.7z$/.test(x.name));
  const expected = asset?.digest?.replace(/^sha256:/, '').toLowerCase();
  if (!asset || !expected) throw new Error('No full_build.7z with a digest in the latest GyanD/codexffmpeg release.');
  const zip = await download(asset.browser_download_url, asset.name);
  if ((await sha256(zip)) !== expected) {
    await rm(zip, { force: true });
    throw new Error('ffmpeg archive failed its SHA-256 check; deleted, run again.');
  }
  // Unpacking the 7z takes a while; keep it until the release changes.
  const unpacked = join(cache, 'ffmpeg-unpacked', asset.name);
  const done = join(unpacked, '.unpacked');
  if (existsSync(done)) {
    log(`cached unpack of ${asset.name}`);
  } else {
    await rm(join(cache, 'ffmpeg-unpacked'), { recursive: true, force: true });
    await mkdir(unpacked, { recursive: true });
    await run(winTar, ['-xf', zip, '-C', unpacked]);
    await writeFile(done, '');
  }
  const [folder] = (await readdir(unpacked)).filter((name) => name !== '.unpacked');
  const source = join(unpacked, folder);
  await mkdir(join(stage, 'ffmpeg', 'bin'), { recursive: true });
  for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) await cp(join(source, 'bin', exe), join(stage, 'ffmpeg', 'bin', exe));
  for (const doc of ['LICENSE', 'README.txt']) if (existsSync(join(source, doc))) await cp(join(source, doc), join(stage, 'ffmpeg', doc));
  return (await run(join(stage, 'ffmpeg', 'bin', 'ffmpeg.exe'), ['-version'])).split(/\r?\n/)[0];
}

async function bundleModels() {
  log('default models');
  for (const name of MODELS) {
    const source = join(mcpHome, 'models', name);
    if (!existsSync(source)) throw new Error(`Missing ${source}. Run "premiere-pro-mcp --setup-asr" on this machine first.`);
    await cp(source, join(stage, 'seed-models', name), { recursive: true });
  }
}

async function bundleApp() {
  log('app package');
  const packDir = join(cache, 'pack');
  await rm(packDir, { recursive: true, force: true });
  await mkdir(packDir, { recursive: true });
  await run('npm', ['pack', '--pack-destination', packDir], { cwd: root });
  const [tgz] = (await readdir(packDir)).filter((f) => f.endsWith('.tgz'));
  await mkdir(join(stage, 'app'), { recursive: true });
  await run(winTar, ['-xzf', join(packDir, tgz), '--strip-components=1', '-C', join(stage, 'app')]);
  await cp(join(root, 'package-lock.json'), join(stage, 'app', 'package-lock.json'));
  await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: join(stage, 'app') });
}

async function writeCrlf(target, text) {
  await writeFile(target, text.replace(/\r?\n/g, '\r\n'));
}

async function bundleLaunchers(ffmpegVersion) {
  await mkdir(join(stage, 'bin'), { recursive: true });
  for (const [from, to] of [['premiere-pro-mcp.cmd', join('bin', 'premiere-pro-mcp.cmd')], ['post-install.cmd', 'post-install.cmd'], ['HUONG-DAN.md', 'HUONG-DAN.md'], ['HUONG-DAN-SU-DUNG.md', 'HUONG-DAN-SU-DUNG.md']]) {
    await writeCrlf(join(stage, to), await readFile(join(root, 'installer', from), 'utf8'));
  }
  await writeFile(join(stage, 'THIRD-PARTY-NOTICES.txt'), [
    'TeamTrau PremiereProControl bundles the components below. Each keeps its own license.',
    '',
    `ffmpeg and ffprobe: ${ffmpegVersion}`,
    '  Gyan "release-full" build, GPL v3. License text: ffmpeg\\LICENSE.',
    '  Source and build details: https://www.gyan.dev/ffmpeg/builds/ and https://ffmpeg.org/download.html',
    'Node.js: MIT, https://nodejs.org',
    'uv: MIT or Apache-2.0, https://github.com/astral-sh/uv',
    'Python 3.12 (python-build-standalone): PSF License, https://github.com/astral-sh/python-build-standalone',
    'Python wheels in wheels\\: each wheel carries its own license metadata.',
    'Zipformer-vi-68M: see the license note inside seed-models\\zipformer-vi-68m-int8.',
    'Silero VAD: MIT. YuNet face model (OpenCV Zoo): MIT.',
    'Whisper large-v3-turbo, if you download it later: MIT.',
    '',
    'This package is for non-commercial use.',
    '',
  ].join('\r\n'));
}

async function compile() {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env['ProgramFiles(x86)'] ?? '', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env.ProgramFiles ?? '', 'Inno Setup 6', 'ISCC.exe'),
  ];
  const iscc = candidates.find((c) => existsSync(c));
  if (!iscc) throw new Error('Inno Setup 6 not found. Install it with: winget install --id JRSoftware.InnoSetup -e');
  // Inno reads a non-ASCII script as Unicode only when it starts with a UTF-8 byte order mark.
  const script = join(stage, '..', '.installer-setup.iss');
  await writeFile(script, `\uFEFF${await readFile(join(root, 'installer', 'setup.iss'), 'utf8')}`);
  await mkdir(outDir, { recursive: true });
  await run(iscc, [`/DStage=${stage}`, `/DAppVersion=${version}`, `/O${outDir}`, script]);
  await rm(script, { force: true });
  log(`built ${join(outDir, `TeamTrau-PremiereProControl-${version}-Setup.exe`)}`);
}

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await bundleApp();
await bundleUvAndPython();
await bundleWheels();
const ffmpegVersion = await bundleFfmpeg();
await bundleNode();
await bundleModels();
await bundleLaunchers(ffmpegVersion);
log(`staged in ${stage}`);
if (!stageOnly) await compile();
