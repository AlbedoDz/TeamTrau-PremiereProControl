/**
 * preview_caption_style: renders one caption look to a cached PNG so the user can see it
 * before burning captions. The drawing is done by the Python sidecar (caption_preview).
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolModule } from '../context.js';
import { premiereMcpHome, runSidecar, isOutdatedSidecarError, sidecarMissingResult, sidecarOutdatedResult, sidecarPython, SidecarError } from '../../analysis/sidecar.js';
import { ASPECT_RATIOS, CAPTION_RENDERER_VERSION, CAPTION_STYLE_IDS, HEX_COLOR, resolveLook, type CaptionStyleId } from '../../analysis/caption-looks.js';

const LONG_EDGE = 960;
const DEFAULT_TEXT = 'Xin chào các bạn, hôm nay mình kể chuyện';
const ACTIVE_INDEX = 1;

/** Caption option arguments shared by the tools that burn captions. */
export const captionOptionFields = {
  captionAccent: z.string().regex(HEX_COLOR, 'captionAccent must look like #RRGGBB, for example #FFD400.').optional()
    .describe("Accent color of the active word or pill as #RRGGBB. Defaults to the style's own accent."),
  captionPosition: z.enum(['bottom', 'middle']).optional()
    .describe('Where the captions sit: bottom (default) or middle of the frame.'),
  captionSize: z.enum(['small', 'medium', 'large']).optional()
    .describe('Caption text size: small, medium (default) or large.'),
};

function frameSize(args: { aspect: keyof typeof ASPECT_RATIOS; width?: number | undefined; height?: number | undefined }): { width: number; height: number } {
  if (args.width !== undefined && args.height !== undefined) return { width: args.width, height: args.height };
  const { num, den } = ASPECT_RATIOS[args.aspect];
  return num >= den
    ? { width: LONG_EDGE, height: Math.round((LONG_EDGE * den) / num) }
    : { width: Math.round((LONG_EDGE * num) / den), height: LONG_EDGE };
}

export const captionPreviewTools: ToolModule[] = [
  {
    name: 'preview_caption_style',
    description:
      'Renders a caption style (clean, pop, karaoke, highlight, minimal) with its accent color, position and size to a PNG on a dark frame, so the look can be checked before captions are burned in. Sample text defaults to a short Vietnamese sentence with the second word active. Returns the PNG path, its size, the resolved word grouping and the layout used for the aspect ratio. Previews are cached by look. Needs the analysis sidecar.',
    inputSchema: z.object({
      style: z.enum(CAPTION_STYLE_IDS as [CaptionStyleId, ...CaptionStyleId[]]).describe('Caption style to preview.'),
      ...captionOptionFields,
      aspect: z.enum(['16:9', '9:16', '1:1', '4:5']).default('9:16').describe('Frame shape to preview (default 9:16). Ignored when width and height are given.'),
      width: z.number().int().min(100).max(4096).optional().describe('Frame width in pixels. Give it together with height.'),
      height: z.number().int().min(100).max(4096).optional().describe('Frame height in pixels. Give it together with width.'),
      text: z.string().min(1).max(200).optional().describe('Sample text to draw. Defaults to a short Vietnamese sentence.'),
    }),
    run: async (_ctx, args) => {
      if ((args.width === undefined) !== (args.height === undefined)) {
        return { success: false, error: 'Give width and height together, or neither.' };
      }
      if (!(await sidecarPython())) return sidecarMissingResult('preview_caption_style');
      try {
        const { width, height } = frameSize(args);
        const text: string = args.text ?? DEFAULT_TEXT;
        const { look, grouping, layout } = resolveLook(
          {
            style: args.style,
            ...(args.captionAccent ? { accent: args.captionAccent } : {}),
            ...(args.captionPosition ? { position: args.captionPosition } : {}),
            ...(args.captionSize ? { size: args.captionSize } : {}),
          },
          width,
          height,
        );
        const key = createHash('sha1').update(JSON.stringify({ look, width, height, text, grouping })).digest('hex');
        // The renderer version is part of the location, so a newer renderer never reuses an older picture.
        const dir = join(premiereMcpHome(), 'renders', 'previews', `v${CAPTION_RENDERER_VERSION}`);
        const outPath = join(dir, `${key}.png`);
        if (!existsSync(outPath)) {
          await mkdir(dir, { recursive: true });
          const drawn = await runSidecar<{ renderer?: number }>('caption_preview', {
            look, width, height, text,
            maxWords: grouping.maxWords, maxChars: grouping.maxChars,
            activeIndex: ACTIVE_INDEX, outPath,
          });
          if (typeof drawn?.renderer !== 'number' || drawn.renderer < CAPTION_RENDERER_VERSION) {
            return sidecarOutdatedResult('preview_caption_style');
          }
        }
        return { success: true, path: outPath, width, height, grouping, layout };
      } catch (error) {
        if (isOutdatedSidecarError(error)) return sidecarOutdatedResult('preview_caption_style');
        if (error instanceof SidecarError && /not installed/i.test(error.message)) return sidecarMissingResult('preview_caption_style');
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  },
];
