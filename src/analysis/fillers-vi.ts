/**
 * Vietnamese filler lexicon in three tiers (spec 5.2).
 *
 *  - A: hesitation sounds. Cut when they stand alone.
 *  - B: stalling phrases. Cut only with a pause right after, or when repeated.
 *  - C: negations, politeness and modal particles, connectives and dialect
 *       words. NEVER cut; they carry meaning ("chẳng", "ạ"). Used only to count
 *       fluency and to stop A/B matching inside them.
 *
 * Each phrase belongs to exactly one tier (A over B over C). The user can
 * override a whole tier in `<PREMIERE_MCP_HOME>/fillers-vi.json`.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { premiereMcpHome } from './sidecar.js';

export interface FillerTiers {
  A: string[];
  B: string[];
  C: string[];
}

export type FillerLexicon = FillerTiers & {
  /** Set when the user's override file was unreadable or partly invalid. */
  warning?: string;
};

export const DEFAULT_FILLER_LEXICON: FillerTiers = {
  A: ['à', 'ờ', 'ừm', 'ơ', 'ư', 'hừm', 'ừm hứm', 'ờ thì', 'à mà'],
  B: [
    'kiểu', 'kiểu như', 'kiểu như là', 'cái kiểu', 'dạng như', 'đại loại là', 'đại khái là',
    'nói chung là', 'nôm na là', 'tạm gọi là', 'thực ra thì', 'thật ra là', 'với lại', 'xong rồi',
    'cái gì nhỉ', 'cái đó đó', 'cái kia kìa', 'làm sao nhỉ', 'thế nào nhỉ', 'nói sao ta',
  ],
  C: [
    'á', 'ối', 'gọi là', 'nhìn chung là', 'tóm lại là', 'tức là', 'nghĩa là', 'ý là',
    'có nghĩa là', 'vấn đề là', 'cái chính là', 'thì', 'mà', 'là', 'sau đó thì', 'tiếp theo là',
    'bên cạnh đó', 'ngoài ra thì', 'căn bản là', 'cơ bản là', 'vốn dĩ là', 'cái thứ', 'nhé', 'nhỉ',
    'nha', 'nhé nha', 'nhé nhé', 'nhá', 'nhé cơ', 'nhé thôi', 'nhé ạ', 'đấy', 'đấy nhé', 'đấy nhỉ',
    'đấy chứ', 'chứ', 'chứ lị', 'chứ còn gì nữa', 'phải không', 'đúng không', 'ha', 'hả', 'hử',
    'hứ', 'thế à', 'vậy à', 'thế hả', 'vậy hả', 'cơ', 'cơ mà', 'cơ đấy', 'cơ chứ', 'mà lị', 'luôn',
    'luôn ấy', 'thật', 'thật đấy', 'thật sự', 'quả thật', 'đúng là', 'rõ ràng là', 'chắc chắn là',
    'chả', 'chẳng', 'đâu', 'đâu có', 'nào', 'sao', 'ôi', 'trời ơi', 'chao ôi', 'chà', 'ái chà',
    'ủa', 'ơ kìa', 'kìa', 'này', 'nè', 'ơi', 'hỡi', 'thôi', 'thôi nào', 'thôi mà', 'đi', 'đi mà',
    'đi thôi', 'ạ', 'vâng', 'dạ', 'vâng ạ', 'dạ vâng', 'thưa', 'kính thưa', 'xin', 'xin phép',
    'đâu mà', 'thế cơ à', 'vậy cơ à', 'bảo này', 'này nhé', 'nhưng mà', 'thành ra', 'đâm ra',
    'khéo mà', 'hè', 'hỉ', 'rứa', 'rứa à', 'rứa hả', 'rứa tê', 'mô', 'tê', 'răng', 'răng rứa',
    'chi', 'chi mô', 'à cơ', 'nhé mô', 'chừ', 'chừ thì', 'thành thử', 'bởi rứa', 'tại rứa',
    'mần răng', 'mần chi', 'heng', 'nghen', 'hén', 'hổng', 'hông', 'vậy ta', 'sao ta', 'đó',
    'đó nha', 'đó nghen', 'luôn á', 'dữ vậy', 'dữ thần', 'thiệt tình', 'trời đất ơi', 'bởi vậy',
    'thành thử ra', 'tự nhiên', 'cái tự nhiên', 'xong cái', 'rồi cái', 'hồi đó', 'bữa hổm',
    'coi bộ', 'bộ', 'ngộ ha',
  ],
};

const TIERS = ['A', 'B', 'C'] as const;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Loads the lexicon, overriding each tier present in the user's file. A missing
 * file gives the defaults; a corrupt one gives the defaults plus a `warning`.
 */
export async function loadFillerLexicon(home: string = premiereMcpHome()): Promise<FillerLexicon> {
  const defaults: FillerLexicon = {
    A: [...DEFAULT_FILLER_LEXICON.A],
    B: [...DEFAULT_FILLER_LEXICON.B],
    C: [...DEFAULT_FILLER_LEXICON.C],
  };
  const file = join(home, 'fillers-vi.json');
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaults;
    return { ...defaults, warning: `Không đọc được ${file}, dùng từ điển mặc định.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return { ...defaults, warning: `File ${file} không phải JSON hợp lệ, dùng từ điển mặc định.` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...defaults, warning: `File ${file} phải là object dạng {A, B, C}, dùng từ điển mặc định.` };
  }
  const result = defaults;
  const bad: string[] = [];
  for (const tier of TIERS) {
    const value = (parsed as Record<string, unknown>)[tier];
    if (value === undefined) continue;
    if (isStringArray(value)) result[tier] = [...value];
    else bad.push(tier);
  }
  if (bad.length > 0) {
    result.warning = `Tầng ${bad.join(', ')} trong ${file} phải là mảng chuỗi, dùng mặc định cho tầng đó.`;
  }
  return result;
}
