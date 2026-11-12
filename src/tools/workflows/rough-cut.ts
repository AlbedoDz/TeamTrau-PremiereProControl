/**
 * workflow_rough_cut: footage folder to a rough cut on a NEW empty sequence (a settings-keeping
 * copy of the source with its contents cleared). With music the cut follows the beats
 * (assemble_beat_cut); without, clips are scored and assembled to a target length. The source
 * sequence is only a template and is never changed.
 */
import type { ToolContext } from '../context.js';
import { isError, type SequenceSnapshot } from '../domains/cleanup.js';
import { autoDuckMusic, ensureBackup } from '../domains/editing.js';
import { assembleBeatCut } from '../domains/music.js';
import { assembleRoughCut, scoreClips } from '../domains/roughcut.js';
import { duplicateSequence } from '../domains/sequence.js';
import { failure, resolveSource, runSteps, uniqueSequenceName, type WorkflowResult, type WorkflowStep } from './steps.js';

export interface RoughCutArgs {
  sequenceId?: string | undefined;
  name?: string | undefined;
  folderPath: string;
  targetSec?: number | undefined;
  musicPath?: string | undefined;
  pace: 'calm' | 'balanced' | 'energetic';
  shotSeconds?: number | undefined;
  hasVoiceover: boolean;
  dryRun: boolean;
  backup: boolean;
}

const SHOT_SECONDS_BY_PACE = { calm: 4, balanced: 3, energetic: 2 } as const;
const MUSIC_TRACK = 1;
const DIALOGUE_TRACK = 0;

const folderName = (folderPath: string): string => {
  const parts = folderPath.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? 'footage';
};

export async function workflowRoughCut(ctx: ToolContext, args: RoughCutArgs): Promise<WorkflowResult> {
  const warnings: string[] = [];
  const summary: Record<string, unknown> = {};
  const shotSeconds = args.shotSeconds ?? SHOT_SECONDS_BY_PACE[args.pace];
  let targetId = args.sequenceId;
  let template: SequenceSnapshot | undefined;

  const create: WorkflowStep = {
    label: 'Tạo sequence mới',
    run: async () => {
      const backup = await ensureBackup(ctx, args.backup);
      if ('failure' in backup) return failure(backup.failure);
      if (backup.path) summary.backupPath = backup.path;
      const name = await uniqueSequenceName(ctx, args.name ?? `${folderName(args.folderPath)} - rough cut`);
      const copy: any = await duplicateSequence(ctx, template!.sequenceId, name, true);
      if (!copy || copy.success === false || !copy.newSequenceId) return failure(copy?.error ?? 'Không tạo được sequence mới.');
      targetId = String(copy.newSequenceId);
      summary.outputName = name;
      return { ok: true, detail: { sequenceId: targetId, name, template: template!.sequenceName }, createdSequenceId: targetId };
    },
  };

  const score: WorkflowStep = {
    label: 'Chấm điểm footage',
    run: async () => {
      const scored: any = await scoreClips(ctx, {
        folderPath: args.folderPath,
        recursive: false,
        windowSeconds: shotSeconds,
        topPerFile: 3,
      });
      if (!scored || scored.success === false) return failure(scored?.error ?? 'Không chấm điểm được footage.');
      if (Array.isArray(scored.failed) && scored.failed.length > 0) warnings.push(`Bỏ qua ${scored.failed.length} file không đọc được khi chấm điểm.`);
      summary.scoredFiles = scored.scored;
      return { ok: true, detail: { checked: scored.checked, scored: scored.scored } };
    },
  };

  const assemble: WorkflowStep = {
    label: args.musicPath ? 'Dựng theo nhịp nhạc' : 'Dựng rough cut',
    run: async () => {
      const placed: any = args.musicPath
        ? await assembleBeatCut(ctx, {
            musicPath: args.musicPath,
            folderPath: args.folderPath,
            recursive: false,
            preset: args.pace,
            beatsPerBar: 4,
            ...(args.targetSec !== undefined ? { durationSeconds: args.targetSec } : {}),
            ...(targetId ? { sequenceId: targetId } : {}),
            videoTrackIndex: 0,
            musicAudioTrackIndex: MUSIC_TRACK,
            addMusic: true,
            startTime: 0,
            // Footage audio stays on track 0 only when there is speech to duck the music under.
            linkAudio: args.hasVoiceover,
            // A dry run plans against the template (the source sequence), whose clips would
            // trip the occupancy check; the real run places onto the empty copy. Dry runs
            // return before placing anything, so allowing overwrite there changes nothing.
            overwrite: args.dryRun,
            dryRun: args.dryRun,
            backup: false,
          })
        : await assembleRoughCut(ctx, {
            folderPath: args.folderPath,
            recursive: false,
            targetSeconds: args.targetSec!,
            shotSeconds,
            maxPerFile: 2,
            order: 'chronological',
            ...(targetId ? { sequenceId: targetId } : {}),
            videoTrackIndex: 0,
            startTime: 0,
            linkAudio: true,
            // A dry run plans against the template (the source sequence), whose clips would
            // trip the occupancy check; the real run places onto the empty copy. Dry runs
            // return before placing anything, so allowing overwrite there changes nothing.
            overwrite: args.dryRun,
            dryRun: args.dryRun,
            backup: false,
          });
      if (!placed || placed.success === false) return failure(placed?.error ?? 'Không dựng được rough cut.');
      for (const w of [placed.warning, placed.verificationWarning]) if (typeof w === 'string') warnings.push(w);
      summary.shotCount = placed.shotCount;
      summary.shots = placed.shots;
      if (placed.totalSeconds !== undefined) summary.totalSeconds = placed.totalSeconds;
      if (placed.cutSeconds !== undefined) summary.totalSeconds = placed.cutSeconds;
      if (placed.bpm !== undefined) summary.bpm = placed.bpm;
      if (placed.shortfallSeconds) warnings.push(`Footage chỉ đủ dựng thiếu ${placed.shortfallSeconds} giây so với mục tiêu.`);
      if (!args.dryRun) summary.verified = placed.verified;
      if (!args.dryRun && placed.verified === false) warnings.push('Không xác nhận được độ dài rough cut sau khi dựng.');
      // The rough cut is built; ducking the music afterwards is optional polish.
      return {
        ok: true,
        detail: { shotCount: placed.shotCount, verified: placed.verified },
        ...(!args.dryRun && targetId ? { createdSequenceId: targetId, complete: true } : {}),
      };
    },
  };

  const duck: WorkflowStep = {
    label: 'Hạ nhạc khi có thoại',
    run: async () => {
      const ducked: any = await autoDuckMusic(ctx, {
        sequenceId: targetId!,
        dialogueTrackIndices: [DIALOGUE_TRACK],
        musicTrackIndices: [MUSIC_TRACK],
        baseDb: -12,
        duckedDb: -24,
        fadeSeconds: 0.3,
        silenceDb: -40,
        minPauseSeconds: 0.3,
        mergeGapSeconds: 0.6,
        minSpeechSeconds: 0.3,
        dryRun: false,
        backup: false,
      });
      // The cut itself is done; a ducking failure is reported, not fatal.
      if (!ducked || ducked.success === false) {
        warnings.push(`Chưa hạ được nhạc dưới thoại: ${ducked?.error ?? 'lỗi không rõ'}`);
        return { ok: true, detail: { ducked: false } };
      }
      summary.ducked = true;
      return { ok: true, detail: { ducked: true } };
    },
  };

  const validate: WorkflowStep = {
    label: 'Kiểm tra tham số',
    run: async () => {
      if (!args.musicPath && args.targetSec === undefined) return failure('Cần targetSec (thời lượng mong muốn) khi không có musicPath.');
      if (args.hasVoiceover && !args.musicPath) warnings.push('hasVoiceover chỉ có tác dụng khi có musicPath (không có nhạc để hạ).');
      // The template is resolved once; a dry run plans against it, a real run copies it.
      const source = await resolveSource(ctx, args);
      if (isError(source)) return failure(source.error);
      template = source;
      targetId = source.sequenceId;
      return { ok: true };
    },
  };

  const cutSteps = [assemble, ...(args.hasVoiceover && args.musicPath ? [duck] : [])];
  const steps: WorkflowStep[] = args.dryRun
    ? [validate, ...(args.musicPath ? [] : [score]), assemble]
    : [validate, create, ...(args.musicPath ? [] : [score]), ...cutSteps];
  const result = await runSteps(ctx, steps);
  result.summary = { ...summary, shotSeconds, ...(args.dryRun ? { dryRun: true } : {}) };
  result.warnings = [...new Set([...warnings, ...result.warnings])];
  return result;
}
