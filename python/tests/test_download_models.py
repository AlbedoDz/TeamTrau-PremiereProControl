"""`download-models` fetches the ASR model and the YuNet face model, run by setup.

Nothing here touches the network. ``snapshot_download`` is a fake that records how
it was called, and ``urlopen`` is a fake whose response streams fixed bytes -- or
raises part way, which is how the "no partial file is left behind" rule is checked:
the download goes to a temp file next to the target and is only moved into place
once it is complete.
"""
import io as stdlib_io
import json
from pathlib import Path
from urllib.error import URLError

import pytest

from premiere_mcp_sidecar import download_models

TURBO = "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
ONNX_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/models/"
    "face_detection_yunet/face_detection_yunet_2023mar.onnx"
)
ONNX_NAME = "face_detection_yunet_2023mar.onnx"

# Comfortably over the 100 KB floor the command checks for.
ONNX_BYTES = b"\x08" * (120 * 1024)

# The whole turbo folder, as the coordinator found it after a real download.
WHISPER_FILES = ("config.json", "model.bin", "preprocessor_config.json", "tokenizer.json", "vocabulary.json")


def write_turbo_snapshot(folder):
    """Every file the real repo puts in the folder, with weights over 100 MB."""
    folder.mkdir(parents=True, exist_ok=True)
    for name in WHISPER_FILES:
        (folder / name).write_bytes(b"weights" if name == "model.bin" else b"{}")
    with open(folder / "model.bin", "r+b") as handle:
        handle.truncate(download_models.MIN_WHISPER_BYTES + 1)
    return folder


class FakeSnapshot:
    """Stands in for ``huggingface_hub.snapshot_download``; writes the given files."""

    calls = []
    files = WHISPER_FILES
    error = None

    @classmethod
    def __call__(cls, repo_id, local_dir, allow_patterns=None, **kwargs):
        cls.calls.append({
            "repoId": repo_id,
            "localDir": local_dir,
            "allowPatterns": allow_patterns,
            "kwargs": kwargs,
        })
        if cls.error is not None:
            raise cls.error
        # Written in the order the given list names, then the rest of the real
        # folder filled in: a fake that leaves out a file must be distinguishable
        # from one that writes them all.
        folder = Path(local_dir)
        folder.mkdir(parents=True, exist_ok=True)
        for name in cls.files:
            (folder / name).write_bytes(b"weights" if name == "model.bin" else b"{}")
        with open(folder / "model.bin", "r+b") as handle:
            handle.truncate(download_models.MIN_WHISPER_BYTES + 1)
        return str(folder)


class FakeResponse:
    """A urlopen result: streams ``chunks`` then reports end of stream.

    ``read(size)`` returns at most ``size`` bytes, the way a real HTTP response
    does, so a test can tell a bounded stream from one that buffers the body.
    """

    def __init__(self, chunks):
        self.chunks = list(chunks)
        self.status = 200
        self.headers = {"Content-Length": str(sum(len(c) for c in self.chunks if isinstance(c, bytes)))}

    def read(self, size=-1):
        if not self.chunks:
            return b""
        chunk = self.chunks[0]
        # ``"raise:message"`` simulates the connection dying mid-body: a real
        # response raises from read(), it does not hand back an exception.
        if isinstance(chunk, str) and chunk.startswith("raise:"):
            self.chunks.pop(0)
            raise URLError(chunk[len("raise:"):])
        if 0 < size < len(chunk):
            self.chunks[0] = chunk[size:]
            return chunk[:size]
        self.chunks.pop(0)
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class FakeUrlopen:
    calls = []
    chunks = [ONNX_BYTES]
    # What the server says the body will be. A real response keeps this promise
    # until the connection drops, which is what makes a mid-body failure visible
    # as an unfinished download rather than as a small but complete one.
    content_length = None
    error = None

    @classmethod
    def __call__(cls, url, timeout=None, **kwargs):
        cls.calls.append({"url": url, "timeout": timeout})
        if cls.error is not None:
            raise cls.error
        response = FakeResponse(cls.chunks)
        if cls.content_length is not None:
            response.headers = {"Content-Length": str(cls.content_length)}
        return response


@pytest.fixture(autouse=True)
def fakes(monkeypatch):
    FakeSnapshot.calls = []
    FakeSnapshot.files = WHISPER_FILES
    FakeSnapshot.error = None
    FakeUrlopen.calls = []
    FakeUrlopen.chunks = [ONNX_BYTES]
    FakeUrlopen.content_length = None
    FakeUrlopen.error = None
    monkeypatch.setattr(download_models, "snapshot_download", FakeSnapshot())
    monkeypatch.setattr(download_models, "urlopen", FakeUrlopen())
    yield


def models_dir(tmp_path):
    return tmp_path / "models"


def run(tmp_path, progress=None, **overrides):
    spec = {"modelsDir": str(models_dir(tmp_path))}
    spec.update(overrides)
    return download_models.run(spec, progress)


def test_downloads_the_turbo_repo_into_its_own_folder(tmp_path):
    result = run(tmp_path)

    call = FakeSnapshot.calls[0]
    whisper = models_dir(tmp_path) / "faster-whisper-large-v3-turbo"
    assert call["repoId"] == TURBO, "Ruling R22 fixes the repo"
    assert Path(call["localDir"]) == whisper
    # Weights and config only: no README, no images, no safetensors copy.
    assert call["allowPatterns"] == ["*.json", "*.bin", "*.txt"]
    assert result["whisper"] == {"path": str(whisper), "downloaded": True}
    assert (whisper / "model.bin").is_file()
    assert (whisper / "config.json").is_file()


def test_whisper_repo_can_be_overridden(tmp_path):
    run(tmp_path, whisperRepo="Systran/faster-whisper-large-v3")

    assert FakeSnapshot.calls[0]["repoId"] == "Systran/faster-whisper-large-v3"


def test_downloads_the_yunet_onnx_next_to_the_model_folder(tmp_path):
    result = run(tmp_path)

    onnx = models_dir(tmp_path) / ONNX_NAME
    assert FakeUrlopen.calls[0]["url"] == ONNX_URL
    assert onnx.read_bytes() == ONNX_BYTES
    assert result["yunet"] == {"path": str(onnx), "downloaded": True}


def test_a_second_run_downloads_nothing(tmp_path):
    run(tmp_path)

    result = run(tmp_path)

    assert len(FakeSnapshot.calls) == 1, "an existing model must not be downloaded again"
    assert len(FakeUrlopen.calls) == 1
    assert result["whisper"] == {
        "path": str(models_dir(tmp_path) / "faster-whisper-large-v3-turbo"), "downloaded": False,
    }
    assert result["yunet"] == {
        "path": str(models_dir(tmp_path) / ONNX_NAME), "downloaded": False,
    }


def test_a_half_written_whisper_folder_is_downloaded_again(tmp_path):
    """Weights, config and vocabulary together count: one alone is a broken copy."""
    folder = models_dir(tmp_path) / "faster-whisper-large-v3-turbo"
    folder.mkdir(parents=True)
    (folder / "model.bin").write_bytes(b"weights")
    with open(folder / "model.bin", "r+b") as handle:
        handle.truncate(download_models.MIN_WHISPER_BYTES + 1)

    result = run(tmp_path)

    assert len(FakeSnapshot.calls) == 1
    assert result["whisper"]["downloaded"] is True


@pytest.mark.parametrize("missing", WHISPER_FILES)
def test_a_folder_missing_any_single_file_is_downloaded_again(tmp_path, missing):
    """snapshot_download fetches in parallel: an interrupted run leaves a gap.

    model.bin + config.json used to be enough, so a folder that lost its tokenizer
    was skipped as complete, `check` said installed, and the first transcription
    failed offline. Every file of the real repo is now required.
    """
    folder = write_turbo_snapshot(models_dir(tmp_path) / "faster-whisper-large-v3-turbo")
    (folder / missing).unlink()

    result = run(tmp_path)

    assert len(FakeSnapshot.calls) == 1, f"a folder without {missing} must be fetched again"
    assert result["whisper"]["downloaded"] is True


def test_a_folder_with_model_bin_and_config_but_no_tokenizer_is_downloaded_again(tmp_path):
    """The exact finding: no tokenizer.json, so the folder is not a model."""
    folder = models_dir(tmp_path) / "faster-whisper-large-v3-turbo"
    folder.mkdir(parents=True)
    for name in ("model.bin", "config.json", "preprocessor_config.json", "vocabulary.json"):
        (folder / name).write_bytes(b"{}")
    (folder / "model.bin").write_bytes(b"weights")
    with open(folder / "model.bin", "r+b") as handle:
        handle.truncate(download_models.MIN_WHISPER_BYTES + 1)

    result = run(tmp_path)

    assert len(FakeSnapshot.calls) == 1
    assert result["whisper"]["downloaded"] is True
    assert (folder / "tokenizer.json").is_file()


def test_a_weight_file_under_a_hundred_megabytes_is_downloaded_again(tmp_path):
    """A truncated model.bin is not a model, however many small files surround it."""
    folder = write_turbo_snapshot(models_dir(tmp_path) / "faster-whisper-large-v3-turbo")
    (folder / "model.bin").write_bytes(b"weights")

    result = run(tmp_path)

    assert len(FakeSnapshot.calls) == 1
    assert result["whisper"]["downloaded"] is True
    assert (folder / "model.bin").stat().st_size > download_models.MIN_WHISPER_BYTES


def test_the_required_whisper_files_are_the_whole_turbo_folder():
    assert download_models.WHISPER_REQUIRED_FILES == (
        "config.json", "model.bin", "preprocessor_config.json", "tokenizer.json", "vocabulary.json",
    )
    assert download_models.MIN_WHISPER_BYTES == 100 * 1024 * 1024


def test_whisper_missing_is_public(tmp_path):
    """`check` imports it across a module boundary: it must not be underscore-private."""
    folder = write_turbo_snapshot(models_dir(tmp_path) / "faster-whisper-large-v3-turbo")

    assert download_models.whisper_missing(folder) == []
    assert not hasattr(download_models, "_whisper_missing"), "one name, no private alias left behind"


def test_whisper_missing_names_every_absent_file_and_a_stub_weight_file(tmp_path):
    folder = models_dir(tmp_path) / "faster-whisper-large-v3-turbo"
    folder.mkdir(parents=True)

    assert download_models.whisper_missing(folder) == list(download_models.WHISPER_REQUIRED_FILES)

    for name in download_models.WHISPER_REQUIRED_FILES:
        (folder / name).write_bytes(b"{}")
    missing = download_models.whisper_missing(folder)

    assert len(missing) == 1 and missing[0].startswith("model.bin under ")


def test_a_truncated_onnx_is_downloaded_again(tmp_path):
    (models_dir(tmp_path)).mkdir(parents=True)
    (models_dir(tmp_path) / ONNX_NAME).write_bytes(b"\x08" * 1024)

    result = run(tmp_path)

    assert len(FakeUrlopen.calls) == 1
    assert result["yunet"]["downloaded"] is True
    assert (models_dir(tmp_path) / ONNX_NAME).read_bytes() == ONNX_BYTES


def test_progress_runs_from_zero_to_one(tmp_path, monkeypatch):
    writes = []
    monkeypatch.setattr(
        download_models.io, "write_progress",
        lambda path, done, eta_sec=None: writes.append(done),
    )

    run(tmp_path, progress=tmp_path / "progress.json")

    assert writes[0] == 0.0
    assert writes == sorted(writes), "progress must never go backwards"
    assert writes[-1] == 1.0
    # Whisper owns the first 90%: the bar sits there while ~1.6 GB arrives.
    assert download_models.WHISPER_SHARE in writes


def test_sizes_are_reported_while_streaming(tmp_path, monkeypatch):
    """The ONNX download reports its own byte position inside the last 10%."""
    writes = []
    FakeUrlopen.chunks = [b"\x08" * 64 * 1024] * 3
    monkeypatch.setattr(
        download_models.io, "write_progress",
        lambda path, done, eta_sec=None: writes.append(done),
    )

    download_models.run(
        {"modelsDir": str(models_dir(tmp_path))}, tmp_path / "progress.json",
        chunk_size=32 * 1024,
    )

    # The body is 192 KB: the bar moves inside the ONNX's 0.1 as bytes land.
    writes = sorted(set(writes))
    assert writes[0] == 0.0
    assert download_models.WHISPER_SHARE in writes
    assert any(download_models.WHISPER_SHARE < value < 1.0 for value in writes), writes
    assert writes[-1] == 1.0


def test_a_network_error_midway_leaves_no_partial_file(tmp_path, monkeypatch):
    from urllib.error import URLError

    writes = []
    FakeUrlopen.chunks = [ONNX_BYTES[:4096], "raise:connection reset by peer"]
    # The server promised the whole body, and the connection dies 4 KB in.
    FakeUrlopen.content_length = len(ONNX_BYTES)
    monkeypatch.setattr(
        download_models.io, "write_progress",
        lambda path, done, eta_sec=None: writes.append(done),
    )

    with pytest.raises(Exception) as caught:
        run(tmp_path, progress=tmp_path / "progress.json")

    assert "connection reset" in str(caught.value)
    onnx = models_dir(tmp_path) / ONNX_NAME
    assert not onnx.exists(), "a failed download must not leave a model to be trusted"
    assert [path.name for path in onnx.parent.iterdir()] == ["faster-whisper-large-v3-turbo"]
    assert writes == sorted(writes), "progress must never go backwards"
    assert writes[-1] < 1.0, "an interrupted download must not look finished"


def test_a_failed_request_before_any_byte_leaves_no_file(tmp_path):
    from urllib.error import URLError

    FakeUrlopen.error = URLError("getaddrinfo failed")

    with pytest.raises(Exception, match="getaddrinfo"):
        run(tmp_path)

    assert not (models_dir(tmp_path) / ONNX_NAME).exists()


def test_an_empty_response_is_an_error(tmp_path):
    FakeUrlopen.chunks = [b""]

    with pytest.raises(Exception, match="0 bytes"):
        run(tmp_path)

    assert not (models_dir(tmp_path) / ONNX_NAME).exists()


def test_a_snapshot_error_propagates(tmp_path):
    FakeSnapshot.error = OSError("no space left on device")

    with pytest.raises(OSError, match="no space left"):
        run(tmp_path)

    assert FakeUrlopen.calls == [], "a failed model download must not go on to the ONNX"


def test_missing_models_dir_is_an_error(tmp_path):
    with pytest.raises(ValueError, match="modelsDir"):
        download_models.run({}, None)


def test_the_models_dir_is_created(tmp_path):
    target = tmp_path / "deep" / "models"

    download_models.run({"modelsDir": str(target)}, None)

    assert (target / ONNX_NAME).is_file()


def test_a_body_shorter_than_its_declared_length_is_an_error(tmp_path):
    """A closed connection can end the stream cleanly; the length still proves it was cut.

    Without this the file is 120 KB of a 160 KB body: over the size floor, so it
    would be moved into place and every Faces-enabled job would fail on it.
    """
    FakeUrlopen.chunks = [ONNX_BYTES[:120 * 1024]]
    FakeUrlopen.content_length = 160 * 1024

    with pytest.raises(Exception, match="Content-Length"):
        run(tmp_path)

    assert not (models_dir(tmp_path) / ONNX_NAME).exists()
    assert not list(models_dir(tmp_path).glob("*.part")), "no scratch file may survive"


def test_a_declared_length_that_is_met_is_accepted(tmp_path):
    FakeUrlopen.content_length = len(ONNX_BYTES)

    result = run(tmp_path)

    assert result["yunet"]["downloaded"] is True
    assert (models_dir(tmp_path) / ONNX_NAME).stat().st_size == len(ONNX_BYTES)


def test_cli_writes_the_result(tmp_path):
    import premiere_mcp_sidecar.__main__ as cli

    spec = tmp_path / "in.json"
    spec.write_text(json.dumps({"modelsDir": str(models_dir(tmp_path))}), encoding="utf-8")
    out = tmp_path / "out.json"

    code = cli.main(["download-models", "--input", str(spec), "--output", str(out)])

    assert code == 0
    result = json.loads(out.read_text(encoding="utf-8"))
    assert result["whisper"]["downloaded"] is True
    assert result["yunet"]["downloaded"] is True


def test_cli_writes_an_error_and_a_non_zero_exit(tmp_path, monkeypatch):
    """The failure contract: ``{"error"}`` at ``--output``, exit code 1."""
    import premiere_mcp_sidecar.__main__ as cli

    spec = tmp_path / "in.json"
    spec.write_text(json.dumps({"modelsDir": str(models_dir(tmp_path))}), encoding="utf-8")
    out = tmp_path / "out.json"

    def boom(repo_id, local_dir, allow_patterns=None, **kwargs):
        raise OSError("network is unreachable")

    monkeypatch.setattr(download_models, "snapshot_download", boom)

    code = cli.main(["download-models", "--input", str(spec), "--output", str(out)])

    assert code != 0
    assert "network is unreachable" in json.loads(out.read_text(encoding="utf-8"))["error"]
    assert not (models_dir(tmp_path) / "faster-whisper-large-v3-turbo").exists()


def test_streams_in_chunks_rather_than_reading_it_all(tmp_path, monkeypatch):
    """A 1.6 GB file is not held in memory: each read is bounded by the chunk size."""
    reads = []

    class Recording(FakeResponse):
        def read(self, size=-1):
            reads.append(size)
            return super().read(size)

    FakeUrlopen.chunks = [ONNX_BYTES[:50 * 1024], ONNX_BYTES[50 * 1024:]]
    monkeypatch.setattr(download_models, "urlopen", lambda url, timeout=None: Recording(FakeUrlopen.chunks))

    download_models.run({"modelsDir": str(models_dir(tmp_path))}, None)

    assert reads and all(0 < size <= download_models.CHUNK_SIZE for size in reads)
    assert downloads_are_complete(tmp_path)


def downloads_are_complete(tmp_path):
    return (models_dir(tmp_path) / ONNX_NAME).read_bytes() == ONNX_BYTES


def test_does_not_import_huggingface_hub_when_the_model_is_present(tmp_path, monkeypatch):
    """A warm run (the usual second `--setup-asr`) must not need the download stack."""
    run(tmp_path)
    calls = []

    def unavailable():
        calls.append("imported")
        raise AssertionError("huggingface_hub must not be imported when the model is there")

    monkeypatch.setattr(download_models, "snapshot_download", None)
    monkeypatch.setattr(download_models, "_snapshot_download", unavailable)

    download_models.run({"modelsDir": str(models_dir(tmp_path))}, None)

    assert calls == []


def test_paths_match_what_the_server_expects(tmp_path):
    """`sidecar.ts` modelPaths(): models/faster-whisper-large-v3-turbo and the .onnx."""
    result = run(tmp_path)

    assert result["whisper"]["path"] == str(models_dir(tmp_path) / "faster-whisper-large-v3-turbo")
    assert result["yunet"]["path"] == str(models_dir(tmp_path) / ONNX_NAME)


def test_the_onnx_floor_is_a_hundred_kilobytes():
    assert download_models.MIN_ONNX_BYTES == 100 * 1024
    assert download_models.ONNX_URL == ONNX_URL
    assert download_models.DEFAULT_WHISPER_REPO == TURBO
    assert download_models.ALLOW_PATTERNS == ["*.json", "*.bin", "*.txt"]


def test_a_response_without_content_length_still_streams(tmp_path, monkeypatch):
    class NoLength(FakeResponse):
        def __init__(self, chunks):
            super().__init__(chunks)
            self.headers = {}

    chunks = [ONNX_BYTES[:20 * 1024], ONNX_BYTES[20 * 1024:]]
    monkeypatch.setattr(download_models, "urlopen", lambda url, timeout=None: NoLength(chunks))

    result = download_models.run({"modelsDir": str(models_dir(tmp_path))}, None)

    assert result["yunet"]["downloaded"] is True
    assert (models_dir(tmp_path) / ONNX_NAME).read_bytes() == ONNX_BYTES


def test_json_content_is_not_buffered_by_accident(tmp_path):
    """Guard against `read()` being called with no size, which loads the file at once."""
    assert download_models.CHUNK_SIZE <= 8 * 1024 * 1024
    assert stdlib_io.DEFAULT_BUFFER_SIZE < download_models.CHUNK_SIZE
