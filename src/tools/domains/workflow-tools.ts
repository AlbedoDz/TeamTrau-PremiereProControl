/** The workflow_* tools: one-call pipelines shared by MCP agents and the panel. */
import { z } from 'zod';
import type { ToolModule } from '../context.js';
import { ENGINE_IDS } from '../../analysis/asr-engines.js';
import { workflowCleanVoiceover } from '../workflows/clean-voiceover.js';
import { workflowSubtitles } from '../workflows/subtitles.js';

const sequenceIdArg = z.string().optional().describe('Sequence ID. Defaults to the active sequence.');
const dialogueArg = z.array(z.number().int().min(0)).optional().describe('Audio track indices that carry speech. Defaults to every audio track that has a clip with a media file.');
const glossaryArg = z.array(z.string()).optional().describe('Names and terms to bias speech recognition toward.');
const engineArg = z.enum(ENGINE_IDS).optional().describe('Speech engine. Defaults to the configured engine.');
const backupArg = z.boolean().default(true).describe('Save the project and copy it to a premiere-mcp-backups folder before changing anything (default true). Ignored on a dry run.');

export const workflowToolsTools: ToolModule[] = [
  {
    name: 'workflow_clean_voiceover',
    description:
      'One-call voice-over cleanup. Measures silences, filler words and retakes on the source sequence (waiting for the background transcription if it is still running), copies the sequence as "<name> - clean", cuts all of them with a single remove_ranges call on the copy, applies the dialogue chain (DeNoise, Dynamics) with loudness normalisation, then runs qa_sequence. The source sequence is never changed. dryRun=true only analyses and returns the planned cuts. Reports per-step progress and can be cancelled. Needs ffmpeg and the analysis sidecar.',
    inputSchema: z.object({
      sequenceId: sequenceIdArg,
      name: z.string().min(1).optional().describe('Name of the cleaned sequence. Default "<source name> - clean"; " (2)" is added when the name is taken.'),
      dialogueTrackIndices: dialogueArg,
      glossary: glossaryArg,
      engine: engineArg,
      cutSilence: z.boolean().default(true).describe('Cut silences (-35 dB, at least 0.5 s) (default true).'),
      cutFillers: z.boolean().default(true).describe('Cut filler words (default true).'),
      fillerTiers: z.array(z.enum(['A', 'B'])).optional().describe('Filler tiers to cut. Default ["A"] when the sequence has a video clip, otherwise ["A","B"].'),
      cutRetakes: z.boolean().default(true).describe('Cut sentences the speaker restarts (default true).'),
      dialogueChain: z.boolean().default(true).describe('Apply DeNoise + Dynamics and normalise loudness (default true).'),
      targetLufs: z.number().min(-60).max(0).default(-16).describe('Target integrated loudness (default -16).'),
      crossfadeMs: z.number().min(0).max(1000).default(30).describe('Audio crossfade at each join in ms (default 30).'),
      dryRun: z.boolean().default(false).describe('Only analyse and return the plan; create and change nothing.'),
      backup: backupArg,
    }),
    run: (ctx, args) => workflowCleanVoiceover(ctx, args),
  },
  {
    name: 'workflow_subtitles',
    description:
      'One-call subtitles. Waits for the transcript (transcribe_sequence in the background), builds readable cues and writes a UTF-8 SRT file. With output="caption_track" it also copies the sequence as "<name> - phụ đề", imports the SRT and creates a caption track on the copy; the source sequence is never changed. dryRun=true returns the cue count and a preview and writes nothing. Reports per-step progress and can be cancelled. Needs the analysis sidecar.',
    inputSchema: z.object({
      sequenceId: sequenceIdArg,
      name: z.string().min(1).optional().describe('Name of the copy that gets the caption track. Default "<source name> - phụ đề".'),
      dialogueTrackIndices: dialogueArg,
      glossary: glossaryArg,
      engine: engineArg,
      output: z.enum(['srt', 'caption_track']).default('srt').describe('"srt" writes the file only; "caption_track" also adds a caption track on a copy of the sequence (default "srt").'),
      maxCharsPerLine: z.number().int().min(10).default(42).describe('Maximum characters per caption line (default 42).'),
      outputPath: z.string().optional().describe('Where to write the .srt; must end in .srt and must not exist. Defaults to the premiere-mcp renders folder.'),
      dryRun: z.boolean().default(false).describe('Return the cue count and a preview; write and change nothing.'),
      backup: backupArg,
    }),
    run: (ctx, args) => workflowSubtitles(ctx, args),
  },
];
