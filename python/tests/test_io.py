"""`io.write_output` must land atomically (Ruling R18).

The TypeScript job runner polls ``output.json`` while the sidecar's pid is still
alive, so a reader may open the file at any moment: it has to see either the
previous state or the complete object, never a half-written JSON document.
"""
import json
import os
import time
from pathlib import Path

import pytest

from premiere_mcp_sidecar import io


BIG = {"words": [{"w": "Chào", "start": i * 0.3, "end": i * 0.3 + 0.2, "p": 0.9} for i in range(20000)]}


def test_write_output_replaces_the_target_in_one_step(tmp_path, monkeypatch):
    """Written through a temp file in the same folder and moved into place."""
    target = tmp_path / "out.json"
    target.write_text('{"stale": true}', encoding="utf-8")
    seen = []
    real_replace = os.replace

    def spy(src, dst):
        # The scratch file is a different file from the target, in the same dir,
        # and the target still holds the old bytes until the replacement.
        seen.append((Path(src), Path(dst), target.read_text(encoding="utf-8")))
        real_replace(src, dst)

    monkeypatch.setattr(io.os, "replace", spy)

    io.write_output(target, BIG)

    assert seen, "write_output must move the finished file into place"
    src, dst, before = seen[0]
    assert dst == target
    assert src.parent == target.parent, "a rename only stays atomic inside one filesystem"
    assert src != target
    assert before == '{"stale": true}', "the old file must survive until the new one is complete"
    assert json.loads(target.read_text(encoding="utf-8")) == BIG


def test_write_output_leaves_no_scratch_file(tmp_path):
    target = tmp_path / "out.json"

    io.write_output(target, {"ok": True})

    assert sorted(path.name for path in tmp_path.iterdir()) == ["out.json"]
    assert json.loads(target.read_text(encoding="utf-8")) == {"ok": True}


def test_write_output_creates_the_folder(tmp_path):
    target = tmp_path / "jobs" / "abc" / "output.json"

    io.write_output(target, {"a": 1})

    assert json.loads(target.read_text(encoding="utf-8")) == {"a": 1}


def test_write_output_keeps_vietnamese_readable(tmp_path):
    target = tmp_path / "out.json"

    io.write_output(target, {"w": "Trưng Trắc"})

    assert "Trưng Trắc" in target.read_text(encoding="utf-8")


def test_a_failed_write_leaves_the_previous_output_intact(tmp_path, monkeypatch):
    target = tmp_path / "out.json"
    io.write_output(target, {"old": True})

    def boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(io.os, "replace", boom)

    with pytest.raises(OSError):
        io.write_output(target, {"new": True})

    assert json.loads(target.read_text(encoding="utf-8")) == {"old": True}


def _open_for_reading(path):
    """A read handle that also allows delete, like a reader that closes promptly."""
    if os.name != "nt":
        return open(path, "rb")
    import ctypes
    import msvcrt
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.restype = wintypes.HANDLE
    handle = kernel32.CreateFileW(
        str(path),
        0x80000000,  # GENERIC_READ
        0x1 | 0x4,   # FILE_SHARE_READ | FILE_SHARE_DELETE: the writer may replace it
        None,
        3,           # OPEN_EXISTING
        0x80,        # FILE_ATTRIBUTE_NORMAL
        None,
    )
    if handle == wintypes.HANDLE(-1).value:
        raise PermissionError(ctypes.get_last_error())
    return os.fdopen(msvcrt.open_osfhandle(handle, os.O_RDONLY), "rb")


def test_a_concurrent_reader_never_sees_a_partial_document(tmp_path):
    """Hammer the target while it is rewritten: every read that succeeds parses.

    The reader holds the file open while it parses and the writer replaces it, so
    the two are still guaranteed to meet -- that is the race this test exists for
    (and the race Ruling R27's retry policy was built for). It must simply hold up
    however the scheduler interleaves them, which is why it runs the whole exchange
    20 times inside one pytest invocation rather than once.
    """
    import threading

    target = tmp_path / "out.json"
    io.write_output(target, {"words": []})
    failures = []
    reads = [0]

    def read_while_it_is_replaced():
        try:
            with _open_for_reading(target) as handle:
                text = handle.read().decode("utf-8")
        except PermissionError:
            # A reader that opened without share-delete makes the rename wait;
            # the writer retries, and this side simply tries again.
            return
        reads[0] += 1
        try:
            json.loads(text)
        except ValueError as error:  # JSONDecodeError is a ValueError
            failures.append(str(error))

    for _ in range(20):
        # The reader starts first, and a (short) moment is left for it to open the
        # file, so most attempts really do race the replacement. Then the writer
        # must win its retries: 10 replacements, no exception, every parse clean.
        # Deliberately a one-shot reader: a loop with no pause can keep re-opening
        # the file at the exact microsecond the rename needs, and then only the
        # retry deadline decides, which is a different race from this one.
        thread = threading.Thread(target=read_while_it_is_replaced)
        thread.start()
        time.sleep(0.0005)
        for _ in range(10):
            io.write_output(target, BIG)
        thread.join(timeout=1.0)
        assert not thread.is_alive(), "a reader stuck in open() means the writer never let go"

    assert reads[0] > 0, "the reader never got to look at the file"
    assert failures == []


def _win_sharing_violation():
    """The error Windows raises while another handle still has the file open."""
    error = PermissionError(13, "The process cannot access the file", "output.json")
    error.winerror = 32
    return error


def test_a_sharing_violation_is_retried_until_the_reader_lets_go(tmp_path, monkeypatch):
    """WinError 32 twice then success: the result must still land, never be lost."""
    target = tmp_path / "out.json"
    real_replace = os.replace
    attempts = []

    def flaky(src, dst):
        attempts.append(dst)
        if len(attempts) <= 2:
            raise _win_sharing_violation()
        real_replace(src, dst)

    monkeypatch.setattr(io.os, "replace", flaky)

    io.write_output(target, {"ok": True})

    assert len(attempts) == 3
    assert json.loads(target.read_text(encoding="utf-8")) == {"ok": True}


def test_a_failure_that_is_not_a_sharing_violation_is_not_retried(tmp_path, monkeypatch):
    """A missing folder or a full disk will not fix itself: fail at once."""
    target = tmp_path / "out.json"
    attempts = []

    def gone(*args):
        attempts.append(args)
        raise FileNotFoundError(2, "no such file", "out.json")

    monkeypatch.setattr(io.os, "replace", gone)

    with pytest.raises(FileNotFoundError):
        io.write_output(target, {"ok": True})

    assert len(attempts) == 1


def test_the_retry_backoff_doubles_from_ten_ms_and_caps_at_250(tmp_path, monkeypatch):
    """Exponential with jitter, 10 ms up to 250 ms, inside the write_output deadline."""
    target = tmp_path / "out.json"
    waits = []

    def always_blocked(src, dst):
        raise _win_sharing_violation()

    monkeypatch.setattr(io.os, "replace", always_blocked)
    monkeypatch.setattr(io.time, "sleep", waits.append)

    with pytest.raises(PermissionError):
        io.write_output(target, {"ok": True}, deadline_sec=1.0)

    assert waits, "a sharing violation must be waited out, not raised at once"
    assert all(0 < wait <= io.REPLACE_BACKOFF_CAP_SEC * (1 + io.REPLACE_BACKOFF_JITTER) for wait in waits), waits
    # 10 ms with up to +-20 % jitter: the first nap still lands in that window.
    assert io.REPLACE_BACKOFF_START_SEC * (1 - io.REPLACE_BACKOFF_JITTER) <= waits[0] <= io.REPLACE_BACKOFF_START_SEC * (1 + io.REPLACE_BACKOFF_JITTER)
    assert max(waits) >= io.REPLACE_BACKOFF_CAP_SEC * (1 - io.REPLACE_BACKOFF_JITTER), "the backoff must grow to the cap"
    assert sum(waits) > 0.5, "the deadline is not spent by a handful of 10 ms naps"
    # The last wait never overshoots the deadline it is allowed: no sleep past 1 s.
    assert sum(waits) < 1.0


def test_the_progress_deadline_is_shorter_than_the_output_one(tmp_path, monkeypatch):
    """Progress gives up after 2 s; the final result is the one worth 10 s."""
    waits = []
    attempts = []

    def always_blocked(src, dst):
        attempts.append(dst)
        raise _win_sharing_violation()

    monkeypatch.setattr(io.os, "replace", always_blocked)
    monkeypatch.setattr(io.time, "sleep", waits.append)

    io.write_progress(tmp_path / "progress.json", 0.5, None)

    assert sum(waits) <= io.PROGRESS_REPLACE_DEADLINE_SEC
    assert sum(waits) >= io.PROGRESS_REPLACE_DEADLINE_SEC - io.REPLACE_BACKOFF_CAP_SEC * 2


def test_write_output_waits_up_to_ten_seconds_for_the_final_result(monkeypatch):
    """The last result must not be lost to a slow reader: that wait is the longest."""
    assert io.REPLACE_DEADLINE_SEC == 10.0
    assert io.PROGRESS_REPLACE_DEADLINE_SEC == 2.0


def test_a_progress_replace_that_always_fails_is_not_an_error(tmp_path, monkeypatch, capsys):
    """Progress is best-effort: a job must never die because progress.json is locked."""
    target = tmp_path / "progress.json"
    calls = [0]

    def always_blocked(src, dst):
        calls[0] += 1
        raise _win_sharing_violation()

    monkeypatch.setattr(io.os, "replace", always_blocked)
    monkeypatch.setattr(io.time, "sleep", lambda seconds: None)

    io.write_progress(target, 0.5, 12.0)  # must not raise

    assert calls[0] > 1, "a sharing violation is still retried first"
    assert not (tmp_path / "progress.json.tmp").exists(), "the temp file must be unlinked"
    err = capsys.readouterr().err
    assert "progress" in err.lower(), "one line to stderr so the failure is visible"
    assert len(err.strip().splitlines()) == 1


def test_a_heartbeat_never_raises_when_progress_is_locked(tmp_path, monkeypatch):
    """at(), finish() and the timer all go through the best-effort path."""

    def always_blocked(src, dst):
        raise _win_sharing_violation()

    monkeypatch.setattr(io.os, "replace", always_blocked)
    monkeypatch.setattr(io.time, "sleep", lambda seconds: None)

    beat = io.Heartbeat(tmp_path / "progress.json", total_sec=10.0, interval_sec=0.01)
    with beat:
        beat.at(seconds=1.0)
        beat.at(fraction=0.3)
        time.sleep(0.05)  # let the timer tick at least once
    beat.finish()

    assert not (tmp_path / "progress.json.tmp").exists()


def test_a_progress_write_that_works_leaves_no_temp_file(tmp_path):
    target = tmp_path / "progress.json"

    io.write_progress(target, 0.25, 3.0)

    assert sorted(path.name for path in tmp_path.iterdir()) == ["progress.json"]
    assert json.loads(target.read_text(encoding="utf-8")) == {"done": 0.25, "etaSec": 3.0}
