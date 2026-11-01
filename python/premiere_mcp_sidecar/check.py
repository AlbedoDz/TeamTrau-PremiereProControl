"""Environment report for the sidecar command: what is installed and usable.

The TypeScript server asks this before a heavy command so it can return
``asr.not_installed`` with a setup command instead of a failed job.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import sys
from pathlib import Path

from . import sherpa_models
from .download_models import (  # noqa: F401  (re-exported for callers of `check`)
    MIN_ONNX_BYTES,
    MIN_WHISPER_BYTES,
    ONNX_NAME,
    WHISPER_DIR_NAME,
    WHISPER_REQUIRED_FILES,
    whisper_missing,
)

# Ruling R22: the model download-models writes and the server runs. The folder name
# is also what `modelPaths().whisper` points at, so both sides agree by construction.
WHISPER_MODEL_DIR = WHISPER_DIR_NAME
WHISPER_WEIGHTS = WHISPER_REQUIRED_FILES[1]
# The same floor the downloader applies before it calls a folder complete.
WHISPER_MIN_WEIGHT_BYTES = MIN_WHISPER_BYTES

# The Zipformer rule lives in `sherpa_models`; re-exported so `check` speaks for
# every model it reports and a caller can see the two are the same function.
zipformer_missing = sherpa_models.zipformer_missing


def data_home() -> Path:
    """``PREMIERE_MCP_HOME`` or ``~/.premiere-mcp``: venv, models, jobs and renders live here."""
    return Path(os.environ.get("PREMIERE_MCP_HOME") or Path.home() / ".premiere-mcp")


def _faster_whisper_ok() -> bool:
    # The whisper extra is optional: do not import (or crash on) packages that are absent.
    if importlib.util.find_spec("faster_whisper") is None or importlib.util.find_spec("ctranslate2") is None:
        return False
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
    return not whisper_missing(models_dir / WHISPER_MODEL_DIR)


def _yunet_model_ok(models_dir: Path) -> bool:
    target = models_dir / ONNX_NAME
    return target.is_file() and target.stat().st_size > MIN_ONNX_BYTES


def _sherpa_ok() -> bool:
    """Whether the Zipformer runtime can be imported at all.

    Separate from the three folder flags: the models can be on disk while a
    broken sherpa-onnx install makes every Zipformer job fail on import.
    """
    try:
        import sherpa_onnx  # noqa: F401
    except Exception:
        return False
    return True


def _zipformer_model_ok(models_dir: Path, name: str) -> bool:
    """The folder is complete by the downloader's own rule: no missing or stub file."""
    return not sherpa_models.zipformer_missing(sherpa_models.folder(models_dir, name), name)


def run(ffmpeg_path: str | None = None) -> dict:
    """``{python, fasterWhisper, cuda, sherpaOnnx, models: {...}, ffmpeg}``."""
    models_dir = data_home() / "models"
    return {
        "python": sys.version.split()[0],
        "fasterWhisper": _faster_whisper_ok(),
        "cuda": _cuda_ok(),
        "sherpaOnnx": _sherpa_ok(),
        "models": {
            "whisper": _whisper_model_ok(models_dir),
            "yunet": _yunet_model_ok(models_dir),
            "zipformer68m": _zipformer_model_ok(models_dir, sherpa_models.ZIPFORMER_68M_DIR),
            "zipformer30m": _zipformer_model_ok(models_dir, sherpa_models.ZIPFORMER_30M_DIR),
            "vad": sherpa_models.vad_ok(models_dir),
        },
        "ffmpeg": bool(ffmpeg_path and Path(ffmpeg_path).is_file()) or shutil.which("ffmpeg") is not None,
    }
