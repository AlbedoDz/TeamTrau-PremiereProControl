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
# silero_vad.onnx is ~2 MB and a 16 KB floor separates it from an error page.
MIN_VAD_BYTES = 16 * 1024

# The int8 encoders are ~71 MB (68M) and ~30 MB (30M); a file under 1 MB is an
# interrupted download, not weights.
MIN_ZIPFORMER_BYTES = 1024 * 1024
MIN_BPE_BYTES = 100 * 1024

# Each folder, the repo it comes from and `model`, `encoder`, ... file names.
ZIPFORMER: dict[str, dict] = {
    ZIPFORMER_68M_DIR: {
        "repo": "csukuangfj/sherpa-onnx-zipformer-vi-int8-2025-04-20",
        "license": "Apache-2.0",
        "files": {
            "encoder": "encoder-epoch-12-avg-8.int8.onnx",
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
            "decoder": "decoder-epoch-20-avg-10.onnx",
            "joiner": "joiner-epoch-20-avg-10.int8.onnx",
            "tokens": "tokens.txt",
            "bpe": "bpe.model",
        },
    },
}

# The 30M repo ships no tokens.txt; :func:`write_tokens` makes this one.
GENERATED_TOKENS = frozenset({ZIPFORMER_30M_DIR})

# The size floor each kind of file must clear. Decoder and tokens are small by
# nature, so they only have to exist.
MIN_BYTES = {
    "encoder": MIN_ZIPFORMER_BYTES,
    "decoder": 1,
    "joiner": MIN_ZIPFORMER_BYTES,
    "tokens": 1,
    "bpe": MIN_BPE_BYTES,
}

LICENSE_NOTE_NAME = "LICENSE-NOTE.txt"
# The 30M weights may not be used commercially: the server ships neither the
# model nor this note, but a user's models folder would otherwise give no sign.
LICENSE_NOTE = (
    "Zipformer-30M-RNNT-6000h (https://huggingface.co/hynt/Zipformer-30M-RNNT-6000h)\n"
    "is licensed CC-BY-NC-ND-4.0: NON-COMMERCIAL use only, no derivatives.\n"
    "The other models are Apache-2.0 (68M) and MIT (turbo Whisper).\n"
    "Do not ship this folder in a product or use it for paid work.\n"
)


def folder(models_dir: Path, name: str) -> Path:
    return models_dir / name


def vad_path(models_dir: Path) -> Path:
    return models_dir / VAD_NAME


def zipformer_missing(folder_path: Path, name: str) -> list[str]:
    """What ``folder_path`` still lacks for the model ``name``, in file order.

    Public because ``check`` asks the very same question: one implementation, so
    the installer and the environment report cannot disagree. An empty list means
    every file is present and the weights clear ``MIN_BYTES``.
    """
    plan = ZIPFORMER[name]["files"]
    missing = []
    for kind, filename in plan.items():
        target = folder_path / filename
        if not target.is_file():
            missing.append(filename)
        elif target.stat().st_size <= MIN_BYTES[kind]:
            missing.append(f"{filename} under {MIN_BYTES[kind]} bytes")
    return missing


def downloaded_missing(folder_path: Path, name: str) -> list[str]:
    """The missing entries a download would fix, ignoring the generated tokens.txt.

    ``download-models`` asks this to decide whether the repo has to be fetched
    again: the 30M folder's ``tokens.txt`` is built from its ``bpe.model`` here,
    so its absence is not a reason for a 70 MB download.
    """
    plan = ZIPFORMER[name]["files"]
    if name in GENERATED_TOKENS:
        generated = plan["tokens"]
        return [entry for entry in zipformer_missing(folder_path, name) if not entry.startswith(generated)]
    return zipformer_missing(folder_path, name)


def vad_ok(models_dir: Path) -> bool:
    target = vad_path(models_dir)
    return target.is_file() and target.stat().st_size > MIN_VAD_BYTES


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

    Written to a temp file beside the target and moved into place, like every
    other file this sidecar writes: an interrupted run must not leave a short
    tokens.txt that ``check`` would then report as installed.
    """
    if tokens_path.is_file():
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


def ensure(models_dir: Path, name: str) -> Path:
    """The folder for the model ``name``, rebuilt from what is already there.

    No network: a missing ``tokens.txt`` in a complete 30M folder is regenerated
    from its ``bpe.model``, everything else must have been downloaded by
    ``download-models``. The result is still complete after the call or this
    raises with the file names, so a job fails on one line instead of inside
    onnxruntime.
    """
    target = folder(models_dir, name)
    if name in GENERATED_TOKENS and not (target / ZIPFORMER[name]["files"]["tokens"]).is_file():
        bpe = target / ZIPFORMER[name]["files"]["bpe"]
        if not bpe.is_file():
            raise FileNotFoundError(
                f"{target} has no bpe.model, so tokens.txt cannot be built: run --setup-asr with engine {name}"
            )
        io.log(f"building {target / ZIPFORMER[name]['files']['tokens']} from bpe.model")
        write_tokens(bpe, target / ZIPFORMER[name]["files"]["tokens"])
    missing = zipformer_missing(target, name)
    if missing:
        raise FileNotFoundError(
            f"the {name} model is missing {', '.join(missing)} in {target}: run --setup-asr"
        )
    return target
