/** The user's chosen default engine, kept in <premiere-mcp home>/config.json. */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { premiereMcpHome, writeJsonAtomic } from './sidecar.js';
import { DEFAULT_ENGINE, isEngineId, type EngineId } from './asr-engines.js';

const configPath = (home?: string): string => join(home ?? premiereMcpHome(), 'config.json');

async function readConfig(home?: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(configPath(home), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The configured engine, or undefined when none is set or the value is unknown. */
export async function readAsrEngine(home?: string): Promise<EngineId | undefined> {
  const value = (await readConfig(home)).asrEngine;
  return isEngineId(value) ? value : undefined;
}

export async function writeAsrEngine(engine: EngineId, home?: string): Promise<void> {
  const path = configPath(home);
  await mkdir(dirname(path), { recursive: true });
  await writeJsonAtomic(path, { ...(await readConfig(home)), asrEngine: engine });
}

/** Tool argument > config > zipformer-68m. */
export async function resolveEngine(arg?: string): Promise<EngineId> {
  if (isEngineId(arg)) return arg;
  return (await readAsrEngine()) ?? DEFAULT_ENGINE;
}
