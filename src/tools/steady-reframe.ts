/**
 * Holds the Auto Reframe framing still within each source shot (see analysis/steady-reframe.ts).
 * The tracked path is read from "Generated Keyframes". Premiere renders from "Adjust Position"
 * once "Overwrite generated path" is on, so the held path is written there; rewriting
 * "Generated Keyframes" alone changes nothing on screen (probed on 25.6.3).
 */
import type { ToolContext } from './context.js';
import { detectScenes } from '../analysis/scenes.js';
import { steadyPath, type PathKey } from '../analysis/steady-reframe.js';

/** How long to wait for Auto Reframe's background analysis. Tests shorten it. */
export const steadyReframeTiming = { timeoutMs: 180_000, pollMs: 2_000 };

const SCENE_OPTS = { threshold: 0.3, minShotSec: 0.5 };

interface ReframedClip {
  track: number;
  index: number;
  mediaPath: string;
  inPoint: number;
  outPoint: number;
  keys: number[][];
}

const readScript = (sequenceId: string): string => `
  // steady_reframe:read
  try {
    var seq = __findSequence(${JSON.stringify(sequenceId)});
    if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
    var fps = seq.timebase ? (254016000000 / parseInt(seq.timebase, 10)) : 30;
    var clips = [];
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      var track = seq.videoTracks[t];
      for (var i = 0; i < track.clips.numItems; i++) {
        var clip = track.clips[i], adj = null;
        for (var c = 0; c < clip.components.numItems; c++) {
          if (String(clip.components[c].displayName) !== "Auto Reframe") continue;
          var props = clip.components[c].properties;
          // The tracked path; "Adjust Position" only holds it once the path is overwritten.
          for (var p = 0; p < props.numItems; p++) if (String(props[p].displayName) === "Generated Keyframes") adj = props[p];
        }
        if (!adj) continue;
        var keys = [], ks = null;
        try { ks = adj.getKeys(); } catch (eKeys) {}
        if (ks) for (var k = 0; k < ks.length; k++) { var v = adj.getValueAtKey(ks[k]); keys.push([ks[k].seconds, v[0], v[1]]); }
        var path = "";
        try { path = String(clip.projectItem.getMediaPath()); } catch (ePath) {}
        clips.push({ track: t, index: i, mediaPath: path, inPoint: clip.inPoint.seconds, outPoint: clip.outPoint.seconds, keys: keys });
      }
    }
    return JSON.stringify({ success: true, frameSec: 1 / fps, clips: clips });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.toString() });
  }
`;

const writeScript = (sequenceId: string, paths: Array<{ track: number; index: number; keys: PathKey[] }>): string => `
  // steady_reframe:write
  try {
    var seq = __findSequence(${JSON.stringify(sequenceId)});
    if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
    var paths = ${JSON.stringify(paths)};
    function at(s) { var x = new Time(); x.seconds = s; return x; }
    var written = 0, errors = [];
    for (var n = 0; n < paths.length; n++) {
      try {
        var clip = seq.videoTracks[paths[n].track].clips[paths[n].index], adj = null, ovr = null;
        for (var c = 0; c < clip.components.numItems; c++) {
          if (String(clip.components[c].displayName) !== "Auto Reframe") continue;
          var props = clip.components[c].properties;
          for (var p = 0; p < props.numItems; p++) {
            var name = String(props[p].displayName);
            if (name === "Adjust Position") adj = props[p];
            if (name === "Overwrite generated path") ovr = props[p];
          }
        }
        if (!adj || !ovr) { errors.push("clip " + paths[n].track + "/" + paths[n].index + ": no Auto Reframe path"); continue; }
        ovr.setValue(true, true);
        if (!adj.isTimeVarying()) adj.setTimeVarying(true);
        var old = adj.getKeys();
        if (old && old.length > 0) adj.removeKeyRange(old[0], old[old.length - 1], true);
        var keys = paths[n].keys;
        for (var k = 0; k < keys.length; k++) {
          adj.addKey(at(keys[k].t));
          adj.setValueAtKey(at(keys[k].t), [keys[k].x, keys[k].y], true);
        }
        written++;
      } catch (eClip) { errors.push(eClip.toString()); }
    }
    return JSON.stringify({ success: true, written: written, errors: errors });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.toString() });
  }
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for Auto Reframe's path on every reframed clip, then replaces it with one still
 * position per source shot. Never fails the caller: problems come back as warnings.
 */
export async function steadyReframe(ctx: ToolContext, sequenceId: string): Promise<{ steadied: number; warnings: string[] }> {
  const warnings: string[] = [];
  const began = Date.now();
  let read: any;
  for (;;) {
    read = await ctx.bridge.executeScript(readScript(sequenceId));
    if (!read || read.success === false) {
      return { steadied: 0, warnings: [`Không đọc được khung Auto Reframe để giữ khung đứng yên: ${read?.error ?? 'lỗi không rõ'}`] };
    }
    const clips = (read.clips ?? []) as ReframedClip[];
    // No Auto Reframe clip: nothing to hold. Keys arrive in the background after the reframe.
    if (clips.every((c) => c.keys.length > 0)) break;
    if (Date.now() - began >= steadyReframeTiming.timeoutMs) break;
    await sleep(steadyReframeTiming.pollMs);
  }
  const clips = (read.clips ?? []) as ReframedClip[];
  const frameSec = Number(read.frameSec) || 1 / 30;
  const paths: Array<{ track: number; index: number; keys: PathKey[] }> = [];
  let unanalysed = 0;
  for (const clip of clips) {
    if (clip.keys.length === 0) { unanalysed++; continue; }
    let cuts: number[] = [];
    if (clip.mediaPath) {
      const found = await detectScenes(clip.mediaPath, { ...SCENE_OPTS, range: { start: clip.inPoint, end: clip.outPoint } });
      if ('failure' in found) warnings.push(`Không dò được điểm chuyển cảnh, giữ một khung cho cả clip: ${String(found.failure.error ?? '')}`);
      else cuts = found.cutTimes;
    }
    const keys = steadyPath(clip.keys.map(([t, x, y]) => ({ t: t!, x: x!, y: y! })), cuts, clip.inPoint, clip.outPoint, frameSec);
    if (keys.length > 0) paths.push({ track: clip.track, index: clip.index, keys });
  }
  if (unanalysed > 0) warnings.push(`Auto Reframe chưa phân tích xong ${unanalysed} clip sau ${Math.round(steadyReframeTiming.timeoutMs / 1000)} giây; các clip đó vẫn có chuyển động khung.`);
  if (paths.length === 0) return { steadied: 0, warnings };
  const wrote: any = await ctx.bridge.executeScript(writeScript(sequenceId, paths));
  if (!wrote || wrote.success === false) {
    warnings.push(`Không ghi được khung đứng yên: ${wrote?.error ?? 'lỗi không rõ'}`);
    return { steadied: 0, warnings };
  }
  for (const e of wrote.errors ?? []) warnings.push(`Giữ khung đứng yên: ${e}`);
  return { steadied: Number(wrote.written ?? 0), warnings };
}
