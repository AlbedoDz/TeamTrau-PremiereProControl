"""Face counting for multi-person detection, driven by a fake detector and reader.

Frames are read by ONE ffmpeg process per input range (Ruling R17): the fake
frame reader records every command line and the tests assert there is exactly one
per range. The detector is fake too, so no ONNX model is needed.
"""
import json
from io import BytesIO

import numpy as np
import pytest

from premiere_mcp_sidecar import faces, io


class FakeDetector:
    """Returns ``count`` faces for every frame, recording what it was given."""

    count = 2
    seen = []
    frame_shapes = []

    @classmethod
    def create(cls, model_path, config, size, score_threshold, nms_threshold, top_k):
        return cls(model_path, {
            "config": config, "size": size, "score_threshold": score_threshold,
            "nms_threshold": nms_threshold, "top_k": top_k,
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

    ``frames_per_range`` is the raw keyframe stream the range would deliver; the
    fake applies the reader's own "one sample per 1/fps seconds" thinning so the
    tests see the same contract the real reader produces.
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
            times = self.frames_per_range
        else:
            times = [start + offset for offset in range(max(0, int(end) - int(start)))]
        frame = np.zeros((360, 640, 3), dtype=np.uint8)
        next_sample = float(start)
        for t in times:
            if t + 1e-6 < next_sample:
                continue
            yield t, frame
            next_sample = t + 1.0 / fps


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
    assert FakeDetector.seen[0].model_path == str(model)
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
    use_reader(monkeypatch, FakeReader(frames_per_range=[5.0, 6.0]))
    model = tmp_path / "yunet.onnx"
    model.write_bytes(b"onnx")

    result = faces.run({"mediaPath": "m.mp4", "modelPath": str(model), "ranges": [{"start": 5, "end": 7}]})

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

    # Sorted by start; a whole-second range start gives whole-second samples, and a
    # fractional one samples from its own start so `t` stays a real file time.
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
    import struct

    row = ((width * 3 + 3) // 4) * 4
    pixels = bytes([fill]) * row * height
    size = 54 + len(pixels)
    return (
        b"BM" + struct.pack("<IHHI", size, 0, 0, 54)
        + struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, len(pixels), 0, 0, 0, 0)
        + pixels
    )


class FakeProcess:
    """What ``read_frames`` needs from a Popen: a stdout pipe, stderr, exit code."""

    calls = []
    frames = 3
    fail_with = None

    def __init__(self, args, **kwargs):
        FakeProcess.calls.append(args)
        assert kwargs.get("stdout") == faces.subprocess.PIPE
        self._killed = False
        self._data = bmp_bytes() * FakeProcess.frames
        if FakeProcess.fail_with is not None:
            # A real ffmpeg delivers the frames it managed, then exits non-zero; the
            # failure only surfaces once the stream has been drained to the end.
            self.stderr = BytesIO(FakeProcess.fail_with.encode())
            self.returncode = 1
        else:
            self.stderr = BytesIO(b"")
            self.returncode = 0
        self.stdout = _Pipe(self._data)

    def poll(self):
        """Exit code once the stream is finished or the process was killed."""
        if self._killed:
            return -9
        return self.returncode if self.stdout.exhausted else None

    def kill(self):
        self._killed = True

    def wait(self, timeout=None):
        return self.poll()


class _Pipe(BytesIO):
    """stdout: ffmpeg has exited once a reader has consumed it to the end."""

    def __init__(self, data):
        super().__init__(data)
        self.exhausted = False

    def read(self, size=-1):
        data = super().read(size)
        if not data:
            self.exhausted = True
        return data


@pytest.fixture
def fake_process(monkeypatch):
    FakeProcess.calls = []
    FakeProcess.frames = 3
    FakeProcess.fail_with = None
    monkeypatch.setattr(faces.subprocess, "Popen", FakeProcess)
    return FakeProcess


def test_read_frames_one_ffmpeg_pass(fake_process):
    """The real reader: one ffmpeg process, BMP stream on a pipe, t from the frame index."""
    frames = list(faces.read_frames("C:/media/talk.mp4", 10, 20, fps=1))

    assert len(fake_process.calls) == 1
    args = fake_process.calls[0]
    assert args[0] == "ffmpeg"
    assert args[args.index("-hwaccel") + 1] == "cuda"
    assert args[args.index("-skip_frame") + 1] == "nokey"
    assert args[args.index("-ss") + 1] == "10.000000"
    assert args[args.index("-to") + 1] == "20.000000"
    assert args[args.index("-vf") + 1] == "scale=640:-2"
    assert args[args.index("-fps_mode") + 1] == "passthrough"
    assert args[args.index("-f") + 1] == "image2pipe"
    assert args[args.index("-vcodec") + 1] == "bmp"
    # t comes from the frame index at the requested rate, starting at the range start.
    assert [t for t, _ in frames] == [10.0, 11.0, 12.0]
    assert frames[0][1].shape == (2, 2, 3)


def test_read_frames_without_hwaccel(fake_process):
    assert [t for t, _ in faces.read_frames("m.mp4", 0, 5, fps=1, hwaccel=False)] == [0.0, 1.0, 2.0]
    assert "-hwaccel" not in fake_process.calls[0]


def test_read_frames_reports_ffmpeg_failure(fake_process):
    fake_process.fail_with = "Invalid data found when processing input"

    with pytest.raises(RuntimeError, match="Invalid data found"):
        list(faces.read_frames("m.mp4", 0, 5))


def test_read_frames_stops_cleanly_on_an_empty_stream(fake_process):
    fake_process.frames = 0

    assert list(faces.read_frames("m.mp4", 0, 5)) == []


def test_read_frames_reports_a_failure_after_some_frames(fake_process):
    """A failure part-way through is an error, not a short silent result."""
    fake_process.frames = 2
    fake_process.fail_with = "moov atom not found"

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
    use_reader(monkeypatch, FakeReader(frames_per_range=[float(t) for t in range(0, 40)]))
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
    use_reader(monkeypatch, FakeReader(frames_per_range=[0.0]))
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
    """Keyframes that bunch up are thinned to one sample per second of the range."""
    use_reader(monkeypatch, FakeReader(frames_per_range=[10.0, 10.4, 10.9, 11.0, 11.5, 13.2]))
    model = tmp_path / "yunet.onnx"
    model.write_bytes(b"onnx")

    result = faces.run({"mediaPath": "m.mp4", "modelPath": str(model), "ranges": [{"start": 10, "end": 14}]})

    # 10.4 and 10.9 fall inside the first second and are dropped; 13.2 is kept at
    # its own file time because no earlier keyframe opened a sample for second 13.
    assert [sample["t"] for sample in result["samples"]] == [10, 11, 13.2]


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
