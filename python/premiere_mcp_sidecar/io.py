"""Reading command input and writing command output as JSON.

The TypeScript server talks to this sidecar only through files, so a command's
result is always a JSON object at ``--output`` -- including on failure, where the
exit code carries the verdict and ``{"error": ...}`` carries the reason.
"""

from __future__ import annotations

import json
import os
import random
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000

# How often long commands write progress.json while one step blocks (Ruling R19).
# Well inside the runner's ten-minute staleness window, so a slow model never
# makes the job look dead, and far below 30 s so a minute-long step still reports.
PROGRESS_INTERVAL_SEC = 5.0

# Share of the distance to the end a heartbeat claims per tick. It decays as the
# fraction grows, so the heartbeat alone never reaches 1.0 (only `finish` does).
HEARTBEAT_CREEP = 0.02

# A reader holding output.json open blocks the rename on Windows. The handle is
# short-lived, but a spinning reader can lose several rounds in a row, so the wait
# backs off exponentially (with jitter, so two writers do not lock step) from 10 ms
# up to 250 ms, inside a total deadline. The final result gets the longest wait --
# losing it means the job returns nothing (Ruling R27) -- while progress is only
# best-effort and gives up sooner.
REPLACE_DEADLINE_SEC = 10.0
PROGRESS_REPLACE_DEADLINE_SEC = 2.0
REPLACE_BACKOFF_START_SEC = 0.010
REPLACE_BACKOFF_CAP_SEC = 0.250
REPLACE_BACKOFF_JITTER = 0.2
# ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION: the three
# ways Windows says "someone else has this file right now". Anything else (a
# missing folder, a full disk) will not fix itself and is raised at once.
RETRYABLE_WINERRORS = frozenset({5, 32, 33})


def read_input(path: str | os.PathLike[str] | None) -> dict:
    """The command's input object; ``{}`` when the command takes no input."""
    if path is None:
        return {}
    raw = Path(path).read_text(encoding="utf-8")
    if not raw.strip():
        return {}
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError(f"input must be a JSON object, got {type(data).__name__}")
    return data


def _is_replace_blocked(exc: OSError) -> bool:
    """True when another handle on the target is the only reason the move failed.

    ``winerror`` only exists on Windows: on macOS and Linux ``OSError`` has no such
    attribute (and Windows leaves it ``None`` for an error raised in Python), so the
    code is read defensively. Reading it directly turned a real errno -- a missing
    folder, a cross-device rename -- into an ``AttributeError`` on those platforms.
    """
    return getattr(exc, "winerror", None) in RETRYABLE_WINERRORS


def _backoff_seconds(attempt: int) -> float:
    """10 ms, 20 ms, 40 ms ... capped at 250 ms, each with up to 20 % jitter."""
    # Shift rather than float exponent: past the cap the exponent would overflow.
    doublings = min(attempt, _BACKOFF_DOUBLINGS_TO_CAP)
    delay = min(REPLACE_BACKOFF_CAP_SEC, REPLACE_BACKOFF_START_SEC * (2 ** doublings))
    return delay * (1.0 + random.uniform(-REPLACE_BACKOFF_JITTER, REPLACE_BACKOFF_JITTER))


# 10 ms * 2**5 = 320 ms: the first step that is capped, so no shift is needed past it.
_BACKOFF_DOUBLINGS_TO_CAP = 5


def _replace_with_retry(
    scratch: Path,
    target: Path,
    deadline_sec: float = REPLACE_DEADLINE_SEC,
) -> None:
    """``os.replace``, retrying on Windows sharing violations until ``deadline_sec``.

    Windows refuses ``MoveFileEx`` while another process has the target open, so a
    reader polling ``output.json`` at the wrong microsecond makes the write fail.
    The handle is short-lived, but not predictably so: a tight read loop can keep
    losing for a second or more, which a fixed 20 ms nap did not survive (Ruling
    R27). The delay therefore doubles each attempt and the deadline is a parameter:
    the final result waits long enough not to be lost, a progress write gives up.
    """
    # Budget tracked as well as the clock: the wall clock is what matters in
    # production, the running total keeps the loop bounded even if a sleep is
    # shorter than asked (or faked out entirely by a test).
    remaining = deadline_sec
    attempt = 0
    while True:
        try:
            os.replace(scratch, target)
            return
        except OSError as exc:
            if not _is_replace_blocked(exc):
                raise
            delay = _backoff_seconds(attempt)
            if delay >= remaining or remaining <= 0:
                raise
            time.sleep(delay)
            remaining -= delay
            attempt += 1


def write_output(
    path: str | os.PathLike[str],
    obj: dict,
    deadline_sec: float | None = None,
) -> None:
    """Write ``obj`` as UTF-8 JSON, creating the parent folder if needed.

    Atomic (Ruling R18): the runner reads ``output.json`` while the pid is still
    alive, so the bytes are written to a temp file in the same folder and moved
    over the target with ``os.replace``. A reader therefore sees either the old
    file or the complete new one, and a crash mid-write cannot leave a truncated
    result that looks like a valid command-specific error.

    ``deadline_sec`` is the time to keep waiting for a reader to let go; tests
    shorten it, everything else gets ``REPLACE_DEADLINE_SEC``.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    scratch = target.with_name(target.name + ".tmp")
    try:
        scratch.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
        _replace_with_retry(scratch, target, REPLACE_DEADLINE_SEC if deadline_sec is None else deadline_sec)
    except BaseException:
        # A failed write must not leave the scratch file behind to be mistaken for
        # a later job's output, and the previous output.json stays untouched.
        scratch.unlink(missing_ok=True)
        raise


def write_progress(path: str | os.PathLike[str] | None, done: float, eta_sec: float | None) -> None:
    """Report fractional progress for long jobs (ASR, face scan).

    Written atomically: the TypeScript side polls this file while the command
    runs and must never read a half-written object. Best effort by design -- a
    locked progress file must never fail the job that is reporting it, so a
    replace that cannot win within ``PROGRESS_REPLACE_DEADLINE_SEC`` is logged in
    one line and dropped, and the temp file is removed like ``write_output`` does.
    """
    if path is None:
        return
    target = Path(path)
    scratch = target.with_name(target.name + ".tmp")
    payload = {"done": max(0.0, min(1.0, float(done))), "etaSec": eta_sec}
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        scratch.write_text(json.dumps(payload), encoding="utf-8")
        _replace_with_retry(scratch, target, PROGRESS_REPLACE_DEADLINE_SEC)
    except OSError as exc:
        log(f"progress write skipped: {exc}")
    finally:
        if scratch.exists():
            scratch.unlink(missing_ok=True)


def pcm16k(
    media_path: str | os.PathLike[str],
    start: float | None = None,
    end: float | None = None,
) -> np.ndarray:
    """Decode ``media_path`` to mono 16 kHz float32 samples.

    Decoding goes through the ffmpeg binary rather than ``faster_whisper``'s
    ``decode_audio``: the bundled PyAV build fails on some containers with a
    ``metadata_errors`` error. ``start``/``end`` are seconds on the source.
    """
    args = ["ffmpeg", "-nostdin", "-v", "error"]
    if start is not None:
        args += ["-ss", f"{float(start):.6f}"]
    if end is not None:
        args += ["-to", f"{float(end):.6f}"]
    args += [
        "-i", str(media_path),
        "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-f", "f32le", "-acodec", "pcm_f32le", "-",
    ]
    run = subprocess.run(args, capture_output=True)
    if run.returncode != 0:
        detail = run.stderr.decode("utf-8", "replace").strip()[-400:]
        raise RuntimeError(f"ffmpeg could not decode {media_path}: {detail or run.returncode}")
    return np.frombuffer(run.stdout, dtype="<f4").copy()


def log(message: str) -> None:
    """Progress lines go to stderr so stdout stays free for the JSON contract."""
    print(message, file=sys.stderr, flush=True)


class Heartbeat:
    """Writes progress.json from a timer while a long step blocks (Ruling R19).

    Segment-by-segment updates are not enough: one ten-minute segment on a slow
    machine would leave the file untouched long enough for the runner to call the
    job stale. The timer creeps the fraction forward and fills ``etaSec`` so the
    caller never sees a frozen job::

        beat = Heartbeat(progress_path, total_sec=duration)
        with beat:
            for segment in segments:
                ...
                beat.at(seconds=segment.end)

    Every write is atomic (see ``write_progress``) and the fraction never goes
    backwards, whatever order the timer and the caller land in. An attempt that
    starts mid-job (a CUDA run retried on the CPU) starts at the fraction the job
    has already reported, so a poller never sees it restart; a fresh job starts at
    zero and does not inherit a previous run's file.
    """

    def __init__(
        self,
        path: str | os.PathLike[str] | None,
        total_sec: float | None = None,
        interval_sec: float | None = None,
    ) -> None:
        self.path = path
        self.total_sec = total_sec
        self.interval = PROGRESS_INTERVAL_SEC if interval_sec is None else interval_sec
        self._done = 0.0
        self._started = 0.0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def at(self, seconds: float | None = None, fraction: float | None = None) -> None:
        """Record a caller-owned position, in media seconds or as a plain fraction.

        ``seconds`` is the media position the step has reached, which is what the
        ETA is computed from; ``fraction`` covers steps measured in something other
        than seconds (frames, ranges). Neither ever moves the fraction backwards.
        """
        with self._lock:
            if fraction is not None:
                self._done = max(self._done, min(1.0, float(fraction)))
            elif seconds is not None and self.total_sec:
                self._done = max(self._done, min(1.0, seconds / self.total_sec))
            self._emit()

    def _emit(self) -> None:
        elapsed = time.monotonic() - self._started if self._started else 0.0
        try:
            write_progress(self.path, self._done, _eta_seconds(self._done, elapsed, self.total_sec))
        except OSError as exc:  # progress is best effort: never fail the job over it
            log(f"progress write skipped: {exc}")

    def _creep(self) -> None:
        """Move the fraction a little past the last known mark, never past the end.

        The step the caller is inside covers the gap to the next mark, which is
        unknown, so the heartbeat claims only a slowly decaying share of what is
        left: it can never reach 1.0 on its own, and no position is ever reported
        as done when it is not.
        """
        with self._lock:
            if self._done >= 0.99:
                return
            remaining = 1.0 - self._done
            self._done = min(0.99, self._done + remaining * HEARTBEAT_CREEP)
            self._emit()

    def start(self) -> None:
        self._started = time.monotonic()
        if self.interval <= 0:
            return
        self._thread = threading.Thread(target=self._loop, name="progress-heartbeat", daemon=True)
        self._thread.start()

    @property
    def done(self) -> float:
        """The highest fraction this heartbeat has recorded."""
        with self._lock:
            return self._done

    def adopt(self, other: "Heartbeat | None") -> None:
        """Start no lower than ``other`` has already reported.

        The caller's ETA clock is its own (a new attempt times its own work), but
        the fraction is the job's, so a retry picks up where the failed attempt
        stopped instead of dropping the poller back to zero.
        """
        if other is None:
            return
        with self._lock:
            self._done = max(self._done, other.done)

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                self._creep()
            except OSError as exc:  # a vanished job dir must not kill the job
                log(f"progress write failed: {exc}")

    def finish(self) -> None:
        with self._lock:
            self._done = 1.0
            self._emit()

    def __enter__(self) -> "Heartbeat":
        self.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self.interval + 1.0)
        return None


def _eta_seconds(done: float, elapsed: float, total_sec: float | None) -> float | None:
    """Seconds left, from the share of media already transcribed."""
    if not total_sec or done <= 0 or done >= 1:
        return 0.0 if done >= 1 else None
    return round(elapsed / done - elapsed, 1)
