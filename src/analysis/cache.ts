/**
 * Memoises analysis results per media file.
 *
 * The key includes the file's size and mtime, so editing or replacing a file
 * invalidates its entries without any explicit bookkeeping. The cache is
 * in-memory and lives as long as the MCP server process.
 */
import { stat } from 'node:fs/promises';

const store = new Map<string, unknown>();

export async function cached<T>(
  mediaPath: string,
  operation: string,
  params: unknown,
  compute: () => Promise<T>,
): Promise<T> {
  let fingerprint = 'nostat';
  try {
    const info = await stat(mediaPath);
    fingerprint = `${info.size}:${Math.round(info.mtimeMs)}`;
  } catch {
    // Unreadable file: compute directly so the caller sees the real error.
    return compute();
  }
  const key = `${mediaPath}|${fingerprint}|${operation}|${JSON.stringify(params)}`;
  if (store.has(key)) return store.get(key) as T;
  const value = await compute();
  store.set(key, value);
  return value;
}

export function clearAnalysisCache(): void {
  store.clear();
}
