"""Face counting for multi-person detection, driven by a fake detector and reader.

Frames are read by ONE ffmpeg process per input range (Ruling R17): the fake
frame reader records every command line and the tests assert there is exactly one
per range. The detector is fake too, so no ONNX model is needed.

The timestamps are not: ``showinfo`` puts each kept frame's real ``pts_time`` on
ffmpeg's stderr, and ``test_real_ffmpeg_*`` below runs a real ffmpeg over a real
video (keyframes every 2 s) to prove the samples land on those keyframes and in
file time, for a range that starts at the file start and one that does not.
"""
import json
import os
import shutil
import struct
import subprocess
import threading
import time

import numpy as np
import pytest

from premiere_mcp_sidecar import faces, io

# How long the fake pipe keeps a reader waiting for bytes that the *other* reader
# has not taken yet: long enough to be a real wait, short enough for a deadlock.
BLOCK_SEC = 5.0


class FakeDetector:
    """Returns ``count`` faces for every frame, recording what it was given."""

    count = 2
    seen = []
    frame_shapes = []

    @classmethod
    def create(cls, framework, buffer_model, buffer_config, size, *rest, **kwargs):
        """The buffer overload: (framework, model bytes, config bytes, size, ...)."""
        options = dict(zip(("score_threshold", "nms_threshold", "top_k"), rest))
        options.update(kwargs)
        return cls(framework, {
            "config": buffer_config, "size": size, "score_threshold": options.get("score_threshold"),
            "nms_threshold": options.get("nms_threshold"), "top_k": options.get("top_k"),
            "buffer": buffer_model,
        })

    def __init__(self, model_path, options=None):
        self.model_path = model_path
        self.config = options or {}
        self.width = self.height = 0
        FakeDetector.seen.append(self)

    def setInputSize(self, size):
        self.width, self.height = size

    def detect(self, frame):
        FakeDetector.frame_shapes.append(frame.shape)
        n = self.count
        # YuNet's row: box, 5 landmarks, then [score, ...]; column 14 is the score.
        found = np.array([[1, 2, 3, 4, 0.95, 5, 6, 0.9, 7, 8, 0.3, 0.97, 0.98, 0.0, 0.97]] * n, dtype=np.float32)
        return (n, found) if n else (0, np.zeros((0, 15), dtype=np.float32))


class FakeReader:
    """Stands in for the single-ffmpeg frame reader: one call per range.

    ``frames_per_range`` is the raw keyframe stream the range would deliver, as
    ``(pts in range seconds, iskey)``; the fake applies the reader's own "keep the
    first frame of each whole second" rule through the same ``is_sample_start``
    boundary, so the tests see the contract the real reader produces.
    """

    calls = []

    def __init__(self, frames_per_range=None, fail_cuda=False):
        self.frames_per_range = frames_per_range
        self.fail_cuda = fail_cuda

    def __call__(self, media, start, end, fps=1.0, hwaccel=True, scale_width=640):
        FakeReader.calls.append({"media": media, "start": start, "end": end, "hwaccel": hwaccel, "fps": fps})
        if hwaccel and self.fail_cuda:
            raise RuntimeError("ffmpeg could not read the frames hwaccel")
        if self.frames_per_range is not None:
            frames = self.frames_per_range
        else:
            frames = [(float(offset), True) for offset in range(max(0, int(end) - int(start)))]
        frame = np.zeros((360, 640, 3), dtype=np.uint8)
        offset = float(start)
        next_sample = offset
        for pts, iskey in frames:
            # Same rule as the real reader: file time, whole-second grid.
            file_time = offset + pts
            if not iskey or not faces.is_sample_start(file_time, next_sample):
                continue
            yield round(file_time, 3), frame
            next_sample = file_time + 1.0 / fps


@pytest.fixture(autouse=True)
def reset():
    FakeDetector.count = 2
    FakeDetector.seen = []
    FakeDetector.frame_shapes = []
    FakeReader.calls = []
    yield


@pytest.fixture
def detector(monkeypatch):
    monkeypatch.setattr(faces, "FaceDetectorYN", FakeDetector)


def use_reader(monkeypatch, reader):
    monkeypatch.setattr(faces, "read_frames", reader)


def test_samples_per_second_in_range(tmp_path, monkeypatch, detector):
    use_reader(monkeypatch, FakeReader())
    model = tmp_path / "face_detection_yunet_2023mar.onnx"
    model.write_bytes(b"onnx")

    result = faces.run({
        "mediaPath": "C:/media/talk.mp4",
        "modelPath": str(model),
        "ranges": [{"start": 10, "end": 13}],
        "fps": 1,
    })

    assert [sample["t"] for sample in result["samples"]] == [10, 11, 12]
    assert all(sample["count"] == 2 for sample in result["samples"])
    assert len(FakeReader.calls) == 1, "one ffmpeg process per input range"
    assert FakeReader.calls[0]["start"] == 10 and FakeReader.calls[0]["end"] == 13
    assert FakeDetector.seen[0].config["score_threshold"] == 0.8
    assert FakeDetector.seen[0].config["nms_threshold"] == 0.3
    assert FakeDetector.frame_shapes == [(360, 640, 3)] * 3


def test_one_ffmpeg_per_range_not_per_frame(tmp_path, monkeypatch, detector):
    use_reader(monkeypatch, FakeReader())
    model = tmp_path / "yunet.onnx"
    model.write_bytes(b"onnx")

    result = faces.run({
        "mediaPath": "C:/media/talk.mp4",
        "modelPath": str(model),
        "ranges": [{"start": 0, "end": 60}, {"start": 120, "end": 150}],
    })

    assert len(FakeReader.calls) == 2
    assert [sample["t"] for sample in result["samples"]][:3] == [0, 1, 2]
    assert len(result["samples"]) == 60 + 30
    assert FakeDetector.seen[0].config["score_threshold"] == 0.8


def test_count_zero_when_no_face(tmp_path, monkeypatch, detector):
    FakeDetector.count = 0
    use_reader(monkeypatch, FakeReader(frames_per_range=[(3.0, True), (4.0, True)]))
    model = tmp_path / "yunet.onnx"
    model.write_bytes(b"onnx")

    result = faces.run({"mediaPath": "m.mp4", "modelPath": str(model), "ranges": [{"start": 2, "end": 7}]})

    # The range starts at 2 s, so its first whole second is 3 s, not 2.0 + 3.
    assert result["samples"] == [{"t": 5, "count": 0}, {"t": 6, "count": 0}]


def test_hwaccel_fallback_retries_the_range_on_cpu(tmp_path, monkeypatch, detector):
    reader = FakeReader(fail_cuda=True)
    use_reader(monkeypatch, reader)
    model = tmp_path / "yunet.onnx"
    model.write_bytes(b"onnx")

    result = faces.run({"mediaPath": "m.mp4", "modelPath": str(model), "ranges": [{"start": 10, "end": 12}]})

    assert [sample["t"] for sample in result["samples"]] == [10, 11]
    assert [call["hwaccel"] for call in FakeReader.calls] == [True, False]


def test_empty_ranges_make_no_ffmpeg_call(tmp_path, detector):
    model = tmp_path / "yunet.onnx"
    model.write_bytes(b"onnx")

    result = faces.run({"mediaPath": "m.mp4", "modelPath": str(model), "ranges": []})

    assert result["samples"] == []
    assert FakeReader.calls == []


def test_ranges_are_sorted_and_samples_follow_the_range_start(tmp_path, monkeypatch, detector):
    use_reader(monkeypatch, FakeReader())
    model = tmp_path / "yunet.onnx"
    model.write_bytes(b"onnx")

    result = faces.run({
        "mediaPath": "m.mp4",
        "modelPath": str(model),
        "ranges": [{"start": 20, "end": 22}, {"start": 10.4, "end": 12.9}],
    })

    # Sorted by start; `t` is always a real file time: a whole-second range starts on
    # whole seconds, and a fractional start (10.4) opens its first sample there and
    # reports the next keyframe's own time, 11.4, for the second one.
    assert [sample["t"] for sample in result["samples"]] == [10.4, 11.4, 20, 21]
    assert [call["start"] for call in FakeReader.calls] == [10.4, 20]


def test_missing_model_is_an_error(tmp_path):
    with pytest.raises(FileNotFoundError, match="yunet"):
        faces.run({"mediaPath": "m.mp4", "modelPath": str(tmp_path / "absent.onnx"), "ranges": [{"start": 0, "end": 1}]})


def test_missing_media_path_is_an_error(tmp_path):
    with pytest.raises(ValueError, match="mediaPath"):
        faces.run({"modelPath": "yunet.onnx"})


def bmp_bytes(width=2, height=2, fill=0x10):
    """One uncompressed 24-bit BMP, the shape ffmpeg writes to image2pipe."""
    row = ((width * 3 + 3) // 4) * 4
    pixels = bytes([fill]) * row * height
    size = 54 + len(pixels)
    return (
        b"BM" + struct.pack("<IHHI", size, 0, 0, 54)
        + struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, len(pixels), 0, 0, 0, 0)
        + pixels
    )


def showinfo_line(index, pts_time, iskey=1):
    """The one line of ffmpeg's showinfo output the reader parses."""
    return (
        f"[Parsed_showinfo_1 @ 000001] n: {index:3d} pts: {int(pts_time * 1000)} "
        f"pts_time:{pts_time:g} duration: 512 duration_time:0.04 fmt:bgr24 "
        f"s:640x360 i:P iskey:{iskey} type:{'I' if iskey else 'P'}\n"
    )


class FakeStream:
    """One ffmpeg pipe: its bytes are handed out as the shared event log says.

    ``events`` is what ffmpeg wrote, in order, as ``(pipe, bytes)`` where pipe is
    ``"out"`` for a frame and ``"err"`` for a line of stderr. Each pipe has its own
    cursor, so neither can read past what ffmpeg has written, and a pipe with
    nothing due blocks the way a real blocking pipe does: ``read()`` waits (briefly
    and repeatedly) until its next event arrives or the process exits. A reader that
    only turns to stderr after stdout's EOF therefore waits here forever, which is
    the deadlock the concurrency test is for.
    """

    def __init__(self, log, pipe, process):
        self._log = log
        self._pipe = pipe
        self._process = process
        self._cursor = 0
        self._data = b""  # bytes of this pipe's current event, not handed out yet
        self.exhausted = False

    def _next_event(self, wait):
        """Take the next ``(pipe, data)`` at or after this pipe's cursor."""
        waited = 0.0
        while self._cursor >= len(self._log):
            if self._process.killed:
                self.exhausted = True
                return None
            if not wait:
                return None
            time.sleep(0.002)
            waited += 0.002
            if waited > BLOCK_SEC:  # pragma: no cover - a hung reader
                raise AssertionError("a reader waited for ffmpeg output that never came")
        self._cursor += 1
        return self._log[self._cursor - 1]

    def _fill(self, wait):
        while not self._data:
            event = self._next_event(wait)
            if event is None:
                return False
            pipe, data = event
            if pipe != self._pipe or data is None:
                if data is None and pipe == self._pipe:
                    # This pipe's sentinel: EOF.
                    self.exhausted = True
                    return False
                # Written for the other pipe: both cursors pass over the whole log.
                continue
            self._data = data
        return True

    def read(self, size=-1):
        if not self._fill(wait=True):
            return b""
        if size is None or size < 0 or size < len(self._data):
            # A short read is allowed on a pipe; the caller asks again.
            data, self._data = self._data[:size], self._data[size:]
            return data
        data, self._data = self._data, b""
        return data

    def readline(self):
        while True:
            newline = self._data.find(b"\n")
            if newline >= 0:
                line, self._data = self._data[: newline + 1], self._data[newline + 1:]
                return line
            if not self._fill(wait=True):
                line, self._data = self._data, b""
                return line

    def close(self):
        self.exhausted = True


class FakeProcess:
    """What ``read_frames`` needs from a Popen: two pipes over one ffmpeg session.

    ``packets`` is the session: ``("stderr", text)`` is a log line, ``("frame", bmp,
    pts)`` is a frame -- ffmpeg writes the showinfo line first, then the BMP -- and
    ``("exit", code)`` is the process exiting after everything it wrote. The session
    is turned into one ordered event log both pipes read.
    """

    calls = []
    packets = None
    fail_with = None
    returncode = 0
    frames = 3

    def __init__(self, args, **kwargs):
        FakeProcess.calls.append(args)
        assert kwargs.get("stdout") == faces.subprocess.PIPE
        assert kwargs.get("stderr") == faces.subprocess.PIPE
        self.killed = False
        packets = _default_packets() if FakeProcess.packets is None else list(FakeProcess.packets)
        if FakeProcess.fail_with is not None:
            # A real ffmpeg delivers the frames it managed, then exits non-zero; the
            # failure only surfaces once the stream has been drained to the end.
            packets += [("stderr", FakeProcess.fail_with + "\n")]
        log = []
        for packet in packets:
            if packet[0] == "stderr":
                log.append(("err", packet[1].encode()))
            elif packet[0] == "frame":
                log.append(("err", packet[2].encode()))
                log.append(("out", packet[1]))
        # One sentinel per pipe, last: reaching it is that pipe's EOF.
        log.append(("out", None))
        log.append(("err", None))
        self.stdout = FakeStream(log, "out", self)
        self.stderr = FakeStream(log, "err", self)

    def poll(self):
        """Exit code once both pipes are drained or the process was killed."""
        if self.killed:
            return -9
        return FakeProcess.returncode if (self.stdout.exhausted and self.stderr.exhausted) else None

    def running(self):
        """Whether ffmpeg could still write: either pipe has not reached its end."""
        return not (self.stdout.exhausted and self.stderr.exhausted)

    def kill(self):
        self.killed = True

    def wait(self, timeout=None):
        """``wait()`` returns once the process has exited: here, once both pipes end.

        A real ffmpeg only exits after writing everything, so the exit code always
        arrives after the last frame; the reader uses that to tell a decode failure
        from a stream it stopped reading itself.
        """
        return FakeProcess.returncode


def _default_packets():
    # The banner before any frame, as the real share of stderr is.
    packets = [("stderr", "ffmpeg version 8.1.2 Copyright (c) the FFmpeg developers\n")]
    for index in range(FakeProcess.frames):
        packets.append(("frame", bmp_bytes(), showinfo_line(index, float(index))))
    packets.append(("stderr", "frame=    3 fps=0.0 q=-0.0 Lsize=1kB\n"))
    return packets


@pytest.fixture
def fake_process(monkeypatch):
    FakeProcess.calls = []
    FakeProcess.packets = None
    FakeProcess.fail_with = None
    FakeProcess.frames = 3
    FakeProcess.returncode = 0
    monkeypatch.setattr(faces.subprocess, "Popen", FakeProcess)
    return FakeProcess


def test_read_frames_one_ffmpeg_pass(fake_process):
    """The real reader: one ffmpeg process, BMP stream on a pipe, t from frame pts."""
    frames = list(faces.read_frames("C:/media/talk.mp4", 10, 20, fps=1))

    assert len(fake_process.calls) == 1
    args = fake_process.calls[0]
    assert args[0] == "ffmpeg"
    assert args[args.index("-hwaccel") + 1] == "cuda"
    assert args[args.index("-skip_frame") + 1] == "nokey"
    assert args[args.index("-ss") + 1] == "10.000000"
    assert args[args.index("-to") + 1] == "20.000000"
    assert args[args.index("-vf") + 1] == "scale=640:-2,showinfo"
    assert args[args.index("-fps_mode") + 1] == "passthrough"
    assert args[args.index("-f") + 1] == "image2pipe"
    assert args[args.index("-vcodec") + 1] == "bmp"
    # showinfo's pts_time restarts at the -ss point, so t = start + pts_time.
    assert [t for t, _ in frames] == [10.0, 11.0, 12.0]
    assert frames[0][1].shape == (2, 2, 3)


def test_read_frames_without_hwaccel(fake_process):
    assert [t for t, _ in faces.read_frames("m.mp4", 0, 5, fps=1, hwaccel=False)] == [0.0, 1.0, 2.0]
    assert "-hwaccel" not in fake_process.calls[0]


def test_read_frames_reports_ffmpeg_failure(fake_process):
    fake_process.fail_with = "Invalid data found when processing input"
    fake_process.returncode = 1

    with pytest.raises(RuntimeError, match="Invalid data found"):
        list(faces.read_frames("m.mp4", 0, 5))


def test_read_frames_stops_cleanly_on_an_empty_stream(fake_process):
    fake_process.frames = 0

    assert list(faces.read_frames("m.mp4", 0, 5)) == []


def test_read_frames_reports_a_failure_after_some_frames(fake_process):
    """A failure part-way through is an error, not a short silent result."""
    fake_process.frames = 2
    fake_process.fail_with = "moov atom not found"
    fake_process.returncode = 1

    frames = faces.read_frames("m.mp4", 0, 5)
    assert next(frames)[0] == 0.0
    with pytest.raises(RuntimeError, match="moov atom not found"):
        list(frames)


def test_read_frames_early_exit_is_not_an_error(fake_process):
    """A caller that breaks out early kills ffmpeg itself: not a decode failure.

    Closing the generator mid-stream must not raise, even though the process we
    killed exits non-zero: the error path only reports a stream we drained.
    """
    frames = faces.read_frames("m.mp4", 0, 5)

    first = next(frames)
    frames.close()

    assert first[0] == 0.0


def test_reads_stderr_concurrently_while_stdout_is_still_open(fake_process):
    """A big stderr and a stdout nobody has drained yet must not deadlock.

    The fake hands out each frame's showinfo line on stderr and the frame on
    stdout in lockstep: reading stderr only after stdout's EOF would hang here,
    which is exactly what a > 64 KB ``showinfo`` log does to the real reader.
    """
    filler = "".join(f"filler line {i:04d} " + "x" * 4000 + "\n" for i in range(40))
    fake_process.packets = (
        [("stderr", filler)]
        + [("frame", bmp_bytes(), showinfo_line(i, float(i))) for i in range(3)]
    )
    seen = []

    def read():
        seen.extend(t for t, _ in faces.read_frames("m.mp4", 0, 5))

    worker = threading.Thread(target=read, daemon=True)
    worker.start()
    worker.join(timeout=30)

    assert not worker.is_alive(), "read_frames deadlocked on a large stderr"
    assert seen == [0.0, 1.0, 2.0]
    # Over 160 KB of stderr -- far more than a pipe buffer -- was written ahead of
    # the frames, so those frames could only arrive if stderr was being drained
    # while stdout was being read rather than after its EOF.
    assert len(filler) > 160_000


def test_an_empty_range_is_not_retried_on_the_cpu(tmp_path, monkeypatch, detector):
    """No keyframes in a range is a real answer, so only one ffmpeg call is made."""
    reader = FakeReader(frames_per_range=[])
    use_reader(monkeypatch, reader)
    model = tmp_path / "yunet.onnx"
    model.write_bytes(b"onnx")

    result = faces.run({"mediaPath": "m.mp4", "modelPath": str(model), "ranges": [{"start": 0, "end": 2}]})

    assert result["samples"] == []
    assert [call["hwaccel"] for call in FakeReader.calls] == [True]


def test_progress_is_written_while_scanning(tmp_path, monkeypatch, detector):
    use_reader(monkeypatch, FakeReader(frames_per_range=[(float(t), True) for t in range(0, 40)]))
    writes = []

    def record(path, done, eta_sec=None):
        writes.append(done)

    monkeypatch.setattr(io, "write_progress", record)
    model = tmp_path / "yunet.onnx"
    model.write_bytes(b"onnx")

    progress = tmp_path / "progress.json"
    faces.run({"mediaPath": "m.mp4", "modelPath": str(model), "ranges": [{"start": 0, "end": 40}]}, progress)

    assert len(writes) >= 2
    assert writes == sorted(writes)
    assert writes[-1] == 1.0


def test_progress_heartbeat_while_a_frame_takes_long(tmp_path, monkeypatch, detector):
    """A slow detector still reports progress from the timer (Ruling R19)."""
    import time

    writes = []

    def slow_detect(self, frame):
        time.sleep(0.1)
        return real_detect(self, frame)

    real_detect = FakeDetector.detect
    monkeypatch.setattr(FakeDetector, "detect", slow_detect)
    use_reader(monkeypatch, FakeReader(frames_per_range=[(0.0, True)]))
    monkeypatch.setattr(faces, "progress_interval", lambda: 0.02)
    monkeypatch.setattr(
        io, "write_progress",
        lambda path, done, eta_sec=None: writes.append(done),
    )
    model = tmp_path / "yunet.onnx"
    model.write_bytes(b"onnx")

    faces.run({"mediaPath": "m.mp4", "modelPath": str(model), "ranges": [{"start": 0, "end": 1}]}, tmp_path / "p.json")

    assert len(writes) >= 3, writes
    assert writes[-1] == 1.0


def test_keeps_at_most_one_frame_per_second(tmp_path, monkeypatch, detector):
    """Keyframes that bunch up are thinned to one sample per whole second."""
    use_reader(monkeypatch, FakeReader(
        frames_per_range=[(2.0, True), (2.4, True), (2.9, True), (3.0, True), (3.5, True), (5.2, True)],
    ))
    model = tmp_path / "yunet.onnx"
    model.write_bytes(b"onnx")

    result = faces.run({"mediaPath": "m.mp4", "modelPath": str(model), "ranges": [{"start": 0, "end": 6}]})

    # 2.4 and 2.9 fall inside the second opened by 2.0 and are dropped; 5.2 is kept
    # at its own file time because no earlier keyframe opened second 5.
    assert [sample["t"] for sample in result["samples"]] == [2, 3, 5.2]


def test_cli_runs_faces(tmp_path, monkeypatch, detector):
    import premiere_mcp_sidecar.__main__ as cli

    use_reader(monkeypatch, FakeReader())
    model = tmp_path / "yunet.onnx"
    model.write_bytes(b"onnx")
    spec_path = tmp_path / "in.json"
    spec_path.write_text(json.dumps({"mediaPath": "m.mp4", "modelPath": str(model), "ranges": [{"start": 10, "end": 12}]}), encoding="utf-8")
    out = tmp_path / "out.json"

    code = cli.main(["faces", "--input", str(spec_path), "--output", str(out)])

    assert code == 0
    assert [sample["t"] for sample in json.loads(out.read_text(encoding="utf-8"))["samples"]] == [10, 11]


# --- guide to the real-ffmpeg tests below -------------------------------------

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg is not on PATH")


def real_showinfo_lines(media, start=None, end=None):
    """The showinfo lines ffmpeg actually writes for a keyframe-only range read."""
    args = [FFMPEG, "-nostdin", "-v", "info", "-skip_frame", "nokey"]
    if start is not None:
        args += ["-ss", f"{start:.6f}"]
    if end is not None:
        args += ["-to", f"{end:.6f}"]
    args += ["-i", str(media), "-vf", "scale=640:-2,showinfo", "-fps_mode", "passthrough",
             "-f", "rawvideo", "-pix_fmt", "bgr24", "-y", "-f", "null", os.devnull]
    run = subprocess.run(args, capture_output=True)
    assert run.returncode == 0, run.stderr.decode("utf-8", "replace")[-500:]
    return run.stderr.decode("utf-8", "replace").splitlines()


@pytest.fixture(scope="module")
def gop2_video(tmp_path_factory):
    """6 s of 320x240 at 25 fps with a keyframe every 2 s (GOP 50)."""
    path = tmp_path_factory.mktemp("media") / "gop2.mp4"
    subprocess.run(
        [FFMPEG, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25",
         "-t", "6", "-c:v", "libx264", "-g", "50", "-keyint_min", "50", "-sc_threshold", "0", str(path)],
        check=True, capture_output=True,
    )
    return path


@needs_ffmpeg
def test_real_ffmpeg_showinfo_pts_restart_at_the_seek_point(gop2_video):
    """``-ss`` before ``-i`` rebases pts: the reader has to add the range start.

    This is the fact the whole timestamp fix rests on, checked against the real
    binary rather than assumed (the alternative, ``-copyts``, keeps file pts).
    """
    whole = [line for line in real_showinfo_lines(gop2_video, 0, 6) if "pts_time:" in line]
    seeked = [line for line in real_showinfo_lines(gop2_video, 2, 6) if "pts_time:" in line]

    assert [faces.parse_pts_time(line.encode()) for line in whole] == [0.0, 2.0, 4.0]
    assert [faces.parse_pts_time(line.encode()) for line in seeked] == [0.0, 2.0]


@needs_ffmpeg
def test_real_ffmpeg_samples_land_on_the_keyframes_in_file_time(gop2_video):
    """End to end over real ffmpeg: real keyframe pts, in file seconds."""
    times = [t for t, _ in faces.read_frames(str(gop2_video), 0, 6, fps=1, hwaccel=False)]
    assert times == pytest.approx([0.0, 2.0, 4.0], abs=0.05)

    seeked = [t for t, _ in faces.read_frames(str(gop2_video), 2, 6, fps=1, hwaccel=False)]
    assert seeked == pytest.approx([2.0, 4.0], abs=0.05)


@needs_ffmpeg
def test_real_ffmpeg_run_reports_file_time_samples(gop2_video, tmp_path, monkeypatch, detector):
    """``run`` over a real file: the samples a caller gets are file-time keyframe times."""
    model = tmp_path / "yunet.onnx"
    model.write_bytes(b"onnx")

    result = faces.run({
        "mediaPath": str(gop2_video),
        "modelPath": str(model),
        "ranges": [{"start": 0, "end": 6}, {"start": 2, "end": 6}],
        "hwaccel": False,
    })

    assert [sample["t"] for sample in result["samples"]] == pytest.approx([0.0, 2.0, 4.0, 2.0, 4.0], abs=0.05)


@needs_ffmpeg
def test_real_ffmpeg_sample_frames_are_decoded(gop2_video):
    """The BMPs on the pipe are real frames of the real video (640 px wide)."""
    frames = list(faces.read_frames(str(gop2_video), 0, 3, fps=1, hwaccel=False))

    assert len(frames) == 2
    assert all(frame.shape == (480, 640, 3) for _, frame in frames)


# --- the ONNX model is handed to OpenCV as bytes, not as a path ---------------


def test_model_is_loaded_from_bytes_so_a_unicode_path_works(tmp_path, monkeypatch):
    """A Vietnamese folder name must not decide whether faces work on Windows.

    ``FaceDetectorYN.create(path, ...)`` hands the path to OpenCV as an ANSI
    string; the buffer overload has no path for the OS to mis-decode. The fake
    detector asserts it was given the model's bytes.
    """
    monkeypatch.setattr(faces, "FaceDetectorYN", FakeDetector)
    model_bytes = b"\x08\x07onnx-bytes"
    folder = tmp_path / "Mô hình khuôn mặt"
    folder.mkdir()
    model = folder / "face_detection_yunet_2023mar.onnx"
    model.write_bytes(model_bytes)

    faces.run({"mediaPath": "m.mp4", "modelPath": str(model), "ranges": []})

    detector = FakeDetector.seen[0]
    assert isinstance(detector.config["buffer"], np.ndarray)
    assert detector.config["buffer"].dtype == np.uint8
    assert detector.config["buffer"].tobytes() == model_bytes
    assert detector.model_path == "onnx", "the framework name, not a path OpenCV would open"


def test_detector_opens_the_model_through_opencv_before_the_ffmpeg_pass(tmp_path, monkeypatch):
    """A model that cannot be loaded fails before any decoding work starts."""
    monkeypatch.setattr(faces, "FaceDetectorYN", FakeDetector)
    model = tmp_path / "bad.onnx"
    model.write_bytes(b"not a model")

    class Rejecting(FakeDetector):
        @classmethod
        def create(cls, *args, **kwargs):
            raise RuntimeError("Failed to parse onnx model")

    monkeypatch.setattr(faces, "FaceDetectorYN", Rejecting)
    calls = []
    monkeypatch.setattr(faces, "read_frames", lambda *a, **k: calls.append(a) or iter(()))

    with pytest.raises(RuntimeError, match="parse onnx"):
        faces.run({"mediaPath": "m.mp4", "modelPath": str(model), "ranges": [{"start": 0, "end": 2}]})
    assert calls == []
