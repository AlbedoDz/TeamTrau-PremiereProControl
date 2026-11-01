/**
 * Agents that find only the single-item tool call it once per item: one
 * session placed 35 clips with 35 add_to_timeline calls because search never
 * surfaced add_to_timeline_batch. These guard the hint that points from a
 * single-item tool to its batch sibling, in search results and descriptions.
 */

import { PremiereProTools } from '../../tools/index.js';
import { BATCH_ALTERNATIVES } from '../../tools/search.js';

jest.mock('../../bridge/index.js');

describe('batch alternatives', () => {
  const tools = new PremiereProTools({ executeScript: async () => ({ success: true }) } as never);
  const catalog = tools.getAvailableTools();
  const byName = new Map(catalog.map((tool) => [tool.name, tool]));

  it('names only tools that exist in the catalog', () => {
    const missing = Object.entries(BATCH_ALTERNATIVES)
      .flatMap(([single, alt]) => [single, alt.tool])
      .filter((name) => !byName.has(name));
    expect(missing).toEqual([]);
  });

  it('never hints a tool that renames every clip in place of renaming one', () => {
    // batch_rename_clips renames EVERY clip to "<prefix> N"; it is not a
    // faster rename_clip, and suggesting it would rewrite the whole timeline.
    expect(BATCH_ALTERNATIVES.rename_clip).toBeUndefined();
  });

  it('appends the batch hint to the single-item description', () => {
    expect(byName.get('add_to_timeline')?.description).toMatch(/add_to_timeline_batch/);
    expect(byName.get('apply_effect')?.description).toMatch(/EVERY clip/);
  });

  it('describes the expanded batch tools instead of echoing their names', () => {
    for (const name of [
      'batch_apply_effect',
      'batch_rename_clips',
      'batch_enable_disable',
      'delete_multiple_project_items',
      'move_items_to_bin',
      'add_tracks',
    ]) {
      expect(byName.get(name)?.description).not.toMatch(/expanded operation/);
    }
    expect(byName.get('batch_rename_clips')?.description).toMatch(/EVERY clip/);
    expect(byName.get('move_items_to_bin')?.description).toMatch(/projectItemIds/);
  });

  it('surfaces add_to_timeline_batch for the query an agent actually sent', async () => {
    const result = await tools.executeTool('search_tools', {
      query: 'add clip to timeline with in point out point source range',
    });
    expect(result.success).toBe(true);
    const names: string[] = result.matches.map((match: { name: string }) => match.name);
    expect(names).toContain('add_to_timeline_batch');
    const single = result.matches.find((match: { name: string }) => match.name === 'add_to_timeline');
    expect(single.batchAlternative).toBe('add_to_timeline_batch');
  });

  it('appends the sibling with its schema when detail=schema', async () => {
    const result = await tools.executeTool('search_tools', { pattern: '^add_to_timeline$', detail: 'schema' });
    expect(result.success).toBe(true);
    const sibling = result.matches.find((match: { name: string }) => match.name === 'add_to_timeline_batch');
    expect(sibling).toBeDefined();
    expect(sibling.inputSchema.type).toBe('object');
  });

  it('does not duplicate a sibling that already ranked', async () => {
    const result = await tools.executeTool('search_tools', { pattern: '^add_to_timeline', limit: 10 });
    const names: string[] = result.matches.map((match: { name: string }) => match.name);
    expect(names.filter((name) => name === 'add_to_timeline_batch')).toHaveLength(1);
  });
});
