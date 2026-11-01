"""Fetch the two models the analysis sidecar needs: the whisper weights and YuNet.

Run once by ``premiere-pro-mcp --setup-asr``, with the models folder as input, and
skipped on every later run that finds the files already there:

* the whisper model (Ruling R22: ``faster-whisper-large-v3-turbo``) is pulled by
  ``huggingface_hub.snapshot_download`` straight into
  ``<modelsDir>/faster-whisper-large-v3-turbo``. ``allow_patterns`` keeps it to the
  weights and config: the repo also carries a README and images, and a second copy
  of the weights in another dtype that ``faster-whisper`` never opens. The folder
  is exactly what ``WhisperModel(path, local_files_only=True)`` expects, so a
  downloaded model never reaches for the network again;
* YuNet is a single ONNX file on GitHub, fetched with ``urllib`` and no extra
  dependency. It is streamed into a temp file next to the target and moved into
  place with ``os.replace``, so a dropped connection leaves no half-written model
  that ``check`` would then report as present. A result under 100 KB is treated as
  an error page or a truncated body, not as the model.

Progress (Ruling R19) is written by a heartbeat for the whole run, and the
whisper download owns the first 90% of the bar because it is ~1.6 GB of the
~2 GB: the same 10 s of silence looks like a stall otherwise. The ONNX download
reports its own byte position inside the last 10%.
"""

from __future__ import annotations

import os
from pathlib import Path
from urllib.request import urlopen

from . import io

# The download seam: ``huggingface_hub`` is bound to this name when a download is
# due. Imported lazily (see ``_snapshot_download``) because the library pulls
# requests, tokenizers and tqdm behind it, and `check` must stay cheap.
snapshot_download = None

# Ruling R22: the model the server runs and the folder name `modelPaths()` uses.
DEFAULT_WHISPER_REPO = "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
WHISPER_DIR_NAME = "faster-whisper-large-v3-turbo"
# Weights, config and vocabulary: never the README or the images.
ALLOW_PATTERNS = ["*.json", "*.bin", "*.txt"]

ONNX_NAME = "face_detection_yunet_2023mar.onnx"
ONNX_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/models/"
    "face_detection_yunet/face_detection_yunet_2023mar.onnx"
)
# YuNet 2023mar is ~345 KB. A truncated body or an HTML error page is far smaller,
# and a model that OpenCV cannot load fails every Faces-enabled job.
MIN_ONNX_BYTES = 100 * 1024

# Read size for the ONNX stream: the file is small, but never load it in one go.
CHUNK_SIZE = 256 * 1024

# Share of the bar the whisper download owns; the ONNX gets the rest.
WHISPER_SHARE = 0.9

# A model folder is only usable with both the weights and the config next to them.
WHISPER_REQUIRED_FILES = ("model.bin", "config.json")


def progress_interval() -> float:
    """Seconds between heartbeat writes (tests shrink it)."""
    return io.PROGRESS_INTERVAL_SEC


def _snapshot_download():
    """The snapshot downloader, imported on first use and kept for later runs.

    Tests set the module-level ``snapshot_download`` to a fake, so a name already
    bound is used as is.
    """
    global snapshot_download
    if snapshot_download is None:
        from huggingface_hub import snapshot_download as downloader

        snapshot_download = downloader
    return snapshot_download


def whisper_dir(models_dir: Path) -> Path:
    return models_dir / WHISPER_DIR_NAME


def onnx_path(models_dir: Path) -> Path:
    return models_dir / ONNX_NAME


def _whisper_present(folder: Path) -> bool:
    """The weights and the config are both there: a partial copy does not count."""
    return all((folder / name).is_file() for name in WHISPER_REQUIRED_FILES)


def _onnx_present(target: Path) -> bool:
    return target.is_file() and target.stat().st_size > MIN_ONNX_BYTES


def _download_whisper(folder: Path, repo: str) -> None:
    """Pull the repo snapshot into ``folder``; ``huggingface_hub`` resumes a partial one.

    Its own progress bars are left alone: they go to stderr, which the installer
    streams to the user, so a 1.6 GB download is not silent for minutes.
    """
    io.log(f"downloading {repo} to {folder}")
    snapshot = _snapshot_download()
    snapshot(repo_id=repo, local_dir=str(folder), allow_patterns=ALLOW_PATTERNS)
    missing = [name for name in WHISPER_REQUIRED_FILES if not (folder / name).is_file()]
    if missing:
        raise RuntimeError(f"{repo} is missing {', '.join(missing)} after the download")


def _download_onnx(target: Path, beat: io.Heartbeat, chunk_size: int = CHUNK_SIZE) -> None:
    """Stream the ONNX to a temp file beside ``target``, then replace it in one step.

    Same reason as ``io.write_output``: a failed download must leave either nothing
    or the previous good file, never a truncated model that ``check`` counts as
    installed. The temp file lives next to the target so the move stays atomic.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    scratch = target.with_name(target.name + ".part")
    io.log(f"downloading {ONNX_URL}")
    try:
        with urlopen(ONNX_URL, timeout=60) as response:
            length = _content_length(response)
            written = 0
            with open(scratch, "wb") as handle:
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    handle.write(chunk)
                    written += len(chunk)
                    if length:
                        beat.at(fraction=WHISPER_SHARE + (1.0 - WHISPER_SHARE) * min(1.0, written / length))
        # A connection that closes early can end the stream without an exception,
        # and a short file over the size floor would pass the check below, so the
        # promised length is what proves the body arrived whole.
        if length and written < length:
            raise RuntimeError(f"{ONNX_NAME} stopped after {written} of {length} bytes (Content-Length)")
        size = scratch.stat().st_size
        if size <= MIN_ONNX_BYTES:
            raise RuntimeError(f"{ONNX_NAME} is only {size} bytes, expected more than {MIN_ONNX_BYTES}")
        io._replace_with_retry(scratch, target)
    except BaseException:
        scratch.unlink(missing_ok=True)
        raise


def _content_length(response) -> int | None:
    """The declared body size, when the server sent one."""
    try:
        headers = getattr(response, "headers", None)
        value = headers.get("Content-Length") if headers is not None else None
        return int(value) if value else None
    except (TypeError, ValueError):  # pragma: no cover - a malformed header
        return None


def run(
    spec: dict,
    progress_path: str | os.PathLike[str] | None = None,
    chunk_size: int = CHUNK_SIZE,
) -> dict:
    """``{whisper: {path, downloaded}, yunet: {path, downloaded}}``.

    Each side is skipped when it is already on disk, so a second ``--setup-asr``
    costs a couple of file checks rather than another 2 GB.
    """
    models_dir_value = spec.get("modelsDir")
    if not models_dir_value:
        raise ValueError("download-models needs modelsDir (the folder to download the models into)")
    models_dir = Path(str(models_dir_value))
    repo = str(spec.get("whisperRepo") or DEFAULT_WHISPER_REPO)
    folder = whisper_dir(models_dir)
    target = onnx_path(models_dir)

    beat = io.Heartbeat(progress_path, interval_sec=progress_interval())
    with beat:
        beat.at(fraction=0.0)
        whisper_downloaded = False
        if _whisper_present(folder):
            io.log(f"using the whisper model already in {folder}")
        else:
            _download_whisper(folder, repo)
            whisper_downloaded = True
        beat.at(fraction=WHISPER_SHARE)

        yunet_downloaded = False
        if _onnx_present(target):
            io.log(f"using the face model already at {target}")
        else:
            _download_onnx(target, beat, chunk_size)
            yunet_downloaded = True
    beat.finish()

    return {
        "whisper": {"path": str(folder), "downloaded": whisper_downloaded},
        "yunet": {"path": str(target), "downloaded": yunet_downloaded},
    }
