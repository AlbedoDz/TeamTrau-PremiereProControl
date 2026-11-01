"""Fetch the models the analysis sidecar needs, per engine.

Run once by ``premiere-pro-mcp --setup-asr``, with the models folder and the
engines wanted as input, and skipped on every later run that finds the files
already there. ``engines`` defaults to ``["whisper-turbo"]``, which is the two
models the sidecar has always fetched:

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
  an error page or a truncated body, not as the model (the real file is 232,589 B).
  It is fetched on **every** run, whatever ``engines`` asks for (Ruling R36): the
  default install is the Zipformer-68M and the shorts pipeline counts faces on it.

The CPU Zipformer engines (T16py) add their own steps, all planned in
``sherpa_models``: one Hugging Face folder per model, the shared Silero VAD from
a GitHub release, and -- for the 30M, whose repo ships no ``tokens.txt`` -- a
``tokens.txt`` rebuilt from its ``bpe.model``. ``rover`` fetches both Zipformers.
Only the models of the engines asked for are in the result, each as
``{path, downloaded, failed}``, or ``{error, failed}`` when it could not be made.
YuNet is the exception: it is in the result of every run (Ruling R36).

Three rules came out of the first live run (fix round 1):

* **the VAD goes first.** Both Zipformer engines open ``silero_vad.onnx`` before
  they decode anything, and it was fetched last -- so a failure on the 30M left
  every later transcribe failing on a VAD that was never downloaded;
* **each model fails on its own.** One repo that will not download (a 404, a
  reset connection) is reported in its own entry and the rest of the run carries
  on: a 68M that arrived is worth more than a run that stopped at the 30M;
* **the bar is split by the bytes that actually move** (:func:`plan_shares`).
  Whisper turbo is ~1.8 GB of a Whisper setup but 0 % of a Zipformer-only one, so
  the fixed "first 90 %" jumped the bar to 0.9 on a run that downloads no whisper
  file at all. Sizes: Whisper turbo ~1.8 GB without CUDA (~3.8 GB with it, which
  the setup warns about separately), YuNet ~228 KB (232,589 B), the 68M int8
  ~77 MB, the 30M int8 ~30 MB, the VAD ~0.6 MB.

Fix round 2 (Ruling R36 and failure isolation): the face model is fetched for
every engine set, and every model -- whisper and YuNet included -- is one entry
of the result that can fail without touching the others.

Sizes for the Zipformer files are asked of Hugging Face first
(:func:`refresh_sizes`): the floor each file must clear is then the size the repo
publishes for it, which is what caught a real 1,033,417 B joiner being reported as
truncated by a round 1 MB floor. Offline, the floors are ``MIN_FILE_BYTES``.
"""

from __future__ import annotations

import os
from pathlib import Path
from urllib.request import urlopen

from . import io, sherpa_models

# The engines ``download-models`` knows, in the order the brief lists them.
ENGINE_NAMES = ("whisper-turbo", "zipformer-68m", "zipformer-30m", "rover")

# The download seam: ``huggingface_hub`` is bound to this name when a download is
# due. Imported lazily (see ``_snapshot_download``) because the library pulls
# requests, tokenizers and tqdm behind it, and `check` must stay cheap.
snapshot_download = None
# The other seam: ``huggingface_hub.HfApi``, used only to ask each repo for its
# file sizes, and cached for the life of the process.
hub_api = None

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
# YuNet 2023mar is 232,589 B. A truncated body or an HTML error page is far
# smaller, and a model that OpenCV cannot load fails every Faces-enabled job.
MIN_ONNX_BYTES = 100 * 1024

# Read size for the ONNX stream: the file is small, but never load it in one go.
CHUNK_SIZE = 256 * 1024

# Rough download sizes, only used to split the progress bar in proportion (see
# plan_shares). Whisper turbo is the model plus its config: ~1.8 GB.
WHISPER_BYTES = 1_800 * 1024 * 1024
YUENT_BYTES = 232 * 1024
# Share of the bar a whisper setup gives the whisper weights: ~1.8 GB of ~1.8 GB,
# so the YuNet stream reports its own byte position in the last fraction.
WHISPER_SHARE = WHISPER_BYTES / (WHISPER_BYTES + YUENT_BYTES)

# The file whose size tells a whole model from a truncated one (`check` reads too).
WHISPER_WEIGHTS = "model.bin"

# Every file the turbo folder needs, as a real download leaves it: the weights,
# the two configs, the tokenizer and the vocabulary. Checking only model.bin and
# config.json was not enough -- snapshot_download fetches in parallel, so an
# interrupted run can leave those two and be missing the tokenizer; the next run
# then skipped the folder as complete, `check` called it installed, and the first
# transcription failed offline. There is no marker file that says the snapshot is
# whole, so the file list is the marker.
WHISPER_REQUIRED_FILES = (
    "config.json",
    "model.bin",
    "preprocessor_config.json",
    "tokenizer.json",
    "vocabulary.json",
)
# large-v3-turbo is ~1.6 GB; a model.bin under 100 MB is a truncated download, not
# a model, and must be fetched again.
MIN_WHISPER_BYTES = 100 * 1024 * 1024

# Progress steps, in the order they run, and the key each is reported under.
VAD_STEP = "vad"
WHISPER_STEP = "whisper"
YUENT_STEP = "yunet"
ZIPFORMER_STEPS = {
    sherpa_models.ZIPFORMER_30M_DIR: "zipformer30m",
    sherpa_models.ZIPFORMER_68M_DIR: "zipformer68m",
}
WHISPER_STEPS = (WHISPER_STEP, YUENT_STEP)


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


def _hub_api():
    """``huggingface_hub.HfApi``, imported on first use (tests bind a fake here)."""
    global hub_api
    if hub_api is None:
        from huggingface_hub import HfApi

        hub_api = HfApi()
    return hub_api


def whisper_dir(models_dir: Path) -> Path:
    return models_dir / WHISPER_DIR_NAME


def onnx_path(models_dir: Path) -> Path:
    return models_dir / ONNX_NAME


def _whisper_present(folder: Path) -> bool:
    """The whole turbo set is there and the weights are whole: a partial copy does not count."""
    return not whisper_missing(folder)


def whisper_missing(folder: Path) -> list[str]:
    """What ``folder`` still lacks, in the order of ``WHISPER_REQUIRED_FILES``.

    Public because ``check`` asks the very same question: one implementation, so the
    installer and the environment report cannot disagree about what a model is.
    An empty list means the model is complete: every required file is present and
    ``model.bin`` is over ``MIN_WHISPER_BYTES``.
    """
    missing = [name for name in WHISPER_REQUIRED_FILES if not (folder / name).is_file()]
    if not missing and (folder / WHISPER_WEIGHTS).stat().st_size <= MIN_WHISPER_BYTES:
        missing.append(f"{WHISPER_WEIGHTS} under {MIN_WHISPER_BYTES} bytes")
    return missing


def _onnx_present(target: Path) -> bool:
    return target.is_file() and target.stat().st_size > MIN_ONNX_BYTES


def zipformer_names(engines: list[str]) -> list[str]:
    """The Zipformer folders ``engines`` needs, in the order they are downloaded.

    The VAD comes first: it is the file both engines open before decoding, and
    fetching it last is how one failed model left every transcribe without it.
    30M before 68M, the order of ``ROVER_ENGINES`` in ``transcribe``.
    """
    wanted = set(engines)
    names = []
    if wanted & {"zipformer-30m", "rover"}:
        names.append(sherpa_models.ZIPFORMER_30M_DIR)
    if wanted & {"zipformer-68m", "rover"}:
        names.append(sherpa_models.ZIPFORMER_68M_DIR)
    return names


def plan_names(engines: list[str]) -> list[str]:
    """Every step of the run in order, as the result key it is reported under.

    The VAD, then each Zipformer, then the whisper pair, then the face model --
    which is fetched whatever engines were asked for (Ruling R36), so it closes
    every plan and the bar ends on it. ``download-models`` walks this list and
    reports each step under the same key.
    """
    names = zipformer_names(engines)
    steps = [ZIPFORMER_STEPS[name] for name in names]
    if steps:
        steps = [VAD_STEP, *steps]
    if "whisper-turbo" in engines:
        steps.append(WHISPER_STEP)
    steps.append(YUENT_STEP)
    return steps


def step_bytes(step: str) -> int:
    """The rough bytes a step downloads (only used to split the bar)."""
    if step == VAD_STEP:
        return sherpa_models.VAD_BYTES
    if step == WHISPER_STEP:
        return WHISPER_BYTES
    if step == YUENT_STEP:
        return YUENT_BYTES
    for name, key in ZIPFORMER_STEPS.items():
        if key == step:
            return sherpa_models.REPO_BYTES[name]
    raise KeyError(step)


def plan_shares(engines: list[str]) -> list[float]:
    """The fraction of the bar each step of ``plan_names(engines)`` ends on.

    Proportional to what the step downloads, so a Zipformer-only run climbs
    through the whole bar (VAD, 30M, 68M) instead of sitting at 0 and jumping to
    1, and a whisper setup still gives the whisper weights ~94 % of it.
    """
    names = plan_names(engines)
    total = sum(step_bytes(name) for name in names) or 1
    shares = []
    done = 0
    for name in names:
        done += step_bytes(name)
        shares.append(min(1.0, done / total))
    return shares


def refresh_sizes(names: list[str]) -> None:
    """Ask Hugging Face for the size of every file of ``names``; offline is fine.

    The answer is what :func:`sherpa_models.floor_for` then holds each file to, so
    a real 1,033,417 B joiner is not called truncated by a round 1 MB floor. A
    hub that cannot be reached (no network, a 404, a rate limit) is logged and
    leaves the 100 KB fallback in place: the download itself still runs.
    """
    for name in names:
        repo = sherpa_models.repo_of(name)
        if repo in sherpa_models.HF_FILE_SIZES:
            continue
        wanted = sherpa_models.allow_patterns(name)
        try:
            entries = _hub_api().get_paths_info(repo_id=repo, paths=wanted)
            sizes = {
                getattr(entry, "path", None): int(getattr(entry, "size", 0) or 0)
                for entry in entries
                if getattr(entry, "path", None) and getattr(entry, "size", None)
            }
        except Exception as exc:  # noqa: BLE001 - any hub failure is the same fallback
            io.log(f"could not read the file sizes of {repo} ({exc}); using {sherpa_models.MIN_FILE_BYTES} byte floors")
            continue
        if not sizes:
            io.log(f"{repo} reported no file sizes; using {sherpa_models.MIN_FILE_BYTES} byte floors")
            continue
        missing = [filename for filename in wanted if filename not in sizes]
        if missing:
            io.log(f"{repo} lists no {', '.join(missing)}; it keeps the {sherpa_models.MIN_FILE_BYTES} byte floor")
        sherpa_models.remember_sizes(repo, sizes)


def _download_whisper(folder: Path, repo: str) -> None:
    """Pull the repo snapshot into ``folder``; ``huggingface_hub`` resumes a partial one.

    Its own progress bars are left alone: they go to stderr, which the installer
    streams to the user, so a 1.6 GB download is not silent for minutes.
    """
    io.log(f"downloading {repo} to {folder}")
    snapshot = _snapshot_download()
    snapshot(repo_id=repo, local_dir=str(folder), allow_patterns=ALLOW_PATTERNS)
    # A parallel fetch that was interrupted can come back without an error and
    # without every file, so the folder is judged here, not by the call's success.
    missing = whisper_missing(folder)
    if missing:
        raise RuntimeError(f"{repo} is still missing {', '.join(missing)} after the download")


def _download_onnx(
    target: Path,
    beat: io.Heartbeat,
    chunk_size: int = CHUNK_SIZE,
    span: tuple[float, float] = (WHISPER_SHARE, 1.0),
) -> None:
    """The face model: :func:`_download_file` with the YuNet URL and floor."""
    _download_file(target, ONNX_URL, MIN_ONNX_BYTES, ONNX_NAME, beat, chunk_size, span)


def _download_file(
    target: Path,
    url: str,
    minimum_bytes: int,
    label: str,
    beat: io.Heartbeat,
    chunk_size: int = CHUNK_SIZE,
    span: tuple[float, float] = (WHISPER_SHARE, 1.0),
) -> None:
    """Stream ``url`` to a temp file beside ``target``, then replace it in one step.

    Same reason as ``io.write_output``: a failed download must leave either nothing
    or the previous good file, never a truncated model that ``check`` counts as
    installed. The temp file lives next to the target so the move stays atomic.

    ``label`` is the file name the errors name; ``minimum_bytes`` is the floor a
    complete body clears (a truncated body or an HTML error page does not).
    ``span`` is where on the progress bar this file sits; the byte position is
    reported inside it.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    scratch = target.with_name(target.name + ".part")
    low, high = span
    io.log(f"downloading {url}")
    try:
        with urlopen(url, timeout=60) as response:
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
                        beat.at(fraction=low + (high - low) * min(1.0, written / length))
        # A connection that closes early can end the stream without an exception,
        # and a short file over the size floor would pass the check below, so the
        # promised length is what proves the body arrived whole.
        if length and written < length:
            raise RuntimeError(f"{label} stopped after {written} of {length} bytes (Content-Length)")
        size = scratch.stat().st_size
        if size < minimum_bytes:
            raise RuntimeError(f"{label} is only {size} bytes, expected at least {minimum_bytes}")
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
    """``{whisper: {...}, yunet: {...}, vad: {...}, zipformer30m: {...}, ...}``.

    Each side is skipped when it is already on disk, so a second ``--setup-asr``
    costs a couple of file checks rather than another download. Every entry is
    ``{path, downloaded, failed}``, or ``{error, failed}`` when that one model
    could not be made -- one model failing never stops the others, and the caller
    decides from ``failed`` (``__main__`` exits non-zero: see :func:`failed`).

    ``engines`` (T16py) names what to fetch: ``whisper-turbo`` (the default,
    exactly the two models above) and/or the Zipformer engines, which add their
    own folders and the shared Silero VAD; ``rover`` is both Zipformers. The face
    model is fetched for every one of them (Ruling R36): the default install is
    the 68M alone, and ``detectFaces`` has to work on it. Only the models of the
    engines that were asked for are in the result, plus ``yunet``.

    The Zipformer plan itself lives in ``sherpa_models``: ``check`` and
    ``transcribe`` read the same folders, and one definition is what keeps setup
    and the environment report from disagreeing about a complete model.
    """
    models_dir_value = spec.get("modelsDir")
    if not models_dir_value:
        raise ValueError("download-models needs modelsDir (the folder to download the models into)")
    models_dir = Path(str(models_dir_value))
    repo = str(spec.get("whisperRepo") or DEFAULT_WHISPER_REPO)
    engines = engines_of(spec)
    names = zipformer_names(engines)
    shares = plan_shares(engines)
    marks = dict(zip(plan_names(engines), shares))

    # Before anything downloads: the floor each Zipformer file must clear is the
    # size the repo publishes for it (see refresh_sizes).
    refresh_sizes(names)

    beat = io.Heartbeat(progress_path, interval_sec=progress_interval())
    result: dict[str, dict] = {}
    with beat:
        beat.at(fraction=0.0)

        # The VAD first: both engines open it before they decode anything, so a
        # run that stops before it leaves every transcribe failing to load it.
        if names:
            result["vad"] = _step(
                lambda: _download_vad(models_dir, beat, chunk_size, _span(marks, VAD_STEP)),
                "vad",
            )
            beat.at(fraction=marks[VAD_STEP])

        for name in names:
            key = ZIPFORMER_STEPS[name]
            result[key] = _step(lambda name=name: _download_zipformer(name, models_dir), key)
            beat.at(fraction=marks[key])

        # Then the whisper pair, then the face model. Both go through `_step` like
        # every Zipformer (fix round 2): a whisper that will not download is one
        # failed entry in the result, not an exception that hides what did arrive,
        # and a lost YuNet does not undo a 1.8 GB whisper that is already on disk.
        if "whisper-turbo" in engines:
            result[WHISPER_STEP] = _step(
                lambda: _download_whisper_step(whisper_dir(models_dir), repo), WHISPER_STEP
            )
            beat.at(fraction=marks[WHISPER_STEP])

        # Ruling R36: the face model is fetched whatever engines were asked for. The
        # default install is the 68M and the VAD, and the shorts pipeline counts
        # faces on it; 232,589 B is nothing next to any model here.
        result[YUENT_STEP] = _step(
            lambda: _download_onnx_step(
                onnx_path(models_dir), beat, chunk_size, _span(marks, YUENT_STEP)
            ),
            YUENT_STEP,
        )
        beat.at(fraction=marks[YUENT_STEP])
    beat.finish()

    return result


def _download_whisper_step(folder: Path, repo: str) -> dict:
    """The turbo folder: skipped when whole, fetched and judged otherwise."""
    if _whisper_present(folder):
        io.log(f"using the whisper model already in {folder}")
        return {"path": str(folder), "downloaded": False}
    _download_whisper(folder, repo)
    return {"path": str(folder), "downloaded": True}


def _download_onnx_step(
    target: Path,
    beat: io.Heartbeat,
    chunk_size: int = CHUNK_SIZE,
    span: tuple[float, float] = (WHISPER_SHARE, 1.0),
) -> dict:
    """The face model: skipped when whole, streamed and verified otherwise."""
    if _onnx_present(target):
        io.log(f"using the face model already at {target}")
        return {"path": str(target), "downloaded": False}
    _download_onnx(target, beat, chunk_size, span)
    return {"path": str(target), "downloaded": True}


def _span(marks: dict[str, float], step: str) -> tuple[float, float]:
    """Where ``step`` sits on the bar: from the previous step's mark to its own."""
    names = list(marks)
    low = marks[names[names.index(step) - 1]] if names.index(step) else 0.0
    return (low, marks[step])


def _step(action, key: str) -> dict:
    """Run one step of the plan and report it as ``{path, downloaded, failed}``.

    A failure is caught here, not at the top: a repo that will not download is
    one bad entry in the result, and every other model still arrives -- the whole
    point of the fix (a 30M that would not download used to cost the 68M and the
    VAD as well). ``failed`` is on every entry so a caller can test one key on
    all of them, and ``run``'s result carries the failing keys at the top level.
    """
    try:
        entry = action()
    except Exception as exc:  # noqa: BLE001 - any failure of one model is reported, not raised
        io.log(f"{key} failed: {exc}")
        return {"error": str(exc) or type(exc).__name__, "failed": True}
    return {**entry, "failed": False}


def failed(result: dict) -> list[str]:
    """The keys of ``result`` that failed: what ``__main__`` turns into a non-zero exit."""
    return [key for key, entry in result.items() if entry.get("failed")]


def engines_of(spec: dict) -> list[str]:
    """The engines in ``spec`` (``whisper-turbo`` when the input names none), checked."""
    engines = [str(engine) for engine in spec.get("engines") or []]
    if not engines:
        return ["whisper-turbo"]
    unknown = [engine for engine in engines if engine not in ENGINE_NAMES]
    if unknown:
        raise ValueError(f"unknown engine {unknown[0]!r}; expected one of {', '.join(ENGINE_NAMES)}")
    return engines


def _download_zipformer(name: str, models_dir: Path) -> dict:
    """Pull one Zipformer folder, and build its tokens.txt when the repo has none.

    A folder whose weights are already there is not fetched again even when its
    generated ``tokens.txt`` is gone: that file is rebuilt from the ``bpe.model``
    on disk, the same way ``transcribe`` rebuilds it at job time.
    """
    folder = sherpa_models.folder(models_dir, name)
    plan = sherpa_models.files_of(name)
    downloaded = False
    # A download is due when a file a download would bring is missing or stubbed;
    # the 30M's generated tokens.txt is not one of them (see downloaded_missing).
    if sherpa_models.downloaded_missing(folder, name):
        repo = sherpa_models.repo_of(name)
        io.log(f"downloading {repo} to {folder}")
        # Exactly the file names of the model table: `*.onnx` also brought the
        # fp32 encoder (92 MB for the 30M) that sherpa never opens.
        _snapshot_download()(
            repo_id=repo,
            local_dir=str(folder),
            allow_patterns=sherpa_models.allow_patterns(name),
        )
        downloaded = True
    else:
        io.log(f"using the {name} model already in {folder}")
    if name in sherpa_models.GENERATED_TOKENS:
        tokens = folder / plan["tokens"]
        if not tokens.is_file() or tokens.stat().st_size < sherpa_models.MIN_TOKENS_BYTES:
            io.log(f"building {tokens} from {plan['bpe']}")
            sherpa_models.write_tokens(folder / plan["bpe"], tokens)
    # CC-BY-NC-ND-4.0: a note in the folder, because the licence is not one that
    # lets this be shipped or used for paid work. Written from the folder, so a
    # 30M that was already complete still gets it.
    sherpa_models.write_license_note(name, folder)
    # A parallel fetch that was interrupted can come back without an error and
    # without every file, so the folder is judged here, not by the call's success.
    missing = sherpa_models.zipformer_missing(folder, name)
    if missing:
        repo = sherpa_models.repo_of(name)
        raise RuntimeError(f"{repo} is still missing {', '.join(missing)} after the download")
    return {"path": str(folder), "downloaded": downloaded}


def _download_vad(
    models_dir: Path,
    beat: io.Heartbeat,
    chunk_size: int = CHUNK_SIZE,
    span: tuple[float, float] = (0.0, 1.0),
) -> dict:
    """The Silero VAD both Zipformer engines split their audio with: one small file."""
    target = sherpa_models.vad_path(models_dir)
    if sherpa_models.vad_ok(models_dir):
        io.log(f"using the VAD already at {target}")
        return {"path": str(target), "downloaded": False}
    _download_file(
        target,
        sherpa_models.VAD_URL,
        sherpa_models.MIN_VAD_BYTES,
        sherpa_models.VAD_NAME,
        beat,
        chunk_size,
        span,
    )
    return {"path": str(target), "downloaded": True}
