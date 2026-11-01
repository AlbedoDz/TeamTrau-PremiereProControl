"""Environment report for the sidecar command: what is installed and usable.

The TypeScript server asks this before a heavy command so it can return
``asr.not_installed`` with a setup command instead of a failed job.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

WHISPER_MODELS_DIR = "whisper"


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
    """A model counts as present when a snapshot folder holds its ``model.bin`` weights."""
    root = models_dir / WHISPER_MODELS_DIR
    return root.is_dir() and any(path.name == "model.bin" for path in root.rglob("*"))


def _yunet_model_ok(models_dir: Path) -> bool:
    root = models_dir / "yunet"
    return root.is_dir() and any(root.glob("*.onnx"))


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
