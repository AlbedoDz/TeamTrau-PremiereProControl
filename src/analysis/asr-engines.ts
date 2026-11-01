/**
 * The speech engines the sidecar can run. Zipformer-68M is the default and the only one set up
 * without asking; every other engine is downloaded only after the user accepts it.
 */
export const ENGINE_IDS = ['zipformer-68m', 'zipformer-30m', 'rover', 'whisper-turbo'] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export const DEFAULT_ENGINE: EngineId = 'zipformer-68m';

/**
 * Measured on Windows (python 3.12, uv): the base requirements.txt venv is 218 MB of site-packages
 * (opencv 113 MB, sherpa-onnx 28 MB, numpy 43 MB, pillow 15 MB, ...) plus about 76 MB of models
 * (Zipformer-68M int8 incl. VAD, YuNet) = about 294 MB, shown as 300.
 */
export const DEFAULT_INSTALL_MB = 300;
/** requirements-whisper.txt (faster-whisper, ctranslate2, av and their deps): measured +183 MB. */
export const WHISPER_PACKAGES_MB = 190;

/** Size of the VAD model every zipformer engine needs. */
export const VAD_MB = 2;

export interface EngineInfo {
  id: EngineId;
  label: string;
  /** Keys of the sidecar `check` report that must all be true. */
  models: string[];
  /** Approximate model download in MB (VAD not included). */
  sizeMb: number;
  license: string;
  nonCommercial: boolean;
  /** Uses CUDA libraries (about 2 GB) when an NVIDIA GPU is present. */
  needsCuda: boolean;
}

export const ENGINES: Record<EngineId, EngineInfo> = {
  'zipformer-68m': {
    id: 'zipformer-68m', label: 'Zipformer-68M (default, CPU)', models: ['zipformer68m', 'vad', 'sherpaOnnx'],
    sizeMb: 80, license: 'Apache-2.0', nonCommercial: false, needsCuda: false,
  },
  'zipformer-30m': {
    id: 'zipformer-30m', label: 'Zipformer-30M (smaller, CPU)', models: ['zipformer30m', 'vad', 'sherpaOnnx'],
    sizeMb: 30, license: 'CC-BY-NC-ND-4.0', nonCommercial: true, needsCuda: false,
  },
  rover: {
    id: 'rover', label: 'ROVER (both Zipformers combined)', models: ['zipformer68m', 'zipformer30m', 'vad', 'sherpaOnnx'],
    sizeMb: 110, license: 'Apache-2.0 + CC-BY-NC-ND-4.0 (uses the 30M model: non-commercial)', nonCommercial: true, needsCuda: false,
  },
  'whisper-turbo': {
    id: 'whisper-turbo', label: 'Whisper large-v3-turbo (GPU recommended)', models: ['whisper', 'fasterWhisper'],
    sizeMb: 1600, license: 'MIT', nonCommercial: false, needsCuda: true,
  },
};

export const isEngineId = (value: unknown): value is EngineId =>
  typeof value === 'string' && (ENGINE_IDS as readonly string[]).includes(value);

export const usesZipformer = (id: EngineId): boolean => id !== 'whisper-turbo';

/** Download size in MB including the VAD model for zipformer engines. */
export function downloadMb(id: EngineId): number {
  return ENGINES[id].sizeMb + (usesZipformer(id) ? VAD_MB : 0);
}

export interface CheckReport {
  sherpaOnnx?: boolean;
  fasterWhisper?: boolean;
  models?: { whisper?: boolean; yunet?: boolean; zipformer68m?: boolean; zipformer30m?: boolean; vad?: boolean };
}

/** True when every model the engine needs is reported present by the sidecar check. */
export function engineInstalled(id: EngineId, report: CheckReport | undefined): boolean {
  if (!report) return false;
  const flags: Record<string, boolean | undefined> = {
    zipformer68m: report.models?.zipformer68m,
    zipformer30m: report.models?.zipformer30m,
    vad: report.models?.vad,
    sherpaOnnx: report.sherpaOnnx,
    fasterWhisper: report.fasterWhisper,
    whisper: report.models?.whisper,
  };
  return ENGINES[id].models.every((key) => flags[key] === true);
}

export function installedEngines(report: CheckReport | undefined): Record<EngineId, boolean> {
  return Object.fromEntries(ENGINE_IDS.map((id) => [id, engineInstalled(id, report)])) as Record<EngineId, boolean>;
}
