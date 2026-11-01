"""Reading command input and writing command output as JSON.

The TypeScript server talks to this sidecar only through files, so a command's
result is always a JSON object at ``--output`` -- including on failure, where the
exit code carries the verdict and ``{"error": ...}`` carries the reason.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000


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


def write_output(path: str | os.PathLike[str], obj: dict) -> None:
    """Write ``obj`` as UTF-8 JSON, creating the parent folder if needed."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def write_progress(path: str | os.PathLike[str] | None, done: float, eta_sec: float | None) -> None:
    """Report fractional progress for long jobs (ASR, face scan).

    Written atomically: the TypeScript side polls this file while the command
    runs and must never read a half-written object.
    """
    if path is None:
        return
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    scratch = target.with_name(target.name + ".tmp")
    payload = {"done": max(0.0, min(1.0, float(done))), "etaSec": eta_sec}
    scratch.write_text(json.dumps(payload), encoding="utf-8")
    scratch.replace(target)


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
