"""The ffmpeg binary the server resolved, the Zipformer default, and an install without the whisper extra."""
import importlib.util
import subprocess

import numpy as np
import pytest

from premiere_mcp_sidecar import check, faces, io, transcribe


@pytest.fixture(autouse=True)
def reset_ffmpeg():
    io.set_ffmpeg(None)
    yield
    io.set_ffmpeg(None)


def test_engine_defaults_to_the_zipformer_68m():
    assert transcribe.engine_of({}) == "zipformer-68m"
    assert transcribe.engine_of({"engine": "whisper-turbo"}) == "whisper-turbo"


def test_ffmpeg_is_looked_up_on_path_unless_a_path_was_given():
    assert io.ffmpeg_bin() == "ffmpeg"
    io.set_ffmpeg("C:/tools/ffmpeg.exe")
    assert io.ffmpeg_bin() == "C:/tools/ffmpeg.exe"
    io.set_ffmpeg("")
    assert io.ffmpeg_bin() == "ffmpeg"


def test_pcm16k_runs_the_given_ffmpeg(monkeypatch):
    seen = []

    def fake_run(args, **kwargs):
        seen.append(args[0])
        return subprocess.CompletedProcess(args, 0, stdout=np.zeros(4, dtype="<f4").tobytes(), stderr=b"")

    monkeypatch.setattr(io.subprocess, "run", fake_run)
    io.pcm16k("a.wav")
    io.set_ffmpeg("D:/ff/ffmpeg.exe")
    io.pcm16k("a.wav")
    assert seen == ["ffmpeg", "D:/ff/ffmpeg.exe"]


def test_faces_frame_command_uses_the_given_ffmpeg():
    assert faces.ffmpeg_args("a.mp4", 0, 5)[0] == "ffmpeg"
    io.set_ffmpeg("D:/ff/ffmpeg.exe")
    assert faces.ffmpeg_args("a.mp4", 0, 5)[0] == "D:/ff/ffmpeg.exe"


def test_the_entry_points_take_ffmpeg_path_from_the_input(tmp_path, monkeypatch):
    with pytest.raises(FileNotFoundError):
        transcribe.run({"mediaPath": str(tmp_path / "gone.wav"), "ffmpegPath": "E:/x/ffmpeg.exe"})
    assert io.ffmpeg_bin() == "E:/x/ffmpeg.exe"
    with pytest.raises(ValueError):
        faces.run({"ffmpegPath": "F:/y/ffmpeg.exe"})
    assert io.ffmpeg_bin() == "F:/y/ffmpeg.exe"


def test_captions_encode_with_the_given_ffmpeg(tmp_path, monkeypatch):
    from premiere_mcp_sidecar import captions

    seen = []

    def fake_run(args, **kwargs):
        seen.append(args[0])
        out = args[-1]
        open(out, "wb").write(b"mov")
        return subprocess.CompletedProcess(args, 0, stdout=b"", stderr=b"")

    monkeypatch.setattr(captions.subprocess, "run", fake_run)
    captions.render({
        "groups": [{"start": 0, "end": 0.5, "words": [{"w": "xin", "start": 0, "end": 0.5}]}],
        "width": 64, "height": 64, "fps": 5, "duration": 0.6,
        "outPath": str(tmp_path / "c.mov"), "ffmpegPath": "G:/z/ffmpeg.exe",
    })
    assert seen == ["G:/z/ffmpeg.exe"]


def test_check_does_not_import_whisper_when_the_extra_is_absent(monkeypatch):
    imported = []
    real_find_spec = importlib.util.find_spec
    monkeypatch.setattr(check.importlib.util, "find_spec",
                        lambda name, *a: None if name in ("faster_whisper", "ctranslate2") else real_find_spec(name, *a))
    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def spy(name, *a, **k):
        if name.split(".")[0] in ("faster_whisper", "ctranslate2"):
            imported.append(name)
        return real_import(name, *a, **k)

    monkeypatch.setattr("builtins.__import__", spy)
    report = check.run()
    assert report["fasterWhisper"] is False
    assert report["cuda"] is False
    assert imported == []


def test_check_reports_an_ffmpeg_path_that_exists(tmp_path):
    exe = tmp_path / "ffmpeg.exe"
    exe.write_bytes(b"")
    assert check.run(str(exe))["ffmpeg"] is True
