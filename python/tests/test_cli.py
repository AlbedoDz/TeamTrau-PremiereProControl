"""The command line contract: JSON in, JSON out, a non-zero exit on failure."""
import json
import os
import subprocess
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def run_cli(*args, cwd=None, pythonpath=None):
    env = dict(os.environ)
    if pythonpath is not None:
        env["PYTHONPATH"] = str(pythonpath)
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
