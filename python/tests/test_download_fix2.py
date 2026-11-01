"""Fix round 2: the face model is always fetched, and every model fails on its own.

Two rules, both about what a default install is for:

* **Ruling R36: YuNet is always downloaded.** The default setup installs the
  Zipformer-68M and the VAD and nothing else (Ruling R33), and the shorts pipeline
  counts faces with ``detectFaces`` on that same install -- so a Zipformer-only
  ``download-models`` that skipped the 232,589 B ``onnx`` shipped an install where
  every Faces-enabled job failed on a missing model. The face model is fetched
  whatever engines were asked for, next to the whisper models it used to sit with.
* **Every model reports, no model raises.** Round 1 isolated the Zipformers and the
  VAD; whisper and YuNet were still downloaded outside the per-model ``_step``, so
  a whisper that would not download raised past the result, and a YuNet that would
  not download raised after it. Now all four kinds go through the same
  ``{path, downloaded, failed}`` / ``{error, failed}`` report, the others still
  complete, and ``download-models`` exits non-zero if any requested item failed.

Sizes are the live ones: YuNet 2023mar is 232,589 B, the 68M int8 set is the same
four files ``test_download_fix1`` uses.
"""
import json
from pathlib import Path

import pytest

from premiere_mcp_sidecar import download_models, sherpa_models

ZIPFORMER_68M_REPO = "csukuangfj/sherpa-onnx-zipformer-vi-int8-2025-04-20"
VAD_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
# The live size of the face model (HEAD on the GitHub URL, 2026-11-01).
YUNET_BYTES = 232_589
VAD_BYTES = 643_854
ZIPFORMER_68M_SIZES = {
    "encoder-epoch-12-avg-8.int8.onnx": 70_876_129,
    "decoder-epoch-12-avg-8.onnx": 5_165_084,
    "joiner-epoch-12-avg-8.int8.onnx": 1_033_417,
    "tokens.txt": 25_847,
    "bpe.model": 270_695,
}
WHISPER_FILES = ("config.json", "model.bin", "preprocessor_config.json", "tokenizer.json", "vocabulary.json")


class Segment:
    def __init__(self, path, size):
        self.path = path
        self.size = size


class FakeApi:
    calls = []

    def get_paths_info(self, repo_id, paths, **kwargs):
        FakeApi.calls.append({"repoId": repo_id, "paths": list(paths)})
        known = ZIPFORMER_68M_SIZES if repo_id == ZIPFORMER_68M_REPO else {}
        return [Segment(path, known[path]) for path in paths if path in known]


class FakeSnapshot:
    """Zipformer files from the size table, the turbo folder for any other repo."""

    calls = []
    failing = set()

    @classmethod
    def __call__(cls, repo_id, local_dir, allow_patterns=None, **kwargs):
        cls.calls.append({"repoId": repo_id, "localDir": local_dir})
        if repo_id in cls.failing:
            raise OSError(f"{repo_id}: 503 Service Unavailable")
        folder = Path(local_dir)
        folder.mkdir(parents=True, exist_ok=True)
        if repo_id == ZIPFORMER_68M_REPO:
            for name in allow_patterns or []:
                if name in ZIPFORMER_68M_SIZES:
                    (folder / name).write_bytes(b"\x08" * ZIPFORMER_68M_SIZES[name])
            return str(folder)
        for name in WHISPER_FILES:
            (folder / name).write_bytes(b"{}")
        with open(folder / "model.bin", "r+b") as handle:
            handle.truncate(download_models.MIN_WHISPER_BYTES + 1)
        return str(folder)


class FakeResponse:
    """A streamable body: ``read(size)`` hands back at most ``size`` bytes."""

    def __init__(self, body):
        self.body = body
        self.headers = {"Content-Length": str(len(body))}

    def read(self, size=-1):
        if not self.body:
            return b""
        if 0 < size < len(self.body):
            chunk, self.body = self.body[:size], self.body[size:]
            return chunk
        chunk, self.body = self.body, b""
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class FakeUrlopen:
    """The VAD and the face model; ``failing`` names the URLs that 404."""

    calls = []
    failing = set()

    @classmethod
    def __call__(cls, url, timeout=None, **kwargs):
        cls.calls.append(url)
        if url in cls.failing:
            return FakeResponse(b"<html>404: Not Found</html>")
        return FakeResponse(b"\x08" * (VAD_BYTES if url == VAD_URL else YUNET_BYTES))


class FakeProcessor:
    pieces = ["<blk>", "<sos/eos>", "<unk>"] + [f"▁PIECE{index:04d}" for index in range(400)]

    def __init__(self, model_file=None, **kwargs):
        self.model_file = model_file

    def get_piece_size(self):
        return len(self.pieces)

    def id_to_piece(self, index):
        return self.pieces[index]


@pytest.fixture(autouse=True)
def fakes(monkeypatch):
    FakeApi.calls = []
    FakeSnapshot.calls, FakeSnapshot.failing = [], set()
    FakeUrlopen.calls, FakeUrlopen.failing = [], set()
    monkeypatch.setattr(download_models, "snapshot_download", FakeSnapshot())
    monkeypatch.setattr(download_models, "urlopen", FakeUrlopen())
    monkeypatch.setattr(download_models, "hub_api", FakeApi())
    monkeypatch.setattr(sherpa_models, "_sentencepiece", lambda: FakeProcessor)
    sizes = dict(sherpa_models.HF_FILE_SIZES)
    yield
    sherpa_models.HF_FILE_SIZES.clear()
    sherpa_models.HF_FILE_SIZES.update(sizes)


def run(tmp_path, **overrides):
    # The no-engines default is the Zipformer-68M; these tests are about the whisper download.
    spec = {"modelsDir": str(tmp_path / "models"), "engines": ["whisper-turbo"]}
    spec.update(overrides)
    return download_models.run(spec, None)


def models_dir(tmp_path):
    return tmp_path / "models"


# --- Ruling R36: the face model, whatever engines were asked for ----------------


def test_a_zipformer_only_install_still_fetches_the_face_model(tmp_path):
    """The default install is 68M only, and detectFaces needs YuNet on it."""
    result = run(tmp_path, engines=["zipformer-68m"])

    onnx = models_dir(tmp_path) / download_models.ONNX_NAME
    assert download_models.ONNX_URL in FakeUrlopen.calls
    assert onnx.stat().st_size == YUNET_BYTES
    assert result["yunet"] == {"path": str(onnx), "downloaded": True, "failed": False}
    assert result["zipformer68m"]["downloaded"] is True


@pytest.mark.parametrize("engines", [
    ["zipformer-68m"], ["zipformer-30m"], ["rover"], ["whisper-turbo"], ["zipformer-68m", "zipformer-30m"],
])
def test_every_engine_combination_fetches_the_face_model(tmp_path, engines):
    result = run(tmp_path, engines=engines)

    onnx = models_dir(tmp_path) / download_models.ONNX_NAME
    assert download_models.ONNX_URL in FakeUrlopen.calls, engines
    assert onnx.is_file() and result["yunet"]["downloaded"] is True


def test_the_face_model_is_fetched_last_and_a_zipformer_run_downloads_no_whisper(tmp_path):
    run(tmp_path, engines=["zipformer-68m"])

    assert download_models.ONNX_URL == FakeUrlopen.calls[-1]
    assert [call["repoId"] for call in FakeSnapshot.calls] == [ZIPFORMER_68M_REPO]
    assert not (models_dir(tmp_path) / download_models.WHISPER_DIR_NAME).exists()


def test_the_face_model_is_not_downloaded_twice(tmp_path):
    run(tmp_path, engines=["zipformer-68m"])
    FakeUrlopen.calls = []

    result = run(tmp_path, engines=["zipformer-68m"])

    assert download_models.ONNX_URL not in FakeUrlopen.calls
    assert result["yunet"]["downloaded"] is False
    assert result["yunet"]["failed"] is False


def test_the_whisper_run_reports_the_same_keys_in_the_same_order(tmp_path):
    result = run(tmp_path)

    assert list(result) == ["yunet"] or list(result) == ["whisper", "yunet"], list(result)
    assert set(result) == {"whisper", "yunet"}


def test_the_progress_bar_ends_on_one_with_the_face_model_in_any_plan(tmp_path):
    for engines in (["zipformer-68m"], ["whisper-turbo"], ["rover"]):
        names = download_models.plan_names(engines)
        shares = download_models.plan_shares(engines)
        assert names[-1] == download_models.YUENT_STEP, names
        assert shares[-1] == pytest.approx(1.0)
        assert shares == sorted(shares)


# --- failure isolation: each model reports, none raises -----------------------


def test_a_failed_whisper_download_is_reported_and_the_face_model_still_arrives(tmp_path):
    FakeSnapshot.failing = {download_models.DEFAULT_WHISPER_REPO}

    result = download_models.run({"modelsDir": str(models_dir(tmp_path)), "engines": ["whisper-turbo"]}, None)

    assert "503" in result["whisper"]["error"]
    assert result["whisper"]["failed"] is True and "path" not in result["whisper"]
    assert result["yunet"]["downloaded"] is True
    assert result["yunet"]["failed"] is False
    assert download_models.failed(result) == ["whisper"]


def test_a_failed_whisper_with_zipformers_still_leaves_them_and_the_face_model(tmp_path):
    FakeSnapshot.failing = {download_models.DEFAULT_WHISPER_REPO}

    result = download_models.run(
        {"modelsDir": str(models_dir(tmp_path)), "engines": ["zipformer-68m", "whisper-turbo"]}, None
    )

    assert result["whisper"]["failed"] is True
    assert result["zipformer68m"]["downloaded"] is True
    assert result["vad"]["downloaded"] is True
    assert result["yunet"]["downloaded"] is True
    assert download_models.failed(result) == ["whisper"]


def test_a_failed_face_model_download_is_reported_and_the_rest_still_arrives(tmp_path):
    FakeUrlopen.failing = {download_models.ONNX_URL}

    result = download_models.run(
        {"modelsDir": str(models_dir(tmp_path)), "engines": ["zipformer-68m", "whisper-turbo"]}, None
    )

    assert result["yunet"]["failed"] is True
    assert "bytes" in result["yunet"]["error"] and "path" not in result["yunet"]
    assert result["whisper"]["downloaded"] is True
    assert result["zipformer68m"]["downloaded"] is True
    assert download_models.failed(result) == ["yunet"]
    assert not (models_dir(tmp_path) / download_models.ONNX_NAME).exists(), "no stub may be left behind"


def test_both_the_whisper_and_the_face_model_can_fail_in_one_run(tmp_path):
    FakeSnapshot.failing = {download_models.DEFAULT_WHISPER_REPO}
    FakeUrlopen.failing = {download_models.ONNX_URL}

    result = download_models.run(
        {"modelsDir": str(models_dir(tmp_path)), "engines": ["zipformer-68m", "whisper-turbo"]}, None
    )

    assert download_models.failed(result) == ["whisper", "yunet"]
    assert result["zipformer68m"]["downloaded"] is True and result["vad"]["downloaded"] is True


def test_a_whisper_folder_that_did_not_arrive_whole_is_a_failure_not_a_raise(tmp_path):
    """A snapshot that returns without its files is judged by the folder, not the call."""

    class Half(FakeSnapshot):
        @classmethod
        def __call__(cls, repo_id, local_dir, allow_patterns=None, **kwargs):
            if repo_id == download_models.DEFAULT_WHISPER_REPO:
                cls.calls.append({"repoId": repo_id, "localDir": local_dir})
                Path(local_dir).mkdir(parents=True, exist_ok=True)
                return str(local_dir)
            return super().__call__(repo_id, local_dir, allow_patterns=allow_patterns, **kwargs)

    download_models.snapshot_download = Half()

    result = download_models.run({"modelsDir": str(models_dir(tmp_path)), "engines": ["whisper-turbo"]}, None)

    assert "config.json" in result["whisper"]["error"]
    assert result["whisper"]["failed"] is True
    assert result["yunet"]["downloaded"] is True


# --- the exit code ------------------------------------------------------------


def _cli(tmp_path, engines):
    import premiere_mcp_sidecar.__main__ as cli

    spec = tmp_path / "in.json"
    spec.write_text(json.dumps({"modelsDir": str(models_dir(tmp_path)), "engines": engines}), encoding="utf-8")
    out = tmp_path / "out.json"
    code = cli.main(["download-models", "--input", str(spec), "--output", str(out)])
    return code, json.loads(out.read_text(encoding="utf-8"))


def test_the_cli_exits_zero_for_the_default_zipformer_install(tmp_path):
    code, result = _cli(tmp_path, ["zipformer-68m"])

    assert code == 0, result
    assert result["yunet"]["downloaded"] is True
    assert result.get("failed") is None


def test_the_cli_exits_non_zero_when_the_whisper_failed(tmp_path):
    FakeSnapshot.failing = {download_models.DEFAULT_WHISPER_REPO}

    code, result = _cli(tmp_path, ["whisper-turbo"])

    assert code == 1
    assert result["failed"] == ["whisper"]
    assert result["yunet"]["downloaded"] is True
    assert "whisper" in result["error"]


def test_the_cli_exits_non_zero_when_the_face_model_failed(tmp_path):
    FakeUrlopen.failing = {download_models.ONNX_URL}

    code, result = _cli(tmp_path, ["zipformer-68m"])

    assert code == 1
    assert result["failed"] == ["yunet"]
    assert result["zipformer68m"]["downloaded"] is True
    assert "yunet" in result["error"]


# --- the plan ----------------------------------------------------------------


def test_the_face_model_is_a_step_of_every_plan():
    for engines in (["whisper-turbo"], ["zipformer-68m"], ["zipformer-30m"], ["rover"]):
        assert download_models.YUENT_STEP in download_models.plan_names(engines), engines
