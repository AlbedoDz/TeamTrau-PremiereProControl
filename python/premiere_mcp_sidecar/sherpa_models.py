"""Where the CPU-friendly Zipformer models live, and whether the folder is whole.

One plan for two commands. ``download-models`` fetches the files and ``check``
reports them; both ask this module what a complete folder is, so setup cannot
skip a download that ``check`` calls installed and the first job then fail
offline. ``transcribe`` resolves its folders and rebuilds a 30M ``tokens.txt``
from what is on disk through :func:`ensure`.

The files are pinned to the exact releases the coordinator verified:

* 68M, ``csukuangfj/sherpa-onnx-zipformer-vi-int8-2025-04-20`` (Apache-2.0,
  upstream ``zzasdf/viet_iter3_pseudo_label``): encoder, decoder, joiner, the
  vocabulary and the sentencepiece model sherpa needs for hotwords;
* 30M, ``hynt/Zipformer-30M-RNNT-6000h`` (CC-BY-NC-ND-4.0): the same three ONNX
  files and ``bpe.model``, but **no** ``tokens.txt`` -- sherpa-onnx needs one, so
  :func:`write_tokens` rebuilds it from ``bpe.model`` at download time.

``bpe.model`` is required even though decoding reads ``tokens.txt``: it is part of
the released model, and a job that needs hotword biasing later opens it.

**Only the files a model loads are fetched** (fix round 1). Both repos carry a
second copy of every ONNX file in fp32 -- 92 MB of encoder for the 30M alone --
and the 30M has an int8 decoder as well, so a pattern like ``*.onnx`` pulled
about 120 MB per folder that sherpa never opens. :func:`allow_patterns` now hands
``snapshot_download`` the exact names of :data:`ZIPFORMER`, and the 30M's decoder
is the int8 one (1,308,690 B); the 68M has no int8 decoder, so its fp32 one stays.

**Size floors are per file, not per kind** (fix round 1). A round number cannot be
right for files this different: the 30M's joiner is 1,033,417 B -- a whole file --
and the 68M's decoder is 5 MB, so any single "weights" floor either called a real
joiner truncated (1 MB did) or was meaningless for a decoder. When the hub can be
asked, :func:`floor_for` is the size Hugging Face reports for that exact file: a
complete download lands on it byte for byte, and anything shorter is a partial
body. Offline, or when the hub cannot answer, every onnx/tokens/bpe file falls
back to :data:`MIN_FILE_BYTES` (100 KB), which is under the smallest real file of
either model (``tokens.txt``, 25,847 B) and still catches an HTML error page.
"""

from __future__ import annotations

import os
from pathlib import Path

from . import io

# The Whisper side of the models folder, imported from `download_models`, stays
# there; this module only plans the Zipformer side (see `download_models.run`).
ZIPFORMER_68M_DIR = "zipformer-vi-68m-int8"
ZIPFORMER_30M_DIR = "zipformer-vi-30m-int8"
VAD_NAME = "silero_vad.onnx"

# The VAD both Zipformer engines split their audio with: one file at the top of
# the models folder, shared, since the audio is the same either way.
VAD_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
# silero_vad.onnx is ~644 KB and a 100 KB floor separates it from an error page.
MIN_VAD_BYTES = 100 * 1024

# The offline floor: every onnx and bpe file of both models is larger than this
# (the smallest is the 30M's joiner and the 68M's joiner at 1,033,417 B).
MIN_FILE_BYTES = 100 * 1024

# Each folder, the repo it comes from and `model`, `encoder`, ... file names.
ZIPFORMER: dict[str, dict] = {
    ZIPFORMER_68M_DIR: {
        "repo": "csukuangfj/sherpa-onnx-zipformer-vi-int8-2025-04-20",
        "license": "Apache-2.0",
        "files": {
            "encoder": "encoder-epoch-12-avg-8.int8.onnx",
            # The 68M repo ships no int8 decoder: the fp32 one is what it loads.
            "decoder": "decoder-epoch-12-avg-8.onnx",
            "joiner": "joiner-epoch-12-avg-8.int8.onnx",
            "tokens": "tokens.txt",
            "bpe": "bpe.model",
        },
    },
    ZIPFORMER_30M_DIR: {
        "repo": "hynt/Zipformer-30M-RNNT-6000h",
        "license": "CC-BY-NC-ND-4.0",
        "files": {
            "encoder": "encoder-epoch-20-avg-10.int8.onnx",
            # The int8 decoder exists in the repo (1,308,690 B) and the fp32 one
            # (7 MB) is what a `*.onnx` fetch used to bring by accident.
            "decoder": "decoder-epoch-20-avg-10.int8.onnx",
            "joiner": "joiner-epoch-20-avg-10.int8.onnx",
            "tokens": "tokens.txt",
            "bpe": "bpe.model",
        },
    },
}

# The 30M repo ships no tokens.txt; :func:`write_tokens` makes this one.
GENERATED_TOKENS = frozenset({ZIPFORMER_30M_DIR})

# A tokens.txt smaller than this is not a vocabulary: the 68M's is 25 KB and the
# 30M's is built from a 4,000-piece bpe.model, so a 1 KB file is a stub.
MIN_TOKENS_BYTES = 1024

LICENSE_NOTE_NAME = "LICENSE-NOTE.txt"
# The 30M weights may not be used commercially: the server ships neither the
# model nor this note, but a user's models folder would otherwise give no sign.
LICENSE_NOTE = (
    "Zipformer-30M-RNNT-6000h (https://huggingface.co/hynt/Zipformer-30M-RNNT-6000h)\n"
    "is licensed CC-BY-NC-ND-4.0: NON-COMMERCIAL use only, no derivatives.\n"
    "The other models are Apache-2.0 (68M) and MIT (turbo Whisper).\n"
    "Do not ship this folder in a product or use it for paid work.\n"
)

# What a download of each model brings, for the progress split: the real sizes, so
# the bar moves in proportion to the bytes that are moving (Whisper is ~1.8 GB,
# the 68M ~77 MB, the 30M ~30 MB, the VAD ~0.6 MB).
REPO_BYTES = {
    ZIPFORMER_68M_DIR: 70_876_129 + 5_165_084 + 1_033_417 + 25_847 + 270_695,
    ZIPFORMER_30M_DIR: 27_699_063 + 1_308_690 + 1_033_417 + 268_106,
}
VAD_BYTES = 643_854

# File sizes learned from the hub, keyed by repo then file name. Filled by
# `download_models` before a snapshot and read by `floor_for`; empty offline.
HF_FILE_SIZES: dict[str, dict[str, int]] = {}


def folder(models_dir: Path, name: str) -> Path:
    return models_dir / name


def vad_path(models_dir: Path) -> Path:
    return models_dir / VAD_NAME


def repo_of(name: str) -> str:
    return ZIPFORMER[name]["repo"]


def files_of(name: str) -> dict[str, str]:
    return ZIPFORMER[name]["files"]


def allow_patterns(name: str) -> list[str]:
    """The exact files ``snapshot_download`` must fetch for ``name``.

    Not a glob: both repos hold fp32 copies of every ONNX file (the 30M's are
    ~120 MB in total) that sherpa never opens, and a ``*.onnx`` pattern fetched
    them every time. The file names of :data:`ZIPFORMER` are the whole model.
    """
    return [
        filename
        for kind, filename in ZIPFORMER[name]["files"].items()
        if not (kind == "tokens" and name in GENERATED_TOKENS)
    ]


def remember_sizes(repo: str, sizes: dict[str, int]) -> None:
    """Store what the hub said about ``repo``'s files, for :func:`floor_for`."""
    HF_FILE_SIZES[repo] = dict(sizes)


def floor_for(repo: str, filename: str) -> int:
    """The smallest whole ``filename``: its hub size, else :data:`MIN_FILE_BYTES`.

    A file the hub does not list under that name is 100 KB: a stub or an error
    page fails, and so does a truncated body of a real download.
    """
    return HF_FILE_SIZES.get(repo, {}).get(filename) or MIN_FILE_BYTES


def zipformer_missing(folder_path: Path, name: str) -> list[str]:
    """What ``folder_path`` still lacks for the model ``name``, in file order.

    Public because ``check`` asks the very same question: one implementation, so
    the installer and the environment report cannot disagree. An empty list means
    every file is present and clears its floor (:func:`floor_for`), and a
    ``tokens.txt`` is not a stub.

    ``tokens.txt`` is held to ``MIN_TOKENS_BYTES`` rather than the hub size,
    because a vocabulary is small by nature: the 68M ships 25,847 B of it, which
    is under the 100 KB floor every other offline file gets, and the 30M's is
    generated here so the hub has no size for it at all.
    """
    repo = repo_of(name)
    missing = []
    for kind, filename in files_of(name).items():
        target = folder_path / filename
        floor = MIN_TOKENS_BYTES if kind == "tokens" else floor_for(repo, filename)
        if not target.is_file():
            missing.append(filename)
        elif target.stat().st_size < floor:
            missing.append(f"{filename} under {floor} bytes")
    return missing


def downloaded_missing(folder_path: Path, name: str) -> list[str]:
    """The missing entries a download would fix, ignoring the generated tokens.txt.

    ``download-models`` asks this to decide whether the repo has to be fetched
    again: the 30M folder's ``tokens.txt`` is built from its ``bpe.model`` here,
    so its absence is not a reason for a 30 MB download.
    """
    plan = files_of(name)
    if name in GENERATED_TOKENS:
        generated = plan["tokens"]
        return [entry for entry in zipformer_missing(folder_path, name) if not entry.startswith(generated)]
    return zipformer_missing(folder_path, name)


def vad_ok(models_dir: Path) -> bool:
    target = vad_path(models_dir)
    return target.is_file() and target.stat().st_size >= MIN_VAD_BYTES


def _sentencepiece():
    """``SentencePieceProcessor``, imported only when a tokens file is due.

    Tests bind a fake here; the real one is 6 MB of wheels that ``check`` and a
    Whisper job never need.
    """
    from sentencepiece import SentencePieceProcessor

    return SentencePieceProcessor


def write_tokens(bpe_path: Path, tokens_path: Path) -> None:
    """Rebuild ``tokens.txt`` from ``bpe.model``: ``<piece> <id>``, one per line.

    sherpa-onnx reads tokens.txt as two columns, the symbol then its integer id,
    in the order the model scored them -- exactly the layout the 68M repo ships
    (UTF-8, LF, no BOM, ``▁`` kept as the word-boundary marker). ``bpe.model``
    holds that order, so the id is the piece's own index.

    A ``tokens.txt`` already at the target is left alone **unless it is under
    :data:`MIN_TOKENS_BYTES`**: a 1 KB file is a stub (an interrupted earlier
    write, or an empty repo file), and skipping it left the 30M folder looking
    complete with a vocabulary sherpa cannot load.

    Written to a temp file beside the target and moved into place, like every
    other file this sidecar writes: an interrupted run must not leave a short
    tokens.txt that ``check`` would then report as installed.
    """
    if tokens_path.is_file() and tokens_path.stat().st_size >= MIN_TOKENS_BYTES:
        return
    processor = _sentencepiece()(model_file=str(bpe_path))
    lines = [
        f"{processor.id_to_piece(index)} {index}"
        for index in range(processor.get_piece_size())
    ]
    tokens_path.parent.mkdir(parents=True, exist_ok=True)
    scratch = tokens_path.with_name(tokens_path.name + ".tmp")
    try:
        with open(scratch, "w", encoding="utf-8", newline="\n") as handle:
            handle.write("\n".join(lines) + "\n")
        os.replace(scratch, tokens_path)
    except BaseException:
        scratch.unlink(missing_ok=True)
        raise


def write_license_note(name: str, folder_path: Path) -> bool:
    """Put the CC-BY-NC-ND note in the 30M folder; a no-op for any other model.

    Returns whether the note is new. It is written from the folder alone, not from
    a download, so a folder of weights that is already complete still gets it.
    """
    if name != ZIPFORMER_30M_DIR:
        return False
    note = folder_path / LICENSE_NOTE_NAME
    if note.is_file():
        return False
    folder_path.mkdir(parents=True, exist_ok=True)
    note.write_text(LICENSE_NOTE, encoding="utf-8", newline="\n")
    return True


def ensure(models_dir: Path, name: str) -> Path:
    """The folder for the model ``name``, rebuilt from what is already there.

    No network: a missing (or stub) ``tokens.txt`` in a complete 30M folder is
    regenerated from its ``bpe.model``, everything else must have been downloaded
    by ``download-models``. The result is still complete after the call or this
    raises with the file names, so a job fails on one line instead of inside
    onnxruntime.
    """
    target = folder(models_dir, name)
    if name in GENERATED_TOKENS:
        tokens = target / files_of(name)["tokens"]
        if not tokens.is_file() or tokens.stat().st_size < MIN_TOKENS_BYTES:
            bpe = target / files_of(name)["bpe"]
            if not bpe.is_file():
                raise FileNotFoundError(
                    f"{target} has no bpe.model, so tokens.txt cannot be built: run --setup-asr with engine {name}"
                )
            io.log(f"building {tokens} from bpe.model")
            write_tokens(bpe, tokens)
    missing = zipformer_missing(target, name)
    if missing:
        raise FileNotFoundError(
            f"the {name} model is missing {', '.join(missing)} in {target}: run --setup-asr"
        )
    return target
