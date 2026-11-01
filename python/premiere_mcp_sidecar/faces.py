"""How many people are on screen, sampled once per second, for multi-face detection.

Frames come from ONE ffmpeg process per input range (Ruling R17): decoding every
frame of a 4K HEVC file just to keep one a second is 7-17x slower, so the range is
read as a stream of keyframes only.

How the command is built
------------------------
The command is::

    ffmpeg -nostdin -v info -hwaccel cuda -skip_frame nokey \\
           -ss <start> -to <end> -i <file> \\
           -vf scale=640:-2,showinfo -fps_mode passthrough \\
           -f image2pipe -vcodec bmp -

``-skip_frame nokey`` makes the decoder hand over only keyframes. ``-fps_mode
passthrough`` keeps exactly those frames instead of letting the image2 muxer
duplicate them back to the source rate, so every BMP on the pipe is one keyframe
and the stream is read in frame order.

How the samples are timed
-------------------------
Keyframes are *not* one per second: they sit at the GOP spacing (a 2 s GOP gives
frames at 0, 2, 4 ...), so a frame's time cannot be derived from its index. Each
kept frame's real presentation time is read instead: ``showinfo`` writes one line
per frame to ffmpeg's stderr, and that line is matched to the frame it describes
in pipe order. showinfo logs at info level, hence ``-v info`` rather than the
``-v error`` the rest of the sidecar uses.

With ``-ss`` before ``-i`` ffmpeg rebases the timestamps to the seek point, so
``pts_time`` restarts near 0 at the range start rather than staying at file time,
which is why the range start is added back (verified against the real binary in
``test_real_ffmpeg_showinfo_pts_restart_at_the_seek_point``). Nothing is cut at a
range boundary (the alternative, ``-copyts``, keeps file pts but also emits the
frames before ``-ss`` that the decode skips to reach a keyframe).

The reader keeps at most one frame per whole second of file time: a frame is a
sample when it is the first frame at or after the next whole second (the same
rule the fake reader in the tests applies). ``t`` is therefore that second, in
file time -- an integer for the default ``fps = 1`` -- and there is exactly one
sample per second that has a keyframe. A keyframe that lands mid-second is kept
when it opens a second no earlier frame opened; it is then reported at its own
time. A keyframe-dense source is sampled once per second; a long-GOP source is
sampled at its keyframes only, which is what Ruling R17 accepts for a 1 s signal.

stderr is drained by a thread while the frames are read. ``showinfo`` writes far
more than a pipe buffer holds (it logs a side-data block per frame), and reading
stderr only after stdout's EOF deadlocks on that.
Faces are found with ``cv2.FaceDetectorYN`` at ``score_threshold=0.8`` on each
640 px wide frame. The model is read into memory and handed to OpenCV as bytes:
the path overload passes the file name to OpenCV as an ANSI string, which fails on
a Windows path with Vietnamese characters in it. Progress (Ruling R19) is written
as ranges complete and by a heartbeat while a range is being read or scanned.
"""

from __future__ import annotations

import os
import queue
import re
import struct
import subprocess
import threading
from pathlib import Path
from typing import Iterator

import cv2
import numpy as np

from . import io

SCALE_WIDTH = 640
SCORE_THRESHOLD = 0.8
NMS_THRESHOLD = 0.3
DEFAULT_FPS = 1.0

# BMP is uncompressed, so a frame is exactly header + rows: read it by length
# rather than guessing where the next one begins.
BMP_HEADER_SIZE = 54
BMP_MAX_FRAME_BYTES = 4096 * 4096 * 3

# ffmpeg picks the input frame rate itself for a rawvideo input; it is replaced
# with the real size on every frame just before detect().
DETECTOR_INIT_SIZE = (SCALE_WIDTH, SCALE_WIDTH)

# showinfo is the last filter in the chain: it logs every frame as it is written to
# the pipe, so there is exactly one line per BMP and in the same order.
SHOWINFO_FILTER = "scale={width}:-2,showinfo"

# showinfo logs at info level, so the command has to stay at `-v info`.
LOG_LEVEL = "info"

# ``[Parsed_showinfo_1 @ 0000020c] n:   0 pts:      0 pts_time:0 duration: ...``
# The tag is all a side-data continuation line shares with it, so both have to match.
SHOWINFO_RE = re.compile(rb"\[Parsed_showinfo_\d+ @ [^\]]*\]\s+n:\s*(\d+)\s+pts:\s*(\S+)\s+pts_time:\s*(\S+)")
ISKEY_RE = re.compile(rb"\siskey:(\d+)")

# A frame counts as being at a whole second up to this much before it: ffmpeg's
# pts_time is a rounded decimal, not exact.
SECOND_TOLERANCE = 0.001

# How much stderr error text an exception carries.
ERROR_TAIL_BYTES = 400


def progress_interval() -> float:
    """Seconds between heartbeat writes (tests shrink it)."""
    return io.PROGRESS_INTERVAL_SEC


def ffmpeg_args(
    media_path: str,
    start: float,
    end: float,
    hwaccel: bool = True,
    scale_width: int = SCALE_WIDTH,
) -> list[str]:
    """One pass over ``[start, end)``: keyframes only, scaled, BMPs on stdout."""
    args = ["ffmpeg", "-nostdin", "-v", LOG_LEVEL]
    if hwaccel:
        args += ["-hwaccel", "cuda"]
    args += [
        "-skip_frame", "nokey",
        "-ss", f"{float(start):.6f}",
        "-to", f"{float(end):.6f}",
        "-i", str(media_path),
        "-vf", SHOWINFO_FILTER.format(width=int(scale_width)),
        # Emit each decoded keyframe once: without this the image2 muxer repeats
        # frames to reach the source rate and we would decode the same picture many times.
        "-fps_mode", "passthrough",
        "-f", "image2pipe",
        "-vcodec", "bmp",
        "-",
    ]
    return args


def parse_pts_time(line: bytes) -> float:
    """The ``pts_time`` of one showinfo line, in seconds (restarted at the seek point)."""
    match = SHOWINFO_RE.search(line)
    if match is None:
        raise ValueError(f"not a showinfo frame line: {line[:120]!r}")
    try:
        return float(match.group(3))
    except ValueError as exc:  # pragma: no cover - ffmpeg would have to change format
        raise ValueError(f"unreadable pts_time in {line[:120]!r}") from exc


def parse_showinfo(line: bytes) -> tuple[float, bool] | None:
    """``(pts_time, iskey)`` for a showinfo frame line, ``None`` for any other line."""
    match = SHOWINFO_RE.search(line)
    if match is None:
        return None
    try:
        pts_time = float(match.group(3))
    except ValueError:
        return None
    key = ISKEY_RE.search(line)
    return pts_time, (key is None or key.group(1) != b"0")


def is_sample_start(pts_time: float, next_sample: float, tolerance: float = SECOND_TOLERANCE) -> bool:
    """Whether a frame at ``pts_time`` opens the next whole second -- i.e. is kept.

    ``next_sample`` is the file time the next sample has to reach: a frame at or
    past it starts a new sample, and every frame before it belongs to the second a
    previous sample opened, so it is dropped.
    """
    return pts_time >= next_sample - tolerance


def _read_exactly(stream, length: int) -> bytes:
    """Up to ``length`` bytes, fewer only at end of stream."""
    chunks = []
    remaining = length
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _frame_size(header: bytes) -> int:
    """Total byte length of the BMP that starts with ``header``."""
    if len(header) < BMP_HEADER_SIZE or header[:2] != b"BM":
        raise RuntimeError("ffmpeg did not send a BMP frame on the image2pipe stream")
    file_size = struct.unpack("<I", header[2:6])[0]
    if BMP_HEADER_SIZE < file_size <= BMP_MAX_FRAME_BYTES:
        return file_size
    # Some writers leave the file size 0: fall back to the pixel data length.
    width, height = struct.unpack("<ii", header[18:26])
    bits = struct.unpack("<H", header[28:30])[0]
    row = ((width * bits + 31) // 32) * 4
    return BMP_HEADER_SIZE + row * abs(height)


def _decode_bmp(data: bytes) -> np.ndarray:
    frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise RuntimeError("could not decode a frame read from ffmpeg")
    return frame


def _supervise(run: subprocess.Popen, exit_code: list) -> queue.Queue:
    """Drain stderr on its own thread, while the frames are read on ours.

    Returns the queue the thread fills with ``("log", line)`` per line and finally
    ``("end", None)``; it also records the exit code in ``exit_code`` (a one-element
    list the caller owns, so nothing needs a lock).

    Reading stderr only after stdout's EOF deadlocks as soon as ffmpeg fills the
    stderr pipe: with ``showinfo`` in the filter chain it logs a side-data block per
    frame, so the pipe fills long before the frames end. The thread takes the
    ``wait()`` too, which reaps the process whatever path the caller leaves by.
    """
    lines: queue.Queue = queue.Queue()

    def pump() -> None:
        try:
            stream = run.stderr
            if stream is not None:
                for line in iter(stream.readline, b""):
                    lines.put(("log", line))
                stream.close()
        except (ValueError, OSError):  # pragma: no cover - closed under our feet
            pass
        finally:
            try:
                exit_code[0] = run.wait()
            except Exception:  # pragma: no cover - killed while waiting
                exit_code[0] = None
            lines.put(("end", None))

    threading.Thread(target=pump, name="ffmpeg-stderr", daemon=True).start()
    return lines


def _kill(run: subprocess.Popen) -> None:
    """Stop ffmpeg; a process that already exited is not an error."""
    if run.poll() is None:
        try:
            run.kill()
        except OSError:  # pragma: no cover - already gone
            pass


def _next_frame_pts(lines: queue.Queue, pending: bytearray, tail: bytearray, media_path: str) -> float:
    """The pts of the frame ffmpeg has just written, from its showinfo line.

    ffmpeg logs a frame before writing it to the pipe, so the line for the frame
    just read is already queued; anything else that is queued (the banner, the
    ``color_range:`` block after each frame, a muxer summary) is not a frame line
    and goes into ``tail``, which is what an error message quotes.
    """
    while True:
        kind, payload = lines.get()
        if kind == "end":
            detail = bytes(tail).decode("utf-8", "replace").strip()[-ERROR_TAIL_BYTES:]
            raise RuntimeError(f"ffmpeg stopped while reading frames from {media_path}: {detail or 'stderr closed'}")
        pending.extend(payload)
        while True:
            split = pending.find(b"\n")
            if split < 0:
                break
            line = bytes(pending[:split])
            del pending[: split + 1]
            info = parse_showinfo(line)
            if info is None:
                # Keep the last lines only: ffmpeg's error comes at the end.
                tail.extend(line + b"\n")
                del tail[: max(0, len(tail) - ERROR_TAIL_BYTES)]
                continue
            pts_time, iskey = info
            if iskey:
                return pts_time


def read_frames(
    media_path: str,
    start: float,
    end: float,
    fps: float = DEFAULT_FPS,
    hwaccel: bool = True,
    scale_width: int = SCALE_WIDTH,
) -> Iterator[tuple[float, np.ndarray]]:
    """Yield ``(t, bgr frame)`` at most once per whole second inside the range.

    ``t`` is the file time of the sample: the range start plus the frame's own
    ``pts_time``, which ffmpeg rebases to the seek point. Frames are read from a
    single ffmpeg process; the process is killed if the caller stops iterating early.
    """
    if fps <= 0:
        raise ValueError(f"fps must be positive, got {fps}")
    step = 1.0 / float(fps)
    args = ffmpeg_args(media_path, start, end, hwaccel=hwaccel, scale_width=scale_width)
    run = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    exit_code: list = [None]
    lines = _supervise(run, exit_code)
    pending = bytearray()
    tail = bytearray()
    # The sample grid is whole seconds of *file* time, but the pts feed is range
    # time (ffmpeg rebased it at -ss), so both ends are kept in file time and
    # compared there: `offset` maps one to the other.
    offset = float(start)
    next_sample = offset
    completed = False
    try:
        stream = run.stdout
        while True:
            header = _read_exactly(stream, BMP_HEADER_SIZE)
            if not header:
                completed = True
                break
            size = _frame_size(header)
            data = header + _read_exactly(stream, size - BMP_HEADER_SIZE)
            file_time = round(offset + _next_frame_pts(lines, pending, tail, str(media_path)), 3)
            if not is_sample_start(file_time, next_sample):
                continue
            next_sample = file_time + step
            # Whole seconds stay integers so a caller can index by second.
            yield (int(round(file_time)) if abs(file_time - round(file_time)) < SECOND_TOLERANCE else file_time,
                   _decode_bmp(data))
    finally:
        if run.stdout is not None:
            run.stdout.close()
        # A caller that stopped early, or an error, leaves ffmpeg writing into a pipe
        # nobody drains; killing it here is what keeps a scan from leaking decoders.
        _kill(run)
    # Only a stream we drained to the end can prove a decode problem; a kill we
    # asked for exits non-zero and is not an error.
    if completed:
        # Read stderr to its end: the thread puts every line before its final
        # ("end", ...), and the exit code is recorded before that, so this both
        # collects ffmpeg's error text and makes the code certain to be there.
        while True:
            kind, payload = lines.get()
            if kind == "end":
                break
            # ffmpeg's error for a failed run comes after the last frame: keep it.
            tail.extend(payload)
            del tail[: max(0, len(tail) - ERROR_TAIL_BYTES)]
        if exit_code[0] not in (0, None):
            detail = bytes(tail).decode("utf-8", "replace").strip()[-ERROR_TAIL_BYTES:]
            raise RuntimeError(f"ffmpeg could not read frames from {media_path}: {detail or exit_code[0]}")


def _range_frames(media_path: str, start: float, end: float, fps: float) -> Iterator[tuple[float, np.ndarray]]:
    """Frames for one range, falling back to CPU decoding when the GPU pass fails.

    One ffmpeg process per range in the normal case. A GPU pass that errors before
    delivering anything is retried once on the CPU, because that is the fallback
    Ruling R17 asks for; an empty range is not an error, so it is not retried.
    """
    try:
        frames = read_frames(media_path, start, end, fps=fps, hwaccel=True)
        first = next(frames)
    except StopIteration:
        return
    except RuntimeError as exc:
        io.log(f"GPU frame read failed ({exc}); retrying on the CPU")
        yield from read_frames(media_path, start, end, fps=fps, hwaccel=False)
        return
    yield first
    yield from frames


FaceDetectorYN = cv2.FaceDetectorYN


def detector(model_path: str, score_threshold: float = SCORE_THRESHOLD, nms_threshold: float = NMS_THRESHOLD):
    """``cv2.FaceDetectorYN`` reading the ONNX at ``model_path``; the size is set per frame.

    The file is read here and passed as a buffer. ``create(path, ...)`` hands the
    string to OpenCV, whose ONNX loader opens it through the ANSI API on Windows: a
    model under a Vietnamese folder name ("Mô hình khuôn mặt") then fails to open,
    and every Faces-enabled job with it. The buffer overload never sees a path.
    """
    data = Path(model_path).read_bytes()
    return FaceDetectorYN.create(
        "onnx",
        np.frombuffer(data, dtype=np.uint8),
        None,
        DETECTOR_INIT_SIZE,
        score_threshold,
        nms_threshold,
        5000,
    )


def count_faces(yunet, frame: np.ndarray) -> int:
    """Faces in ``frame`` at or above the score threshold.

    ``cv2.FaceDetectorYN.detect`` already drops boxes below ``score_threshold``; the
    score check here keeps the contract explicit for any other detector, and the
    row may carry extra trailing values so only the score column is read.
    """
    height, width = frame.shape[:2]
    yunet.setInputSize((width, height))
    _count, faces = yunet.detect(frame)
    if faces is None or len(faces) == 0:
        return 0
    detected = np.asarray(faces, dtype=np.float32)
    if detected.ndim != 2 or detected.shape[1] < 15:
        return 0
    return int((detected[:, 14] >= SCORE_THRESHOLD).sum())


def run(spec: dict, progress_path: str | os.PathLike[str] | None = None) -> dict:
    """``{samples: [{t, count}]}`` with ``t`` in file seconds, sorted, one per second."""
    media_path = spec.get("mediaPath")
    if not media_path:
        raise ValueError("faces needs mediaPath")
    model_path = spec.get("modelPath")
    if not model_path:
        raise ValueError("faces needs modelPath (the YuNet .onnx file)")
    if not Path(model_path).is_file():
        raise FileNotFoundError(f"the yunet face model is missing: {model_path}")
    fps = float(spec.get("fps") or DEFAULT_FPS)
    hwaccel = bool(spec.get("hwaccel", True))
    ranges = [
        (float(bracket["start"]), float(bracket["end"]))
        for bracket in spec.get("ranges") or []
        if float(bracket.get("end", 0)) > float(bracket.get("start", 0))
    ]
    ranges.sort()

    # Before any decoding: a model OpenCV cannot load is an error the caller wants
    # in seconds, not after minutes of frame reading.
    yunet = detector(str(model_path))

    samples: list[dict] = []
    if not ranges:
        io.write_progress(progress_path, 1.0, 0.0)
        return {"samples": samples}

    total = sum(end - start for start, end in ranges)
    beat = io.Heartbeat(progress_path, total_sec=total, interval_sec=progress_interval())
    # Media seconds covered: whole finished ranges plus the samples seen in the
    # range being read, over the total across every range, so the fraction keeps
    # moving across ranges instead of restarting at each of them.
    covered = 0.0
    with beat:
        for start, end in ranges:
            in_range = 0.0
            for t, frame in _range_frames(str(media_path), start, end, fps):
                # `t` sits at the sample's own second; whole seconds are reported as
                # ints so the caller can index by second without float drift.
                samples.append({"t": int(t) if float(t).is_integer() else t, "count": count_faces(yunet, frame)})
                in_range = min(end - start, in_range + 1.0 / fps)
                beat.at(fraction=(covered + in_range) / total if total else 1.0)
            covered += end - start
    beat.finish()
    return {"samples": samples}
