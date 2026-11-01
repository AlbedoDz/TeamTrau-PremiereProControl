"""What `check` reports about the models on disk.

The server's `asrStatus()` reads ``models.whisper`` / ``models.yunet`` and tells the
user what is missing, so each flag has to match the exact paths the download
command writes and the analysis tools read (``modelPaths()`` in ``sidecar.ts``).
"""
import json
import subprocess
import sys
from pathlib import Path

from premiere_mcp_sidecar import check

PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def home(tmp_path, monkeypatch):
    monkeypatch.setenv("PREMIERE_MCP_HOME", str(tmp_path))
    return tmp_path / "models"


def test_the_turbo_folder_is_the_whisper_model(tmp_path, monkeypatch):
    """Ruling R22: the downloaded model is faster-whisper-large-v3-turbo."""
    models = home(tmp_path, monkeypatch)
    turbo = models / "faster-whisper-large-v3-turbo"
    turbo.mkdir(parents=True)
    (turbo / "model.bin").write_bytes(b"weights")
    (turbo / "config.json").write_text("{}", encoding="utf-8")

    report = check.run()

    assert report["models"]["whisper"] is True


def test_an_empty_turbo_folder_is_not_a_model(tmp_path, monkeypatch):
    models = home(tmp_path, monkeypatch)
    (models / "faster-whisper-large-v3-turbo").mkdir(parents=True)

    assert check.run()["models"]["whisper"] is False


def test_the_old_large_v3_folder_no_longer_counts(tmp_path, monkeypatch):
    """A leftover large-v3 download must not make the turbo model look present."""
    models = home(tmp_path, monkeypatch)
    old = models / "whisper" / "models--Systran--faster-whisper-large-v3" / "snapshots" / "abc"
    old.mkdir(parents=True)
    (old / "model.bin").write_bytes(b"weights")
    (models / "faster-whisper-large-v3").mkdir()
    (models / "faster-whisper-large-v3" / "model.bin").write_bytes(b"weights")

    assert check.run()["models"]["whisper"] is False


def test_the_yunet_onnx_is_the_face_model(tmp_path, monkeypatch):
    models = home(tmp_path, monkeypatch)
    models.mkdir(parents=True)
    (models / "face_detection_yunet_2023mar.onnx").write_bytes(b"\x08" * (120 * 1024))

    assert check.run()["models"]["yunet"] is True


def test_a_tiny_truncated_onnx_is_not_a_model(tmp_path, monkeypatch):
    models = home(tmp_path, monkeypatch)
    models.mkdir(parents=True)
    (models / "face_detection_yunet_2023mar.onnx").write_bytes(b"\x08" * 1024)

    assert check.run()["models"]["yunet"] is False


def test_what_download_models_writes_is_what_check_finds(tmp_path, monkeypatch):
    """The two commands must agree, or setup reports success and status says missing."""
    from premiere_mcp_sidecar import download_models

    models = home(tmp_path, monkeypatch)

    def snapshot(repo_id, local_dir, allow_patterns=None, **kwargs):
        folder = Path(local_dir)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "model.bin").write_bytes(b"weights")
        (folder / "config.json").write_text("{}", encoding="utf-8")
        return str(folder)

    class Response:
        def __init__(self):
            self.chunks = [b"\x08" * (120 * 1024)]

        def read(self, size=-1):
            return self.chunks.pop(0) if self.chunks else b""

        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

    monkeypatch.setattr(download_models, "snapshot_download", snapshot)
    monkeypatch.setattr(download_models, "urlopen", lambda url, timeout=None: Response())
    download_models.run({"modelsDir": str(models)}, None)

    report = check.run()
    assert report["models"] == {"whisper": True, "yunet": True}


def test_cli_reports_the_models(tmp_path):
    env = {"PREMIERE_MCP_HOME": str(tmp_path), "PYTHONPATH": str(PACKAGE_ROOT)}
    turbo = tmp_path / "models" / "faster-whisper-large-v3-turbo"
    turbo.mkdir(parents=True)
    (turbo / "model.bin").write_bytes(b"weights")
    out = tmp_path / "out.json"

    completed = subprocess.run(
        [sys.executable, "-m", "premiere_mcp_sidecar", "check", "--output", str(out)],
        capture_output=True, text=True, cwd=PACKAGE_ROOT,
        env={**__import__("os").environ, **env},
    )

    assert completed.returncode == 0, completed.stderr
    assert json.loads(out.read_text(encoding="utf-8"))["models"]["whisper"] is True
