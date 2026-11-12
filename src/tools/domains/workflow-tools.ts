/** The workflow_* tools: one-call pipelines shared by MCP agents and the panel. */
import { z } from 'zod';
import type { ToolModule } from '../context.js';
import { ENGINE_IDS } from '../../analysis/asr-engines.js';
import { workflowCleanVoiceover } from '../workflows/clean-voiceover.js';
import { workflowSubtitles } from '../workflows/subtitles.js';
import { workflowRecap } from '../workflows/recap.js';
import { workflowShorts } from '../workflows/shorts.js';
import { workflowRoughCut } from '../workflows/rough-cut.js';

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
  {
    name: 'workflow_recap',
    description:
      'One-call recap. Plans the recap (speech mode when the dialogue covers at least 30% of the sequence, otherwise shots; waits for the background transcription), then builds it as a new sequence "<name> - recap" with build_recap (30 ms crossfades, optional 9:16 Auto Reframe and captions, loudness -14, qa_sequence and readback). The source sequence is never changed. dryRun=true only returns the planned segments and creates nothing. Reports per-step progress and can be cancelled. Needs ffmpeg and, for speech mode, the analysis sidecar.',
    inputSchema: z.object({
      sequenceId: sequenceIdArg,
      name: z.string().min(1).optional().describe('Name of the recap sequence. Default "<source name> - recap"; " (2)" is added when the name is taken.'),
      dialogueTrackIndices: dialogueArg,
      glossary: glossaryArg,
      engine: engineArg,
      targetSec: z.number().positive().default(90).describe('Length of the recap in seconds (default 90).'),
      aspect: z.enum(['16:9', '9:16']).default('16:9').describe('"9:16" reframes the recap to vertical with Auto Reframe (default "16:9").'),
      captionStyle: z.enum(['none', 'clean', 'pop', 'karaoke']).default('none').describe('Burned-in captions from the transcript (default none).'),
      audioLeadSec: z.number().min(0).max(2).default(0).describe('J-cut lead in seconds: the next segment\'s audio starts this much before its picture (default 0 = straight cuts).'),
      dryRun: z.boolean().default(false).describe('Only plan and return the segments; create and change nothing.'),
      backup: backupArg,
    }),
    run: (ctx, args) => workflowRecap(ctx, args),
  },
  {
    name: 'workflow_shorts',
    description:
      'One-call vertical shorts. Waits for the transcript, finds highlight windows, takes the count best that do not overlap in time and builds one 9:16 short from each as a new sequence "<source name> - short N" (Auto Reframe, captions, loudness -14, qa_sequence). If a later short fails the earlier ones are kept. The source sequence is never changed. dryRun=true returns the chosen windows and builds nothing. Reports per-step progress and can be cancelled. Needs the analysis sidecar and ffmpeg.',
    inputSchema: z.object({
      sequenceId: sequenceIdArg,
      dialogueTrackIndices: dialogueArg,
      glossary: glossaryArg,
      engine: engineArg,
      count: z.number().int().min(1).max(5).default(3).describe('How many shorts to build, 1-5 (default 3).'),
      minSec: z.number().positive().default(30).describe('Shortest short in seconds (default 30).'),
      maxSec: z.number().positive().default(60).describe('Longest short in seconds (default 60).'),
      captionStyle: z.enum(['clean', 'pop', 'karaoke']).default('clean').describe('Caption look (default clean).'),
      dryRun: z.boolean().default(false).describe('Only choose the windows; create and change nothing.'),
      backup: backupArg,
    }),
    run: (ctx, args) => workflowShorts(ctx, args),
  },
  {
    name: 'workflow_rough_cut',
    description:
      'One-call rough cut from a folder of footage onto a NEW empty sequence "<folder name> - rough cut" (a copy of the given or active sequence with its contents cleared, so frame rate and size carry over; that sequence is never changed). Without musicPath: score_clips then assemble_rough_cut to targetSec, with shot length from shotSeconds or pace (calm 4, balanced 3, energetic 2). With musicPath: assemble_beat_cut cut to the beat, pace picks the preset. hasVoiceover=true adds auto_duck_music (music track 2 ducked under audio track 1). dryRun=true reports the planned shots and creates nothing. Reports per-step progress and can be cancelled. Needs ffmpeg.',
    inputSchema: z.object({
      sequenceId: z.string().optional().describe('Sequence to copy settings from. Defaults to the active sequence.'),
      name: z.string().min(1).optional().describe('Name of the new sequence. Default "<folder name> - rough cut"; " (2)" is added when the name is taken.'),
      folderPath: z.string().min(1).describe('Folder of video files to choose from.'),
      targetSec: z.number().positive().optional().describe('Length of the cut in seconds. Required without musicPath; with music it limits how much of the song is cut (default the whole song).'),
      musicPath: z.string().optional().describe('Absolute path to a music file; the cut follows its beats.'),
      pace: z.enum(['calm', 'balanced', 'energetic']).default('balanced').describe('How fast the cut is (default balanced).'),
      shotSeconds: z.number().positive().optional().describe('Typical shot length without music. Overrides the pace default (calm 4, balanced 3, energetic 2).'),
      hasVoiceover: z.boolean().default(false).describe('A voice-over will sit on audio track 1: duck the music under it (needs musicPath) (default false).'),
      dryRun: z.boolean().default(false).describe('Only report the planned shots; create and change nothing.'),
      backup: backupArg,
    }),
    run: (ctx, args) => workflowRoughCut(ctx, args),
  },
];
