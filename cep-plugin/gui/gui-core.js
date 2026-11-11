/**
 * Pure logic of the "Quy trình" tab: no DOM, no Node APIs, so it can be tested directly.
 * UMD and ES5 on purpose: CEP's Chromium is old, and the file is loaded both by a
 * <script> tag (window.GuiCore) and by tests (module.exports).
 */
(function (root, factory) {
    if (typeof module === 'object' && module && module.exports) {
        module.exports = factory();
    } else {
        root.GuiCore = factory();
    }
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
            error: 'Không tìm thấy trình chạy quy trình (runner). Chạy "premiere-pro-mcp --doctor" để kiểm tra, ' +
                'hoặc cài lại bằng Setup.exe rồi mở lại panel.'
        };
    }

    // ------------------------------------------------------------------- buildArgs

    function coerceField(field, raw) {
        var value = hasValue(raw) ? raw : field.default;
        if (field.type === 'toggle') return value === 'false' ? false : !!value;
        if (field.type === 'number') {
            var n = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.'));
            if (isNaN(n)) n = field.default;
            if (field.integer) n = Math.round(n);
            if (isNumber(field.min) && n < field.min) n = field.min;
            if (isNumber(field.max) && n > field.max) n = field.max;
            return n;
        }
        if (field.type === 'path') return isString(value) ? value.trim() : '';
        return value;
    }

    /** Form values (by field key) to tool arguments, with the card defaults applied. Empty paths are left out. */
    function buildArgs(card, formValues) {
        var form = formValues || {};
        var args = {};
        var fields = card.fields || [];
        for (var i = 0; i < fields.length; i++) {
            var field = fields[i];
            var value = coerceField(field, form[field.key]);
            if (field.type === 'path' && value === '') continue;
            if (hasValue(field.omitValue) && value === field.omitValue) continue;
            if (field.map && Object.prototype.hasOwnProperty.call(field.map, value)) value = field.map[value];
            args[field.key] = value;
        }
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
            step: 0,
            stepCount: 0,
            label: '',
            result: null,
            cancelled: false,
            error: '',
            runnerReady: false
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
        next.stepCount = 0;
        next.label = '';
        next.result = null;
        next.cancelled = false;
        next.error = '';
    }

    function isActive(status) {
        return status === 'starting' || status === 'running' || status === 'cancelling';
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
                next.queue = [];
                if (!next.current) return next;
                next.result = null;
                next.cancelled = false;
                next.status = 'failed';
                next.error = message.error || 'Trình chạy quy trình đã dừng đột ngột.';
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
        'silence': 'khoảng lặng'
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
            sequenceIds: Array.isArray(r.outputSequenceIds) ? r.outputSequenceIds.slice() : []
        };
    }

    /**
     * The cuts of a Dọn voice-over preview, one entry each: { time, reason, text }.
     * Reads steps[].detail.ranges when a step lists them, else summary.plan.
     */
    function listCuts(result) {
        var r = result || {};
        var ranges = null;
        var steps = Array.isArray(r.steps) ? r.steps : [];
        for (var i = 0; i < steps.length; i++) {
            var d = steps[i] && steps[i].detail;
            if (d && Array.isArray(d.ranges)) { ranges = d.ranges; break; }
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

    /**
     * English messages the earlier tools pass through, as [pattern, Vietnamese, keepDetail].
     * First match wins. With keepDetail the text captured after a colon is appended.
     */
    var KNOWN_MESSAGES = [
        [/^Caption render failed(?:, nothing in the project was changed)?(?::\s*(.*))?$/i, 'Không dựng được phụ đề burn-in', true],
        [/^Auto Reframe did not return a sequence/i, 'Premiere không trả về sequence sau khi Auto Reframe. Thử lại, hoặc kiểm tra Auto Reframe trong Premiere.'],
        [/^No words fall in (?:the sequence|this range)/i, 'Không có từ nào trong đoạn này, nên không có phụ đề để tạo.'],
        [/^Sequence not found/i, 'Không tìm thấy sequence. Bấm làm mới danh sách sequence rồi chọn lại.'],
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

    /** One message in Vietnamese; unknown English text is kept and prefixed with "Lỗi: ". */
    function viMessage(text) {
        var raw = String(text === undefined || text === null ? '' : text).trim();
        if (!raw) return '';
        if (raw.indexOf('music-chopped') === 0) return raw.replace(/^music-chopped:\s*/, 'Nhạc nền bị cắt đứt: ');
        for (var i = 0; i < KNOWN_MESSAGES.length; i++) {
            var entry = KNOWN_MESSAGES[i];
            var m = entry[0].exec(raw);
            if (m) return entry[1] + (entry[2] && m[1] ? ': ' + m[1] : '');
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

    return {
        ASR_ENGINES: ASR_ENGINES,
        DEFAULT_SETTINGS: DEFAULT_SETTINGS,
        resolveRunner: resolveRunner,
        buildArgs: buildArgs,
        missingRequired: missingRequired,
        normalizeSettings: normalizeSettings,
        applySettings: applySettings,
        initialRunState: initialRunState,
        reduceRunState: reduceRunState,
        describeResult: describeResult,
        listCuts: listCuts,
        formatDuration: formatDuration,
        vi: vi
    };
});
