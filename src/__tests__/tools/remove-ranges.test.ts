import { PremiereProTools } from '../../tools/index.js';

jest.mock('../../bridge/index.js');

const FRAME = 1 / 25;

function snapshot(endTime: number) {
  return {
    success: true,
    sequenceId: 'seq-1',
    sequenceName: 'Main',
    frameDuration: FRAME,
    endTime,
    clips: [
      { id: 'v1', trackType: 'video', trackIndex: 0, start: 0, end: 20, inPoint: 0, outPoint: 20, mediaPath: 'talk.mp4' },
      { id: 'a1', trackType: 'audio', trackIndex: 0, start: 0, end: 20, inPoint: 0, outPoint: 20, mediaPath: 'talk.mp4' },
    ],
  };
}

const DELETE = 'inside[inside.length - 1].remove(true, true)';

describe('remove_ranges', () => {
  let executeScript: jest.Mock;
  let tools: PremiereProTools;

  beforeEach(() => {
    executeScript = jest.fn();
    tools = new PremiereProTools({ executeScript } as never);
  });

  const scripts = () => executeScript.mock.calls.map((c) => c[0] as string);

  /** before, razor end, razor start, delete, after: one range, applied cleanly. */
  const oneCut = (afterEnd: number) =>
    executeScript
      .mockResolvedValueOnce(snapshot(20))
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true, removedClips: 2 })
      .mockResolvedValueOnce(snapshot(afterEnd));

  it('dry run plans the cuts without razoring or backing up', async () => {
    executeScript.mockResolvedValueOnce(snapshot(20));
    const result = await tools.executeTool('remove_ranges', { ranges: [{ start: 5, end: 8 }], dryRun: true });
    expect(result).toMatchObject({ success: true, dryRun: true, durationBefore: 20, crossfadeFrames: 1 });
    expect(result.removed).toEqual([{ start: 5, end: 8, duration: 3 }]);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('razors both edges and ripple-deletes from the last range to the first', async () => {
    executeScript
      .mockResolvedValueOnce(snapshot(20))
      .mockResolvedValueOnce({ success: true }) // razor 14
      .mockResolvedValueOnce({ success: true }) // razor 12
      .mockResolvedValueOnce({ success: true, removedClips: 2 })
      .mockResolvedValueOnce({ success: true }) // razor 8
      .mockResolvedValueOnce({ success: true }) // razor 5
      .mockResolvedValueOnce({ success: true, removedClips: 2 })
      .mockResolvedValueOnce(snapshot(15))
      .mockResolvedValueOnce({ success: true, applied: 2, failed: 0 });

    const result = await tools.executeTool('remove_ranges', {
      ranges: [{ start: 5, end: 8 }, { start: 12, end: 14 }],
      backup: false,
    });

    expect(result).toMatchObject({ success: true, verified: true, durationBefore: 20, durationAfter: 15 });
    const s = scripts();
    expect(s[1]).toContain('Math.round(14 * fps)');
    expect(s[2]).toContain('Math.round(12 * fps)');
    expect(s[3]).toContain(DELETE);
    expect(s[3]).toContain('12 - 0.02');
    expect(s[4]).toContain('Math.round(8 * fps)');
    expect(s[5]).toContain('Math.round(5 * fps)');
    expect(s[6]).toContain('5 - 0.02');
    // joins on the shortened timeline: 5 s and 12 - 3 = 9 s
    expect(s[8]).toContain('[5,9]');
  });

  it('adds a Constant Power audio crossfade of the right length at each new join', async () => {
    oneCut(17).mockResolvedValueOnce({ success: true, applied: 1, failed: 0 });

    const result = await tools.executeTool('remove_ranges', { ranges: [{ start: 5, end: 8 }], backup: false, crossfadeMs: 100 });

    expect(result).toMatchObject({ success: true, verified: true, crossfadeFrames: 3, crossfadeMsActual: 120 });
    expect(result.warning).toBeUndefined();
    const fade = scripts()[5]!;
    expect(fade).toContain('Constant Power');
    expect(fade).toContain('"3:00"');
    expect(fade).toContain('[5]');
  });

  it('a failing crossfade only adds a warning', async () => {
    oneCut(17).mockResolvedValueOnce({ success: false, error: 'QE unavailable' });

    const result = await tools.executeTool('remove_ranges', { ranges: [{ start: 5, end: 8 }], backup: false });

    expect(result).toMatchObject({ success: true, verified: true });
    expect(result.warning).toContain('QE unavailable');
  });

  it('skips the crossfade when crossfadeMs is 0', async () => {
    oneCut(17);
    const result = await tools.executeTool('remove_ranges', { ranges: [{ start: 5, end: 8 }], backup: false, crossfadeMs: 0 });
    expect(result).toMatchObject({ success: true, crossfadeFrames: 0, crossfadeMsActual: 0 });
    expect(executeScript).toHaveBeenCalledTimes(5);
  });

  it('flags verified=false with a warning when the length does not shrink (locked tracks)', async () => {
    oneCut(20);
    const result = await tools.executeTool('remove_ranges', { ranges: [{ start: 5, end: 8 }], backup: false });
    expect(result.success).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.warning).toContain('locked');
    expect(executeScript).toHaveBeenCalledTimes(5); // no crossfade on a sequence that did not cut cleanly
  });

  it('keeps the listed ranges when invert is true', async () => {
    executeScript.mockResolvedValueOnce(snapshot(20));
    const result = await tools.executeTool('remove_ranges', {
      ranges: [{ start: 2, end: 5 }, { start: 8, end: 20 }],
      invert: true,
      dryRun: true,
    });
    expect(result.removed).toEqual([{ start: 0, end: 2, duration: 2 }, { start: 5, end: 8, duration: 3 }]);
  });

  it('stops and reports partial progress when a razor fails', async () => {
    executeScript.mockResolvedValueOnce(snapshot(20)).mockResolvedValueOnce({ success: false, error: 'QE unavailable' });
    const result = await tools.executeTool('remove_ranges', { ranges: [{ start: 5, end: 8 }], backup: false });
    expect(result.success).toBe(false);
    expect(result.error).toContain('QE unavailable');
    expect(result.applied).toEqual([]);
  });

  it('refuses to edit when the backup cannot be made', async () => {
    executeScript.mockResolvedValueOnce(snapshot(20)).mockResolvedValueOnce({ success: false, error: 'The project has not been saved yet' });
    const result = await tools.executeTool('remove_ranges', { ranges: [{ start: 5, end: 8 }] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Backup failed, nothing was changed');
    expect(executeScript).toHaveBeenCalledTimes(2);
  });

  it('does nothing when every range falls outside the sequence', async () => {
    executeScript.mockResolvedValueOnce(snapshot(20));
    const result = await tools.executeTool('remove_ranges', { ranges: [{ start: 30, end: 40 }], backup: false });
    expect(result).toMatchObject({ success: true, removed: [] });
    expect(executeScript).toHaveBeenCalledTimes(1);
  });
});
