import { availableParallelism } from 'node:os';

/**
 * How many ffmpeg/ffprobe processes to run at once. Each is mostly one decode
 * thread, so half the cores keeps Premiere responsive while the analysis runs.
 * PREMIERE_MCP_ANALYSIS_JOBS overrides it.
 */
export function analysisConcurrency(): number {
  const override = Number(process.env.PREMIERE_MCP_ANALYSIS_JOBS);
  if (Number.isInteger(override) && override > 0) return override;
  return Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));
}

/** Like Promise.all(items.map(fn)) but with at most `limit` calls in flight; keeps input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
