/**
 * Media already in the Premiere project, so tools that take file paths also accept what the
 * editor sees in the Project panel: a bin ("01 Footage", "01 Footage/Flycam"), an imported
 * item by name ("song.mp3"), or the current Project panel selection (PROJECT_SELECTION).
 * A value that exists on disk is always used as a path first.
 */
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ToolContext } from './context.js';

/** Field value meaning "the items selected in the Project panel when the tool runs". */
export const PROJECT_SELECTION = '@selection';

export const FOOTAGE_SOURCE_HELP =
  'Where the footage is: a folder on disk, a project bin ("01 Footage" or "01 Footage/Flycam"), or "@selection" for the clips and bins selected in the Project panel. Use this or mediaPaths.';
export const MUSIC_PATH_HELP =
  'The music: an absolute file path, the name of an audio or video item already imported into the project ("song.mp3" or "bin/song.mp3"), or "@selection" for the item selected in the Project panel.';

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mxf', '.mkv', '.m4v', '.avi', '.mts', '.m2ts', '.webm']);
export const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.aif', '.aiff', '.m4a', '.aac', '.flac', '.ogg', '.wma']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.psd', '.tif', '.tiff', '.gif', '.bmp', '.ai', '.webp']);

export type MediaKind = 'video' | 'audio' | 'image' | 'other';

export interface ProjectMediaItem {
  id: string;
  name: string;
  /** Bin path from the project root, "" for the root, "A/B" for bin B inside bin A. */
  bin: string;
  mediaPath: string;
  kind: MediaKind;
  offline: boolean;
  selected: boolean;
}

export interface ProjectBin {
  path: string;
  selected: boolean;
}

export interface ProjectMedia {
  bins: ProjectBin[];
  items: ProjectMediaItem[];
}

export function mediaKind(path: string): MediaKind {
  const ext = extname(path).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return 'other';
}

const READ_SCRIPT = `
  try {
    var selected = {};
    try {
      var sel = app.getCurrentProjectViewSelection();
      if (sel) for (var s = 0; s < sel.length; s++) selected[sel[s].nodeId] = true;
    } catch (e0) {}
    var bins = [];
    var items = [];
    function walk(parent, path) {
      for (var i = 0; i < parent.children.numItems; i++) {
        var child = parent.children[i];
        if (child.type === ProjectItemType.BIN) {
          var binPath = path ? path + '/' + child.name : child.name;
          bins.push({ path: binPath, selected: selected[child.nodeId] === true });
          walk(child, binPath);
          continue;
        }
        var isSeq = false;
        try { isSeq = child.isSequence(); } catch (e1) {}
        if (isSeq) continue;
        var media = null;
        try { media = child.getMediaPath(); } catch (e2) {}
        if (!media) continue;
        var offline = false;
        try { offline = child.isOffline(); } catch (e3) {}
        items.push({ id: child.nodeId, name: child.name, bin: path, mediaPath: String(media), offline: offline, selected: selected[child.nodeId] === true });
      }
    }
    walk(app.project.rootItem, '');
    return JSON.stringify({ success: true, bins: bins, items: items });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.toString() });
  }
`;

/** Every bin and every media item of the open project (sequences left out). */
export async function readProjectMedia(ctx: ToolContext): Promise<ProjectMedia | { error: string }> {
  const r: any = await ctx.bridge.executeScript(READ_SCRIPT);
  if (!r || r.success === false || !Array.isArray(r.items)) return { error: `Could not read the project: ${r?.error ?? 'no response'}` };
  return {
    bins: (r.bins ?? []).map((b: any) => ({ path: String(b.path), selected: b.selected === true })),
    items: r.items.map((i: any) => ({
      id: String(i.id),
      name: String(i.name),
      bin: String(i.bin ?? ''),
      mediaPath: String(i.mediaPath),
      kind: mediaKind(String(i.mediaPath)),
      offline: i.offline === true,
      selected: i.selected === true,
    })),
  };
}

const key = (s: string): string => s.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/').toLowerCase();

async function existsOnDisk(path: string): Promise<'file' | 'dir' | null> {
  try {
    const s = await stat(path);
    return s.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

const inBin = (item: ProjectMediaItem, bin: string, recursive: boolean): boolean =>
  key(item.bin) === bin || (recursive && key(item.bin).startsWith(`${bin}/`));

/** The one bin a typed value names: its full path, else a unique last segment. */
function findBin(media: ProjectMedia, value: string): { path: string } | { error: string } | null {
  const wanted = key(value);
  const exact = media.bins.find((b) => key(b.path) === wanted);
  if (exact) return { path: key(exact.path) };
  const byName = media.bins.filter((b) => key(b.path).split('/').pop() === wanted);
  if (byName.length === 1) return { path: key(byName[0]!.path) };
  if (byName.length > 1) return { error: `Several bins are named "${value}": ${byName.map((b) => b.path).join(', ')}. Give the full bin path.` };
  return null;
}

const uniquePaths = (items: ProjectMediaItem[]): string[] => [...new Map(items.map((i) => [key(i.mediaPath), i.mediaPath])).values()];

/**
 * Video files for a footage source: a folder on disk (returns null so the caller walks it),
 * a project bin, or PROJECT_SELECTION (selected clips plus the clips of selected bins).
 */
export async function resolveProjectFootage(
  ctx: ToolContext,
  value: string,
  recursive: boolean,
): Promise<{ paths: string[]; source: string } | { error: string } | null> {
  if (value !== PROJECT_SELECTION && (await existsOnDisk(value)) === 'dir') return null;
  const media = await readProjectMedia(ctx);
  if ('error' in media) return media;
  let picked: ProjectMediaItem[];
  let source: string;
  if (value === PROJECT_SELECTION) {
    const bins = media.bins.filter((b) => b.selected).map((b) => key(b.path));
    picked = media.items.filter((i) => i.selected || bins.some((b) => inBin(i, b, recursive)));
    source = 'the Project panel selection';
    if (picked.length === 0) return { error: 'Nothing is selected in the Project panel. Select clips or a bin there, then run again.' };
  } else {
    const bin = findBin(media, value);
    if (!bin) return { error: `"${value}" is neither a folder on disk nor a bin in the project.` };
    if ('error' in bin) return bin;
    picked = media.items.filter((i) => inBin(i, bin.path, recursive));
    source = `bin "${value}"`;
  }
  const video = picked.filter((i) => i.kind === 'video');
  const online = video.filter((i) => !i.offline);
  if (online.length === 0) {
    const why = video.length > 0 ? `its ${video.length} video clip(s) are offline` : 'it holds no video clips';
    return { error: `Cannot use ${source}: ${why}${recursive ? '' : ' (pass recursive=true to include sub-bins)'}.` };
  }
  return { paths: uniquePaths(online), source };
}

/**
 * One media file: a path on disk as is, else an imported item named by its project name,
 * its file name, or "bin/name", else the single selected item (PROJECT_SELECTION).
 */
export async function resolveProjectFile(
  ctx: ToolContext,
  value: string,
  kinds: MediaKind[],
): Promise<{ path: string } | { error: string }> {
  if (value !== PROJECT_SELECTION && (await existsOnDisk(value)) === 'file') return { path: value };
  const media = await readProjectMedia(ctx);
  if ('error' in media) return { error: `File not found on disk, and ${media.error.charAt(0).toLowerCase()}${media.error.slice(1)}` };
  const usable = media.items.filter((i) => kinds.includes(i.kind));
  const wanted = key(value);
  const matches = value === PROJECT_SELECTION
    ? usable.filter((i) => i.selected)
    : usable.filter((i) => {
        const fileName = key(i.mediaPath).split('/').pop();
        const name = key(i.name);
        return name === wanted || fileName === wanted || `${key(i.bin)}/${name}` === wanted;
      });
  const distinct = uniquePaths(matches);
  if (distinct.length === 0) {
    return { error: value === PROJECT_SELECTION
      ? `No ${kinds.join('/')} item is selected in the Project panel.`
      : `File not found: "${value}" is neither a file on disk nor an imported ${kinds.join('/')} item in the project.` };
  }
  if (distinct.length > 1) {
    return { error: `"${value}" matches ${distinct.length} project items: ${matches.map((m) => (m.bin ? `${m.bin}/${m.name}` : m.name)).join(', ')}. Give the bin path too ("bin/name") or the full file path.` };
  }
  const item = matches[0]!;
  if (item.offline) return { error: `Project item "${item.name}" is offline (${item.mediaPath}). Relink it in Premiere first.` };
  return { path: distinct[0]! };
}
