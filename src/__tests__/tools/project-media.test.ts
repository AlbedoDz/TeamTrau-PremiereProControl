import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_SELECTION, resolveProjectFile, resolveProjectFootage } from '../../tools/project-media.js';

const item = (name: string, bin: string, mediaPath: string, over: Record<string, unknown> = {}) =>
  ({ id: `id-${name}`, name, bin, mediaPath, offline: false, selected: false, ...over });

// Shape of the live Yéno2026 project: footage in "01 Footage", a rough cut sequence beside it
// (sequences are never listed), music in a sub-bin.
const project = () => ({
  success: true,
  bins: [{ path: '01 Footage', selected: false }, { path: '01 Footage/Flycam', selected: false }, { path: '02 Music', selected: false }],
  items: [
    item('DJI_0001.MP4', '01 Footage', 'E:/shoot/DJI_0001.MP4'),
    item('DJI_0002.MP4', '01 Footage', 'E:/shoot/DJI_0002.MP4'),
    item('air.mov', '01 Footage/Flycam', 'E:/shoot/air.mov'),
    item('still.png', '01 Footage', 'E:/shoot/still.png'),
    item('apalonbeats-family.mp3', '02 Music', 'D:/music/apalonbeats-family.mp3'),
  ],
});

const ctxWith = (data: unknown) => {
  const executeScript = jest.fn(async () => data);
  return { ctx: { bridge: { executeScript } } as never, executeScript };
};

describe('resolveProjectFootage', () => {
  it('takes the video clips of a bin, by name, without sub-bins unless recursive', async () => {
    const { ctx } = ctxWith(project());
    expect(await resolveProjectFootage(ctx, '01 footage', false)).toEqual({ paths: ['E:/shoot/DJI_0001.MP4', 'E:/shoot/DJI_0002.MP4'], source: 'bin "01 footage"' });
    const deep = await resolveProjectFootage(ctx, '01 Footage', true);
    expect(deep && 'paths' in deep ? deep.paths : []).toContain('E:/shoot/air.mov');
  });

  it('finds a sub-bin by its full path or a unique last segment', async () => {
    const { ctx } = ctxWith(project());
    expect(await resolveProjectFootage(ctx, '01 Footage\\Flycam', false)).toMatchObject({ paths: ['E:/shoot/air.mov'] });
    expect(await resolveProjectFootage(ctx, 'Flycam', false)).toMatchObject({ paths: ['E:/shoot/air.mov'] });
  });

  it('uses the selected clips and the clips of selected bins', async () => {
    const data = project();
    data.items[0]!.selected = true;
    data.bins[1]!.selected = true;
    const { ctx } = ctxWith(data);
    expect(await resolveProjectFootage(ctx, PROJECT_SELECTION, false)).toMatchObject({ paths: ['E:/shoot/DJI_0001.MP4', 'E:/shoot/air.mov'] });
  });

  it('explains an unknown name, an empty selection, and a bin with only offline clips', async () => {
    const data = project();
    data.items[2]!.offline = true;
    const { ctx } = ctxWith(data);
    expect(await resolveProjectFootage(ctx, 'Nope', false)).toEqual({ error: '"Nope" is neither a folder on disk nor a bin in the project.' });
    expect(await resolveProjectFootage(ctx, PROJECT_SELECTION, false)).toMatchObject({ error: expect.stringContaining('Nothing is selected') });
    expect(await resolveProjectFootage(ctx, 'Flycam', false)).toMatchObject({ error: expect.stringContaining('offline') });
  });

  it('leaves a real folder to the caller without asking Premiere', async () => {
    const { ctx, executeScript } = ctxWith(project());
    expect(await resolveProjectFootage(ctx, mkdtempSync(join(tmpdir(), 'pm-footage-')), false)).toBeNull();
    expect(executeScript).not.toHaveBeenCalled();
  });
});

describe('resolveProjectFile', () => {
  it('finds imported music by item name, file name or bin/name', async () => {
    const { ctx } = ctxWith(project());
    for (const value of ['apalonbeats-family.mp3', 'APALONBEATS-FAMILY.MP3', '02 Music/apalonbeats-family.mp3']) {
      expect(await resolveProjectFile(ctx, value, ['audio', 'video'])).toEqual({ path: 'D:/music/apalonbeats-family.mp3' });
    }
  });

  it('uses the selected item, and refuses an ambiguous or unknown name', async () => {
    const data = project();
    data.items[4]!.selected = true;
    data.items.push(item('apalonbeats-family.mp3', '03 Old', 'D:/old/apalonbeats-family.mp3'));
    const { ctx } = ctxWith(data);
    expect(await resolveProjectFile(ctx, PROJECT_SELECTION, ['audio'])).toEqual({ path: 'D:/music/apalonbeats-family.mp3' });
    expect(await resolveProjectFile(ctx, 'apalonbeats-family.mp3', ['audio'])).toMatchObject({ error: expect.stringContaining('matches 2 project items') });
    expect(await resolveProjectFile(ctx, 'missing.mp3', ['audio'])).toMatchObject({ error: expect.stringContaining('neither a file on disk') });
  });

  it('returns a file on disk as is', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pm-file-')), 'song.mp3');
    writeFileSync(file, 'x');
    const { ctx, executeScript } = ctxWith(project());
    expect(await resolveProjectFile(ctx, file, ['audio'])).toEqual({ path: file });
    expect(executeScript).not.toHaveBeenCalled();
  });
});
