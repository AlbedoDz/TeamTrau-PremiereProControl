/**
 * Progress and cancellation reach a tool handler through ToolContext.
 *
 * The seam is a spy on the `run` of an existing domain tool (create_bin).
 * The handler map holds the same ToolModule objects as domainTools, so the
 * spy is seen by executeTool without registering anything in the catalog.
 */

import { PremiereProTools } from '../../tools/index.js';
import { domainTools } from '../../tools/domains/index.js';
import { throwIfAborted } from '../../tools/context.js';
import type { ToolContext } from '../../tools/context.js';

const makeTools = (): PremiereProTools =>
  new PremiereProTools({ executeScript: async () => ({ success: true }) } as never);

const createBin = () => {
  const mod = domainTools.find((t) => t.name === 'create_bin');
  if (!mod) throw new Error('create_bin missing from domainTools');
  return mod;
};

describe('progress and cancellation in ToolContext', () => {
  afterEach(() => jest.restoreAllMocks());

  it('executeTool passes progress and signal to the handler', async () => {
    const seen: Array<[number, number, string]> = [];
    const controller = new AbortController();
    let received: ToolContext | undefined;
    jest.spyOn(createBin(), 'run').mockImplementation(async (ctx: ToolContext) => {
      received = ctx;
      ctx.progress?.(1, 2, 'a');
      return { success: true };
    });

    const tools = makeTools();
    await tools.executeTool(
      'create_bin',
      { name: 'x' },
      { progress: (s, n, l) => seen.push([s, n, l]), signal: controller.signal },
    );

    expect(seen).toEqual([[1, 2, 'a']]);
    expect(received?.signal).toBe(controller.signal);
  });

  it('does not leak per-call options into the shared context', async () => {
    const contexts: ToolContext[] = [];
    jest.spyOn(createBin(), 'run').mockImplementation(async (ctx: ToolContext) => {
      contexts.push(ctx);
      return { success: true };
    });

    const tools = makeTools();
    await tools.executeTool('create_bin', { name: 'x' }, { progress: () => {} });
    await tools.executeTool('create_bin', { name: 'x' });

    expect(contexts[0]!.progress).toBeDefined();
    expect(contexts[1]!.progress).toBeUndefined();
    expect(contexts[1]!.signal).toBeUndefined();
  });

  it('invoke_tool forwards options', async () => {
    const seen: Array<[number, number, string]> = [];
    const controller = new AbortController();
    let received: ToolContext | undefined;
    jest.spyOn(createBin(), 'run').mockImplementation(async (ctx: ToolContext) => {
      received = ctx;
      ctx.progress?.(2, 3, 'b');
      return { success: true };
    });

    const tools = makeTools();
    await tools.executeTool(
      'invoke_tool',
      { name: 'create_bin', arguments: { name: 'x' } },
      { progress: (s, n, l) => seen.push([s, n, l]), signal: controller.signal },
    );

    expect(seen).toEqual([[2, 3, 'b']]);
    expect(received?.signal).toBe(controller.signal);
  });

  it('throwIfAborted throws on an aborted signal', () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow('cancelled');
  });
});
