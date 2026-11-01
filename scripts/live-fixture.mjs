#!/usr/bin/env node
/**
 * Generates synthetic media for testing tools that write to a Premiere timeline,
 * so they can be proven on a scratch project instead of a real one.
 *
 * Each clip is 12 s: a 440 Hz tone with two known silences, so the cuts that
 * remove_silence_from_sequence must make are exact:
 *
 *   tone 0-3   silence 3-6   tone 6-9   silence 9-11   tone 11-12
 *
 * Clips are made at 25 and 29.97 fps, because fractional frame rates are where
 * timecode arithmetic goes wrong. Needs ffmpeg on PATH.
 *
 *   node scripts/live-fixture.mjs [outputDir]
 *
 * Prints the files and the cuts expected with the default settings (threshold
 * -35 dB, minimum 0.5 s, padding 0.1 s). Then, in a SCRATCH project only:
 *   1. import the clips, drop each on its own sequence (match the clip's fps)
 *   2. run remove_silence_from_sequence with dryRun=true, compare to "expected"
 *   3. run it with dryRun=false; the sequence must end at the "expectedDuration"
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SILENCES = [[3, 6], [9, 11]];
const LENGTH = 12;
const PADDING = 0.1;
const VARIANTS = [
  { name: 'speech-25fps', fps: '25' },
  { name: 'speech-29.97fps', fps: '30000/1001' },
];

const outDir = resolve(process.argv[2] ?? join(tmpdir(), 'premiere-mcp-fixtures'));
mkdirSync(outDir, { recursive: true });

const mute = SILENCES.map(([a, b]) => `between(t,${a},${b})`).join('+');
const files = [];

for (const { name, fps } of VARIANTS) {
  const file = join(outDir, `${name}.mp4`);
  const run = spawnSync(
    'ffmpeg',
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=${fps}:duration=${LENGTH}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${LENGTH}`,
      '-af', `volume=enable='${mute}':volume=0`,
      '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
    ],
    { encoding: 'utf8' },
  );
  if (run.error?.code === 'ENOENT') {
    console.error('ffmpeg was not found on PATH. Install it first (winget install Gyan.FFmpeg).');
    process.exit(1);
  }
  if (run.status !== 0) {
    console.error(`ffmpeg failed for ${name}:\n${run.stderr}`);
    process.exit(1);
  }
  files.push({ name, file, fps });
}

const expectedCuts = SILENCES.map(([a, b]) => ({ start: a + PADDING, end: b - PADDING }));
const removed = expectedCuts.reduce((sum, c) => sum + (c.end - c.start), 0);
console.log(JSON.stringify({
  outputDir: outDir,
  files,
  expectedCuts,
  expectedRemovedSeconds: Math.round(removed * 1000) / 1000,
  expectedDuration: Math.round((LENGTH - removed) * 1000) / 1000,
  note: 'Cut edges snap inward to the frame grid, so allow one frame of difference.',
}, null, 2));
