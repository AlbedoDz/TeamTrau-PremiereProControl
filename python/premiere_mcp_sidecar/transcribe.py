"""Word-level Vietnamese transcription with faster-whisper.

The TypeScript runner hands over a media file and the folder holding the model
weights, and gets back one row per spoken word. Ruling R22 fixes the model
(``large-v3-turbo``), the compute type (``int8_float16`` on CUDA, ``int8`` on
CPU) and the decoding options; the glossary is what turns the podcast's proper
nouns ("Vietcetera", "Trưng Trắc") into the right diacritics.

Audio is decoded by the ffmpeg binary through :func:`io.pcm16k`, never by
``faster_whisper.decode_audio``: the bundled PyAV build fails on some of the
podcast containers with a ``metadata_errors`` error. If CUDA cannot load or fails
mid-run the model is rebuilt on the CPU and the job continues -- slower, but a
job that would otherwise be lost.

Neither ``faster_whisper`` nor ``ctranslate2`` is imported at module import time.
ctranslate2 binds its CUDA libraries when it is first imported, and the
``nvidia-*`` wheels put cublas/cudnn somewhere Windows does not search, so the
import has to wait until :func:`_add_cuda_dll_directories` has run; doing it at
the top of this module is what made a CUDA install fall back to the CPU.

Progress (Ruling R19) is written after every segment and by a heartbeat while a
segment is still being transcribed, measured against the media duration in file
seconds; the media path is a single file, so its times are the file's own. The
CPU attempt after a CUDA failure continues from the fraction the CUDA attempt
reached, so a poller never sees the job restart.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from . import io

# Ruling R22: options that must not drift between runs.
LANGUAGE = "vi"
BEAM_SIZE = 5
CUDA_COMPUTE_TYPE = "int8_float16"
CPU_COMPUTE_TYPE = "int8"


def windows() -> bool:
    """Whether this is Windows (tests pretend it is to check the DLL sweep)."""
    return sys.platform == "win32"


def _import_whisper_model():
    """``faster_whisper.WhisperModel``, imported only after the DLL path is set.

    Importing this module must not load ctranslate2 (see the module docstring), so
    the import lives here and runs from :func:`run`; tests replace this function.
    """
    from faster_whisper import WhisperModel

    return WhisperModel


def _add_cuda_dll_directories() -> None:
    """Let ctranslate2 find cublas/cudnn when they came from the ``nvidia-*`` wheels.

    A CUDA install through ``requirements-cuda.txt`` puts the DLLs under
    ``site-packages/nvidia/<lib>/bin``, which is not on the search path; without
    this ``WhisperModel(device="cuda")`` fails with "Cannot load library
    cublas64_12.dll" and every job would quietly run on the CPU.

    Every ``nvidia/<lib>/bin`` that exists is added, not just cublas and cudnn:
    which libraries the pinned ctranslate2 build loads (cudart, cufft, nvrtc, ...)
    is not ours to assume, and adding a directory costs nothing.
    """
    if not windows() or not hasattr(os, "add_dll_directory"):
        return
    try:
        import site
    except ImportError:  # pragma: no cover - site is always importable
        return
    roots = {Path(path) for path in site.getsitepackages()} if hasattr(site, "getsitepackages") else set()
    roots.add(Path(sys.prefix) / "Lib" / "site-packages")
    for root in roots:
        libraries = root / "nvidia"
        if not libraries.is_dir():
            continue
        for library in sorted(libraries.glob("*/bin")):
            if not library.is_dir():
                continue
            try:
                os.add_dll_directory(str(library))
            except OSError as exc:  # pragma: no cover - a broken install
                io.log(f"could not add {library} to the DLL search path: {exc}")


def cuda_available() -> bool:
    """Whether ctranslate2 can see a CUDA device at all."""
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def progress_interval() -> float:
    """Seconds between heartbeat writes (tests shrink it)."""
    return io.PROGRESS_INTERVAL_SEC


def _model_options(device: str) -> dict:
    """How to build the model on ``device``; Ruling R22 fixes the compute types."""
    options = {
        "device": device,
        "compute_type": CUDA_COMPUTE_TYPE if device == "cuda" else CPU_COMPUTE_TYPE,
        # The model folder was downloaded by setup: never reach for the network.
        "local_files_only": True,
    }
    if device == "cuda":
        options["device_index"] = 0
    return options


def _transcribe(model, audio, glossary: list[str], progress: io.Heartbeat) -> tuple[list[dict], float]:
    """Run the model over ``audio`` and flatten its segments into word rows."""
    prompt = ", ".join(glossary) if glossary else None
    # The generator is lazy: transcribe() returns as soon as decoding starts, so the
    # heartbeat has to be running before the first segment is pulled out of it.
    segments, info = model.transcribe(
        audio,
        language=LANGUAGE,
        beam_size=BEAM_SIZE,
        word_timestamps=True,
        vad_filter=True,
        initial_prompt=prompt,
    )
    duration = float(getattr(info, "duration", 0.0) or 0.0)
    progress.total_sec = duration or None
    words: list[dict] = []
    for segment in segments:
        for word in getattr(segment, "words", None) or []:
            text = (word.word or "").strip()
            if not text:
                continue
            # faster-whisper marks pauses with blank words and occasionally
            # emits a zero-length one; neither is a word the captions can use.
            words.append({
                "w": text,
                "start": round(float(word.start), 3),
                "end": round(float(word.end), 3),
                "p": round(float(word.probability), 3),
            })
        progress.at(seconds=getattr(segment, "end", None))
    return words, duration


def run(spec: dict, progress_path: str | os.PathLike[str] | None = None) -> dict:
    """``{words: [{w, start, end, p}], device, computeType, durationSec}``."""
    media_path = spec.get("mediaPath")
    if not media_path:
        raise ValueError("transcribe needs mediaPath")
    if not Path(media_path).is_file():
        raise FileNotFoundError(f"mediaPath does not exist: {media_path}")
    model_dir = spec.get("modelDir")
    if not model_dir:
        raise ValueError("transcribe needs modelDir (the folder holding the model weights)")
    glossary = [str(entry) for entry in spec.get("glossary") or [] if str(entry).strip()]

    # Before the first ctranslate2 import, here or in cuda_available().
    _add_cuda_dll_directories()
    WhisperModel = _import_whisper_model()

    # Decode before loading the model: a bad file should fail in seconds, not
    # after minutes of loading weights onto the GPU.
    audio = io.pcm16k(media_path)

    wanted = str(spec.get("device") or "auto").lower()
    devices = ["cpu"] if wanted == "cpu" or not cuda_available() else (["cuda", "cpu"] if wanted == "auto" else [wanted])

    last_error: Exception | None = None
    previous: io.Heartbeat | None = None
    for device in devices:
        options = _model_options(device)
        # A fresh heartbeat per attempt: a fallback restarts the clock, so the ETA
        # reflects the CPU run rather than the failed CUDA one. It does not restart
        # the fraction: that is the job's, and a lower value would look like a restart.
        progress = io.Heartbeat(progress_path, total_sec=None, interval_sec=progress_interval())
        progress.adopt(previous)
        previous = progress
        try:
            model = WhisperModel(str(model_dir), **options)
            with progress:
                words, duration = _transcribe(model, audio, glossary, progress)
        except Exception as exc:
            # Ruling R22: any CUDA load or run error retries on the CPU. A CPU error
            # is the real failure and propagates; interrupts are never a fallback.
            if device == "cpu":
                raise
            last_error = exc
            io.log(f"CUDA failed ({exc}); falling back to the CPU with {CPU_COMPUTE_TYPE}")
            continue
        progress.finish()
        return {
            "words": words,
            "device": device,
            "computeType": options["compute_type"],
            "durationSec": round(duration, 3),
        }
    raise RuntimeError(f"could not load the model in {model_dir}: {last_error}")
