"""`download-models` for the Zipformer engines: what each engine needs, and idempotence.

Still no network: the Hugging Face snapshot download is a fake that writes the
files of the repo it was asked for, the Silero VAD arrives through the same fake
``urlopen`` as YuNet, and sentencepiece is replaced by a fake processor. What is
asserted is the plan (which engine pulls which folder, in which order) and the
result: each model reported with its path and whether it was fetched this time.
"""
import json
from pathlib import Path

import pytest

from premiere_mcp_sidecar import download_models, sherpa_models

ZIPFORMER_68M_REPO = "csukuangfj/sherpa-onnx-zipformer-vi-int8-2025-04-20"
ZIPFORMER_30M_REPO = "hynt/Zipformer-30M-RNNT-6000h"
VAD_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"

# Over the download commands' size floors, so a fake download produces a real model.
ONNX_BYTES = b"\x08" * (120 * 1024)
ZIPFORMER_WEIGHTS = b"\x08" * (1024 * 1024 + 1)  # clears MIN_ZIPFORMER_BYTES
ZIPFORMER_BPE = b"\x08" * (100 * 1024 + 1)  # clears MIN_BPE_BYTES
VAD_BYTES = b"\x08" * (16 * 1024 + 1)  # clears MIN_VAD_BYTES
# The small files in a Zipformer folder only have to exist.
ZIPFORMER_SMALL = b"{}"


class FakeSnapshot:
    """Writes the files the named repo holds, as a real download leaves them."""

    calls = []

    @classmethod
    def __call__(cls, repo_id, local_dir, allow_patterns=None, **kwargs):
        cls.calls.append({"repoId": repo_id, "localDir": local_dir, "allowPatterns": allow_patterns})
        folder = Path(local_dir)
        folder.mkdir(parents=True, exist_ok=True)
        if repo_id in ZIPFORMER_REPOS:
            plan = sherpa_models.ZIPFORMER[ZIPFORMER_REPOS[repo_id]]["files"]
            for kind, name in plan.items():
                if kind == "tokens" and ZIPFORMER_REPOS[repo_id] in sherpa_models.GENERATED_TOKENS:
                    continue  # this repo has no tokens.txt: setup builds it
                body = {"encoder": ZIPFORMER_WEIGHTS, "joiner": ZIPFORMER_WEIGHTS, "bpe": ZIPFORMER_BPE}
                (folder / name).write_bytes(body.get(kind, ZIPFORMER_SMALL))
        else:
            for name in ("config.json", "model.bin", "preprocessor_config.json", "tokenizer.json", "vocabulary.json"):
                (folder / name).write_bytes(b"weights" if name == "model.bin" else b"{}")
            with open(folder / "model.bin", "r+b") as handle:
                handle.truncate(download_models.MIN_WHISPER_BYTES + 1)
        return str(folder)


class models:
    """Just the repo-to-engine mapping, so the fake can name its files."""

    ZIPFORMER_REPOS = {ZIPFORMER_68M_REPO: "zipformer-vi-68m-int8", ZIPFORMER_30M_REPO: "zipformer-vi-30m-int8"}


ZIPFORMER_REPOS = models.ZIPFORMER_REPOS


class FakeResponse:
    def __init__(self, body):
        self.chunks = [body]
        self.headers = {"Content-Length": str(len(body))}

    def read(self, size=-1):
        if not self.chunks:
            return b""
        chunk = self.chunks.pop(0)
        if 0 < size < len(chunk):
            self.chunks.insert(0, chunk[size:])
            return chunk[:size]
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class FakeUrlopen:
    calls = []

    @classmethod
    def __call__(cls, url, timeout=None, **kwargs):
        cls.calls.append(url)
        return FakeResponse(VAD_BYTES if url == VAD_URL else ONNX_BYTES)


class FakeProcessor:
    """A ``SentencePieceProcessor`` with three pieces, one of them a subword.

    ``_sentencepiece()`` returns the class and the code calls it with
    ``model_file=``, so this is a class, not an instance. Bound as a class.
    """

    pieces = ["<blk>", "<sos/eos>", "<unk>", "▁XIN", "CHAO", "▁BẠN"]

    def __init__(self, model_file=None, **kwargs):
        self.model_file = model_file

    def get_piece_size(self):
        return len(self.pieces)

    def id_to_piece(self, index):
        return self.pieces[index]


@pytest.fixture(autouse=True)
def fakes(monkeypatch):
    FakeSnapshot.calls = []
    FakeUrlopen.calls = []
    monkeypatch.setattr(download_models, "snapshot_download", FakeSnapshot())
    monkeypatch.setattr(download_models, "urlopen", FakeUrlopen())
    # A fake download is bytes, not a sentencepiece model: the tokeniser is the
    # one the tokens tests cover, and binding it here keeps this file offline-only.
    monkeypatch.setattr(sherpa_models, "_sentencepiece", lambda: FakeProcessor)


def run(tmp_path, **overrides):
    spec = {"modelsDir": str(tmp_path / "models")}
    spec.update(overrides)
    return download_models.run(spec, None)


def engine_calls():
    return [call["repoId"] for call in FakeSnapshot.calls if call["repoId"] in ZIPFORMER_REPOS]


# --- what each engine downloads ----------------------------------------------


@pytest.mark.parametrize("engine,repos", [
    ("whisper-turbo", []),
    ("zipformer-68m", [ZIPFORMER_68M_REPO]),
    ("zipformer-30m", [ZIPFORMER_30M_REPO]),
    ("rover", [ZIPFORMER_30M_REPO, ZIPFORMER_68M_REPO]),
])
def test_each_engine_pulls_what_it_needs(tmp_path, engine, repos):
    run(tmp_path, engines=[engine])

    assert engine_calls() == repos


@pytest.mark.parametrize("engine", ["zipformer-68m", "zipformer-30m", "rover"])
def test_the_zipformer_engines_fetch_the_vad(tmp_path, engine):
    run(tmp_path, engines=[engine])

    assert VAD_URL in FakeUrlopen.calls
    assert (tmp_path / "models" / "silero_vad.onnx").read_bytes() == VAD_BYTES


def test_whisper_still_fetches_whisper_and_yunet_only(tmp_path):
    result = run(tmp_path)

    assert FakeSnapshot.calls[0]["repoId"] == download_models.DEFAULT_WHISPER_REPO
    assert FakeUrlopen.calls == [download_models.ONNX_URL]
    assert set(result) == {"whisper", "yunet"}


def test_the_default_engines_are_whisper_alone(tmp_path):
    assert download_models.engines_of({}) == ["whisper-turbo"]


def test_a_rover_run_fills_the_same_folders_as_the_two_engines(tmp_path):
    """rover is not a model of its own: it is the two folders the engines use."""
    rover = run(tmp_path, engines=["rover"])

    folder = tmp_path / "models"
    assert rover["zipformer68m"]["path"] == str(folder / sherpa_models.ZIPFORMER_68M_DIR)
    assert rover["zipformer30m"]["path"] == str(folder / sherpa_models.ZIPFORMER_30M_DIR)
    assert (folder / sherpa_models.ZIPFORMER_68M_DIR).is_dir()
    assert (folder / sherpa_models.ZIPFORMER_30M_DIR).is_dir()


def test_an_unknown_engine_is_refused(tmp_path):
    with pytest.raises(ValueError, match="engine"):
        run(tmp_path, engines=["zipformer"])


# --- the report ---------------------------------------------------------------


def test_every_downloaded_model_is_reported_with_its_path(tmp_path):
    result = run(tmp_path, engines=["rover"])

    folder = tmp_path / "models"
    assert result["zipformer68m"] == {"path": str(folder / "zipformer-vi-68m-int8"), "downloaded": True}
    assert result["zipformer30m"] == {"path": str(folder / "zipformer-vi-30m-int8"), "downloaded": True}
    assert result["vad"] == {"path": str(folder / "silero_vad.onnx"), "downloaded": True}


def test_a_second_run_downloads_nothing(tmp_path):
    run(tmp_path, engines=["rover"])

    result = run(tmp_path, engines=["rover"])

    # rover is the two Zipformers, not Whisper: one repo each on the first run.
    assert len(FakeSnapshot.calls) == 2, "the two zipformers, once each"
    assert len(FakeUrlopen.calls) == 1, "the vad, once"
    for name in ("zipformer68m", "zipformer30m", "vad"):
        assert result[name]["downloaded"] is False, name


def test_an_engine_not_asked_for_is_not_reported(tmp_path):
    result = run(tmp_path, engines=["zipformer-68m"])

    assert "zipformer30m" not in result and "whisper" not in result


def test_cli_accepts_the_engines_list(tmp_path):
    import premiere_mcp_sidecar.__main__ as cli

    spec = tmp_path / "in.json"
    spec.write_text(json.dumps({"modelsDir": str(tmp_path / "models"), "engines": ["rover"]}), encoding="utf-8")
    out = tmp_path / "out.json"

    assert cli.main(["download-models", "--input", str(spec), "--output", str(out)]) == 0
    assert json.loads(out.read_text(encoding="utf-8"))["zipformer30m"]["downloaded"] is True


# --- half a model is not a model ---------------------------------------------


@pytest.mark.parametrize("name", [
    "encoder-epoch-12-avg-8.int8.onnx",
    "decoder-epoch-12-avg-8.onnx",
    "joiner-epoch-12-avg-8.int8.onnx",
    "tokens.txt",
    "bpe.model",
])
def test_a_68m_folder_missing_a_file_is_fetched_again(tmp_path, name):
    run(tmp_path, engines=["zipformer-68m"])
    (tmp_path / "models" / "zipformer-vi-68m-int8" / name).unlink()
    FakeSnapshot.calls = []

    result = run(tmp_path, engines=["zipformer-68m"])

    assert engine_calls() == [ZIPFORMER_68M_REPO]
    assert result["zipformer68m"]["downloaded"] is True


def test_a_truncated_zipformer_weights_file_is_fetched_again(tmp_path):
    run(tmp_path, engines=["zipformer-68m"])
    plan = sherpa_models.ZIPFORMER[sherpa_models.ZIPFORMER_68M_DIR]["files"]
    (tmp_path / "models" / sherpa_models.ZIPFORMER_68M_DIR / plan["encoder"]).write_bytes(b"\x08")
    FakeSnapshot.calls = []

    result = run(tmp_path, engines=["zipformer-68m"])

    assert engine_calls() == [ZIPFORMER_68M_REPO]
    assert result["zipformer68m"]["downloaded"] is True


def test_the_30m_folder_does_not_need_a_downloaded_tokens_file(tmp_path):
    """The 30M repo has no tokens.txt: a folder of weights gets it built, not refetched."""
    folder = tmp_path / "models" / "zipformer-vi-30m-int8"
    folder.mkdir(parents=True)
    plan = sherpa_models.ZIPFORMER[sherpa_models.ZIPFORMER_30M_DIR]["files"]
    (folder / plan["encoder"]).write_bytes(ZIPFORMER_WEIGHTS)
    (folder / plan["decoder"]).write_bytes(ZIPFORMER_SMALL)
    (folder / plan["joiner"]).write_bytes(ZIPFORMER_WEIGHTS)
    (folder / plan["bpe"]).write_bytes(ZIPFORMER_BPE)
    (tmp_path / "models" / "silero_vad.onnx").write_bytes(VAD_BYTES)
    FakeSnapshot.calls = []

    result = run(tmp_path, engines=["zipformer-30m"])

    assert engine_calls() == [], "the weights are there: only tokens.txt is rebuilt"
    assert (folder / "tokens.txt").is_file()
    assert result["zipformer30m"]["downloaded"] is False


def test_a_30m_folder_without_its_tokens_file_gets_it_built_again(tmp_path):
    run(tmp_path, engines=["zipformer-30m"])
    (tmp_path / "models" / "zipformer-vi-30m-int8" / "tokens.txt").unlink()
    FakeSnapshot.calls = []

    run(tmp_path, engines=["zipformer-30m"])

    assert engine_calls() == [], "the weights are there: only the tokens file is rebuilt"
    assert (tmp_path / "models" / "zipformer-vi-30m-int8" / "tokens.txt").is_file()


def test_a_truncated_vad_is_downloaded_again(tmp_path):
    run(tmp_path, engines=["zipformer-68m"])
    (tmp_path / "models" / "silero_vad.onnx").write_bytes(b"\x08" * 16)
    FakeUrlopen.calls = []

    result = run(tmp_path, engines=["zipformer-68m"])

    assert VAD_URL in FakeUrlopen.calls
    assert result["vad"]["downloaded"] is True


# --- tokens.txt from bpe.model ------------------------------------------------


def test_tokens_txt_is_one_piece_and_id_per_line(tmp_path):
    bpe = tmp_path / "bpe.model"
    bpe.write_bytes(b"fake")

    sherpa_models.write_tokens(bpe, tmp_path / "tokens.txt")

    assert (tmp_path / "tokens.txt").read_text(encoding="utf-8").splitlines() == [
        "<blk> 0", "<sos/eos> 1", "<unk> 2", "▁XIN 3", "CHAO 4", "▁BẠN 5",
    ]


def test_tokens_txt_is_written_with_lf_and_no_bom(tmp_path):
    """The 68M tokens.txt is ``piece id\\n`` in UTF-8 with LF: sherpa reads it as is."""
    bpe = tmp_path / "bpe.model"
    bpe.write_bytes(b"fake")

    sherpa_models.write_tokens(bpe, tmp_path / "tokens.txt")

    raw = (tmp_path / "tokens.txt").read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf")
    assert b"\r\n" not in raw
    assert raw == "<blk> 0\n<sos/eos> 1\n<unk> 2\n▁XIN 3\nCHAO 4\n▁BẠN 5\n".encode("utf-8")


def test_a_tokens_file_is_not_rewritten_when_it_exists(tmp_path):
    """Only what is missing is made: a second setup must not touch the folder."""
    tokens = tmp_path / "tokens.txt"
    tokens.write_text("▁XIN 0\n", encoding="utf-8")

    sherpa_models.write_tokens(tmp_path / "bpe.model", tokens)

    assert tokens.read_text(encoding="utf-8") == "▁XIN 0\n"


def test_the_tokens_format_matches_the_68m_file(tmp_path):
    """Each line is two columns, the piece and its id, in the repo's own order."""
    bpe = tmp_path / "bpe.model"
    bpe.write_bytes(b"fake")
    sherpa_models.write_tokens(bpe, tmp_path / "tokens.txt")

    lines = (tmp_path / "tokens.txt").read_text(encoding="utf-8").splitlines()
    assert [int(line.rsplit(" ", 1)[1]) for line in lines] == list(range(len(lines)))
    for line in lines:
        piece, _, index = line.rpartition(" ")
        assert piece and index.isdigit()
