import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ENGINE, ENGINES, ENGINE_IDS, downloadMb, engineInstalled, isEngineId, usesZipformer } from '../../analysis/asr-engines.js';
import { readAsrEngine, resolveEngine, writeAsrEngine } from '../../analysis/asr-config.js';
import { restoreCasing } from '../../analysis/casing.js';

describe('engine table', () => {
  it('lists the four engines with zipformer-68m as default', () => {
    expect(ENGINE_IDS).toEqual(['zipformer-68m', 'zipformer-30m', 'rover', 'whisper-turbo']);
    expect(DEFAULT_ENGINE).toBe('zipformer-68m');
    expect(ENGINES['zipformer-30m']).toMatchObject({ license: 'CC-BY-NC-ND-4.0', nonCommercial: true, needsCuda: false });
    expect(ENGINES['rover']).toMatchObject({ nonCommercial: true });
    expect(ENGINES['zipformer-68m']).toMatchObject({ license: 'Apache-2.0', nonCommercial: false, sizeMb: 80 });
    expect(ENGINES['whisper-turbo']).toMatchObject({ license: 'MIT', sizeMb: 1600, needsCuda: true });
    expect(downloadMb('zipformer-68m')).toBe(82);
    expect(downloadMb('rover')).toBe(112);
    expect(isEngineId('rover')).toBe(true);
    expect(isEngineId('nope')).toBe(false);
    expect(usesZipformer('rover')).toBe(true);
    expect(usesZipformer('whisper-turbo')).toBe(false);
  });

  it('decides installed from the check report', () => {
    const report = { zipformer68m: true, zipformer30m: false, vad: true, sherpaOnnx: true, fasterWhisper: true, models: { whisper: false, yunet: true } };
    expect(engineInstalled('zipformer-68m', report)).toBe(true);
    expect(engineInstalled('zipformer-30m', report)).toBe(false);
    expect(engineInstalled('rover', report)).toBe(false);
    expect(engineInstalled('whisper-turbo', report)).toBe(false);
    expect(engineInstalled('zipformer-68m', { ...report, vad: false })).toBe(false);
    expect(engineInstalled('rover', { ...report, zipformer30m: true })).toBe(true);
    expect(engineInstalled('whisper-turbo', { ...report, models: { whisper: true, yunet: true } })).toBe(true);
  });
});

describe('asr config', () => {
  let home: string;
  let prev: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'asr-config-'));
    prev = process.env.PREMIERE_MCP_HOME;
    process.env.PREMIERE_MCP_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PREMIERE_MCP_HOME; else process.env.PREMIERE_MCP_HOME = prev;
  });

  it('resolves tool arg > config > default', async () => {
    expect(await resolveEngine()).toBe('zipformer-68m');
    await writeAsrEngine('whisper-turbo');
    expect(await readAsrEngine()).toBe('whisper-turbo');
    expect(await resolveEngine()).toBe('whisper-turbo');
    expect(await resolveEngine('rover')).toBe('rover');
  });

  it('ignores an unknown or corrupt config value', async () => {
    writeFileSync(join(home, 'config.json'), '{"asrEngine":"bogus"}');
    expect(await readAsrEngine()).toBeUndefined();
    expect(await resolveEngine()).toBe('zipformer-68m');
    writeFileSync(join(home, 'config.json'), 'not json');
    expect(await resolveEngine()).toBe('zipformer-68m');
  });

  it('writes atomically, keeps other keys and leaves no temp file', async () => {
    writeFileSync(join(home, 'config.json'), '{"other":1}');
    await writeAsrEngine('zipformer-30m');
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({ other: 1, asrEngine: 'zipformer-30m' });
    expect(readdirSync(home).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});

describe('restoreCasing', () => {
  const w = (text: string, segEnd = false) => ({ w: text, start: 0, end: 1, p: 1, ...(segEnd ? { segEnd: true } : {}) });

  it('capitalises the transcript start and the word after a segEnd', () => {
    const out = restoreCasing([w('xin'), w('chào', true), w('hôm'), w('nay', true), w('đẹp')], []);
    expect(out.map((x) => x.w)).toEqual(['Xin', 'chào', 'Hôm', 'nay', 'Đẹp']);
  });

  it('applies the glossary case-insensitively for words and phrases', () => {
    const out = restoreCasing([w('gặp'), w('vietcetera'), w('và'), w('trưng'), w('trắc', true)], ['Vietcetera', 'Trưng Trắc']);
    expect(out.map((x) => x.w)).toEqual(['Gặp', 'Vietcetera', 'và', 'Trưng', 'Trắc']);
  });

  it('matches NFC-insensitively, whole words only, and does not mutate the input', () => {
    const decomposed = 'tru\u031Bng'; // u + horn, composed differently
    const input = [w('xin'), w(decomposed.normalize('NFD')), w('trắc'), w('vietceteras')];
    const out = restoreCasing(input, ['Trưng Trắc', 'Vietcetera']);
    expect(out.map((x) => x.w)).toEqual(['Xin', 'Trưng', 'Trắc', 'vietceteras']);
    expect(input[0]!.w).toBe('xin');
  });

  it('keeps the glossary spelling at a sentence start and other fields', () => {
    const out = restoreCasing([{ w: 'iphone', start: 2, end: 3, p: 0.5 }], ['iPhone']);
    expect(out[0]).toEqual({ w: 'iPhone', start: 2, end: 3, p: 0.5 });
  });
});
