/**
 * Agents stringify numbers and booleans ("12", "false"). The key allowlist in
 * mcp-args only covers known names, so anything outside it — search_tools
 * `limit`, add_to_timeline_batch `sourceInPoint` — died as zod.invalid_type.
 * These guard the schema-driven fallback: coerce only where Zod says a number
 * or boolean was expected, and leave string fields (numeric GUIDs) alone.
 */

import { PremiereProTools } from '../../tools/index.js';
import { coerceArgsFromIssues } from '../../utils/mcp-args.js';

jest.mock('../../bridge/index.js');

describe('schema-driven argument coercion', () => {
  let batchClips: unknown;
  const tools = new PremiereProTools({
    executeScript: async () => ({ success: true }),
    addToTimelineBatch: async (_sequenceId: string, clips: unknown) => {
      batchClips = clips;
      return { success: true, status: 'success', results: [] };
    },
  } as never);

  beforeEach(() => {
    batchClips = undefined;
  });

  it('accepts a stringified search_tools limit', async () => {
    const result = await tools.executeTool('search_tools', { pattern: '^list_', limit: '12' });
    expect(result.success).toBe(true);
    expect(result.limit).toBe(12);
  });

  it('coerces nested numbers and booleans outside the key allowlist', async () => {
    const result = await tools.executeTool('add_to_timeline_batch', {
      sequenceId: 'seq-1',
      clips: [{ projectItemId: '12345', trackIndex: 0, time: 0, sourceInPoint: '13.2', sourceOutPoint: '19.75', linkAudio: 'false' }],
    });
    expect(result.status).not.toBe('validation');
    expect(batchClips).toEqual([
      // A numeric-looking id in a string field stays a string.
      { projectItemId: '12345', trackIndex: 0, time: 0, sourceInPoint: 13.2, sourceOutPoint: 19.75, linkAudio: false },
    ]);
  });

  it('still rejects a non-numeric string for a number', async () => {
    const result = await tools.executeTool('search_tools', { pattern: '^list_', limit: 'abc' });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('zod.invalid_type');
    expect(result.errorFields).toBe('limit');
  });

  it('returns null when no issue is coercible and does not mutate the input', () => {
    const args = { clips: [{ time: '5' }] };
    const coerced = coerceArgsFromIssues(args, [
      { code: 'invalid_type', expected: 'number', path: ['clips', 0, 'time'] },
    ]);
    expect(coerced).toEqual({ clips: [{ time: 5 }] });
    expect(args.clips[0]!.time).toBe('5');
    expect(
      coerceArgsFromIssues(args, [{ code: 'invalid_type', expected: 'string', path: ['clips', 0, 'time'] }]),
    ).toBeNull();
    expect(coerceArgsFromIssues({ on: 'yes' }, [{ code: 'invalid_type', expected: 'boolean', path: ['on'] }])).toBeNull();
  });
});
