/**
 * Memoises analysis results per media file.
 *
 * The key includes the file's size and mtime, so editing or replacing a file
 * invalidates its entries without any explicit bookkeeping. Results live in memory
 * for the life of the server and are mirrored to disk, so a restart does not redo
 * ffmpeg work on a project with hundreds of files. The directory is
 * PREMIERE_MCP_CACHE_DIR, or ~/.premiere-mcp/analysis. Disk trouble never fails an
 * analysis: reads and writes are best effort.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_ENTRIES = 5000;

const store = new Map<string, unknown>();
let writesSincePrune = 0;

function cacheDir(): string {
  return process.env.PREMIERE_MCP_CACHE_DIR || join(homedir(), '.premiere-mcp', 'analysis');
}

async function readDisk(file: string): Promise<{ value: unknown } | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as { value: unknown };
  } catch {
    return undefined;
  }
}

async function writeDisk(dir: string, file: string, value: unknown): Promise<void> {
  try {
    const body = JSON.stringify({ value });
    if (body.length > MAX_ENTRY_BYTES) return;
    await mkdir(dir, { recursive: true });
    await writeFile(file, body);
    if (++writesSincePrune >= 200) {
      writesSincePrune = 0;
      await prune(dir);
    }
  } catch {
    // Read-only or full disk: the in-memory entry still serves this process.
  }
}

/** Drops the oldest entries once the directory holds more than MAX_ENTRIES. */
async function prune(dir: string): Promise<void> {
  const names = await readdir(dir);
  if (names.length <= MAX_ENTRIES) return;
  const aged = await Promise.all(
    names.map(async (name) => ({ name, mtime: (await stat(join(dir, name))).mtimeMs })),
  );
  aged.sort((a, b) => a.mtime - b.mtime);
  await Promise.all(aged.slice(0, names.length - MAX_ENTRIES).map((e) => unlink(join(dir, e.name)).catch(() => {})));
}

export async function cached<T>(
  mediaPath: string,
  operation: string,
  params: unknown,
  compute: () => Promise<T>,
): Promise<T> {
  let fingerprint: string;
  try {
    const info = await stat(mediaPath);
    fingerprint = `${info.size}:${Math.round(info.mtimeMs)}`;
  } catch {
    // Unreadable file: compute directly so the caller sees the real error.
    return compute();
  }
  const key = `${mediaPath}|${fingerprint}|${operation}|${JSON.stringify(params)}`;
  if (store.has(key)) return store.get(key) as T;

  const dir = cacheDir();
  const file = join(dir, `${createHash('sha1').update(key).digest('hex')}.json`);
  const onDisk = await readDisk(file);
  if (onDisk) {
    store.set(key, onDisk.value);
    return onDisk.value as T;
  }

  const value = await compute();
  store.set(key, value);
  await writeDisk(dir, file, value);
  return value;
}

/** Forgets every cached analysis, in memory and on disk. */
export async function clearAnalysisCache(): Promise<void> {
  store.clear();
  await rm(cacheDir(), { recursive: true, force: true }).catch(() => {});
}
