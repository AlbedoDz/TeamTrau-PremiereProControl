"""`io.write_output` must land atomically (Ruling R18).

The TypeScript job runner polls ``output.json`` while the sidecar's pid is still
alive, so a reader may open the file at any moment: it has to see either the
previous state or the complete object, never a half-written JSON document.
"""
import json
import os
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
    """Hammer the target while it is rewritten: every read that succeeds parses."""
    import threading

    target = tmp_path / "out.json"
    io.write_output(target, {"words": []})
    stop = threading.Event()
    failures = []
    reads = [0]

    def reader():
        while not stop.is_set():
            try:
                with _open_for_reading(target) as handle:
                    text = handle.read().decode("utf-8")
            except PermissionError:
                # A reader that opened without share-delete makes the rename wait;
                # the writer retries, and this side simply tries again.
                continue
            reads[0] += 1
            try:
                json.loads(text)
            except ValueError as error:  # JSONDecodeError is a ValueError
                failures.append(str(error))

    thread = threading.Thread(target=reader)
    thread.start()
    try:
        for _ in range(40):
            io.write_output(target, BIG)
    finally:
        stop.set()
        thread.join()

    assert reads[0] > 0, "the reader never got to look at the file"
    assert failures == []
