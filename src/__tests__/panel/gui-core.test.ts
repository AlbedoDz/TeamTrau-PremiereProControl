/**
 * gui-core.js is plain UMD ES5 for CEP. The package is "type": "module", so jest would treat a
 * .js file under cep-plugin/ as ESM and refuse require(); like helpers/panel.ts this runs the
 * file in a vm context with a CommonJS `module`, which also exercises the UMD module.exports branch.
 */
import vm from 'vm';
import path from 'path';
import { readFileSync } from 'fs';
import { loadPanel } from '../helpers/panel.js';
import { ACCENT_SWATCHES } from '../../analysis/caption-looks.js';
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

describe('gui-core loading in the CEP panel', () => {
  it('sets window.GuiCore even when Node exposes `module` (CEP --mixed-context)', () => {
    // Live: the panel runs with --enable-nodejs --mixed-context, where `module` exists.
    // The UMD used to export only to module.exports there, so gui.js found no
    // window.GuiCore, threw on start-up, and no button in the panel responded.
    const window: any = {};
    const sandbox: any = { window, module: { exports: {} }, console };
    vm.createContext(sandbox);
    vm.runInContext(realFs.readFileSync(path.join(GUI_DIR, 'gui-core.js'), 'utf8'), sandbox);
    expect(typeof window.GuiCore?.reduceRunState).toBe('function');
    expect(typeof sandbox.module.exports.reduceRunState).toBe('function');
  });

  it('gui.js reads GuiCore from window', () => {
    expect(realFs.readFileSync(path.join(GUI_DIR, 'gui.js'), 'utf8')).toMatch(/window\.GuiCore/);
  });
});
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

  it('returns an error that names the repair command when nothing is found', () => {
    const result = core.resolveRunner({}, { PATH: '/usr/bin' }, () => false);
    expect(result.error).toContain('premiere-pro-mcp --register-panel-runner');
    expect(result.error).toContain('--doctor');
    // Setup.exe is only the Windows option.
    expect(result.error).toMatch(/Windows[^.]*Setup\.exe/);
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
    expect(core.buildArgs(card('recap'), {})).toEqual({ minSec: 75, maxSec: 105, aspect: '16:9', captionStyle: 'none', audioLeadSec: 0 });
  });

  it('converts form text and clamps numbers', () => {
    const args = core.buildArgs(card('shorts'), { count: '9', minSec: '25,5', maxSec: 'abc', caption: { style: 'pop' } });
    expect(args).toEqual({ count: 5, minSec: 25.5, maxSec: 60, aspect: '9:16', captionStyle: 'pop' });
  });

  it('leaves empty paths out and maps filler tiers', () => {
    const args = core.buildArgs(card('clean_voiceover'), { fillerTiers: 'AB', cutFillers: false });
    expect(args.fillerTiers).toEqual(['A', 'B']);
    expect(args.cutFillers).toBe(false);
    expect(core.buildArgs(card('clean_voiceover'), {}).fillerTiers).toBeUndefined();
    expect(core.buildArgs(card('subtitles'), {})).toEqual({ output: 'srt' });
  });

  it('asks for the footage folder of the rough cut, and a length when there is no music', () => {
    const args = core.buildArgs(card('rough_cut'), {});
    expect(core.missingRequired(card('rough_cut'), args)).toEqual([
      'Cần điền: Footage (bin, thư mục hoặc mục đang chọn).',
      'Cần điền: Thời lượng mong muốn (giây), hoặc chọn file nhạc.',
    ]);
    expect(core.missingRequired(card('rough_cut'), core.buildArgs(card('rough_cut'), { folderPath: ' D:\\clips ', targetSec: '45' }))).toEqual([]);
    expect(core.missingRequired(card('rough_cut'), core.buildArgs(card('rough_cut'), { folderPath: 'D:/c', musicPath: 'D:/m.mp3' }))).toEqual([]);
  });

  it('recap: the shortest length must be under the longest', () => {
    expect(core.missingRequired(card('recap'), core.buildArgs(card('recap'), { minSec: '60', maxSec: '90' }))).toEqual([]);
    expect(core.missingRequired(card('recap'), core.buildArgs(card('recap'), { minSec: '90', maxSec: '90' }))).toEqual([
      '"Ngắn nhất" phải nhỏ hơn "Dài nhất".',
    ]);
  });

  it('rough cut: targetSec defaults to empty and is never sent with a music file', () => {
    expect(core.buildArgs(card('rough_cut'), { folderPath: 'D:/c' }).targetSec).toBeUndefined();
    expect(core.buildArgs(card('rough_cut'), { folderPath: 'D:/c', targetSec: '45' }).targetSec).toBe(45);
    const withMusic = core.buildArgs(card('rough_cut'), { folderPath: 'D:/c', musicPath: 'D:/m.mp3', targetSec: '45' });
    expect(withMusic.targetSec).toBeUndefined();
    expect(withMusic.musicPath).toBe('D:/m.mp3');
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
        expect(Object.keys(schema.shape)).toContain(field.type === 'caption' ? 'captionStyle' : field.key);
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

  it('keeps the rising progress value next to the 1-based step', () => {
    let state = core.reduceRunState(core.initialRunState(), run('a'));
    expect(state.progress).toBe(0);
    state = core.reduceRunState(state, { type: 'progress', id: 'a', step: 2, progress: 1.4, stepCount: 3, label: 'Nhận dạng 40%' });
    expect(state).toMatchObject({ step: 2, progress: 1.4, stepCount: 3 });
    // An older runner without `progress`: the amount done is step - 1.
    state = core.reduceRunState(state, { type: 'progress', id: 'a', step: 3, stepCount: 3, label: 'x' });
    expect(state.progress).toBe(2);
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

  it('shows the clean voice-over QA count (a number)', () => {
    const none = core.describeResult({ success: true, steps: [], summary: { qaFindings: 0 }, outputSequenceIds: [], warnings: [] });
    expect(none.lines).toContain('QA: không có vấn đề');
    const some = core.describeResult({ success: true, steps: [], summary: { qaFindings: 3 }, outputSequenceIds: [], warnings: [] });
    expect(some.lines).toContain('QA: 3 vấn đề');
    const list = core.describeResult({ success: true, steps: [], summary: { qaFindings: [{}, {}] }, outputSequenceIds: [], warnings: [] });
    expect(list.lines).toContain('Kiểm tra chất lượng: 2 lưu ý');
  });

  it('offers only the unfinished copies for deletion', () => {
    const out = core.describeResult({
      success: false, cancelled: true, steps: [], summary: {},
      outputSequenceIds: ['s1', 's2', 's3'], partialSequenceIds: ['s3'], warnings: [],
    });
    expect(out.sequenceIds).toEqual(['s1', 's2', 's3']);
    expect(out.partialSequenceIds).toEqual(['s3']);
    expect(core.describeResult({ success: true, outputSequenceIds: ['s1'] }).partialSequenceIds).toEqual([]);
    expect(core.cancelledResult().partialSequenceIds).toEqual([]);
  });

  it('translates the English warnings of remove_ranges, transcription and build_short', () => {
    const out = core.describeResult({
      success: true, steps: [], summary: {}, outputSequenceIds: [],
      warnings: [
        'Only 3 of 5 audio crossfades were placed and verified (x). The cuts themselves are fine.',
        'The sequence shortened by 12.5s but 14s was planned. Tracks may be locked or sync lock off, leaving audio and video out of step. Use undo, unlock tracks, and retry.',
        'CPU fallback: transcription is 3-4× slower',
        'Skipped 2 clip(s): its speed is not 100%; it has no media file.',
        'Repaired 4 word timestamp(s) that had no duration.',
        'No speech was recognised in the dialogue tracks.',
        'Short 2: The short lasts 41.2 s, expected 40 s.',
        'Short 1: Captions were rendered at 1080×1920 but the short is 1215×2160; Premiere scales the caption overlay.',
        'Short 3: qa_sequence found 2 error(s) on the short; see qa.findings.',
        'Short 1: The short is 1920×1080, not 9:16.',
        'Short 1: Auto Reframe had no subject-tracking keyframes after 120 s; check the framing in Premiere.',
        'Short 1: The caption clip was not found on the top video track.',
        'Short 1: The caption file could not be moved into the Shorts bin.',
        'Short 1: The intermediate subsequence could not be deleted; remove it from the project by hand.',
        'Short 1: No words fall in this range, so the caption track is empty.',
        'Short 4: không xác nhận được kết quả sau khi dựng.',
      ],
    });
    expect(out.warnings).toEqual([
      'Chỉ đặt được 3/5 crossfade âm thanh. Các vết cắt vẫn đúng.',
      expect.stringMatching(/^Sequence chỉ ngắn đi 12\.5 giây, dự kiến 14 giây\./),
      'Không dùng được GPU: nhận dạng giọng nói chạy bằng CPU, chậm hơn 3-4 lần.',
      'Bỏ qua 2 clip: tốc độ khác 100%; không có file media.',
      'Đã sửa mốc thời gian của 4 từ không có độ dài.',
      'Không nhận dạng được lời thoại nào trên các track thoại.',
      'Short 2: Short dài 41.2 giây, dự kiến 40 giây.',
      'Short 1: Phụ đề được dựng ở 1080×1920 nhưng short là 1215×2160; Premiere sẽ co giãn lớp phụ đề.',
      'Short 3: qa_sequence thấy 2 lỗi trên short; xem qa.findings.',
      'Short 1: Short có kích thước 1920×1080, không phải 9:16.',
      'Short 1: Sau 120 giây Auto Reframe vẫn chưa có keyframe bám chủ thể; kiểm tra khung hình trong Premiere.',
      'Short 1: Không thấy clip phụ đề trên track video trên cùng.',
      'Short 1: Không chuyển được file phụ đề vào bin Shorts.',
      'Short 1: Không xóa được subsequence trung gian; xóa tay trong project.',
      'Short 1: Không có từ nào trong đoạn này, nên không có phụ đề để tạo.',
      'Short 4: không xác nhận được kết quả sau khi dựng.',
    ]);
  });

  it('keeps the "Short N: " prefix around unknown English text', () => {
    const out = core.describeResult({ success: true, steps: [], summary: {}, outputSequenceIds: [], warnings: ['Short 2: Something odd'] });
    expect(out.warnings).toEqual(['Short 2: Something odd']);
    expect(core.vi({ success: false, error: 'Short 2: Something odd' })).toBe('Lỗi: Short 2: Something odd');
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

  it('turns a backup failure into panel advice, without the backup=false hint', () => {
    const text = core.vi({
      success: false,
      steps: [{ label: 'Nhân bản sequence', ok: false, detail: { error: 'Backup failed, nothing was changed: save failed Fix this, or pass backup=false to edit without a backup.' } }],
    });
    expect(text).toContain('Nhân bản sequence: Không sao lưu được project: hãy lưu project (Ctrl+S) rồi chạy lại.');
    expect(text).not.toContain('backup=false');
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

  it('translates the project media lookup errors', () => {
    expect(core.vi({ error: 'File not found: "song.mp3" is neither a file on disk nor an imported audio/video item in the project.' }))
      .toBe('Không tìm thấy "song.mp3" trên máy hay trong dự án. Bấm "Từ dự án…" để chọn file đã import.');
    expect(core.vi({ error: '"01 Foot" is neither a folder on disk nor a bin in the project.' })).toContain('không phải bin trong dự án');
    expect(core.vi({ error: 'Cannot use bin "B-roll": it holds no video clips (pass recursive=true to include sub-bins).' }))
      .toBe('Bin "B-roll" không có clip video nào (bin con không được tính).');
  });
});

describe('gui-core projectChoices', () => {
  const media = {
    bins: [{ path: '01 Footage', selected: false }, { path: '02 Music', selected: false }, { path: 'Empty', selected: false }],
    items: [
      { name: 'a.mp4', bin: '01 Footage', mediaPath: 'E:/a.mp4', kind: 'video', offline: false, selected: true },
      { name: 'b.mp4', bin: '01 Footage', mediaPath: 'E:/b.mp4', kind: 'video', offline: false, selected: false },
      { name: 'song.mp3', bin: '02 Music', mediaPath: 'D:/song.mp3', kind: 'audio', offline: false, selected: false },
    ],
  };

  it('offers the selection and the bins that hold video for footage', () => {
    expect(core.projectChoices(media, 'folderPath')).toEqual([
      { value: '@selection', label: 'Mục đang chọn trong Project (1 clip)' },
      { value: '01 Footage', label: 'Bin 01 Footage (2 clip)' },
    ]);
  });

  it('offers imported audio by its file path for music', () => {
    expect(core.projectChoices(media, 'musicPath')).toEqual([{ value: 'D:/song.mp3', label: '02 Music/song.mp3' }]);
    expect(core.projectChoices({}, 'musicPath')).toEqual([]);
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

describe('gui-core caption look helpers', () => {
  it('captionArgs drops defaults', () => {
    expect(core.captionArgs({ style: 'clean', accent: '', position: 'bottom', size: 'medium' })).toEqual({ captionStyle: 'clean' });
    expect(core.captionArgs({ style: 'pop', accent: '#ff3b5c', position: 'middle', size: 'large' })).toEqual({
      captionStyle: 'pop', captionAccent: '#ff3b5c', captionPosition: 'middle', captionSize: 'large',
    });
  });

  it('isHexColor accepts #ff3b5c and rejects #f00', () => {
    expect(core.isHexColor('#ff3b5c')).toBe(true);
    expect(core.isHexColor('#f00')).toBe(false);
    expect(core.isHexColor('')).toBe(false);
  });

  it('keeps the swatches and labels in step with the server', () => {
    expect(core.ACCENT_SWATCHES).toEqual([...ACCENT_SWATCHES]);
    expect(Object.keys(core.CAPTION_STYLE_LABELS)).toEqual(['clean', 'pop', 'karaoke', 'highlight', 'minimal', 'none']);
  });

  it('previewRequest builds the tool call and returns null for none', () => {
    const req = core.previewRequest({}, 'shorts', '9:16', { style: 'pop', accent: '#FFD400', position: 'middle' });
    expect(req).toEqual({ tool: 'preview_caption_style', args: { style: 'pop', captionAccent: '#FFD400', captionPosition: 'middle', aspect: '9:16' } });
    expect(core.previewRequest({}, 'recap', '16:9', { style: 'none' })).toBeNull();
  });

  it('nextPreview keeps only the latest request while busy and sends it when free', () => {
    const a = { tool: 'preview_caption_style', args: { style: 'a' } };
    const b = { tool: 'preview_caption_style', args: { style: 'b' } };
    const c = { tool: 'preview_caption_style', args: { style: 'c' } };
    expect(core.nextPreview(null, false, a)).toEqual({ send: a, pending: null });
    expect(core.nextPreview(null, true, a)).toEqual({ send: null, pending: a });
    expect(core.nextPreview(a, true, b)).toEqual({ send: null, pending: b });
    expect(core.nextPreview(b, false, null)).toEqual({ send: b, pending: null });
    expect(core.nextPreview(b, false, c)).toEqual({ send: c, pending: null });
    expect(core.nextPreview(null, false, null)).toEqual({ send: null, pending: null });
  });

  it('missingRequired flags a bad hex', () => {
    const args = core.buildArgs(card('shorts'), { caption: { style: 'pop', accent: '#f00' } });
    expect(core.missingRequired(card('shorts'), args)).toContain('Màu phải có dạng #RRGGBB.');
    const ok = core.buildArgs(card('shorts'), { caption: { style: 'pop', accent: '#ff3b5c' } });
    expect(core.missingRequired(card('shorts'), ok)).not.toContain('Màu phải có dạng #RRGGBB.');
  });

  it('recap and shorts cards offer 1:1 and 4:5', () => {
    for (const id of ['recap', 'shorts']) {
      const values = card(id).fields.find((f: any) => f.key === 'aspect').options.map((o: any) => o.value);
      expect(values).toEqual(expect.arrayContaining(['9:16', '1:1', '4:5']));
    }
    expect(card('recap').fields.find((f: any) => f.key === 'aspect').options.map((o: any) => o.value)).toContain('16:9');
  });

  it('subtitles card sends no maxCharsPerLine when left empty', () => {
    expect(core.buildArgs(card('subtitles'), {}).maxCharsPerLine).toBeUndefined();
    expect(core.buildArgs(card('subtitles'), { maxCharsPerLine: '30' }).maxCharsPerLine).toBe(30);
  });

  it('describeResult shows the SRT line limits', () => {
    const r = core.describeResult({ success: true, summary: { cueCount: 3, lineLimits: { maxCharsPerLine: 22, maxLines: 2, layout: '9:16' } } });
    expect(r.lines).toContain('22 ký tự/dòng (khung 9:16)');
  });
});
