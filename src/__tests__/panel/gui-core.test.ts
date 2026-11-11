/**
 * gui-core.js is plain UMD ES5 for CEP. The package is "type": "module", so jest would treat a
 * .js file under cep-plugin/ as ESM and refuse require(); like helpers/panel.ts this runs the
 * file in a vm context with a CommonJS `module`, which also exercises the UMD module.exports branch.
 */
import vm from 'vm';
import path from 'path';
import { readFileSync } from 'fs';
import { loadPanel } from '../helpers/panel.js';
import { workflowToolsTools } from '../../tools/domains/workflow-tools.js';

const GUI_DIR = path.join(__dirname, '..', '..', '..', 'cep-plugin', 'gui');
const realFs = jest.requireActual<typeof import('fs')>('fs');

function loadCore(): any {
  const sandbox: any = { module: { exports: {} }, console };
  vm.createContext(sandbox);
  vm.runInContext(realFs.readFileSync(path.join(GUI_DIR, 'gui-core.js'), 'utf8'), sandbox);
  return sandbox.module.exports;
}

const core = loadCore();
const { cards } = JSON.parse(readFileSync(path.join(GUI_DIR, 'workflows.json'), 'utf8')) as { cards: any[] };
const card = (id: string): any => cards.find((c) => c.id === id);

describe('gui-core resolveRunner', () => {
  const win = { PATH: 'C:\\Windows;C:\\nodejs', APPDATA: 'C:\\Users\\a\\AppData\\Roaming' };

  it('uses the config when both files exist', () => {
    const config = { runner: { nodePath: 'C:\\app\\node\\node.exe', cliPath: 'C:\\app\\dist\\cli.js' } };
    expect(core.resolveRunner(config, win, () => true)).toEqual(config.runner);
  });

  it('falls back to node on PATH with the global npm package', () => {
    const files = new Set(['C:\\nodejs\\node.exe', 'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\adobe-premiere-pro-mcp\\dist\\cli.js']);
    expect(core.resolveRunner({}, win, (p: string) => files.has(p))).toEqual({
      nodePath: 'node',
      cliPath: 'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\adobe-premiere-pro-mcp\\dist\\cli.js',
    });
  });

  it('ignores a config whose files are gone', () => {
    const config = { runner: { nodePath: 'C:\\gone\\node.exe', cliPath: 'C:\\gone\\cli.js' } };
    const result = core.resolveRunner(config, win, () => false);
    expect(result.error).toContain('--doctor');
  });

  it('returns an error that names --doctor when nothing is found', () => {
    const result = core.resolveRunner({}, { PATH: '/usr/bin' }, () => false);
    expect(result.error).toContain('--doctor');
    expect(result.cliPath).toBeUndefined();
  });

  it('prefers the settings override over the config', () => {
    const config = {
      runner: { nodePath: 'C:\\app\\node.exe', cliPath: 'C:\\app\\cli.js' },
      runnerOverride: 'D:\\mine\\cli.js',
    };
    expect(core.resolveRunner(config, win, () => true)).toEqual({ nodePath: 'C:\\app\\node.exe', cliPath: 'D:\\mine\\cli.js' });
  });

  it('works on a unix PATH', () => {
    const files = new Set(['/opt/node/bin/node', '/opt/node/lib/node_modules/adobe-premiere-pro-mcp/dist/cli.js']);
    const env = { PATH: '/usr/bin:/opt/node/bin' };
    expect(core.resolveRunner({}, env, (p: string) => files.has(p.replace('/bin/../lib', '/lib')))).toEqual({
      nodePath: 'node',
      cliPath: '/opt/node/bin/../lib/node_modules/adobe-premiere-pro-mcp/dist/cli.js',
    });
  });
});

describe('gui-core buildArgs', () => {
  it('gives the recap defaults for an empty form', () => {
    expect(core.buildArgs(card('recap'), {})).toEqual({ targetSec: 90, aspect: '16:9', captionStyle: 'clean', audioLeadSec: 0 });
  });

  it('converts form text and clamps numbers', () => {
    const args = core.buildArgs(card('shorts'), { count: '9', minSec: '25,5', maxSec: 'abc', captionStyle: 'pop' });
    expect(args).toEqual({ count: 5, minSec: 25.5, maxSec: 60, captionStyle: 'pop' });
  });

  it('leaves empty paths out and maps filler tiers', () => {
    const args = core.buildArgs(card('clean_voiceover'), { fillerTiers: 'AB', cutFillers: false });
    expect(args.fillerTiers).toEqual(['A', 'B']);
    expect(args.cutFillers).toBe(false);
    expect(core.buildArgs(card('clean_voiceover'), {}).fillerTiers).toBeUndefined();
    expect(core.buildArgs(card('subtitles'), {})).toEqual({ output: 'srt', maxCharsPerLine: 42 });
  });

  it('asks for the footage folder of the rough cut', () => {
    const args = core.buildArgs(card('rough_cut'), {});
    expect(core.missingRequired(card('rough_cut'), args)).toEqual(['Cần điền: Thư mục footage.']);
    expect(core.missingRequired(card('rough_cut'), core.buildArgs(card('rough_cut'), { folderPath: ' D:\\clips ' }))).toEqual([]);
  });

  it('adds the engine and the output folder from the settings', () => {
    const settings = { asrEngine: 'rover', outputDir: 'D:\\srt\\', runnerPath: '' };
    const subs = core.applySettings(card('subtitles'), core.buildArgs(card('subtitles'), {}), settings, 'Tập 1: mở đầu');
    expect(subs.engine).toBe('rover');
    expect(subs.outputPath).toBe('D:\\srt\\Tập 1- mở đầu.srt');
    const rough = core.applySettings(card('rough_cut'), { folderPath: 'x' }, settings, 'S');
    expect(rough.engine).toBeUndefined();
    const own = core.applySettings(card('subtitles'), { outputPath: 'E:\\a.srt' }, settings, 'S');
    expect(own.outputPath).toBe('E:\\a.srt');
  });
});

describe('workflows.json against the tool schemas', () => {
  it('has the five cards with fields the tools accept', () => {
    expect(cards.map((c) => c.tool)).toEqual([
      'workflow_clean_voiceover', 'workflow_recap', 'workflow_shorts', 'workflow_subtitles', 'workflow_rough_cut',
    ]);
    for (const c of cards) {
      const tool = workflowToolsTools.find((t) => t.name === c.tool)!;
      const schema: any = tool.inputSchema;
      for (const field of c.fields) {
        expect(Object.keys(schema.shape)).toContain(field.key);
      }
      // What the panel sends for an untouched card must pass the tool's own validation.
      const parsed = schema.safeParse({ ...core.buildArgs(c, {}), folderPath: 'x' });
      expect(parsed.success).toBe(true);
    }
  });

  it('only offers engines that transcribe_sequence accepts', async () => {
    const { ENGINE_IDS } = await import('../../analysis/asr-engines.js');
    expect(core.ASR_ENGINES).toEqual([...ENGINE_IDS]);
  });
});

describe('gui-core reduceRunState', () => {
  const run = (id: string) => ({ type: 'run', id, tool: 'workflow_recap', cardId: 'recap' });

  it('queues the second run while one is active', () => {
    let state = core.reduceRunState(core.initialRunState(), run('a'));
    expect(state.status).toBe('starting');
    state = core.reduceRunState(state, run('b'));
    expect(state.current.id).toBe('a');
    expect(state.queue.map((j: any) => j.id)).toEqual(['b']);
  });

  it('moves starting to running on progress and keeps the step', () => {
    let state = core.reduceRunState(core.initialRunState(), run('a'));
    state = core.reduceRunState(state, { type: 'progress', id: 'a', step: 2, stepCount: 3, label: 'Dựng' });
    expect(state).toMatchObject({ status: 'running', step: 2, stepCount: 3, label: 'Dựng' });
    state = core.reduceRunState(state, { type: 'progress', id: 'other', step: 9, stepCount: 9, label: 'x' });
    expect(state.step).toBe(2);
  });

  it('goes to cancelling on cancel while running', () => {
    let state = core.reduceRunState(core.initialRunState(), run('a'));
    state = core.reduceRunState(state, { type: 'progress', id: 'a', step: 1, stepCount: 3, label: 'x' });
    state = core.reduceRunState(state, { type: 'cancel', id: 'a' });
    expect(state.status).toBe('cancelling');
  });

  it('drops a queued job on cancel by id', () => {
    let state = core.reduceRunState(core.initialRunState(), run('a'));
    state = core.reduceRunState(state, run('b'));
    state = core.reduceRunState(state, { type: 'cancel', id: 'b' });
    expect(state.queue).toEqual([]);
    expect(state.status).toBe('starting');
  });

  it('ends a cancelled result as done with the cancelled flag', () => {
    let state = core.reduceRunState(core.initialRunState(), run('a'));
    state = core.reduceRunState(state, { type: 'cancel', id: 'a' });
    state = core.reduceRunState(state, { type: 'result', id: 'a', result: { success: false, cancelled: true, steps: [], outputSequenceIds: ['s1'] } });
    expect(state.status).toBe('done');
    expect(state.cancelled).toBe(true);
    expect(state.current).toBeNull();
  });

  it('ends a failed result as failed, a good one as done without the flag', () => {
    const failed = core.reduceRunState(core.reduceRunState(core.initialRunState(), run('a')), { type: 'result', id: 'a', result: { success: false } });
    expect(failed).toMatchObject({ status: 'failed', cancelled: false });
    const ok = core.reduceRunState(core.reduceRunState(core.initialRunState(), run('a')), { type: 'result', id: 'a', result: { success: true } });
    expect(ok).toMatchObject({ status: 'done', cancelled: false });
  });

  it('starts the queued job when the current one ends', () => {
    let state = core.reduceRunState(core.initialRunState(), run('a'));
    state = core.reduceRunState(state, run('b'));
    state = core.reduceRunState(state, { type: 'result', id: 'a', result: { success: true } });
    expect(state.status).toBe('starting');
    expect(state.current.id).toBe('b');
    expect(state.queue).toEqual([]);
    expect(state.previous.status).toBe('done');
  });

  it('fails the job and drops the queue when the runner exits', () => {
    let state = core.reduceRunState(core.initialRunState(), run('a'));
    state = core.reduceRunState(state, run('b'));
    state = core.reduceRunState(state, { type: 'runner-exit', error: 'boom' });
    expect(state).toMatchObject({ status: 'failed', error: 'boom', queue: [], current: null });
  });

  it('reports every queued job as failed, in Vietnamese, when the runner exits', () => {
    let state = core.reduceRunState(core.initialRunState(), run('a'));
    state = core.reduceRunState(state, { ...run('b'), cardId: 'shorts' });
    state = core.reduceRunState(state, run('c'));
    state = core.reduceRunState(state, { type: 'runner-exit', error: 'boom' });
    expect(state.failedJobs.map((j: any) => [j.id, j.cardId])).toEqual([['b', 'shorts'], ['c', 'recap']]);
    expect(state.failedJobs[0].error).toContain('chưa chạy được');
    expect(state.failedJobs[0].error).toContain('boom');
    state = core.reduceRunState(state, run('d'));
    expect(state.failedJobs).toEqual([]);
  });

  it('does not send a job that was cancelled while the runner was starting', () => {
    let state = core.reduceRunState(core.initialRunState(), run('a'));
    expect(core.shouldSendRun(state, 'a')).toBe(true);
    state = core.reduceRunState(state, { type: 'cancel', id: 'a' });
    expect(state.status).toBe('cancelling');
    expect(core.shouldSendRun(state, 'a')).toBe(false);
    // Completing it locally reaches a terminal state.
    state = core.reduceRunState(state, { type: 'result', id: 'a', result: core.cancelledResult() });
    expect(state).toMatchObject({ status: 'done', cancelled: true, current: null });
  });

  it('does not send a queued job that was removed, but sends one still queued', () => {
    let state = core.reduceRunState(core.initialRunState(), run('a'));
    state = core.reduceRunState(state, run('b'));
    state = core.reduceRunState(state, run('c'));
    state = core.reduceRunState(state, { type: 'cancel', id: 'b' });
    expect(core.shouldSendRun(state, 'b')).toBe(false);
    expect(core.shouldSendRun(state, 'c')).toBe(true);
  });

  it('locks only the card whose job is active', () => {
    let state = core.initialRunState();
    expect(core.isCardLocked(state, 'recap')).toBe(false);
    state = core.reduceRunState(state, run('a'));
    expect(core.isCardLocked(state, 'recap')).toBe(true);
    expect(core.isCardLocked(state, 'shorts')).toBe(false);
    state = core.reduceRunState(state, { type: 'cancel', id: 'a' });
    expect(core.isCardLocked(state, 'recap')).toBe(true);
    state = core.reduceRunState(state, { type: 'result', id: 'a', result: { success: true } });
    expect(core.isCardLocked(state, 'recap')).toBe(false);
  });
});

describe('gui-core describeResult', () => {
  it('describes a clean voice-over result', () => {
    const out = core.describeResult({
      success: true,
      steps: [],
      summary: { cutCount: 42, removedSeconds: 72, outputName: 'A - clean', durationBefore: 600, durationAfter: 528 },
      outputSequenceIds: ['seq1'],
      warnings: [],
    });
    expect(out.title).toBe('Xong');
    expect(out.lines).toContain('42 vết cắt, bớt 1:12');
    expect(out.lines).toContain('Thời lượng: 10:00 → 8:48');
    expect(out.lines).toContain('Sequence mới: A - clean');
    expect(out.sequenceIds).toEqual(['seq1']);
  });

  it('labels a preview and translates warnings', () => {
    const out = core.describeResult({
      success: true,
      steps: [],
      summary: { dryRun: true, cutCount: 3, plannedRemovedSeconds: 9 },
      outputSequenceIds: [],
      warnings: ['music-chopped: 2 clip', 'No words fall in the sequence, so the caption track is empty.'],
    });
    expect(out.title).toContain('Xem trước');
    expect(out.lines).toContain('3 vết cắt, sẽ bớt 0:09');
    expect(out.warnings[0]).toContain('Nhạc nền bị cắt đứt');
    expect(out.warnings[1]).toContain('Không có từ nào');
  });

  it('warns when the result could not be verified', () => {
    const out = core.describeResult({ success: true, steps: [], summary: { verified: false }, outputSequenceIds: [], warnings: [] });
    expect(out.warnings.join(' ')).toContain('Chưa xác nhận');
  });

  it('lists the cuts of a preview', () => {
    const cuts = core.listCuts({
      steps: [{ label: 'x', ok: true, detail: { ranges: [{ start: 83.4, end: 84.1, reason: 'filler-A', text: 'ờ thì' }] } }],
    });
    expect(cuts).toEqual([{ time: '1:23.4 - 1:24.1', reason: 'từ ngập ngừng', text: 'ờ thì' }]);
    expect(core.listCuts({ summary: { plan: [{ start: 1, end: 2, duration: 1 }] } })).toHaveLength(1);
    const withCuts = core.listCuts({
      steps: [{ label: 'x', ok: true, detail: { ranges: 3 } }],
      summary: {
        plan: [{ start: 1, end: 2, duration: 1 }],
        cuts: [
          { start: 1, end: 2, reason: 'silence' },
          { start: 30, end: 30.4, reason: 'filler-B', text: 'kiểu như' },
          { start: 50, end: 52, reason: 'retake', text: 'x' },
        ],
      },
    });
    expect(withCuts).toEqual([
      { time: '0:01.0 - 0:02.0', reason: 'khoảng lặng', text: '' },
      { time: '0:30.0 - 0:30.4', reason: 'từ câu giờ', text: 'kiểu như' },
      { time: '0:50.0 - 0:52.0', reason: 'câu vấp', text: 'x' },
    ]);
    expect(core.listCuts({ steps: [] })).toEqual([]);
  });
});

describe('gui-core vi', () => {
  it('translates the English messages earlier tools pass through', () => {
    expect(core.vi({ success: false, error: 'Caption render failed: disk full' })).toBe('Không dựng được phụ đề burn-in: disk full');
    expect(core.vi({ success: false, error: 'Auto Reframe did not return a sequence.' })).toContain('Auto Reframe');
    expect(core.vi({ success: false, error: 'No words fall in the sequence, so the caption track is empty.' })).toContain('Không có từ nào');
  });

  it('prefixes unknown English text with "Lỗi: "', () => {
    expect(core.vi({ success: false, error: 'Something odd' })).toBe('Lỗi: Something odd');
  });

  it('keeps Vietnamese text and appends the nextStep', () => {
    const text = core.vi({
      success: false,
      steps: [{ label: 'Nhân bản sequence', ok: false, detail: { error: 'Sequence not found' } }],
      nextStep: 'Bước "Nhân bản sequence" lỗi. Sửa lỗi rồi chạy lại.',
    });
    expect(text).toBe('Nhân bản sequence: Không tìm thấy sequence. Bấm làm mới danh sách sequence rồi chọn lại.\nBước "Nhân bản sequence" lỗi. Sửa lỗi rồi chạy lại.');
  });

  it('copes with an empty result', () => {
    expect(core.vi({})).toContain('không rõ nguyên nhân');
  });
});

describe('Kết nối tab keeps the old panel behaviour', () => {
  it('still exposes the bridge prototype', () => {
    const { bridge } = loadPanel();
    expect(typeof bridge.startBridge).toBe('function');
    expect(typeof bridge.getTempDirectory).toBe('function');
  });

  it('keeps every old element id and handler in index.html', () => {
    const html = readFileSync(path.join(GUI_DIR, '..', 'index.html'), 'utf8');
    for (const id of ['connectionStatus', 'serverStatus', 'tempDirectory', 'telemetryEnabled', 'startButton', 'stopButton', 'diagnosticsButton', 'clearButton', 'commandQueue', 'logContainer', 'updateBanner']) {
      expect(html).toContain(`id="${id}"`);
    }
    for (const handler of ['saveConfig()', 'startBridge()', 'stopBridge()', 'runDiagnostics()', 'clearLog()', 'copyUpdateCommand()', 'updateLater()', 'saveTelemetryPreference()']) {
      expect(html).toContain(`onclick="${handler}"`.replace('onclick="saveTelemetryPreference()"', 'onchange="saveTelemetryPreference()"'));
    }
  });
});
