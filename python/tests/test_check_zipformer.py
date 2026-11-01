"""`check` for the Zipformer engines: three folder booleans and the runtime import.

Each flag has to mean the same thing here as in ``download-models`` (one verdict,
no drift), because setup skips a download that `check` calls complete and the
first transcription then fails offline.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from premiere_mcp_sidecar import check, sherpa_models

PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def home(tmp_path, monkeypatch):
    monkeypatch.setenv("PREMIERE_MCP_HOME", str(tmp_path))
    return tmp_path / "models"


def write_zipformer(models, name):
    """A complete folder, with the weights over the downloader's size floors."""
    folder = models / name
    folder.mkdir(parents=True, exist_ok=True)
    plan = sherpa_models.ZIPFORMER[name]["files"]
    for kind, filename in plan.items():
        if kind == "tokens" and name in sherpa_models.GENERATED_TOKENS:
            # The 30M tokens.txt is generated, never downloaded.
            (folder / filename).write_text("<blk> 0\n", encoding="utf-8")
            continue
        body = {"encoder": b"\x08" * (1024 * 1024 + 1), "joiner": b"\x08" * (1024 * 1024 + 1),
                "bpe": b"\x08" * (100 * 1024 + 1)}
        (folder / filename).write_bytes(body.get(kind, b"{}"))
    return folder


def write_vad(models):
    models.mkdir(parents=True, exist_ok=True)
    (models / sherpa_models.VAD_NAME).write_bytes(b"\x08" * (16 * 1024 + 1))


def test_a_complete_68m_folder_is_reported(tmp_path, monkeypatch):
    models = home(tmp_path, monkeypatch)
    write_zipformer(models, sherpa_models.ZIPFORMER_68M_DIR)

    assert check.run()["models"]["zipformer68m"] is True


def test_a_complete_30m_folder_is_reported(tmp_path, monkeypatch):
    models = home(tmp_path, monkeypatch)
    write_zipformer(models, sherpa_models.ZIPFORMER_30M_DIR)

    assert check.run()["models"]["zipformer30m"] is True


def test_the_vad_is_reported(tmp_path, monkeypatch):
    models = home(tmp_path, monkeypatch)
    write_vad(models)

    assert check.run()["models"]["vad"] is True


def test_nothing_installed_is_all_false(tmp_path, monkeypatch):
    home(tmp_path, monkeypatch)

    report = check.run()["models"]

    assert report["zipformer68m"] is False
    assert report["zipformer30m"] is False
    assert report["vad"] is False


@pytest.mark.parametrize("name", [
    "encoder-epoch-12-avg-8.int8.onnx",
    "joiner-epoch-12-avg-8.int8.onnx",
    "tokens.txt",
])
def test_a_68m_folder_missing_a_file_is_not_installed(tmp_path, monkeypatch, name):
    models = home(tmp_path, monkeypatch)
    folder = write_zipformer(models, sherpa_models.ZIPFORMER_68M_DIR)
    (folder / name).unlink()

    assert check.run()["models"]["zipformer68m"] is False


def test_a_30m_folder_missing_its_generated_tokens_file_is_not_installed(tmp_path, monkeypatch):
    models = home(tmp_path, monkeypatch)
    folder = write_zipformer(models, sherpa_models.ZIPFORMER_30M_DIR)
    (folder / "tokens.txt").unlink()

    assert check.run()["models"]["zipformer30m"] is False


def test_a_truncated_encoder_is_not_installed(tmp_path, monkeypatch):
    models = home(tmp_path, monkeypatch)
    folder = write_zipformer(models, sherpa_models.ZIPFORMER_68M_DIR)
    (folder / sherpa_models.ZIPFORMER[sherpa_models.ZIPFORMER_68M_DIR]["files"]["encoder"]).write_bytes(b"\x08")

    assert check.run()["models"]["zipformer68m"] is False


def test_a_tiny_vad_is_not_installed(tmp_path, monkeypatch):
    models = home(tmp_path, monkeypatch)
    models.mkdir(parents=True)
    (models / sherpa_models.VAD_NAME).write_bytes(b"")

    assert check.run()["models"]["vad"] is False


def test_the_folder_names_are_the_downloaders():
    assert check.zipformer_missing is sherpa_models.zipformer_missing


def test_sherpa_onnx_is_reported_from_the_import(monkeypatch):
    monkeypatch.setitem(sys.modules, "sherpa_onnx", object())

    assert check.run()["sherpaOnnx"] is True


def test_a_missing_sherpa_is_reported_as_false(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "sherpa_onnx":
            raise ImportError("no sherpa here")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    assert check.run()["sherpaOnnx"] is False


def test_cli_still_reports_the_models_in_a_subprocess(tmp_path):
    env = {"PREMIERE_MCP_HOME": str(tmp_path), "PYTHONPATH": str(PACKAGE_ROOT)}
    write_zipformer(tmp_path / "models", sherpa_models.ZIPFORMER_68M_DIR)
    out = tmp_path / "out.json"

    completed = subprocess.run(
        [sys.executable, "-m", "premiere_mcp_sidecar", "check", "--output", str(out)],
        capture_output=True, text=True, cwd=PACKAGE_ROOT,
        env={**os.environ, **env},
    )

    assert completed.returncode == 0, completed.stderr
    report = json.loads(out.read_text(encoding="utf-8"))
    assert report["models"]["zipformer68m"] is True
    assert "sherpaOnnx" in report
