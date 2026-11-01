"""Environment report for the sidecar command: what is installed and usable.

The TypeScript server asks this before a heavy command so it can return
``asr.not_installed`` with a setup command instead of a failed job.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from .download_models import (
    MIN_ONNX_BYTES,
    MIN_WHISPER_BYTES,
    ONNX_NAME,
    WHISPER_DIR_NAME,
    WHISPER_REQUIRED_FILES,
    _whisper_missing,
)

# Ruling R22: the model download-models writes and the server runs. The folder name
# is also what `modelPaths().whisper` points at, so both sides agree by construction.
WHISPER_MODEL_DIR = WHISPER_DIR_NAME
WHISPER_WEIGHTS = WHISPER_REQUIRED_FILES[1]
# The same floor the downloader applies before it calls a folder complete.
WHISPER_MIN_WEIGHT_BYTES = MIN_WHISPER_BYTES


def data_home() -> Path:
    """``PREMIERE_MCP_HOME`` or ``~/.premiere-mcp``: venv, models, jobs and renders live here."""
    return Path(os.environ.get("PREMIERE_MCP_HOME") or Path.home() / ".premiere-mcp")


def _faster_whisper_ok() -> bool:
    try:
        import faster_whisper  # noqa: F401
    except Exception:
        return False
    return True


def _cuda_ok() -> bool:
    if not _faster_whisper_ok():
        return False
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def _whisper_model_ok(models_dir: Path) -> bool:
    """The turbo folder is complete enough for ``WhisperModel`` to load offline.

    Checked by exact path rather than by searching: a leftover large-v3 download
    from an older setup must not make the turbo model look installed, or the first
    transcription would fail on a model that was never fetched. And all five files
    must be there -- ``snapshot_download`` fetches in parallel, so an interrupted
    run used to leave model.bin + config.json behind, which was reported as
    installed and then failed on the missing tokenizer at the first transcription.
    """
    return not _whisper_missing(models_dir / WHISPER_MODEL_DIR)


def _yunet_model_ok(models_dir: Path) -> bool:
    target = models_dir / ONNX_NAME
    return target.is_file() and target.stat().st_size > MIN_ONNX_BYTES


def run() -> dict:
    """``{python, fasterWhisper, cuda, models: {whisper, yunet}, ffmpeg}``."""
    models_dir = data_home() / "models"
    return {
        "python": sys.version.split()[0],
        "fasterWhisper": _faster_whisper_ok(),
        "cuda": _cuda_ok(),
        "models": {
            "whisper": _whisper_model_ok(models_dir),
            "yunet": _yunet_model_ok(models_dir),
        },
        "ffmpeg": shutil.which("ffmpeg") is not None,
    }
