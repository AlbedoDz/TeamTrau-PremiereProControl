"""Word-level Vietnamese transcription: turbo Whisper, or a CPU Zipformer.

The TypeScript runner hands over a media file, the engine to run it with and the
folders holding the weights, and gets back one row per spoken word. Ruling R22
fixes the Whisper side (``large-v3-turbo``, ``int8_float16`` on CUDA, ``int8`` on
CPU, the decoding options); the glossary is what turns the podcast's proper nouns
("Vietcetera", "Trưng Trắc") into the right diacritics.

Four engines, ``engine`` in the input (T16py):

* ``whisper-turbo`` (the default, and byte-for-byte the behaviour above);
* ``zipformer-68m`` / ``zipformer-30m``: sherpa-onnx int8 transducers that run on
  the CPU at a fraction of the size, for the PCs without an NVIDIA GPU. Silero
  VAD splits the audio into speech chunks, each chunk is decoded on its own, and
  the tokens are rebuilt into words;
* ``rover``: both Zipformers over the same chunks, their word lists combined by
  the alignment rule in :func:`_rover_words`.

The Zipformer engines read their folders from ``modelsDir`` (``modelDir`` stays
the Whisper folder) and report ``engine`` in the result; Whisper's result also
carries it, with its own value, so a caller never has to guess what ran.

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

import difflib
import math
import os
import sys
import unicodedata
from pathlib import Path

import numpy as np

from . import io, sherpa_models

# Ruling R22: options that must not drift between runs.
LANGUAGE = "vi"
BEAM_SIZE = 5
CUDA_COMPUTE_TYPE = "int8_float16"
CPU_COMPUTE_TYPE = "int8"

# The engines the input may name, and what a missing ``engine`` means.
WHISPER_ENGINE = "whisper-turbo"
ZIPFORMER_68M_ENGINE = "zipformer-68m"
ZIPFORMER_30M_ENGINE = "zipformer-30m"
ROVER_ENGINE = "rover"
ENGINES = (WHISPER_ENGINE, ZIPFORMER_68M_ENGINE, ZIPFORMER_30M_ENGINE, ROVER_ENGINE)
ZIPFORMER_ENGINES = frozenset({ZIPFORMER_68M_ENGINE, ZIPFORMER_30M_ENGINE, ROVER_ENGINE})

# Engine -> model folder, for the Zipformer side.
ENGINE_FOLDERS = {
    ZIPFORMER_68M_ENGINE: sherpa_models.ZIPFORMER_68M_DIR,
    ZIPFORMER_30M_ENGINE: sherpa_models.ZIPFORMER_30M_DIR,
}
# ROVER needs the two models, and takes them in this order (see _rover_words).
ROVER_ENGINES = (ZIPFORMER_30M_ENGINE, ZIPFORMER_68M_ENGINE)

# CPU-only, like every Zipformer job: the point of these engines is a PC without
# an NVIDIA card, and 4 threads keeps a background job from taking the machine.
MAX_THREADS = 4
# VAD: half a second of silence ends a chunk, and a chunk never runs past 20 s
# (a long unbroken talk would otherwise be one decode of minutes).
MIN_SILENCE_SEC = 0.5
MAX_SPEECH_SEC = 20.0
# How much audio the VAD is handed per `accept_waveform`: 512 samples (32 ms) is
# one Silero window, so the detector fires as soon as a chunk closes and its
# buffer never holds more than the chunk in progress (see `speech_chunks`).
VAD_WINDOW = 512
# A caption needs a visible span; sherpa timestamps can put two words on one token.
MIN_WORD_SEC = 0.04
# sherpa's ``▁`` is the sentencepiece word boundary; some builds emit a space.
WORD_START_MARKERS = ("▁", " ")
# A ROVER span only counts as more confident when it is this much better than the
# other: two 1.0 scores that differ in the last float digit are a tie, and a tie
# goes to the 30M.
ROVER_P_EPSILON = 1e-9


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

    The directories go on ``PATH`` as well as through ``os.add_dll_directory``.
    ctranslate2 and cuBLAS open each other lazily with a plain ``LoadLibrary``,
    which searches ``PATH`` and ignores the directories added above; on the live
    install the DLL was there and ``check`` reported cuda, and the job still fell
    back to the CPU until the same directories were on ``PATH``. ``PATH`` is
    prepended, so the wheel's own copy wins over a different CUDA install, and a
    directory already listed is moved rather than added twice.
    """
    if not windows() or not hasattr(os, "add_dll_directory"):
        return
    try:
        import site
    except ImportError:  # pragma: no cover - site is always importable
        return
    roots = {Path(path) for path in site.getsitepackages()} if hasattr(site, "getsitepackages") else set()
    roots.add(Path(sys.prefix) / "Lib" / "site-packages")
    search_path: list[str] = []
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
            if str(library) not in search_path:
                search_path.append(str(library))
    _prepend_to_path(search_path)


def _prepend_to_path(directories: list[str]) -> None:
    """Put ``directories`` at the front of ``PATH``, once each, order kept."""
    if not directories:
        return
    current = os.environ.get("PATH") or ""
    rest = [entry for entry in current.split(os.pathsep) if entry and entry not in directories]
    os.environ["PATH"] = os.pathsep.join([*directories, *rest])


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
        # Ruling R30: turbo punctuates almost nothing (15 sentence ends in 2181
        # words on the live podcast), but every segment is a phrase, so the last
        # word a segment actually produced is marked as ending one. Flattening the
        # segments used to throw that boundary away and the sentences came out of
        # punctuation alone. ``segment_end`` counts the words that survived the
        # blank/empty filter below, not the segment's words list.
        segment_end = len(words)
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
        if len(words) > segment_end:
            words[-1]["segEnd"] = True
        progress.at(seconds=getattr(segment, "end", None))
    return words, duration


def run(spec: dict, progress_path: str | os.PathLike[str] | None = None) -> dict:
    """``{words: [{w, start, end, p}], device, computeType, engine, durationSec}``."""
    engine = engine_of(spec)
    media_path = spec.get("mediaPath")
    if not media_path:
        raise ValueError("transcribe needs mediaPath")
    if not Path(media_path).is_file():
        raise FileNotFoundError(f"mediaPath does not exist: {media_path}")
    if engine in ZIPFORMER_ENGINES:
        return _run_zipformer(engine, spec, progress_path)
    return _run_whisper(spec, progress_path)


def engine_of(spec: dict) -> str:
    """The requested engine, ``whisper-turbo`` when the input names none."""
    engine = str(spec.get("engine") or WHISPER_ENGINE)
    if engine not in ENGINES:
        raise ValueError(f"unknown engine {engine!r}; expected one of {', '.join(ENGINES)}")
    return engine


def threads() -> int:
    """Decoder threads: up to four, fewer on a smaller machine (tests fake the count)."""
    return max(1, min(MAX_THREADS, os.cpu_count() or 1))


def _run_whisper(spec: dict, progress_path: str | os.PathLike[str] | None) -> dict:
    """The turbo Whisper path: Ruling R22, unchanged."""
    media_path = spec.get("mediaPath")
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
        # Fix round 1 (B8): no ``engine`` key -- the whisper result is exactly what
        # it was before the Zipformers existed, so an existing caller that compared
        # the whole object (or passed it on unchanged) sees no difference. Only a
        # Zipformer result names its engine, and a caller knows which one it asked
        # for.
        return {
            "words": words,
            "device": device,
            "computeType": options["compute_type"],
            "durationSec": round(duration, 3),
        }
    raise RuntimeError(f"could not load the model in {model_dir}: {last_error}")


# --- the Zipformer engines ----------------------------------------------------


def _sherpa():
    """``sherpa_onnx``, imported on the first Zipformer job (tests replace this).

    Importing it costs a few hundred milliseconds of onnxruntime; ``check`` and
    every Whisper job must not pay it, so the import lives here, not at the top.
    """
    import sherpa_onnx

    return sherpa_onnx


def _vad_config(sherpa, vad_model: Path):
    """Silero VAD options: where the model is, and where a chunk ends.

    The two durations the brief fixes: 0.5 s of silence closes a chunk, and a
    speech run never grows past 20 s, so one decode stays bounded. The rest are
    sherpa's own defaults (0.5 threshold, 512-sample window at 16 kHz).
    """
    return sherpa.VadModelConfig(
        silero_vad=sherpa.SileroVadModelConfig(
            model=str(vad_model),
            min_silence_duration=MIN_SILENCE_SEC,
            max_speech_duration=MAX_SPEECH_SEC,
        ),
        sample_rate=io.SAMPLE_RATE,
    )


def _build_recognizer(model_file: dict[str, str], sherpa):
    """An offline transducer over the four files of a Zipformer folder.

    ``from_transducer`` is the documented entry point for exactly these models;
    the decoding method is the one the spike ran (modified beam search, which is
    also what hotword biasing would need later).
    """
    return sherpa.OfflineRecognizer.from_transducer(
        encoder=model_file["encoder"],
        decoder=model_file["decoder"],
        joiner=model_file["joiner"],
        tokens=model_file["tokens"],
        num_threads=threads(),
        decoding_method="modified_beam_search",
    )


def speech_chunks(sherpa, audio, vad_model: Path) -> list[tuple[float, float]]:
    """Split ``audio`` into speech spans ``(start, end)`` in seconds, with Silero VAD.

    The audio is fed in :data:`VAD_WINDOW`-sample windows and the finished-chunk
    queue is drained after every window (fix round 1). One ``accept_waveform`` of
    the whole file was wrong two ways: the detector's buffer is
    ``buffer_size_in_seconds`` long, so a real episode overflowed it -- sherpa
    logs ``circular-buffer.cc:Push: Overflow!`` and copies the buffer, doubling
    the memory of a 9-minute file at once -- and on the live 2-minute clip the
    one-shot call produced a single bogus 8 s span where windows produced seven
    real ones. Feeding in windows also means only the current window and the
    pending chunk are in memory, whatever the length of the file.

    ``flush`` at the end closes the chunk still open when the audio stops, and the
    queue is drained once more so that chunk is not lost.

    A segment's ``start`` is a sample index on the **whole file** even when the
    audio arrived in pieces (checked on the live clip: the spans of a windowed run
    are the same as the offsets built from them), which is why the spans can be
    placed on the file's own timeline at all.
    """
    detector = sherpa.VoiceActivityDetector(_vad_config(sherpa, vad_model), buffer_size_in_seconds=60)
    rate = io.SAMPLE_RATE
    spans: list[tuple[float, float]] = []

    def drain() -> None:
        while not detector.empty():
            segment = detector.front
            start = segment.start / rate
            spans.append((start, start + len(segment.samples) / rate))
            detector.pop()

    for offset in range(0, len(audio), VAD_WINDOW):
        detector.accept_waveform(np.asarray(audio[offset:offset + VAD_WINDOW], dtype=np.float32))
        drain()
    detector.flush()
    drain()
    return spans


def _decode_chunk(recognizer, samples) -> list[dict]:
    """One VAD chunk through the transducer, in the chunk's own seconds.

    ``result.tokens`` and ``result.timestamps`` are per token; the boundaries
    between words are the ``▁`` markers, so the pieces in between are joined into
    the word they belong to. ``ys_log_probs`` is where per-token log-probabilities
    would be, but sherpa-onnx 2.0.1 leaves it empty, so ``p`` is 1.0 unless a
    future build fills it.

    A token that is **only** the marker (``"▁"``, or a lone space) carries no
    piece of its own, but it still says where the next word begins (fix round 1).
    The old loop skipped it, so the token after it was glued onto the previous
    word and the new word lost its start time: ``["▁XIN", "▁", "CHÀO"]`` came out
    as one word "xinchào". Now the marker arms ``pending`` and the next piece
    starts a word timed at **that piece's** token time -- the marker's own
    timestamp is the one place the boundary is known, and the piece that follows
    is when it is actually spoken.
    """
    stream = recognizer.create_stream()
    stream.accept_waveform(io.SAMPLE_RATE, np.asarray(samples, dtype=np.float32))
    recognizer.decode_stream(stream)
    result = stream.result
    tokens = list(getattr(result, "tokens", None) or [])
    stamps = list(getattr(result, "timestamps", None) or [])
    log_probs = list(getattr(result, "ys_log_probs", None) or [])

    words: list[dict] = []
    current: dict | None = None
    # Set by a bare marker: the next piece is the first of a new word.
    pending = False
    for index, token in enumerate(tokens):
        start = float(stamps[index]) if index < len(stamps) else 0.0
        begins = pending or any(token.startswith(marker) for marker in WORD_START_MARKERS)
        piece = token.lstrip("".join(WORD_START_MARKERS))
        if not piece:
            # A bare marker: nothing to append, but the next piece starts a word.
            pending = True
            continue
        pending = False
        # Kept as the log-probability: _finish_words averages them before exp, so a
        # word made of several pieces is scored once, not once per piece.
        log_probability = float(log_probs[index]) if index < len(log_probs) else 0.0
        if begins or current is None:
            current = {"w": piece, "start": start, "logs": [log_probability]}
            words.append(current)
        else:
            current["w"] += piece
            current["logs"].append(log_probability)
    return words


def _finish_words(raw: list[dict], offset: float, chunk_end: float) -> list[dict]:
    """Turn the per-chunk pieces into word rows: times, casing, ``segEnd``.

    ``start`` is the first token's time plus the chunk's offset on the file;
    ``end`` is the next word's start, or the chunk's end for the last word, but
    never sooner than ``MIN_WORD_SEC`` after ``start``. Text is lowercased NFC --
    the model emits uppercase without punctuation, and the TypeScript side puts
    the casing back, so folding it here is what lets the two agree on a string.

    ``p`` is the word's probability: the mean of the token *log-probabilities*
    exponentiated (a geometric mean), which is the probability of the whole word
    seen as a product of its pieces, not an average that a long word would pull
    towards certainty.
    """
    words: list[dict] = []
    for index, piece in enumerate(raw):
        start = round(offset + piece["start"], 3)
        following = raw[index + 1]["start"] if index + 1 < len(raw) else chunk_end - offset
        end = max(round(offset + following, 3), round(start + MIN_WORD_SEC, 3))
        words.append({
            "w": unicodedata.normalize("NFC", piece["w"]).lower(),
            "start": start,
            "end": end,
            "p": round(math.exp(sum(piece["logs"]) / len(piece["logs"])), 3) if piece["logs"] else 1.0,
        })
    if words:
        words[-1]["segEnd"] = True
    return words


def _zipformer_words(engine: str, audio, spans, sherpa, models_dir: Path, beat: io.Heartbeat) -> list[list[dict]]:
    """Every chunk's words, for one engine, in chunk order."""
    folder = sherpa_models.ensure(models_dir, ENGINE_FOLDERS[engine])
    plan = sherpa_models.ZIPFORMER[ENGINE_FOLDERS[engine]]["files"]
    recognizer = _build_recognizer({key: str(folder / plan[key]) for key in ("encoder", "decoder", "joiner", "tokens")}, sherpa)
    chunks: list[list[dict]] = []
    for start, end in spans:
        samples = audio[int(start * io.SAMPLE_RATE):int(end * io.SAMPLE_RATE)]
        raw = _decode_chunk(recognizer, samples) if len(samples) else []
        chunks.append(_finish_words(raw, start, end))
        beat.at(seconds=end)
    return chunks


def _run_zipformer(engine: str, spec: dict, progress_path: str | os.PathLike[str] | None) -> dict:
    """The CPU Zipformer path: VAD, one decode per chunk, tokens to words."""
    models_dir = spec.get("modelsDir")
    if not models_dir:
        raise ValueError("transcribe needs modelsDir (the folder holding the Zipformer models)")
    models_dir = Path(str(models_dir))
    media_path = spec.get("mediaPath")

    # Decode before loading anything: a bad file should fail in seconds.
    audio = io.pcm16k(media_path)
    duration = len(audio) / io.SAMPLE_RATE
    sherpa = _sherpa()

    progress = io.Heartbeat(progress_path, total_sec=duration or None, interval_sec=progress_interval())
    with progress:
        spans = speech_chunks(sherpa, audio, sherpa_models.vad_path(models_dir))
        if engine == ROVER_ENGINE:
            # The two models judge the same chunks: the combination in _rover_words
            # only makes sense on identical spans. Each pass owns half of the bar
            # (fix round 1): both were recording against the whole file's duration,
            # so the first pass took the fraction to 1.0 and the second had nowhere
            # to go -- a poller saw the job finish, then start again. Half each
            # walks the bar once, in the order the work happens.
            sides = {
                name: _zipformer_words(
                    name, audio, spans, sherpa, models_dir,
                    progress.fraction(first=index * 0.5, span=0.5),
                )
                for index, name in enumerate(ROVER_ENGINES)
            }
            chunks = [
                _rover_words(sides[ZIPFORMER_30M_ENGINE][index], sides[ZIPFORMER_68M_ENGINE][index])
                for index in range(len(spans))
            ]
        else:
            chunks = _zipformer_words(engine, audio, spans, sherpa, models_dir, progress)
        progress.at(fraction=1.0)
    progress.finish()

    words = [word for chunk in chunks for word in chunk]
    return {
        "words": words,
        "device": "cpu",
        "computeType": CPU_COMPUTE_TYPE,
        "engine": engine,
        "durationSec": round(duration, 3),
    }


def _rover_words(words_30m: list[dict], words_68m: list[dict]) -> list[dict]:
    """Combine one chunk of 30M and 68M words by aligning their normalized text.

    The rule, in full, because it is a judgement call nobody can re-derive from
    the code:

    1. Both lists are aligned with :mod:`difflib` (``SequenceMatcher``) on the
       *normalized* text of each word -- lowercased NFC with spaces and the
       sentencepiece ``▁`` marker removed -- so casing and spacing cannot split a
       span the way a character comparison would.
    2. ``equal`` spans (both sides said the same words) keep the **68M** words
       and their timestamps: that is the better of the two models where they
       agree and its panel is the one the engine list advertises.
    3. **Ruling R35 -- every differing span takes the 30M side.** ``replace``,
       ``insert`` and ``delete`` are all the same judgement now: an insert is a
       replace with an empty 30M side and a delete one with an empty 68M side.
       sherpa-onnx 2.0.1 reports no per-token probabilities
       (``result.ys_log_probs`` is empty, so every word has ``p == 1.0``), which
       makes the confidence comparison below a guarantee that the 30M always
       wins -- and the 30M has the better published WER -- so the rule is stated
       once instead of left to a comparison that cannot discriminate. It also
       means a word only the 68M heard is **dropped** (the 30M's silence is its
       verdict), which is the change from the pre-R35 behaviour that kept it.
    4. The confidence comparison is still here for the day a sherpa-onnx build
       fills ``ys_log_probs``: when **both** sides of a differing span have a
       mean ``p`` under 1.0 (so the numbers mean something), the span goes to the
       side with the higher mean ``p``, compared with ``>`` -- a difference
       smaller than ``ROVER_P_EPSILON`` (or an exact tie) goes to the **30M**.

    The last word of the chunk is marked ``segEnd`` whichever side it came from;
    the caller has already given each word its final times.
    """
    left = [_rover_key(word) for word in words_30m]
    right = [_rover_key(word) for word in words_68m]
    matcher = difflib.SequenceMatcher(a=left, b=right, autojunk=False)
    merged: list[dict] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            merged.extend(dict(word) for word in words_68m[j1:j2])
        elif tag in ("replace", "insert", "delete"):
            merged.extend(dict(word) for word in _rover_span(words_30m[i1:i2], words_68m[j1:j2]))
    for word in merged:
        word.pop("segEnd", None)
    if merged:
        merged[-1]["segEnd"] = True
    return merged


def _rover_span(words_30m: list[dict], words_68m: list[dict]) -> list[dict]:
    """The 30M side of a differing span (R35), unless both sides have real confidences.

    Ruling R35: with every ``p`` at 1.0 (sherpa-onnx 2.0.1 reports no per-token
    probabilities) there is nothing to weigh, so the 30M side wins -- including an
    empty 30M side, which drops words only the 68M heard. The confidence
    comparison is kept for a build that reports probabilities: it runs only when
    both sides have a mean ``p`` strictly under 1.0, so a "1.0 versus 0.4" pair
    (one side confident, one side without data) is still the 30M's.
    """
    if not words_30m:
        # A delete: the 30M heard nothing here, and that is its answer.
        return []
    if not words_68m:
        return words_30m
    confidence_30m = sum(word["p"] for word in words_30m) / len(words_30m)
    confidence_68m = sum(word["p"] for word in words_68m) / len(words_68m)
    if confidence_30m < 1.0 and confidence_68m < 1.0:
        return words_68m if confidence_68m > confidence_30m + ROVER_P_EPSILON else words_30m
    return words_30m


def _rover_key(word: dict) -> str:
    """What the alignment compares: the text, folded so casing cannot matter."""
    return word["w"].replace("▁", "").replace(" ", "").strip()

