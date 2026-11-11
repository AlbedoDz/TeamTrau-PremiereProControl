import type { z } from 'zod';
import type { PremiereProTransport } from '../bridge/types.js';
import type { Logger } from '../utils/logger.js';
import type { MCPTool } from './types.js';

/**
 * Everything a tool handler is allowed to reach outside its own module.
 *
 * Handlers are free functions rather than methods so that a domain module can
 * be read, tested, and imported without constructing the server. This is the
 * seam: pass a fake bridge and a handler runs with no Premiere present.
 */
export interface ToolContext {
  bridge: PremiereProTransport;
  logger: Logger;
  /** The full catalog, including tools this server only exposes via invoke_tool. */
  listTools(): MCPTool[];
  /** The subset advertised in tools/list under the active PREMIERE_MCP_TOOLSET. */
  listAdvertisedTools(): MCPTool[];
  /** Reports step `step` of `stepCount`. Absent when the caller is not listening. */
  progress?: (step: number, stepCount: number, label: string) => void;
  /** Aborted when the caller cancels; long handlers should check it between steps. */
  signal?: AbortSignal;
}

/** Throws `Error('cancelled')` once the signal has been aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('cancelled');
}

/** A tool declaration bound to the handler that implements it. */
export interface ToolModule extends MCPTool {
  run(ctx: ToolContext, args: any): unknown | Promise<unknown>;
}

export type { MCPTool };
export type ToolSchema = z.ZodSchema<any>;
