/**
 * DOM and runner process of the "Quy trình" tab. The logic that can be tested without a
 * browser lives in gui-core.js; this file only draws it and talks to the runner.
 * ES5 on purpose (CEP's Chromium is old).
 */
(function () {
    'use strict';

    var Core = window.GuiCore;
    var fs = require('fs');
    var path = require('path');
    var os = require('os');
    var childProcess = require('child_process');

    var MCP_HOME = process.env.PREMIERE_MCP_HOME || path.join(os.homedir(), '.premiere-mcp');
    var SETTINGS_PATH = path.join(MCP_HOME, 'gui-settings.json');
    var FILLERS_PATH = path.join(MCP_HOME, 'fillers-vi.json');
    var PANEL_CONFIG_PATH = path.join(os.homedir(), '.premiere-mcp-bridge', 'config.json');
    var STDERR_LINES = 20;

    var cards = [];
    var settings = Core.normalizeSettings(null);
    var runState = Core.initialRunState();
    var runner = null;             // { child, ready, readyWaiters: [], buffer }
    var stderrTail = [];
    var jobs = {};                 // run id -> { id, card, args, dryRun }
    var calls = {};                // call id -> callback(result)
    var counter = 0;
    var startedAt = 0;
    var ticker = null;
    var lastRun = null;            // { job, result } of the last finished run, for Thử lại

    function $(id) { return document.getElementById(id); }

    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        var key;
        for (key in (attrs || {})) {
            if (key === 'text') node.textContent = attrs[key];
            else if (key === 'className') node.className = attrs[key];
            else if (key === 'onclick') node.onclick = attrs[key];
            else node.setAttribute(key, attrs[key]);
        }
        var list = children || [];
        for (var i = 0; i < list.length; i++) if (list[i]) node.appendChild(list[i]);
        return node;
    }

    function readJson(file, fallback) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            return fallback;
        }
    }

    function bridgeLog(message, level) {
        if (window.bridge && window.bridge.log) window.bridge.log(message, level || 'info');
    }

    // --------------------------------------------------------------------- settings

    function loadSettings() {
        settings = Core.normalizeSettings(readJson(SETTINGS_PATH, null));
    }

    function saveSettings(next) {
        // Keep keys this version does not know (e.g. written by a later one).
        var existing = readJson(SETTINGS_PATH, {});
        if (!existing || typeof existing !== 'object') existing = {};
        for (var key in next) existing[key] = next[key];
        fs.mkdirSync(MCP_HOME, { recursive: true });
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(existing, null, 2));
        settings = Core.normalizeSettings(existing);
    }

    // ----------------------------------------------------------------------- runner

    function runnerStatus(text) {
        var node = $('runnerStatus');
        if (node) node.textContent = text;
        var log = $('runnerLog');
        if (log) {
            log.hidden = stderrTail.length === 0;
            log.innerHTML = '';
            for (var i = 0; i < stderrTail.length; i++) {
                log.appendChild(el('div', { className: 'log-entry warning', text: stderrTail[i] }));
            }
        }
    }

    function pushStderr(text) {
        var lines = String(text).split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) if (lines[i].trim()) stderrTail.push(lines[i]);
        if (stderrTail.length > STDERR_LINES) stderrTail = stderrTail.slice(-STDERR_LINES);
    }

    function currentTempDir() {
        return window.bridge && window.bridge.getTempDirectory ? window.bridge.getTempDirectory() : '';
    }

    function startRunnerProcess(onError) {
        var config = readJson(PANEL_CONFIG_PATH, {});
        var located = Core.resolveRunner(
            { runner: config.runner, runnerOverride: settings.runnerPath },
            process.env,
            function (p) { try { return fs.existsSync(p); } catch (e) { return false; } }
        );
        if (located.error) {
            onError(located.error);
            return null;
        }
        var env = {};
        var key;
        for (key in process.env) env[key] = process.env[key];
        env.PREMIERE_TEMP_DIR = currentTempDir();
        var child;
        try {
            child = childProcess.spawn(located.nodePath, [located.cliPath, '--panel-runner'], { env: env, windowsHide: true });
        } catch (e) {
            onError('Không khởi động được runner: ' + e.message);
            return null;
        }
        var state = { child: child, ready: false, readyWaiters: [], buffer: '' };
        runner = state;
        stderrTail = [];
        runnerStatus('Đang khởi động runner…');

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', function (chunk) {
            state.buffer += chunk;
            var index;
            while ((index = state.buffer.indexOf('\n')) >= 0) {
                var line = state.buffer.slice(0, index).trim();
                state.buffer = state.buffer.slice(index + 1);
                if (line) onRunnerLine(line, state);
            }
        });
        child.stdin.on('error', function (err) {
            // EPIPE after the child died: the exit handler reports the failure.
            pushStderr('stdin: ' + err.message);
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', function (chunk) { pushStderr(chunk); });
        child.on('error', function (err) {
            pushStderr(err.message);
            onRunnerExit(state, err.message);
        });
        child.on('exit', function (code) {
            onRunnerExit(state, 'Runner đã dừng (mã ' + code + ').');
        });
        return state;
    }

    function ensureRunner(onReady, onError) {
        if (runner && runner.ready) return onReady();
        if (runner) {
            runner.readyWaiters.push({ ok: onReady, fail: onError });
            return;
        }
        var state = startRunnerProcess(onError);
        if (state) state.readyWaiters.push({ ok: onReady, fail: onError });
    }

    function onRunnerLine(line, state) {
        var message;
        try { message = JSON.parse(line); } catch (e) { pushStderr(line); return; }
        if (!message || typeof message !== 'object') return;
        if (message.type === 'ready') {
            state.ready = true;
            runnerStatus('Runner sẵn sàng (phiên bản ' + message.version + ').');
            var waiters = state.readyWaiters;
            state.readyWaiters = [];
            for (var i = 0; i < waiters.length; i++) waiters[i].ok();
            dispatch(message);
        } else if (message.type === 'log') {
            pushStderr('[' + message.level + '] ' + message.message);
            runnerStatus($('runnerStatus') ? $('runnerStatus').textContent : '');
        } else if (message.type === 'progress') {
            dispatch(message);
        } else if (message.type === 'result') {
            if (calls[message.id]) {
                var callback = calls[message.id];
                delete calls[message.id];
                callback(message.result);
            } else {
                onWorkflowResult(message);
            }
        }
    }

    function onRunnerExit(state, text) {
        if (runner !== state) return;
        runner = null;
        var waiters = state.readyWaiters;
        state.readyWaiters = [];
        for (var i = 0; i < waiters.length; i++) waiters[i].fail(text);
        var pending = calls;
        calls = {};
        for (var id in pending) pending[id]({ success: false, error: text });
        runnerStatus(text + ' Runner sẽ tự khởi động lại ở lần chạy sau.');
        if (runState.current) {
            var job = jobs[runState.current.id];
            var failure = { success: false, error: text, steps: [] };
            lastRun = { job: job, result: failure };
            dispatch({ type: 'runner-exit', error: text });
            renderResult(job, failure, true);
        } else {
            dispatch({ type: 'runner-exit', error: text });
        }
        var dropped = runState.failedJobs;
        var box = $('guiResult');
        for (var d = 0; d < dropped.length; d++) {
            delete jobs[dropped[d].id];
            box.hidden = false;
            box.appendChild(el('div', { className: 'gui-error', text: cardTitle(dropped[d].cardId) + ': ' + dropped[d].error }));
        }
    }

    function cardTitle(cardId) {
        for (var i = 0; i < cards.length; i++) if (cards[i].id === cardId) return cards[i].title;
        return 'Quy trình';
    }

    function send(message) {
        if (!runner || !runner.child || !runner.child.stdin.writable) return false;
        runner.child.stdin.write(JSON.stringify(message) + '\n');
        return true;
    }

    function stopRunner() {
        if (runner && runner.child) {
            try { runner.child.stdin.end(); } catch (e) {}
            var old = runner;
            runner = null;
            var stopped = 'Runner đã được dừng. Thử lại để khởi động lại.';
            var waiting = old.readyWaiters;
            old.readyWaiters = [];
            for (var w = 0; w < waiting.length; w++) waiting[w].fail(stopped);
            var pending = calls;
            calls = {};
            for (var id in pending) pending[id]({ success: false, error: stopped });
            setTimeout(function () { try { old.child.kill(); } catch (e) {} }, 3000);
        }
    }

    /** Runs one tool on the runner outside the workflow state (list, open, delete a sequence). */
    function callTool(tool, args, done) {
        ensureRunner(function () {
            var id = 'call-' + (++counter);
            calls[id] = done;
            if (!send({ type: 'run', id: id, tool: tool, args: args })) {
                delete calls[id];
                done({ success: false, error: 'Không gửi được lệnh tới runner.' });
            }
        }, function (error) {
            done({ success: false, error: error });
        });
    }

    // ------------------------------------------------------------------ run state UI

    function isActive() {
        return runState.status === 'starting' || runState.status === 'running' || runState.status === 'cancelling';
    }

    var cardButtons = {};          // card id -> [Xem trước, Chạy trên bản sao]

    function updateCardLocks() {
        for (var id in cardButtons) {
            var locked = Core.isCardLocked(runState, id);
            for (var i = 0; i < cardButtons[id].length; i++) cardButtons[id][i].disabled = locked;
        }
    }

    function dispatch(message) {
        runState = Core.reduceRunState(runState, message);
        updateCardLocks();
        renderProgress();
    }

    function elapsedText() {
        return startedAt ? Core.formatDuration((Date.now() - startedAt) / 1000) : '0:00';
    }

    function renderProgress() {
        var box = $('guiProgress');
        if (!box) return;
        if (isActive() && !ticker) {
            if (!startedAt) startedAt = Date.now();
            ticker = setInterval(renderProgress, 1000);
        }
        if (!isActive() && ticker) {
            clearInterval(ticker);
            ticker = null;
            startedAt = 0;
        }
        box.hidden = !isActive();
        if (!isActive()) return;

        var count = runState.stepCount || 1;
        // progress is the amount done (fractional while a step waits); step is the step being run.
        var done = typeof runState.progress === 'number' ? Math.min(runState.progress, count) : (runState.step > 0 ? runState.step - 1 : 0);
        $('guiBarFill').style.width = (done / count * 100) + '%';
        var pulse = $('guiBarPulse');
        pulse.style.left = (done / count * 100) + '%';
        pulse.style.width = (100 / count) + '%';

        var text;
        if (runState.status === 'cancelling') text = 'Đang hủy… chờ Premiere xong thao tác hiện tại';
        else if (runState.step > 0) text = 'Bước ' + runState.step + '/' + runState.stepCount + ': ' + runState.label;
        else text = 'Đang khởi động…';
        $('guiStep').textContent = text;
        var queued = runState.queue.length;
        $('guiMeta').textContent = 'Đã chạy ' + elapsedText();
        $('guiQueue').textContent = queued > 0 ? queued + ' quy trình đang xếp hàng' : '';
        $('guiCancel').disabled = runState.status === 'cancelling';
    }

    // ------------------------------------------------------------------ running cards

    function selectedSequence() {
        var select = $('guiSequence');
        var option = select && select.options[select.selectedIndex];
        return { id: select ? select.value : '', name: option && select.value ? option.textContent : '' };
    }

    function readForm(card) {
        var values = {};
        for (var i = 0; i < card.fields.length; i++) {
            var field = card.fields[i];
            var input = $('f-' + card.id + '-' + field.key);
            if (!input) continue;
            values[field.key] = field.type === 'toggle' ? input.checked : input.value;
        }
        return values;
    }

    function runCard(card, dryRun) {
        clearResult();
        var args = Core.buildArgs(card, readForm(card));
        var problems = Core.missingRequired(card, args);
        if (problems.length > 0) {
            showError(problems.join('\n'));
            return;
        }
        var sequence = selectedSequence();
        args = Core.applySettings(card, args, settings, sequence.name);
        if (sequence.id) args.sequenceId = sequence.id;
        args.dryRun = !!dryRun;
        startJob({ id: 'run-' + (++counter), card: card, args: args, dryRun: !!dryRun });
    }

    function startJob(job) {
        jobs[job.id] = job;
        dispatch({ type: 'run', id: job.id, tool: job.card.tool, cardId: job.card.id, dryRun: job.dryRun });
        // The panel starts the bridge when it opens; make sure it is up before the runner uses it.
        if (window.bridge && !window.bridge.isConnected && window.bridge.startBridge) window.bridge.startBridge();
        ensureRunner(function () {
            if (!Core.shouldSendRun(runState, job.id)) {
                // Cancelled while the runner was starting: it never ran, so finish it here.
                if (runState.current && runState.current.id === job.id) {
                    var cancelled = Core.cancelledResult();
                    delete jobs[job.id];
                    lastRun = { job: job, result: cancelled };
                    dispatch({ type: 'result', id: job.id, result: cancelled });
                    renderResult(job, cancelled, false);
                } else {
                    delete jobs[job.id];
                }
                return;
            }
            if (!send({ type: 'run', id: job.id, tool: job.card.tool, args: job.args })) {
                failJob(job, 'Không gửi được lệnh tới runner.');
            }
        }, function (error) {
            failJob(job, error);
        });
    }

    function failJob(job, error) {
        var failure = { success: false, error: error, steps: [] };
        lastRun = { job: job, result: failure };
        dispatch({ type: 'result', id: job.id, result: failure });
        renderResult(job, failure, false);
    }

    function onWorkflowResult(message) {
        var job = jobs[message.id];
        if (!job) return;
        delete jobs[message.id];
        lastRun = { job: job, result: message.result };
        var wasCurrent = runState.current && runState.current.id === message.id;
        dispatch(message);
        if (wasCurrent || runState.queue.length === 0) renderResult(job, message.result, false);
    }

    function cancelRun() {
        if (!runState.current) return;
        var id = runState.current.id;
        dispatch({ type: 'cancel', id: id });
        send({ type: 'cancel', id: id });
    }

    // ------------------------------------------------------------------- result area

    function clearResult() {
        var box = $('guiResult');
        box.hidden = true;
        box.innerHTML = '';
    }

    function showError(text) {
        var box = $('guiResult');
        box.hidden = false;
        box.innerHTML = '';
        box.appendChild(el('div', { className: 'gui-result-title bad', text: 'Chưa chạy được' }));
        box.appendChild(el('div', { className: 'gui-error', text: text }));
    }

    function listOf(tag, className, items) {
        if (items.length === 0) return null;
        var list = el(tag, { className: className });
        for (var i = 0; i < items.length; i++) list.appendChild(el('li', { text: items[i] }));
        return list;
    }

    function cutList(result) {
        var cuts = Core.listCuts(result);
        if (cuts.length === 0) return null;
        var list = el('ul', { className: 'gui-cuts' });
        for (var i = 0; i < cuts.length; i++) {
            var item = el('li', {}, [
                el('span', { className: 't', text: cuts[i].time }),
                el('span', { className: 'r', text: cuts[i].reason ? '  (' + cuts[i].reason + ')' : '' })
            ]);
            if (cuts[i].text) item.appendChild(el('div', { text: '“' + cuts[i].text + '”' }));
            list.appendChild(item);
        }
        return list;
    }

    function deleteCopies(ids, button, note) {
        if (!window.confirm('Xóa ' + ids.length + ' bản sao dang dở? Bản gốc không bị ảnh hưởng.')) return;
        button.disabled = true;
        var remaining = ids.slice();
        var failed = 0;
        (function next() {
            if (remaining.length === 0) {
                note.textContent = failed ? 'Có ' + failed + ' bản sao chưa xóa được. Xóa tay trong project.' : 'Đã xóa bản sao.';
                return;
            }
            callTool('delete_sequence', { sequenceId: remaining.shift() }, function (result) {
                if (!result || result.success === false) failed++;
                next();
            });
        })();
    }

    function renderResult(job, result, runnerCrashed) {
        var box = $('guiResult');
        box.hidden = false;
        box.innerHTML = '';
        var note = el('div', { className: 'gui-note' });

        var failed = result && result.success === false && !result.cancelled;
        if (failed || runnerCrashed) {
            var info = Core.describeResult(result);
            box.appendChild(el('div', { className: 'gui-result-title bad', text: 'Chưa hoàn tất' }));
            box.appendChild(el('div', { className: 'gui-error', text: Core.vi(result) }));
            var okLines = listOf('ul', 'gui-lines', info.lines);
            if (okLines) box.appendChild(okLines);
        } else {
            var described = Core.describeResult(result);
            box.appendChild(el('div', { className: 'gui-result-title ' + (result && result.cancelled ? 'warn' : 'ok'), text: described.title }));
            var lines = listOf('ul', 'gui-lines', described.lines);
            if (lines) box.appendChild(lines);
            var warnings = listOf('ul', 'gui-warnings', described.warnings);
            if (warnings) box.appendChild(warnings);
            if (job && job.dryRun) {
                var cuts = cutList(result);
                if (cuts) box.appendChild(cuts);
            }
            if (result && result.cancelled && result.nextStep) {
                box.appendChild(el('div', { className: 'gui-hint', text: result.nextStep }));
            }
        }

        var ids = result && Array.isArray(result.outputSequenceIds) ? result.outputSequenceIds : [];
        var actions = el('div', { className: 'gui-actions' });
        var i;
        for (i = 0; i < ids.length && !(job && job.dryRun); i++) {
            (function (id, index) {
                var label = ids.length > 1 ? 'Mở sequence ' + (index + 1) : 'Mở sequence';
                actions.appendChild(el('button', {
                    type: 'button', className: 'secondary', text: label,
                    onclick: function () {
                        callTool('set_active_sequence', { sequenceId: id }, function (res) {
                            note.textContent = res && res.success === false ? Core.vi(res) : 'Đã mở sequence.';
                        });
                    }
                }));
            })(ids[i], i);
        }
        // Only the unfinished copies of a cancelled or failed run; finished outputs are kept.
        var partial = Core.describeResult(result).partialSequenceIds;
        if (partial.length > 0 && !(job && job.dryRun)) {
            var del = el('button', { type: 'button', className: 'utility', text: 'Xóa bản sao' });
            del.onclick = function () { deleteCopies(partial, del, note); };
            actions.appendChild(del);
        }
        if ((runnerCrashed || (failed && result.userActionRequired)) && job) {
            actions.appendChild(el('button', {
                type: 'button', className: 'primary', text: 'Thử lại',
                onclick: function () {
                    clearResult();
                    startJob({ id: 'run-' + (++counter), card: job.card, args: job.args, dryRun: job.dryRun });
                }
            }));
        }
        if (actions.childNodes.length > 0) box.appendChild(actions);
        box.appendChild(note);
    }

    // ----------------------------------------------------------------------- the UI

    function fieldNode(card, field) {
        var id = 'f-' + card.id + '-' + field.key;
        var input;
        if (field.type === 'toggle') {
            input = el('input', { type: 'checkbox', id: id });
            input.checked = !!field.default;
            return el('div', { className: 'gui-field gui-toggle' }, [input, el('label', { 'for': id, text: field.label })]);
        }
        if (field.type === 'select') {
            input = el('select', { id: id });
            for (var i = 0; i < field.options.length; i++) {
                var option = el('option', { value: field.options[i].value, text: field.options[i].label });
                if (field.options[i].value === field.default) option.selected = true;
                input.appendChild(option);
            }
        } else if (field.type === 'number') {
            input = el('input', { type: 'number', id: id, value: String(field.default), step: 'any' });
            if (typeof field.min === 'number') input.setAttribute('min', String(field.min));
            if (typeof field.max === 'number') input.setAttribute('max', String(field.max));
        } else {
            input = el('input', { type: 'text', id: id, value: field.default || '', placeholder: field.placeholder || '' });
        }
        var body = [el('label', { 'for': id, text: field.label })];
        if (field.type === 'path') {
            var pick = el('button', { type: 'button', className: 'utility', text: 'Chọn…', title: 'Chọn trong hộp thoại' });
            pick.onclick = function () { chooseInto(input, field.key === 'folderPath'); };
            body.push(el('div', { className: 'gui-pathrow' }, [input, pick]));
        } else {
            body.push(input);
        }
        return el('div', { className: 'gui-field' }, body);
    }

    function chooseInto(input, folder) {
        try {
            var result = window.cep.fs.showOpenDialogEx(false, folder, folder ? 'Chọn thư mục' : 'Chọn file', '', []);
            if (result && result.data && result.data.length > 0) input.value = result.data[0];
        } catch (e) {
            bridgeLog('Không mở được hộp thoại chọn file: ' + e.message, 'warning');
        }
    }

    function cardNode(card) {
        var node = el('details', { className: 'gui-card' });
        node.appendChild(el('summary', { text: card.title }));
        if (card.hint) node.appendChild(el('div', { className: 'gui-hint', text: card.hint }));
        for (var i = 0; i < card.fields.length; i++) {
            if (!card.fields[i].hidden) node.appendChild(fieldNode(card, card.fields[i]));
        }
        var preview = el('button', { type: 'button', className: 'secondary', text: 'Xem trước', onclick: function () { runCard(card, true); } });
        var runButton = el('button', { type: 'button', className: 'primary', text: 'Chạy trên bản sao', onclick: function () { runCard(card, false); } });
        cardButtons[card.id] = [preview, runButton];
        node.appendChild(el('div', { className: 'gui-actions' }, [preview, runButton]));
        return node;
    }

    function refreshSequences() {
        var note = $('guiSeqNote');
        note.textContent = 'Đang tải danh sách…';
        callTool('list_sequences', {}, function (result) {
            var select = $('guiSequence');
            var keep = select.value;
            note.textContent = '';
            if (!result || result.success === false || !Array.isArray(result.sequences)) {
                note.textContent = Core.vi(result || {});
                return;
            }
            select.innerHTML = '';
            select.appendChild(el('option', { value: '', text: 'Sequence đang mở' }));
            for (var i = 0; i < result.sequences.length; i++) {
                var seq = result.sequences[i];
                var option = el('option', { value: String(seq.id), text: String(seq.name) });
                if (String(seq.id) === keep) option.selected = true;
                select.appendChild(option);
            }
        });
    }

    function buildWorkflowPane() {
        var pane = $('guiPaneWorkflows');
        pane.innerHTML = '';
        pane.appendChild(el('div', { className: 'gui-box' }, [
            el('label', { className: 'gui-label', 'for': 'guiSequence', text: 'Sequence' }),
            el('div', { className: 'gui-seq' }, [
                el('select', { id: 'guiSequence', className: 'gui-select' }, [el('option', { value: '', text: 'Sequence đang mở' })]),
                el('button', { type: 'button', className: 'utility', id: 'guiSeqRefresh', text: 'Làm mới', onclick: refreshSequences })
            ]),
            el('div', { className: 'gui-note', id: 'guiSeqNote' })
        ]));
        for (var i = 0; i < cards.length; i++) pane.appendChild(cardNode(cards[i]));

        var progress = el('div', { className: 'gui-box', id: 'guiProgress', hidden: 'hidden' }, [
            el('div', { className: 'gui-step', id: 'guiStep' }),
            el('div', { className: 'gui-progress-track' }, [
                el('div', { className: 'gui-progress-fill', id: 'guiBarFill' }),
                el('div', { className: 'gui-progress-pulse', id: 'guiBarPulse' })
            ]),
            el('div', { className: 'gui-meta', id: 'guiMeta' }),
            el('div', { className: 'gui-queue', id: 'guiQueue' }),
            el('div', { className: 'gui-actions' }, [
                el('button', { type: 'button', className: 'utility', id: 'guiCancel', text: 'Hủy', onclick: cancelRun })
            ])
        ]);
        pane.appendChild(progress);
        pane.appendChild(el('div', { className: 'gui-box', id: 'guiResult', hidden: 'hidden' }));
    }

    // ---------------------------------------------------------------------- settings UI

    function openDictionary(note) {
        try {
            if (!fs.existsSync(FILLERS_PATH)) {
                var config = readJson(PANEL_CONFIG_PATH, {});
                var located = Core.resolveRunner(
                    { runner: config.runner, runnerOverride: settings.runnerPath },
                    process.env,
                    function (p) { try { return fs.existsSync(p); } catch (e) { return false; } }
                );
                if (located.error) { note.textContent = located.error; return; }
                // The default lexicon is compiled into dist/analysis/fillers-vi.js (an ES module).
                var moduleUrl = require('url').pathToFileURL(path.join(path.dirname(located.cliPath), 'analysis', 'fillers-vi.js')).href;
                var code = 'import(process.argv[1]).then(function(m){var l=m.DEFAULT_FILLER_LEXICON;' +
                    'process.stdout.write(JSON.stringify({A:l.A,B:l.B,C:l.C},null,2));})';
                childProcess.execFile(located.nodePath, ['-e', code, moduleUrl], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, function (error, stdout) {
                    if (error || !stdout) {
                        note.textContent = 'Không tạo được từ điển mặc định. Chạy "premiere-pro-mcp --doctor" để kiểm tra.';
                        return;
                    }
                    try {
                        fs.mkdirSync(MCP_HOME, { recursive: true });
                        fs.writeFileSync(FILLERS_PATH, stdout);
                        openFile(FILLERS_PATH, note);
                    } catch (e) {
                        note.textContent = 'Không ghi được file từ điển: ' + e.message;
                    }
                });
                return;
            }
            openFile(FILLERS_PATH, note);
        } catch (e) {
            note.textContent = 'Không mở được từ điển: ' + e.message;
        }
    }

    function openFile(file, note) {
        var parts = file.replace(/\\/g, '/').replace(/^\/+/, '').split('/');
        for (var p = 0; p < parts.length; p++) {
            if (p === 0 && /^[A-Za-z]:$/.test(parts[p])) continue;
            parts[p] = encodeURIComponent(parts[p]);
        }
        var url = 'file:///' + parts.join('/');
        try {
            window.cep.util.openURLInDefaultBrowser(url);
            note.textContent = 'Đã mở ' + file + '. Sửa, lưu, rồi chạy lại quy trình.';
        } catch (e) {
            note.textContent = 'Không mở được file. Mở tay: ' + file;
        }
    }

    function buildSettingsOverlay() {
        var overlay = $('guiSettings');
        if (overlay) overlay.parentNode.removeChild(overlay);
        var engine = el('select', { id: 'setEngine', className: 'gui-select' }, [el('option', { value: '', text: 'Mặc định (zipformer-68m)' })]);
        for (var i = 0; i < Core.ASR_ENGINES.length; i++) {
            var option = el('option', { value: Core.ASR_ENGINES[i], text: Core.ASR_ENGINES[i] });
            if (settings.asrEngine === Core.ASR_ENGINES[i]) option.selected = true;
            engine.appendChild(option);
        }
        var outputDir = el('input', { type: 'text', id: 'setOutputDir', value: settings.outputDir, placeholder: 'Để trống: thư mục renders mặc định' });
        var runnerPath = el('input', { type: 'text', id: 'setRunnerPath', value: settings.runnerPath, placeholder: 'Đường dẫn cli.js (để trống: tự tìm)' });
        var note = el('div', { className: 'gui-note' });
        var close = function () { overlay.hidden = true; };

        overlay = el('div', { className: 'gui-overlay', id: 'guiSettings' }, [
            el('div', { className: 'gui-box' }, [
                el('div', { className: 'gui-result-title', text: 'Cài đặt' }),
                el('div', { className: 'gui-field' }, [
                    el('label', { text: 'Từ điển từ đệm' }),
                    el('button', { type: 'button', className: 'secondary', text: 'Mở từ điển', onclick: function () { openDictionary(note); } })
                ]),
                el('div', { className: 'gui-field' }, [el('label', { 'for': 'setEngine', text: 'Engine nhận dạng giọng nói' }), engine]),
                el('div', { className: 'gui-field' }, [el('label', { 'for': 'setOutputDir', text: 'Thư mục xuất (file SRT)' }), outputDir]),
                el('div', { className: 'gui-field' }, [el('label', { 'for': 'setRunnerPath', text: 'Đường dẫn runner (cli.js)' }), runnerPath]),
                el('div', { className: 'gui-actions' }, [
                    el('button', {
                        type: 'button', className: 'primary', text: 'Lưu',
                        onclick: function () {
                            try {
                                var changedRunner = runnerPath.value.trim() !== settings.runnerPath;
                                saveSettings({ asrEngine: engine.value, outputDir: outputDir.value, runnerPath: runnerPath.value });
                                if (changedRunner && !isActive()) stopRunner();
                                note.textContent = 'Đã lưu.';
                                close();
                            } catch (e) {
                                note.textContent = 'Không lưu được: ' + e.message;
                            }
                        }
                    }),
                    el('button', { type: 'button', className: 'utility', text: 'Đóng', onclick: close })
                ]),
                note
            ])
        ]);
        overlay.hidden = true;
        document.body.appendChild(overlay);
    }

    // ------------------------------------------------------------------------- tabs

    function showTab(name) {
        $('guiPaneWorkflows').hidden = name !== 'workflows';
        $('guiPaneConnection').hidden = name !== 'connection';
        $('guiTabWorkflows').className = 'gui-tab' + (name === 'workflows' ? ' active' : '');
        $('guiTabConnection').className = 'gui-tab' + (name === 'connection' ? ' active' : '');
    }

    function loadCards() {
        var dirs = [];
        try {
            if (typeof CSInterface === 'function' && typeof SystemPath !== 'undefined') {
                dirs.push(path.join(new CSInterface().getSystemPath(SystemPath.EXTENSION), 'gui'));
            }
        } catch (e) {}
        if (typeof __dirname !== 'undefined') dirs.push(path.join(__dirname, 'gui'), __dirname);
        for (var i = 0; i < dirs.length; i++) {
            var data = readJson(path.join(dirs[i], 'workflows.json'), null);
            if (data && Array.isArray(data.cards)) return data.cards;
        }
        return [];
    }

    function init() {
        cards = loadCards();
        loadSettings();
        buildWorkflowPane();
        buildSettingsOverlay();
        if (cards.length === 0) {
            showError('Không đọc được workflows.json. Cài lại panel bằng premiere-pro-mcp --install-cep.');
        }
        $('guiTabWorkflows').onclick = function () { showTab('workflows'); };
        $('guiTabConnection').onclick = function () { showTab('connection'); };
        $('guiSettingsButton').onclick = function () { buildSettingsOverlay(); $('guiSettings').hidden = false; };

        window.onbeforeunload = function () {
            if (isActive()) return 'Đang chạy quy trình. Đóng panel bây giờ sẽ dừng ở bước kế tiếp và để lại bản sao dang dở.';
            return undefined;
        };
        window.addEventListener('unload', function () { stopRunner(); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
