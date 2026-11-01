"""Fix round 1: what `download-models` fetches, in what order, and what it costs.

The live run of T16py failed three ways that no fake had covered, so each one is a
test here with the numbers the real repos have:

* the 30M's ``joiner-epoch-20-avg-10.int8.onnx`` is **1,033,417 B** -- a per-kind
  floor of 1 MB called a real file truncated. The floor is now the size Hugging
  Face reports for that exact file, and 100 KB on every onnx/tokens/bpe file when
  the hub cannot be asked;
* ``allow_patterns`` was ``["*.onnx", ...]``, so the 30M folder got its 92 MB fp32
  encoder, decoder and joiner as well as the int8 set. It now names the exact
  files of the model table;
* the run stopped on the 30M error, so the VAD (which both engines open) and the
  68M were never fetched. The VAD goes first and each model fails on its own.
"""
import json
from pathlib import Path

import pytest

from premiere_mcp_sidecar import download_models, sherpa_models

ZIPFORMER_68M_REPO = "csukuangfj/sherpa-onnx-zipformer-vi-int8-2025-04-20"
ZIPFORMER_30M_REPO = "hynt/Zipformer-30M-RNNT-6000h"
VAD_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"

# The real sizes, from `hf`/`get_paths_info` on 2026-11-01: the 30M joiner and the
# 68M joiner are the same 1,033,417 B file, and both are *under* a 1 MB floor.
REAL_SIZES = {
    ZIPFORMER_30M_REPO: {
        "encoder-epoch-20-avg-10.int8.onnx": 27_699_063,
        "decoder-epoch-20-avg-10.int8.onnx": 1_308_690,
        "joiner-epoch-20-avg-10.int8.onnx": 1_033_417,
        "bpe.model": 268_106,
    },
    ZIPFORMER_68M_REPO: {
        "encoder-epoch-12-avg-8.int8.onnx": 70_876_129,
        "decoder-epoch-12-avg-8.onnx": 5_165_084,
        "joiner-epoch-12-avg-8.int8.onnx": 1_033_417,
        "tokens.txt": 25_847,
        "bpe.model": 270_695,
    },
}
# What the live run must never see again in a 30M folder: the fp32 copies.
FP32_FILES = {
    "encoder-epoch-20-avg-10.onnx",
    "decoder-epoch-20-avg-10.onnx",
    "joiner-epoch-20-avg-10.onnx",
}
VAD_BYTES = b"\x08" * (643_854)


class Segment:
    """One file in a repo, as ``get_paths_info`` reports it (``.path``/``.size``)."""

    def __init__(self, path, size):
        self.path = path
        self.size = size


class FakeApi:
    """Stands in for ``huggingface_hub.HfApi``: the sizes above, or a failure."""

    calls = []
    fails = False

    def get_paths_info(self, repo_id, paths, **kwargs):
        FakeApi.calls.append({"repoId": repo_id, "paths": list(paths)})
        if FakeApi.fails:
            raise RuntimeError("hub unreachable")
        known = REAL_SIZES.get(repo_id, {})
        return [Segment(path, known[path]) for path in paths if path in known]


class FakeSnapshot:
    """Writes exactly the files ``allow_patterns`` names, as the real one does.

    A pattern that does not match a file of the repo is not an error on Hugging
    Face either: the folder simply comes back without it, which is what the
    interrupted-fetch check is there to notice.
    """

    calls = []
    writes: dict[str, list[str]] = {}

    @classmethod
    def __call__(cls, repo_id, local_dir, allow_patterns=None, **kwargs):
        cls.calls.append({"repoId": repo_id, "localDir": local_dir, "allowPatterns": list(allow_patterns or [])})
        folder = Path(local_dir)
        folder.mkdir(parents=True, exist_ok=True)
        sizes = REAL_SIZES.get(repo_id, {})
        written = []
        for name in allow_patterns or []:
            if name not in sizes:
                continue
            path = folder / name
            path.write_bytes(b"\x08" * sizes[name])
            written.append(name)
        cls.writes[repo_id] = written
        return str(folder)


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
    """The Silero VAD, or a 404-shaped body when ``FakeUrlopen.failing`` is set."""

    calls = []
    failing = False

    @classmethod
    def __call__(cls, url, timeout=None, **kwargs):
        cls.calls.append(url)
        if cls.failing:
            return FakeResponse(b"<html>404</html>")
        return FakeResponse(VAD_BYTES)


class FakeProcessor:
    """A vocabulary big enough to clear ``MIN_TOKENS_BYTES``, as a real bpe.model is.

    The real 30M ``tokens.txt`` is thousands of lines: a three-piece stand-in would
    be a "stub" by the sidecar's own rule and the folder would never be called
    complete.
    """

    pieces = ["<blk>", "<sos/eos>", "<unk>", "▁XIN", "CHAO", "▁BẠN"] + [
        f"▁PIECE{index:04d}" for index in range(400)
    ]

    def __init__(self, model_file=None, **kwargs):
        self.model_file = model_file

    def get_piece_size(self):
        return len(self.pieces)

    def id_to_piece(self, index):
        return self.pieces[index]


@pytest.fixture(autouse=True)
def fakes(monkeypatch):
    FakeApi.calls, FakeApi.fails = [], False
    FakeSnapshot.calls, FakeSnapshot.writes = [], {}
    FakeUrlopen.calls, FakeUrlopen.failing = [], False
    monkeypatch.setattr(download_models, "snapshot_download", FakeSnapshot())
    monkeypatch.setattr(download_models, "urlopen", FakeUrlopen())
    monkeypatch.setattr(download_models, "hub_api", FakeApi())
    monkeypatch.setattr(sherpa_models, "_sentencepiece", lambda: FakeProcessor)
    # `download-models` is offline in every test but these: the hub is faked, so
    # nothing here needs the network or a cached copy of the sizes.
    sz = dict(sherpa_models.HF_FILE_SIZES)
    yield
    sherpa_models.HF_FILE_SIZES.clear()
    sherpa_models.HF_FILE_SIZES.update(sz)


def run(tmp_path, **overrides):
    spec = {"modelsDir": str(tmp_path / "models")}
    spec.update(overrides)
    return download_models.run(spec, None)


# --- the exact files of each model -------------------------------------------


def test_the_30m_downloads_exactly_the_four_files_it_uses(tmp_path):
    run(tmp_path, engines=["zipformer-30m"])

    call = next(call for call in FakeSnapshot.calls if call["repoId"] == ZIPFORMER_30M_REPO)
    assert sorted(call["allowPatterns"]) == sorted(REAL_SIZES[ZIPFORMER_30M_REPO])
    folder = tmp_path / "models" / sherpa_models.ZIPFORMER_30M_DIR
    assert sorted(p.name for p in folder.iterdir()) == sorted(
        [*REAL_SIZES[ZIPFORMER_30M_REPO], "tokens.txt", sherpa_models.LICENSE_NOTE_NAME]
    )


def test_the_30m_folder_holds_no_fp32_weights(tmp_path):
    run(tmp_path, engines=["rover"])

    folder = tmp_path / "models" / sherpa_models.ZIPFORMER_30M_DIR
    assert not [name for name in FP32_FILES if (folder / name).exists()]


def test_the_68m_downloads_exactly_the_five_files_it_uses(tmp_path):
    run(tmp_path, engines=["zipformer-68m"])

    call = next(call for call in FakeSnapshot.calls if call["repoId"] == ZIPFORMER_68M_REPO)
    assert sorted(call["allowPatterns"]) == sorted(REAL_SIZES[ZIPFORMER_68M_REPO])


def test_the_30m_keeps_its_int8_decoder():
    """The hub has ``decoder-epoch-20-avg-10.int8.onnx``: the fp32 one was a mistake."""
    files = sherpa_models.ZIPFORMER[sherpa_models.ZIPFORMER_30M_DIR]["files"]
    assert files["decoder"] == "decoder-epoch-20-avg-10.int8.onnx"


def test_the_68m_keeps_its_fp32_decoder():
    """The 68M repo ships no int8 decoder, so the fp32 one is what it loads."""
    files = sherpa_models.ZIPFORMER[sherpa_models.ZIPFORMER_68M_DIR]["files"]
    assert files["decoder"] == "decoder-epoch-12-avg-8.onnx"


# --- the size floors ----------------------------------------------------------


def test_a_real_1_033_417_byte_joiner_is_not_truncated(tmp_path):
    """The live failure: the 30M joiner is under 1 MB and is a whole file."""
    result = run(tmp_path, engines=["zipformer-30m"])

    assert result["zipformer30m"].get("error") is None
    assert (tmp_path / "models" / sherpa_models.ZIPFORMER_30M_DIR / "joiner-epoch-20-avg-10.int8.onnx").stat().st_size == 1_033_417


def test_each_floor_is_the_size_hugging_face_reports_for_that_file(tmp_path):
    run(tmp_path, engines=["rover"])

    for repo, sizes in REAL_SIZES.items():
        for name, size in sizes.items():
            floor = sherpa_models.floor_for(repo, name)
            # A completed, verified download lands exactly on the hub size.
            assert floor == size, (repo, name)


def test_the_floor_is_checked_before_the_download(tmp_path):
    run(tmp_path, engines=["zipformer-68m"])
    folder = tmp_path / "models" / sherpa_models.ZIPFORMER_68M_DIR
    # One byte short of the hub size: a body that lost its last chunk.
    (folder / "decoder-epoch-12-avg-8.onnx").write_bytes(b"\x08" * (5_165_084 - 1))
    FakeSnapshot.calls = []

    result = run(tmp_path, engines=["zipformer-68m"])

    assert result["zipformer68m"]["downloaded"] is True
    assert (folder / "decoder-epoch-12-avg-8.onnx").stat().st_size == 5_165_084


def test_offline_the_floor_of_every_onnx_tokens_and_bpe_is_100_kb(tmp_path):
    FakeApi.fails = True

    run(tmp_path, engines=["rover"])

    for repo, sizes in REAL_SIZES.items():
        for name in sizes:
            assert sherpa_models.floor_for(repo, name) == sherpa_models.MIN_FILE_BYTES, (repo, name)
    assert sherpa_models.MIN_FILE_BYTES == 100 * 1024


def test_offline_a_real_30m_joiner_still_passes(tmp_path):
    """Every real file of both models is over 100 KB, so offline setup still works."""
    FakeApi.fails = True

    result = run(tmp_path, engines=["rover"])

    assert result["zipformer30m"].get("error") is None
    assert result["zipformer68m"].get("error") is None


def test_the_sizes_are_asked_for_the_exact_files_of_the_repo(tmp_path):
    run(tmp_path, engines=["rover"])

    asked = {call["repoId"]: set(call["paths"]) for call in FakeApi.calls}
    assert asked[ZIPFORMER_30M_REPO] == set(REAL_SIZES[ZIPFORMER_30M_REPO])
    assert asked[ZIPFORMER_68M_REPO] == set(REAL_SIZES[ZIPFORMER_68M_REPO])


def test_the_hub_is_asked_once_per_model_even_twice_asked(tmp_path):
    run(tmp_path, engines=["zipformer-30m"])
    run(tmp_path, engines=["zipformer-30m"])

    assert [call["repoId"] for call in FakeApi.calls].count(ZIPFORMER_30M_REPO) == 1


def test_a_failed_size_lookup_does_not_fail_the_download(tmp_path):
    FakeApi.fails = True

    result = run(tmp_path, engines=["zipformer-68m"])

    assert result["zipformer68m"]["downloaded"] is True


# --- the VAD first, and one model's failure does not stop the others ----------


def test_the_vad_is_downloaded_before_any_model(tmp_path):
    order = []

    class OrderedSnapshot(FakeSnapshot):
        @classmethod
        def __call__(cls, repo_id, local_dir, allow_patterns=None, **kwargs):
            order.append(repo_id)
            return super().__call__(repo_id, local_dir, allow_patterns=allow_patterns, **kwargs)

    class OrderedUrlopen(FakeUrlopen):
        @classmethod
        def __call__(cls, url, timeout=None, **kwargs):
            order.append(url)
            return super().__call__(url, timeout=timeout, **kwargs)

    download_models.snapshot_download = OrderedSnapshot()
    download_models.urlopen = OrderedUrlopen()

    run(tmp_path, engines=["zipformer-68m", "zipformer-30m"])

    # The VAD first, then the two models; the face model closes every run (R36).
    assert order[0] == VAD_URL
    assert set(order[1:3]) == {ZIPFORMER_30M_REPO, ZIPFORMER_68M_REPO}
    assert order[-1] == download_models.ONNX_URL


def test_a_failed_30m_still_fetches_the_68m_and_the_vad(tmp_path, monkeypatch):
    def failing_for_30m(repo_id, local_dir, allow_patterns=None, **kwargs):
        if repo_id == ZIPFORMER_30M_REPO:
            raise RuntimeError("Connection reset by peer")
        return FakeSnapshot()(repo_id, local_dir, allow_patterns=allow_patterns, **kwargs)

    monkeypatch.setattr(download_models, "snapshot_download", failing_for_30m)

    result = download_models.run(
        {"modelsDir": str(tmp_path / "models"), "engines": ["zipformer-68m", "zipformer-30m"]}, None
    )

    assert "Connection reset by peer" in result["zipformer30m"]["error"]
    assert result["zipformer30m"]["failed"] is True and "path" not in result["zipformer30m"]
    assert result["zipformer68m"] == {
        "path": str(tmp_path / "models" / sherpa_models.ZIPFORMER_68M_DIR), "downloaded": True, "failed": False,
    }
    assert result["vad"]["downloaded"] is True
    assert (tmp_path / "models" / "silero_vad.onnx").stat().st_size == len(VAD_BYTES)


def test_a_failed_vad_does_not_stop_the_models(tmp_path):
    FakeUrlopen.failing = True

    result = download_models.run(
        {"modelsDir": str(tmp_path / "models"), "engines": ["zipformer-68m", "zipformer-30m"]}, None
    )

    assert result["vad"]["failed"] is True and "silero_vad.onnx" in result["vad"]["error"]
    assert result["zipformer68m"]["downloaded"] is True
    assert result["zipformer30m"]["downloaded"] is True


def test_a_model_whose_files_did_not_arrive_reports_an_error(tmp_path, monkeypatch):
    """The download returns without an exception and without the files: still a failure."""

    def half(repo_id, local_dir, allow_patterns=None, **kwargs):
        folder = Path(local_dir)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "bpe.model").write_bytes(b"\x08" * 268_106)
        return str(folder)

    monkeypatch.setattr(download_models, "snapshot_download", half)

    result = download_models.run(
        {"modelsDir": str(tmp_path / "models"), "engines": ["zipformer-68m", "zipformer-30m"]}, None
    )

    assert "encoder-epoch-20-avg-10.int8.onnx" in result["zipformer30m"]["error"]
    assert result["zipformer68m"]["failed"] is True


def test_a_rover_run_reports_the_two_models_and_the_vad(tmp_path, monkeypatch):
    def failing_for_68m(repo_id, local_dir, allow_patterns=None, **kwargs):
        if repo_id == ZIPFORMER_68M_REPO:
            raise RuntimeError("timed out")
        return FakeSnapshot()(repo_id, local_dir, allow_patterns=allow_patterns, **kwargs)

    monkeypatch.setattr(download_models, "snapshot_download", failing_for_68m)

    result = download_models.run({"modelsDir": str(tmp_path / "models"), "engines": ["rover"]}, None)

    assert result["zipformer30m"]["downloaded"] is True
    assert result["zipformer68m"]["failed"] is True


# --- the exit code ------------------------------------------------------------


def _cli(tmp_path, engines):
    import premiere_mcp_sidecar.__main__ as cli

    spec = tmp_path / "in.json"
    spec.write_text(json.dumps({"modelsDir": str(tmp_path / "models"), "engines": engines}), encoding="utf-8")
    out = tmp_path / "out.json"
    code = cli.main(["download-models", "--input", str(spec), "--output", str(out)])
    return code, json.loads(out.read_text(encoding="utf-8"))


def test_the_cli_exits_zero_when_every_model_arrived(tmp_path):
    code, result = _cli(tmp_path, ["zipformer-68m", "zipformer-30m"])

    assert code == 0, result
    assert not [name for name in ("zipformer68m", "zipformer30m", "vad") if result[name].get("failed")]


def test_the_cli_exits_non_zero_when_a_model_failed(tmp_path, monkeypatch):
    def failing_for_30m(repo_id, local_dir, allow_patterns=None, **kwargs):
        if repo_id == ZIPFORMER_30M_REPO:
            raise RuntimeError("404 Client Error")
        return FakeSnapshot()(repo_id, local_dir, allow_patterns=allow_patterns, **kwargs)

    monkeypatch.setattr(download_models, "snapshot_download", failing_for_30m)

    code, result = _cli(tmp_path, ["zipformer-68m", "zipformer-30m"])

    assert code == 1
    # The other model is still in the result: the caller sees both verdicts.
    assert result["zipformer68m"]["downloaded"] is True
    assert result["zipformer30m"]["failed"] is True
    assert result["failed"] == ["zipformer30m"]
    assert "404 Client Error" in result["error"]


# --- the minor findings -------------------------------------------------------


def test_a_tokens_file_under_one_kb_is_rebuilt(tmp_path):
    tokens = tmp_path / "tokens.txt"
    tokens.write_text("<blk> 0\n", encoding="utf-8")
    bpe = tmp_path / "bpe.model"
    bpe.write_bytes(b"fake")

    sherpa_models.write_tokens(bpe, tokens)

    lines = tokens.read_text(encoding="utf-8").splitlines()
    assert len(lines) == len(FakeProcessor.pieces)
    assert lines[:6] == ["<blk> 0", "<sos/eos> 1", "<unk> 2", "▁XIN 3", "CHAO 4", "▁BẠN 5"]
    assert tokens.stat().st_size >= sherpa_models.MIN_TOKENS_BYTES


def test_a_tokens_file_over_one_kb_is_left_alone(tmp_path):
    tokens = tmp_path / "tokens.txt"
    body = "▁XIN 0\n" * 200
    tokens.write_text(body, encoding="utf-8")
    bpe = tmp_path / "bpe.model"
    bpe.write_bytes(b"fake")

    sherpa_models.write_tokens(bpe, tokens)

    assert tokens.read_text(encoding="utf-8") == body


def test_a_complete_30m_folder_still_gets_the_licence_note(tmp_path):
    """Nothing was downloaded the second time, so the note must not depend on that."""
    run(tmp_path, engines=["zipformer-30m"])
    note = tmp_path / "models" / sherpa_models.ZIPFORMER_30M_DIR / sherpa_models.LICENSE_NOTE_NAME
    note.unlink()
    FakeSnapshot.calls = []

    result = run(tmp_path, engines=["zipformer-30m"])

    assert result["zipformer30m"]["downloaded"] is False
    assert note.is_file()
    assert "CC-BY-NC-ND-4.0" in note.read_text(encoding="utf-8")


# --- progress ----------------------------------------------------------------


def measured(tmp_path, engines, monkeypatch):
    writes = []
    import premiere_mcp_sidecar.io as sidecar_io

    monkeypatch.setattr(download_models, "progress_interval", lambda: 0.0)
    real = download_models._download_file

    def wrapped(*args, **kwargs):
        return real(*args, **kwargs)

    monkeypatch.setattr(download_models, "_download_file", wrapped)
    # The heartbeat writes through io.write_progress; record every fraction.
    monkeypatch.setattr(
        sidecar_io, "write_progress",
        lambda path, done, eta_sec=None: writes.append(round(float(done), 4)),
        raising=False,
    )
    download_models.run({"modelsDir": str(tmp_path / "models"), "engines": engines}, tmp_path / "p.json")
    return writes


def test_a_zipformer_only_run_never_jumps_to_ninety_percent(tmp_path, monkeypatch):
    """The old code wrote WHISPER_SHARE (0.9) after a whisper download it never ran."""
    writes = measured(tmp_path, ["zipformer-68m"], monkeypatch)

    assert writes
    assert writes[-1] == 1.0
    # The whisper mark is not in the plan, so 0.9 is no longer a step boundary: the
    # 68M ends just under it and the face model (R36) takes the bar over the line.
    assert 0.9 not in writes, writes


def test_progress_is_split_by_the_bytes_each_download_brings(tmp_path):
    """A zipformer-only run has no whisper download to give 90 % of the bar to."""
    from premiere_mcp_sidecar import download_models as d

    whisper_only = d.plan_shares(["whisper-turbo"])
    zipformer_only = d.plan_shares(["zipformer-68m", "zipformer-30m"])

    # Every step ends the bar exactly once, in the order it runs.
    assert whisper_only[-1] == pytest.approx(1.0)
    assert zipformer_only[-1] == pytest.approx(1.0)
    for shares in (whisper_only, zipformer_only):
        assert shares == sorted(shares)


def test_the_vad_gets_a_slice_of_the_bar_worth_its_two_mb(tmp_path):
    shares = download_models.plan_shares(["zipformer-68m"])
    names = download_models.plan_names(["zipformer-68m"])

    assert names[0] == "vad"
    vad_share = shares[0]
    assert 0.0 < vad_share < 0.05, shares  # 2 MB out of ~82 MB
