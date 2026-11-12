/**
 * Caption looks: the five burned-in caption styles, the per-aspect layout table,
 * and the resolver that turns (style, options, frame size) into concrete pixels.
 * Pure data and arithmetic, no I/O. The Python renderer receives the resolved look.
 */

export type CaptionStyleId = 'clean' | 'pop' | 'karaoke' | 'highlight' | 'minimal';
export const CAPTION_STYLE_IDS: readonly CaptionStyleId[] = ['clean', 'pop', 'karaoke', 'highlight', 'minimal'];

export type CaptionPosition = 'bottom' | 'middle';
export type CaptionSize = 'small' | 'medium' | 'large';

export interface CaptionOptions {
  style: CaptionStyleId;
  accent?: string;
  position?: CaptionPosition;
  size?: CaptionSize;
}

export const ACCENT_SWATCHES: readonly string[] = ['#FFD400', '#FF3B5C', '#22D3EE', '#4ADE80', '#A855F7'];
export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export const ASPECT_RATIOS: Record<'16:9' | '9:16' | '1:1' | '4:5', { num: number; den: number }> = {
  '16:9': { num: 16, den: 9 },
  '9:16': { num: 9, den: 16 },
  '1:1': { num: 1, den: 1 },
  '4:5': { num: 4, den: 5 },
};

export interface CaptionLayout {
  id: '9:16' | '4:5' | '1:1' | '5:4' | '16:9';
  ratio: number;
  fontPct: number;
  maxWords: number;
  maxChars: number;
  minimalWords: number;
  minimalChars: number;
  srtChars: number;
  srtLines: number;
  safeArea: { top: number; bottom: number; side: number };
}

export const CAPTION_LAYOUTS: readonly CaptionLayout[] = [
  { id: '9:16', ratio: 0.5625, fontPct: 0.0375, maxWords: 3, maxChars: 18, minimalWords: 6, minimalChars: 32, srtChars: 22, srtLines: 2,
    safeArea: { top: 250 / 1920, bottom: 350 / 1920, side: 80 / 1080 } },
  { id: '4:5', ratio: 0.8, fontPct: 0.04, maxWords: 4, maxChars: 22, minimalWords: 7, minimalChars: 36, srtChars: 28, srtLines: 2,
    safeArea: { top: 0.10, bottom: 0.12, side: 0.06 } },
  { id: '1:1', ratio: 1.0, fontPct: 0.042, maxWords: 4, maxChars: 24, minimalWords: 7, minimalChars: 40, srtChars: 30, srtLines: 2,
    safeArea: { top: 0.10, bottom: 0.12, side: 0.06 } },
  { id: '5:4', ratio: 1.29, fontPct: 0.045, maxWords: 5, maxChars: 28, minimalWords: 8, minimalChars: 46, srtChars: 37, srtLines: 2,
    safeArea: { top: 0.08, bottom: 0.08, side: 0.05 } },
  { id: '16:9', ratio: 1.78, fontPct: 0.05, maxWords: 5, maxChars: 32, minimalWords: 14, minimalChars: 84, srtChars: 42, srtLines: 2,
    safeArea: { top: 0.08, bottom: 0.08, side: 0.05 } },
];

function checkSize(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Caption frame size must be positive, got ${width}x${height}.`);
  }
}

/** The table row whose width/height ratio is closest to the frame's, compared on a log scale. */
export function layoutFor(width: number, height: number): CaptionLayout {
  checkSize(width, height);
  const target = Math.log(width / height);
  let best = CAPTION_LAYOUTS[0] as CaptionLayout;
  let bestDist = Infinity;
  for (const row of CAPTION_LAYOUTS) {
    const d = Math.abs(Math.log(row.ratio) - target);
    if (d < bestDist) { best = row; bestDist = d; }
  }
  return best;
}

/** Round half to even, like Python's round(); a tiny epsilon absorbs float noise on exact .5 values. */
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

export interface CaptionLook {
  font: string;
  sizePx: number;
  uppercase: boolean;
  textColor: string;
  accentColor: string;
  stroke: { widthPx: number; color: string } | null;
  shadow: { dxPx: number; dyPx: number; blurPx: number; color: string } | null;
  active: 'color' | 'pop' | 'pill' | 'none';
  pill: { padXPx: number; padYPx: number; radiusPx: number } | null;
  position: CaptionPosition;
  safeArea: { top: number; bottom: number; side: number };
  bottomGapPx: number;
}

interface StyleDef {
  font: string;
  uppercase: boolean;
  accent: string;
  active: CaptionLook['active'];
  styleScale: number;
  /** Stroke width: fixed pixels or a fraction of the font size; null = no stroke. */
  stroke: { px: number } | { em: number } | null;
  shadow: boolean;
  pill: boolean;
  minimalGrouping: boolean;
}

const BOLD = 'BeVietnamPro-Bold.ttf';
const CAPTION_STYLES: Record<CaptionStyleId, StyleDef> = {
  clean: { font: BOLD, uppercase: false, accent: '#FFD400', active: 'color', styleScale: 1, stroke: { px: 6 }, shadow: false, pill: false, minimalGrouping: false },
  pop: { font: BOLD, uppercase: true, accent: '#FFD400', active: 'pop', styleScale: 1, stroke: { px: 6 }, shadow: false, pill: false, minimalGrouping: false },
  karaoke: { font: BOLD, uppercase: false, accent: '#FFD400', active: 'color', styleScale: 1, stroke: { px: 6 }, shadow: false, pill: false, minimalGrouping: false },
  highlight: { font: 'BeVietnamPro-ExtraBold.ttf', uppercase: false, accent: '#FF3B5C', active: 'pill', styleScale: 1, stroke: { em: 0.04 }, shadow: false, pill: true, minimalGrouping: false },
  minimal: { font: BOLD, uppercase: false, accent: '#FFD400', active: 'none', styleScale: 0.85, stroke: null, shadow: true, pill: false, minimalGrouping: true },
};

const SIZE_SCALE: Record<CaptionSize, number> = { small: 0.85, medium: 1, large: 1.2 };

export function resolveLook(
  opts: CaptionOptions,
  width: number,
  height: number,
): { look: CaptionLook; grouping: { maxWords: number; maxChars: number }; layout: CaptionLayout['id'] } {
  checkSize(width, height);
  if (!Object.prototype.hasOwnProperty.call(CAPTION_STYLES, opts.style)) {
    throw new Error(`Unknown caption style "${String(opts.style)}". Use one of: ${CAPTION_STYLE_IDS.join(', ')}.`);
  }
  const def = CAPTION_STYLES[opts.style];
  if (opts.accent !== undefined && !HEX_COLOR.test(opts.accent)) {
    throw new Error(`Caption accent must look like #RRGGBB, got "${opts.accent}".`);
  }
  const size = opts.size ?? 'medium';
  if (!Object.prototype.hasOwnProperty.call(SIZE_SCALE, size)) {
    throw new Error(`Unknown caption size "${String(size)}". Use small, medium or large.`);
  }
  const sizeScale = SIZE_SCALE[size];
  const position = opts.position ?? 'bottom';
  if (position !== 'bottom' && position !== 'middle') {
    throw new Error(`Unknown caption position "${String(position)}". Use bottom or middle.`);
  }

  const layout = layoutFor(width, height);
  const sizePx = roundHalfEven(height * layout.fontPct * def.styleScale * sizeScale);
  const em = (k: number): number => roundHalfEven(k * sizePx);

  const look: CaptionLook = {
    font: def.font,
    sizePx,
    uppercase: def.uppercase,
    textColor: '#FFFFFF',
    accentColor: (opts.accent ?? def.accent).toUpperCase(),
    stroke: def.stroke === null ? null : { widthPx: 'px' in def.stroke ? def.stroke.px : em(def.stroke.em), color: '#000000' },
    shadow: def.shadow ? { dxPx: em(0.06), dyPx: em(0.06), blurPx: em(0.12), color: '#000000B3' } : null,
    active: def.active,
    pill: def.pill ? { padXPx: em(0.18), padYPx: em(0.08), radiusPx: em(0.22) } : null,
    position,
    safeArea: { ...layout.safeArea },
    bottomGapPx: roundHalfEven((height * 40) / 1920),
  };

  const baseChars = def.minimalGrouping ? layout.minimalChars : layout.maxChars;
  const grouping = {
    maxWords: def.minimalGrouping ? layout.minimalWords : layout.maxWords,
    maxChars: Math.floor(baseChars / sizeScale + 1e-9),
  };
  return { look, grouping, layout: layout.id };
}

/** SRT line limits for the frame: characters per line and number of lines. */
export function subtitleLineLimits(
  width: number,
  height: number,
): { maxCharsPerLine: number; maxLines: number; layout: CaptionLayout['id'] } {
  const row = layoutFor(width, height);
  return { maxCharsPerLine: row.srtChars, maxLines: row.srtLines, layout: row.id };
}
