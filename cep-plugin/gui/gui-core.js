/**
 * Pure logic of the "Quy trình" tab: no DOM, no Node APIs, so it can be tested directly.
 * UMD and ES5 on purpose: CEP's Chromium is old, and the file is loaded both by a
 * <script> tag (window.GuiCore) and by tests (module.exports).
 */
(function (root, factory) {
    // Both, not either: CEP runs this panel with --enable-nodejs --mixed-context, where
    // Node's `module` exists in the page too. Exporting only to module.exports there left
    // window.GuiCore undefined, so gui.js failed on start-up and no button responded.
    var api = factory();
    if (root) root.GuiCore = api;
    if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    var PACKAGE_NAME = 'adobe-premiere-pro-mcp';

    /** Speech engines transcribe_sequence accepts (src/analysis/asr-engines.ts ENGINE_IDS). */
    var ASR_ENGINES = ['zipformer-68m', 'zipformer-30m', 'rover', 'whisper-turbo'];

    /** Workflow tools that take an `engine` argument. */
    var ENGINE_TOOLS = ['workflow_clean_voiceover', 'workflow_recap', 'workflow_shorts', 'workflow_subtitles'];

    var DEFAULT_SETTINGS = { asrEngine: '', outputDir: '', runnerPath: '' };

    function isString(v) { return typeof v === 'string'; }
    function hasValue(v) { return v !== undefined && v !== null && v !== ''; }
    function isNumber(v) { return typeof v === 'number' && isFinite(v); }

    // ---------------------------------------------------------------- resolveRunner

    function joinPath(sep, parts) {
        var out = '';
        for (var i = 0; i < parts.length; i++) {
            if (!parts[i]) continue;
            out = out ? out.replace(/[\\\/]+$/, '') + sep + parts[i] : parts[i];
        }
        return out;
    }

    function findNodeOnPath(env, exists) {
        var pathValue = env.PATH || env.Path || '';
        var win = pathValue.indexOf(';') >= 0 || !!env.APPDATA || /windows/i.test(env.OS || '');
        var sep = win ? '\\' : '/';
        var dirs = pathValue.split(win ? ';' : ':');
        var names = win ? ['node.exe', 'node'] : ['node'];
        for (var i = 0; i < dirs.length; i++) {
            if (!dirs[i]) continue;
            for (var j = 0; j < names.length; j++) {
                if (exists(joinPath(sep, [dirs[i], names[j]]))) return { dir: dirs[i], sep: sep };
            }
        }
        return null;
    }

    /**
     * Where to find the runner, in the order of spec section 3:
     *  1. the settings override (a cli.js path) and 2. `runner` from the panel config,
     *     each only when its files exist;
     *  3. `node` on PATH with the cli.js of the global npm package;
     *  otherwise an error that points to --doctor.
     * config: { runner?: { nodePath, cliPath }, runnerOverride?: string }
     */
    function resolveRunner(config, env, exists) {
        config = config || {};
        env = env || {};
        exists = exists || function () { return false; };
        var runner = config.runner && typeof config.runner === 'object' ? config.runner : {};
        var configNode = isString(runner.nodePath) && runner.nodePath ? runner.nodePath : '';
        var configCli = isString(runner.cliPath) && runner.cliPath ? runner.cliPath : '';

        var override = isString(config.runnerOverride) ? config.runnerOverride.trim() : '';
        if (override && exists(override)) {
            return { nodePath: configNode && exists(configNode) ? configNode : 'node', cliPath: override };
        }
        if (configNode && configCli && exists(configNode) && exists(configCli)) {
            return { nodePath: configNode, cliPath: configCli };
        }

        var node = findNodeOnPath(env, exists);
        if (node) {
            var tail = ['node_modules', PACKAGE_NAME, 'dist', 'cli.js'];
            var candidates = [];
            if (env.APPDATA) candidates.push(joinPath(node.sep, [env.APPDATA, 'npm'].concat(tail)));
            candidates.push(joinPath(node.sep, [node.dir].concat(tail)));
            candidates.push(joinPath(node.sep, [node.dir, '..', 'lib'].concat(tail)));
            candidates.push(joinPath('/', ['/usr/local/lib'].concat(tail)));
            candidates.push(joinPath('/', ['/opt/homebrew/lib'].concat(tail)));
            for (var i = 0; i < candidates.length; i++) {
                if (exists(candidates[i])) return { nodePath: 'node', cliPath: candidates[i] };
            }
        }
        return {
            error: 'Không tìm thấy trình chạy quy trình (runner). Chạy "premiere-pro-mcp --register-panel-runner" ' +
                'để đăng ký lại rồi mở lại panel (trên Windows cũng có thể cài lại bằng Setup.exe). ' +
                'Chạy "premiere-pro-mcp --doctor" nếu vẫn lỗi.'
        };
    }

    // ------------------------------------------------------------------- buildArgs

    /** The form value as the tool expects it; undefined for a number field left empty with no default. */
    function coerceField(field, raw) {
        var value = hasValue(raw) ? raw : field.default;
        if (field.type === 'toggle') return value === 'false' ? false : !!value;
        if (field.type === 'number') {
            var n = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.'));
            if (isNaN(n)) n = field.default;
            if (!isNumber(n)) return undefined;
            if (field.integer) n = Math.round(n);
            if (isNumber(field.min) && n < field.min) n = field.min;
            if (isNumber(field.max) && n > field.max) n = field.max;
            return n;
        }
        if (field.type === 'path') return isString(value) ? value.trim() : '';
        return value;
    }

    /**
     * Form values (by field key) to tool arguments, with the card defaults applied. Empty paths and
     * empty number fields without a default are left out. Rough cut: with a music file the cut
     * follows the music, so targetSec is not sent (it would cap the cut).
     */
    function buildArgs(card, formValues) {
        var form = formValues || {};
        var args = {};
        var fields = card.fields || [];
        for (var i = 0; i < fields.length; i++) {
            var field = fields[i];
            var value = coerceField(field, form[field.key]);
            if (value === undefined) continue;
            if (field.type === 'path' && value === '') continue;
            if (hasValue(field.omitValue) && value === field.omitValue) continue;
            if (field.map && Object.prototype.hasOwnProperty.call(field.map, value)) value = field.map[value];
            args[field.key] = value;
        }
        if (card.tool === 'workflow_rough_cut' && hasValue(args.musicPath)) delete args.targetSec;
        return args;
    }

    /** Vietnamese messages for what the editor must fix before the card can run. */
    function missingRequired(card, args) {
        var out = [];
        var fields = card.fields || [];
        for (var i = 0; i < fields.length; i++) {
            if (fields[i].required && !hasValue(args[fields[i].key])) out.push('Cần điền: ' + fields[i].label + '.');
        }
        if (card.tool === 'workflow_shorts' && args.minSec > args.maxSec) {
            out.push('"Ngắn nhất" không được lớn hơn "Dài nhất".');
        }
        if (card.tool === 'workflow_recap' && args.minSec >= args.maxSec) {
            out.push('"Ngắn nhất" phải nhỏ hơn "Dài nhất".');
        }
        if (card.tool === 'workflow_rough_cut' && !hasValue(args.musicPath) && !hasValue(args.targetSec)) {
            out.push('Cần điền: Thời lượng mong muốn (giây), hoặc chọn file nhạc.');
        }
        return out;
    }

    function normalizeSettings(raw) {
        var out = {};
        var src = raw && typeof raw === 'object' ? raw : {};
        for (var key in DEFAULT_SETTINGS) {
            out[key] = isString(src[key]) ? src[key].trim() : DEFAULT_SETTINGS[key];
        }
        return out;
    }

    function safeFileName(name) {
        return String(name || 'phu-de').replace(/[\\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'phu-de';
    }

    /** Adds the settings that apply to a run: the engine, and the output folder for the SRT file. */
    function applySettings(card, args, settings, sequenceName) {
        var out = {};
        for (var key in args) out[key] = args[key];
        var s = normalizeSettings(settings);
        if (s.asrEngine && ENGINE_TOOLS.indexOf(card.tool) >= 0) out.engine = s.asrEngine;
        if (card.tool === 'workflow_subtitles' && !out.outputPath && s.outputDir) {
            var sep = s.outputDir.indexOf('\\') >= 0 || /^[A-Za-z]:/.test(s.outputDir) ? '\\' : '/';
            out.outputPath = s.outputDir.replace(/[\\\/]+$/, '') + sep + safeFileName(sequenceName) + '.srt';
        }
        return out;
    }

    // --------------------------------------------------------------- reduceRunState

    function initialRunState() {
        return {
            status: 'idle',      // idle | starting | running | cancelling | done | failed
            current: null,       // { id, tool, cardId, dryRun }
            queue: [],           // jobs waiting behind the current one
            step: 0,            // 1-based step being run
            progress: 0,        // amount done, 0..stepCount (fractional while a step waits)
            stepCount: 0,
            label: '',
            result: null,
            cancelled: false,
            error: '',
            runnerReady: false,
            failedJobs: []       // queued jobs dropped because the runner exited
        };
    }

    function copyState(state) {
        var out = {};
        for (var key in state) out[key] = state[key];
        out.queue = state.queue.slice();
        return out;
    }

    function begin(next, job) {
        next.status = 'starting';
        next.current = job;
        next.step = 0;
        next.progress = 0;
        next.stepCount = 0;
        next.label = '';
        next.result = null;
        next.cancelled = false;
        next.error = '';
    }

    function isActive(status) {
        return status === 'starting' || status === 'running' || status === 'cancelling';
    }

    /** The Xem trước and Chạy buttons of a card are locked while that card's own job is active. */
    function isCardLocked(state, cardId) {
        return !!(state && state.current && isActive(state.status) && state.current.cardId === cardId);
    }

    /**
     * Whether a job that was waiting for the runner to start should still be sent. A job the
     * editor cancelled meanwhile (cancelling, or removed from the queue) must not run.
     */
    function shouldSendRun(state, id) {
        if (state.current && state.current.id === id) return state.status !== 'cancelling';
        for (var i = 0; i < state.queue.length; i++) if (state.queue[i].id === id) return true;
        return false;
    }

    /** Result a job gets when it was cancelled before it ever reached the runner. */
    function cancelledResult() {
        return { success: false, cancelled: true, steps: [], outputSequenceIds: [], partialSequenceIds: [], warnings: [] };
    }

    /**
     * State machine for one runner. Messages:
     *   { type: 'run', id, tool, cardId?, dryRun? }  the editor pressed a run button
     *   { type: 'cancel', id? }                      Hủy, or drop a queued job by id
     *   runner messages: ready, progress, result, log
     *   { type: 'runner-exit', error? }              the runner process ended
     * A job pressed while another is active waits in `queue` and starts as soon as the
     * current one ends. A result with cancelled:true is terminal: status `done` plus
     * `cancelled`. When a queued job starts, the one that just ended stays in `previous`.
     */
    function reduceRunState(state, message) {
        var next = copyState(state || initialRunState());
        if (!message || !message.type) return next;
        var id = message.id;

        switch (message.type) {
            case 'run': {
                var job = { id: id, tool: message.tool, cardId: message.cardId, dryRun: !!message.dryRun };
                next.failedJobs = [];
                if (isActive(next.status)) next.queue.push(job);
                else begin(next, job);
                return next;
            }
            case 'cancel': {
                if (id !== undefined && (!next.current || next.current.id !== id)) {
                    next.queue = next.queue.filter(function (j) { return j.id !== id; });
                    return next;
                }
                if (next.status === 'starting' || next.status === 'running') next.status = 'cancelling';
                return next;
            }
            case 'ready':
                next.runnerReady = true;
                return next;
            case 'progress': {
                if (!next.current || next.current.id !== id) return next;
                if (next.status === 'starting') next.status = 'running';
                next.step = message.step;
                next.progress = isNumber(message.progress) ? message.progress : Math.max(0, (message.step || 0) - 1);
                next.stepCount = message.stepCount;
                next.label = message.label || '';
                return next;
            }
            case 'result': {
                if (!next.current || next.current.id !== id) return next;
                var result = message.result;
                next.result = result;
                next.cancelled = !!(result && result.cancelled === true);
                next.status = next.cancelled || !result || result.success !== false ? 'done' : 'failed';
                next.current = null;
                delete next.previous;
                if (next.queue.length > 0) {
                    var finished = { status: next.status, result: next.result, cancelled: next.cancelled };
                    begin(next, next.queue.shift());
                    next.previous = finished;
                }
                return next;
            }
            case 'runner-exit': {
                next.runnerReady = false;
                var exitError = message.error || 'Trình chạy quy trình đã dừng đột ngột.';
                next.failedJobs = next.queue.map(function (j) {
                    return { id: j.id, cardId: j.cardId, error: 'Quy trình xếp hàng chưa chạy được vì runner đã dừng. ' + exitError };
                });
                next.queue = [];
                if (!next.current) return next;
                next.result = null;
                next.cancelled = false;
                next.status = 'failed';
                next.error = exitError;
                next.current = null;
                return next;
            }
            default:
                return next;
        }
    }

    // ---------------------------------------------------------------- describeResult

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    /** 72 becomes "1:12"; 3725 becomes "1:02:05". */
    function formatDuration(seconds) {
        var total = Math.max(0, Math.round(Number(seconds) || 0));
        var h = Math.floor(total / 3600);
        var m = Math.floor((total % 3600) / 60);
        var s = total % 60;
        return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
    }

    /** Position of a cut with tenths: 83.4 becomes "1:23.4". */
    function formatTime(seconds) {
        var n = Math.max(0, Number(seconds) || 0);
        var whole = Math.floor(n);
        var tenth = Math.round((n - whole) * 10);
        if (tenth === 10) { whole += 1; tenth = 0; }
        return formatDuration(whole) + '.' + tenth;
    }

    var REASON_LABELS = {
        'filler-A': 'từ ngập ngừng',
        'filler-B': 'từ câu giờ',
        'retake': 'câu vấp',
        'silence': 'khoảng lặng',
        'isolated': 'tiếng lẻ',
        'slate': 'câu đọc thử / xướng tên',
        'island': 'mẩu tiếng không có lời'
    };

    function describeSummary(s, lines, warnings) {
        if (isNumber(s.cutCount)) {
            var done = isNumber(s.removedSeconds);
            var removed = done ? s.removedSeconds : s.plannedRemovedSeconds;
            lines.push(s.cutCount + ' vết cắt' + (isNumber(removed) ? ', ' + (done ? 'bớt ' : 'sẽ bớt ') + formatDuration(removed) : ''));
        }
        if (isNumber(s.durationBefore) && isNumber(s.durationAfter)) {
            lines.push('Thời lượng: ' + formatDuration(s.durationBefore) + ' → ' + formatDuration(s.durationAfter));
        }
        if (isNumber(s.targetLufs)) lines.push('Âm lượng chuẩn hóa: ' + s.targetLufs + ' LUFS');
        if (s.mode) lines.push('Chế độ chọn: ' + (s.mode === 'shots' ? 'theo cảnh quay' : 'theo lời thoại'));
        if (isNumber(s.segmentCount)) {
            lines.push(s.segmentCount + ' đoạn' + (isNumber(s.totalSec) ? ', tổng ' + formatDuration(s.totalSec) : ''));
        }
        if (isNumber(s.durationSec)) lines.push('Thời lượng recap: ' + formatDuration(s.durationSec));
        if (Array.isArray(s.picks)) {
            lines.push('Chọn được ' + s.picks.length + ' đoạn nổi bật' + (isNumber(s.candidates) ? ' (trong ' + s.candidates + ' ứng viên)' : ''));
        }
        if (Array.isArray(s.shorts)) lines.push('Đã dựng ' + s.shorts.length + ' short');
        if (isNumber(s.cueCount)) lines.push(s.cueCount + ' dòng phụ đề');
        if (s.srtPath) lines.push('File SRT: ' + s.srtPath);
        if (isNumber(s.shotCount)) {
            lines.push(s.shotCount + ' shot' + (isNumber(s.totalSeconds) ? ', tổng ' + formatDuration(s.totalSeconds) : ''));
        }
        if (isNumber(s.bpm)) lines.push('Nhịp nhạc: ' + Math.round(s.bpm) + ' BPM');
        if (isNumber(s.scoredFiles)) lines.push('Đã chấm điểm ' + s.scoredFiles + ' file');
        if (s.ducked) lines.push('Đã hạ nhạc khi có voice-over');
        if (Array.isArray(s.qaFindings)) {
            lines.push(s.qaFindings.length === 0 ? 'Kiểm tra chất lượng: không có lưu ý' : 'Kiểm tra chất lượng: ' + s.qaFindings.length + ' lưu ý');
        } else if (isNumber(s.qaFindings)) {
            // workflow_clean_voiceover reports the number of findings.
            lines.push(s.qaFindings === 0 ? 'QA: không có vấn đề' : 'QA: ' + s.qaFindings + ' vấn đề');
        }
        if (s.outputName) lines.push('Sequence mới: ' + s.outputName);
        if (s.backupPath) lines.push('Bản backup: ' + s.backupPath);
        if (Array.isArray(s.skippedClips) && s.skippedClips.length > 0) {
            warnings.push('Bỏ qua ' + s.skippedClips.length + ' clip (đổi tốc độ, chạy ngược hoặc không có media).');
        }
        if (s.verified === false) warnings.push('Chưa xác nhận được kết quả sau khi dựng. Hãy kiểm tra sequence mới.');
    }

    /** Result of a workflow_* tool as Vietnamese sentences for the panel. */
    function describeResult(result) {
        var r = result || {};
        var s = r.summary || {};
        var lines = [];
        var warnings = [];
        var title;
        if (r.cancelled) title = 'Đã hủy';
        else if (r.success === false) title = 'Chưa hoàn tất';
        else if (s.dryRun) title = 'Xem trước (chưa sửa gì)';
        else title = 'Xong';

        describeSummary(s, lines, warnings);

        var raw = Array.isArray(r.warnings) ? r.warnings : [];
        for (var i = 0; i < raw.length; i++) {
            var text = viMessage(String(raw[i])).replace(/^Lỗi: /, '');
            if (warnings.indexOf(text) < 0) warnings.push(text);
        }
        return {
            title: title,
            lines: lines,
            warnings: warnings,
            sequenceIds: Array.isArray(r.outputSequenceIds) ? r.outputSequenceIds.slice() : [],
            // Only these are offered for deletion (Xóa bản sao); finished outputs are kept.
            partialSequenceIds: Array.isArray(r.partialSequenceIds) ? r.partialSequenceIds.slice() : []
        };
    }

    /**
     * The cuts of a Dọn voice-over preview, one entry each: { time, reason, text }.
     * Reads summary.cuts (reason and sentence per cut); falls back to steps[].detail.ranges, then summary.plan.
     */
    function listCuts(result) {
        var r = result || {};
        var ranges = null;
        if (r.summary && Array.isArray(r.summary.cuts)) ranges = r.summary.cuts;
        var steps = Array.isArray(r.steps) ? r.steps : [];
        for (var i = 0; !ranges && i < steps.length; i++) {
            var d = steps[i] && steps[i].detail;
            if (d && Array.isArray(d.ranges)) ranges = d.ranges;
        }
        if (!ranges && r.summary && Array.isArray(r.summary.plan)) ranges = r.summary.plan;
        if (!ranges) return [];
        var out = [];
        for (var j = 0; j < ranges.length; j++) {
            var range = ranges[j] || {};
            out.push({
                time: formatTime(range.start) + ' - ' + formatTime(range.end),
                reason: REASON_LABELS[range.reason] || (range.reason ? String(range.reason) : ''),
                text: isString(range.text) ? range.text : ''
            });
        }
        return out;
    }

    // -------------------------------------------------------------------------- vi

    var SKIP_REASONS_VI = {
        'its speed is not 100%': 'tốc độ khác 100%',
        'it has no media file': 'không có file media'
    };

    /**
     * English messages the earlier tools pass through, as [pattern, Vietnamese, keepDetail].
     * First match wins. With keepDetail the text captured after a colon is appended. The
     * Vietnamese part may be a function of the match, to keep the numbers of the message.
     */
    var KNOWN_MESSAGES = [
        [/^Backup failed/i, 'Không sao lưu được project: hãy lưu project (Ctrl+S) rồi chạy lại.'],
        [/^Only (\d+) of (\d+) audio crossfades/i, function (m) {
            return 'Chỉ đặt được ' + m[1] + '/' + m[2] + ' crossfade âm thanh. Các vết cắt vẫn đúng.';
        }],
        [/^The sequence shortened by ([\d.]+)s but ([\d.]+)s was planned/i, function (m) {
            return 'Sequence chỉ ngắn đi ' + m[1] + ' giây, dự kiến ' + m[2] + ' giây. Có thể track bị khóa hoặc sync lock tắt ' +
                'làm lệch hình và tiếng. Hãy Undo (Ctrl+Z), mở khóa track rồi chạy lại.';
        }],
        [/^CPU fallback/i, 'Không dùng được GPU: nhận dạng giọng nói chạy bằng CPU, chậm hơn 3-4 lần.'],
        [/^Skipped (\d+) clip\(s\): (.*?)\.?$/i, function (m) {
            var reasons = m[2].split('; ');
            for (var i = 0; i < reasons.length; i++) reasons[i] = SKIP_REASONS_VI[reasons[i]] || reasons[i];
            return 'Bỏ qua ' + m[1] + ' clip: ' + reasons.join('; ') + '.';
        }],
        [/^Repaired (\d+) word timestamp/i, function (m) {
            return 'Đã sửa mốc thời gian của ' + m[1] + ' từ không có độ dài.';
        }],
        [/^No speech was recognised/i, 'Không nhận dạng được lời thoại nào trên các track thoại.'],
        [/^Pass expectedFingerprint/i, 'Nên truyền expectedFingerprint để phát hiện sequence bị sửa sau khi chọn đoạn.'],
        [/^The intermediate subsequence could not be deleted/i, 'Không xóa được subsequence trung gian; xóa tay trong project.'],
        [/^Captions were rendered at (\S+) but the short is (\S+?);/i, function (m) {
            return 'Phụ đề được dựng ở ' + m[1] + ' nhưng short là ' + m[2] + '; Premiere sẽ co giãn lớp phụ đề.';
        }],
        [/^The caption file could not be moved into the Shorts bin/i, 'Không chuyển được file phụ đề vào bin Shorts.'],
        [/^qa_sequence found (\d+) error/i, function (m) {
            return 'qa_sequence thấy ' + m[1] + ' lỗi trên short; xem qa.findings.';
        }],
        [/^Auto Reframe had no subject-tracking keyframes after (\d+) s/i, function (m) {
            return 'Sau ' + m[1] + ' giây Auto Reframe vẫn chưa có keyframe bám chủ thể; kiểm tra khung hình trong Premiere.';
        }],
        [/^The short is (\S+), not 9:16/i, function (m) {
            return 'Short có kích thước ' + m[1] + ', không phải 9:16.';
        }],
        [/^The short lasts ([\d.]+) s, expected ([\d.]+) s/i, function (m) {
            return 'Short dài ' + m[1] + ' giây, dự kiến ' + m[2] + ' giây.';
        }],
        [/^The caption clip was not found on the top video track/i, 'Không thấy clip phụ đề trên track video trên cùng.'],
        [/^Caption render failed(?:, nothing in the project was changed)?(?::\s*(.*))?$/i, 'Không dựng được phụ đề burn-in', true],
        [/^Auto Reframe did not return a sequence/i, 'Premiere không trả về sequence sau khi Auto Reframe. Thử lại, hoặc kiểm tra Auto Reframe trong Premiere.'],
        [/^No words fall in (?:the sequence|this range)/i, 'Không có từ nào trong đoạn này, nên không có phụ đề để tạo.'],
        [/^"(.+)" is neither a folder on disk nor a bin in the project/i, function (m) {
            return '"' + m[1] + '" không phải thư mục trên máy, cũng không phải bin trong dự án. Bấm "Từ dự án…" để chọn bin.';
        }],
        [/^File not found: "(.+)" is neither a file on disk nor an imported/i, function (m) {
            return 'Không tìm thấy "' + m[1] + '" trên máy hay trong dự án. Bấm "Từ dự án…" để chọn file đã import.';
        }],
        [/^Several bins are named "(.+)": (.+)\. Give the full bin path/i, function (m) {
            return 'Có nhiều bin tên "' + m[1] + '": ' + m[2] + '. Gõ đủ đường dẫn bin, ví dụ "Cha/Con".';
        }],
        [/^"(.+)" matches (\d+) project items: (.+?)\. Give the bin path/i, function (m) {
            return '"' + m[1] + '" trùng ' + m[2] + ' mục trong dự án: ' + m[3] + '. Gõ kèm bin ("bin/tên") hoặc chọn bằng "Từ dự án…".';
        }],
        [/^Nothing is selected in the Project panel/i, 'Chưa chọn gì trong panel Project. Chọn clip hoặc bin ở đó rồi chạy lại.'],
        [/^No (\S+) item is selected in the Project panel/i, 'Chưa chọn file nhạc nào trong panel Project.'],
        [/^Cannot use (.+?): its (\d+) video clip\(s\) are offline/i, function (m) {
            return 'Không dùng được ' + m[1].replace('the Project panel selection', 'mục đang chọn') + ': cả ' + m[2] + ' clip video đều offline. Relink trong Premiere trước.';
        }],
        [/^Cannot use (.+?): it holds no video clips/i, function (m) {
            return m[1].replace('the Project panel selection', 'Mục đang chọn').replace(/^bin/, 'Bin') + ' không có clip video nào (bin con không được tính).';
        }],
        [/^Project item "(.+)" is offline/i, function (m) {
            return 'File "' + m[1] + '" trong dự án đang offline. Relink trong Premiere trước.';
        }],
        [/^Sequence not found/i,'Không tìm thấy sequence. Bấm làm mới danh sách sequence rồi chọn lại.'],
        [/^Tool '.*' not found/i, 'Không tìm thấy công cụ cần dùng. Cập nhật premiere-pro-mcp rồi mở lại panel.'],
        [/already exists|must not exist/i, 'File đã tồn tại và sẽ không bị ghi đè. Đổi tên hoặc chọn thư mục khác.'],
        [/ffmpeg.*(?:not found|missing|not installed)|(?:missing|not found).*ffmpeg/i, 'Thiếu ffmpeg. Chạy "premiere-pro-mcp --doctor" để kiểm tra rồi thử lại.'],
        [/sidecar.*(?:not installed|missing|not found)/i, 'Chưa cài bộ phân tích giọng nói. Chạy "premiere-pro-mcp --doctor" để kiểm tra.'],
        [/timed? ?out|timeout/i, 'Premiere không phản hồi kịp. Chờ Premiere xong việc đang làm rồi thử lại.'],
        [/bridge.*(?:not running|not connected)|panel.*not (?:running|connected)/i, 'Premiere chưa kết nối. Mở panel TeamTrau PremiereProControl trong Premiere rồi thử lại.'],
        [/^No active sequence/i, 'Premiere chưa mở sequence nào. Mở một sequence rồi thử lại.']
    ];

    function hasVietnamese(text) {
        return /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i.test(text);
    }

    /**
     * One message in Vietnamese; unknown English text is kept and prefixed with "Lỗi: ".
     * A "Short N: " prefix (workflow_shorts) is kept around the translated message.
     */
    function viMessage(text) {
        var raw = String(text === undefined || text === null ? '' : text).trim();
        if (!raw) return '';
        var prefixed = /^(Short \d+): (.+)$/.exec(raw);
        if (prefixed) {
            var inner = viMessage(prefixed[2]);
            return inner.indexOf('Lỗi: ') === 0
                ? 'Lỗi: ' + prefixed[1] + ': ' + inner.slice('Lỗi: '.length)
                : prefixed[1] + ': ' + inner;
        }
        if (raw.indexOf('music-chopped') === 0) return raw.replace(/^music-chopped:\s*/, 'Nhạc nền bị cắt đứt: ');
        for (var i = 0; i < KNOWN_MESSAGES.length; i++) {
            var entry = KNOWN_MESSAGES[i];
            var m = entry[0].exec(raw);
            if (!m) continue;
            if (typeof entry[1] === 'function') return entry[1](m);
            return entry[1] + (entry[2] && m[1] ? ': ' + m[1] : '');
        }
        return hasVietnamese(raw) ? raw : 'Lỗi: ' + raw;
    }

    function firstErrorText(result) {
        if (isString(result.error) && result.error) return result.error;
        if (result.error && isString(result.error.message)) return result.error.message;
        var steps = Array.isArray(result.steps) ? result.steps : [];
        for (var i = steps.length - 1; i >= 0; i--) {
            var step = steps[i];
            if (step && step.ok === false) {
                var d = step.detail;
                var why = isString(d) ? d : d && isString(d.error) ? d.error : '';
                return step.label ? step.label + (why ? ': ' + why : '') : why;
            }
        }
        return '';
    }

    /** firstErrorText gives "<step label>: <detail>"; translate only the detail. */
    function viErrorText(text) {
        var idx = text.indexOf(': ');
        if (idx > 0 && hasVietnamese(text.slice(0, idx))) {
            return text.slice(0, idx) + ': ' + viMessage(text.slice(idx + 2)).replace(/^Lỗi: /, '');
        }
        return viMessage(text);
    }

    /** Error text for the editor: the translated error, then what to do next (nextStep). */
    function vi(errorResult) {
        var r = errorResult || {};
        var text = firstErrorText(r);
        var message = text ? viErrorText(text) : 'Có lỗi nhưng không rõ nguyên nhân. Xem tab Kết nối để biết thêm.';
        var next = isString(r.nextStep) && r.nextStep ? viMessage(r.nextStep).replace(/^Lỗi: /, '') : '';
        return next && next !== message ? message + '\n' + next : message;
    }

    var PROJECT_SELECTION = '@selection';

    /**
     * Choices for a path field's "Từ dự án…" list, from list_project_media. Footage fields get
     * the Project panel selection and every bin holding video; music fields get audio items.
     * Each choice is { value, label }; value goes into the field as typed.
     */
    function projectChoices(media, fieldKey) {
        var items = media && Array.isArray(media.items) ? media.items : [];
        var bins = media && Array.isArray(media.bins) ? media.bins : [];
        var out = [];
        var i;
        if (fieldKey === 'folderPath') {
            var selected = 0;
            var selectedBins = [];
            for (i = 0; i < bins.length; i++) if (bins[i].selected) selectedBins.push(bins[i].path);
            for (i = 0; i < items.length; i++) {
                if (items[i].kind !== 'video') continue;
                var inSelectedBin = false;
                for (var b = 0; b < selectedBins.length; b++) if (items[i].bin === selectedBins[b]) inSelectedBin = true;
                if (items[i].selected || inSelectedBin) selected++;
            }
            if (selected > 0) out.push({ value: PROJECT_SELECTION, label: 'Mục đang chọn trong Project (' + selected + ' clip)' });
            for (i = 0; i < bins.length; i++) {
                var count = 0;
                for (var j = 0; j < items.length; j++) if (items[j].kind === 'video' && items[j].bin === bins[i].path) count++;
                if (count > 0) out.push({ value: bins[i].path, label: 'Bin ' + bins[i].path + ' (' + count + ' clip)' });
            }
            return out;
        }
        for (i = 0; i < items.length; i++) {
            if (items[i].kind !== 'audio') continue;
            var where = items[i].bin ? items[i].bin + '/' + items[i].name : items[i].name;
            out.push({ value: items[i].mediaPath, label: (items[i].selected ? '★ ' : '') + where + (items[i].offline ? ' (offline)' : '') });
        }
        return out;
    }

    return {
        ASR_ENGINES: ASR_ENGINES,
        PROJECT_SELECTION: PROJECT_SELECTION,
        projectChoices: projectChoices,
        DEFAULT_SETTINGS: DEFAULT_SETTINGS,
        resolveRunner: resolveRunner,
        buildArgs: buildArgs,
        missingRequired: missingRequired,
        normalizeSettings: normalizeSettings,
        applySettings: applySettings,
        initialRunState: initialRunState,
        reduceRunState: reduceRunState,
        isCardLocked: isCardLocked,
        shouldSendRun: shouldSendRun,
        cancelledResult: cancelledResult,
        describeResult: describeResult,
        listCuts: listCuts,
        formatDuration: formatDuration,
        vi: vi
    };
});
