"""The command line contract: JSON in, JSON out, a non-zero exit on failure."""
import json
import os
import subprocess
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def run_cli(*args, cwd=None, pythonpath=None):
    env = dict(os.environ)
    # A stub tree (e.g. a PIL that cannot be imported) goes first on the path.
    parts = [str(path) for path in (pythonpath, PACKAGE_ROOT) if path is not None]
    env["PYTHONPATH"] = os.pathsep.join(parts)
    return subprocess.run(
        [sys.executable, "-m", "premiere_mcp_sidecar", *args],
        capture_output=True,
        text=True,
        cwd=cwd or PACKAGE_ROOT,
        env=env,
    )


def test_unknown_command_writes_error(tmp_path):
    out = tmp_path / "out.json"
    completed = run_cli("wubba", "--input", str(tmp_path / "in.json"), "--output", str(out))

    assert completed.returncode != 0
    assert "error" in json.loads(out.read_text(encoding="utf-8"))


def test_check_reports_the_environment_without_pillow(tmp_path):
    # `check` must run on a host where the render stack (Pillow) is missing: the
    # command imports `captions` lazily instead of at module import time.
    stub = tmp_path / "stub"
    stub.mkdir()
    (stub / "PIL.py").write_text("raise ImportError('no pillow here')\n", encoding="utf-8")
    out = tmp_path / "out.json"

    completed = run_cli("check", "--output", str(out), pythonpath=stub)

    assert completed.returncode == 0, completed.stderr
    assert "fasterWhisper" in json.loads(out.read_text(encoding="utf-8"))