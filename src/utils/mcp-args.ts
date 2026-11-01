/**
 * Agents and MCP clients often send snake_case keys and stringify numbers.
 * Canonicalize those before Zod so the call reaches Premiere instead of dying
 * as a ~12ms validation error.
 *
 * ID-like strings that happen to be numeric are left alone — clip and sequence
 * GUIDs must stay strings.
 */

const ARG_ALIASES: Record<string, string> = {
  clip_id: 'clipId',
  clip_id1: 'clipId1',
  clip_id2: 'clipId2',
  sequence_id: 'sequenceId',
  project_item_id: 'projectItemId',
  item_id: 'projectItemId',
  itemId: 'projectItemId',
  target_bin_id: 'targetBinId',
  bin_id: 'targetBinId',
  transition_name: 'transitionName',
  effect_name: 'effectName',
  component_name: 'componentName',
  param_name: 'paramName',
  property_name: 'propertyName',
  track_index: 'trackIndex',
  new_time: 'newTime',
  split_time: 'splitTime',
  start_time: 'startTime',
  end_time: 'endTime',
  in_point: 'inPoint',
  out_point: 'outPoint',
  new_name: 'newName',
  output_path: 'outputPath',
  media_path: 'mediaPath',
  mogrt_path: 'mogrtPath',
  preset_path: 'presetPath',
  lut_path: 'lutPath',
  color_index: 'colorIndex',
  delete_mode: 'deleteMode',
  insert_mode: 'insertMode',
  source_clip_id: 'sourceClipId',
  target_clip_id: 'targetClipId',
  project_item_ids: 'projectItemIds',
  item_ids: 'projectItemIds',
  clip_ids: 'clipIds',
};

const NUMERIC_ARG_KEYS = new Set([
  'duration',
  'time',
  'trackIndex',
  'newTime',
  'splitTime',
  'speed',
  'value',
  'inPoint',
  'outPoint',
  'startTime',
  'endTime',
  'colorIndex',
  'left',
  'right',
  'top',
  'bottom',
  'edgeFeather',
  'level',
  'scale',
  'rotation',
  'opacity',
  'width',
  'height',
  'frameRate',
  'x',
  'y',
  'amount',
  'percent',
  'smoothness',
  'videoTrackIndex',
  'audioTrackIndex',
  'numerator',
  'denominator',
  'noiseThresholdDb',
  'minDurationSeconds',
  'baseDb',
  'fadeSeconds',
  'clipStartTime',
  'clipEndTime',
  'sampleRate',
  'bitsPerSample',
  'intensity',
]);

function coerceNumericString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '' || !/^-?\d+(\.\d+)?$/.test(trimmed)) return value;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : value;
}

function canonicalizeValue(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeValue(entry, key));
  }
  if (value && typeof value === 'object') {
    return canonicalizeMcpArgs(value as Record<string, unknown>);
  }
  if (key === 'format' && typeof value === 'string') {
    return value.trim().toLowerCase();
  }
  if (NUMERIC_ARG_KEYS.has(key)) return coerceNumericString(value);
  return value;
}

export function canonicalizeMcpArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const metadataValue = typeof args.key === 'string' || typeof args.field === 'string';
  for (const [rawKey, rawValue] of Object.entries(args)) {
    const lookupKey = ARG_ALIASES[rawKey] ?? rawKey;
    if (metadataValue && lookupKey === 'value') {
      out[rawKey] = rawValue;
      continue;
    }
    out[rawKey] = canonicalizeValue(rawValue, lookupKey);
  }
  for (const [rawKey, rawValue] of Object.entries(args)) {
    const canonical = ARG_ALIASES[rawKey];
    if (!canonical || out[canonical] !== undefined) continue;
    out[canonical] = canonicalizeValue(rawValue, canonical);
  }
  return out;
}

type ZodIssueLike = { code?: unknown; expected?: unknown; path?: unknown };

/**
 * Fallback for numbers and booleans the key allowlist does not know about
 * (search_tools `limit`, a nested `sourceInPoint`). Driven by the schema's own
 * verdict: a value is converted only where Zod reported that it expected a
 * number or boolean, so string fields — numeric-looking GUIDs included — are
 * never touched. Returns a converted copy, or null when nothing was coercible.
 */
export function coerceArgsFromIssues(
  args: Record<string, unknown>,
  issues: readonly ZodIssueLike[],
): Record<string, unknown> | null {
  let copy: Record<string, unknown> | null = null;
  for (const issue of issues) {
    if (issue.code !== 'invalid_type' || !Array.isArray(issue.path) || issue.path.length === 0) continue;
    const path = issue.path as Array<string | number>;
    const raw = path.reduce<unknown>(
      (node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
      copy ?? args,
    );
    let value: unknown = raw;
    if (issue.expected === 'number') value = coerceNumericString(raw);
    else if (issue.expected === 'boolean' && (raw === 'true' || raw === 'false')) value = raw === 'true';
    if (value === raw) continue;

    copy ??= structuredClone(args);
    let parent: Record<string, unknown> = copy;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    parent[path[path.length - 1]!] = value;
  }
  return copy;
}
