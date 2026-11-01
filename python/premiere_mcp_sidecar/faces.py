"""How many people are on screen, sampled once per second, for multi-face detection.

Frames come from ONE ffmpeg process per input range (Ruling R17): decoding every
frame of a 4K HEVC file just to keep one a second is 7-17x slower, so the range is
read as a stream of keyframes only.

How the samples are chosen
--------------------------
The command is::

    ffmpeg -hwaccel cuda -skip_frame nokey -ss <start> -to <end> -i <file> \\
           -vf scale=640:-2 -fps_mode passthrough -f image2pipe -vcodec bmp -

``-skip_frame nokey`` makes the decoder hand over only keyframes. ``-fps_mode
passthrough`` keeps exactly those frames instead of letting the image2 muxer
duplicate them back to the source rate, so every BMP on the pipe is one keyframe
and the stream is read in frame order.

The timestamp of each kept frame is therefore not known to us by name, only by
order, so it is derived from the frame index at the requested rate:
``t = start + index / fps``. Keeping "at most one frame per second" then means
keeping the first keyframe of each second, counted from the range start, and
dropping the rest. ``t`` is reported at the second that frame belongs to (an
integer for the default ``fps = 1``). A keyframe-dense source (a 1 s GOP) is
sampled exactly once per second; a long-GOP source is sampled at keyframes only,
which is what Ruling R17 accepts for a 1 s signal.

Faces are found with ``cv2.FaceDetectorYN`` at ``score_threshold=0.8`` on each
640 px wide frame. Progress (Ruling R19) is written as ranges complete and by a
heartbeat while a range is being read or scanned.
"""

from __future__ import annotations

import os
import struct
import subprocess
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
    args = ["ffmpeg", "-nostdin", "-v", "error"]
    if hwaccel:
        args += ["-hwaccel", "cuda"]
    args += [
        "-skip_frame", "nokey",
        "-ss", f"{float(start):.6f}",
        "-to", f"{float(end):.6f}",
        "-i", str(media_path),
        "-vf", f"scale={scale_width}:-2",
        # Emit each decoded keyframe once: without this the image2 muxer repeats
        # frames to reach the source rate and we would decode the same picture many times.
        "-fps_mode", "passthrough",
        "-f", "image2pipe",
        "-vcodec", "bmp",
        "-",
    ]
    return args


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


def read_frames(
    media_path: str,
    start: float,
    end: float,
    fps: float = DEFAULT_FPS,
    hwaccel: bool = True,
    scale_width: int = SCALE_WIDTH,
) -> Iterator[tuple[float, np.ndarray]]:
    """Yield ``(t, bgr frame)`` at most once per ``1/fps`` seconds inside the range.

    ``t`` is the file time of the sample. Frames are read from a single ffmpeg
    process; the process is killed if the caller stops iterating early.
    """
    if fps <= 0:
        raise ValueError(f"fps must be positive, got {fps}")
    step = 1.0 / float(fps)
    run = subprocess.Popen(
        ffmpeg_args(media_path, start, end, hwaccel=hwaccel, scale_width=scale_width),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    next_index = 0
    index = 0
    completed = False
    failed: RuntimeError | None = None
    try:
        stream = run.stdout
        while True:
            header = _read_exactly(stream, BMP_HEADER_SIZE)
            if not header:
                completed = True
                break
            size = _frame_size(header)
            data = header + _read_exactly(stream, size - BMP_HEADER_SIZE)
            if index == next_index:
                # Whole seconds stay integers so a caller can index by second.
                yield round(float(start) + index * step, 3), _decode_bmp(data)
                next_index += 1
            index += 1
    finally:
        if run.stdout is not None:
            run.stdout.close()
        if run.poll() is None:
            # A caller that stopped early leaves ffmpeg writing into a pipe nobody
            # drains; killing it here is what keeps a scan from leaking decoders.
            run.kill()
        stderr = run.stderr.read() if run.stderr is not None else b""
        run.wait()
        if run.stderr is not None:
            run.stderr.close()
        # Only a stream we drained to the end can prove a decode problem; a kill we
        # asked for exits non-zero and is not an error.
        if completed and run.returncode not in (0, None):
            detail = stderr.decode("utf-8", "replace").strip()[-400:]
            failed = RuntimeError(f"ffmpeg could not read frames from {media_path}: {detail or run.returncode}")
    if failed is not None:
        raise failed


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
    """``cv2.FaceDetectorYN`` reading ``model_path``; the input size is set per frame."""
    return FaceDetectorYN.create(
        str(model_path),
        "",
        (SCALE_WIDTH, SCALE_WIDTH),
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
    ranges = [
        (float(bracket["start"]), float(bracket["end"]))
        for bracket in spec.get("ranges") or []
        if float(bracket.get("end", 0)) > float(bracket.get("start", 0))
    ]
    ranges.sort()

    samples: list[dict] = []
    if not ranges:
        io.write_progress(progress_path, 1.0, 0.0)
        return {"samples": samples}

    yunet = detector(str(model_path))
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
                # `t` sits at the sample's own second; report an exact second as an
                # integer so the caller can index by second without float drift.
                samples.append({"t": int(t) if float(t).is_integer() else t, "count": count_faces(yunet, frame)})
                in_range = min(end - start, in_range + 1.0 / fps)
                beat.at(fraction=(covered + in_range) / total if total else 1.0)
            covered += end - start
    beat.finish()
    return {"samples": samples}
