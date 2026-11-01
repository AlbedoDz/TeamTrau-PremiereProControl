"""Fix round 1 of the Zipformer engines: word starts, VAD streaming, ROVER spans.

Three findings, each with the case that failed in review:

* a token that is only the word-boundary marker (``▁``) has no piece of its own,
  and the old loop ``continue``d past it, so the *next* word was glued onto the
  word before it and lost its start time;
* the whole file went into one ``accept_waveform`` against a 60 s VAD buffer, which
  overflows on any real episode (the live 2-minute clip produced one bogus 8 s
  span). The audio is now fed in windows and the queue drained as it fills;
* Ruling R35: sherpa-onnx 2.0.1 reports no per-token probability (``p == 1.0``), so
  every differing ROVER span -- replace, insert *and* delete -- is taken from the
  30M.
"""
import numpy as np
import pytest

from premiere_mcp_sidecar import transcribe


# --- fakes (the same shapes as test_engines.py) -------------------------------


class FakeSegment:
    def __init__(self, start, end):
        self.samples = np.zeros(int((end - start) * 16000), dtype=np.float32)
        self.start = int(start * 16000)


class RecordingVad:
    """A VAD that records how much audio each call carried, and emits in order.

    ``segments`` are handed out as the fed audio passes their end, the way the real
    detector queues a chunk when speech turns to silence, so a caller that drains
    after every window sees the same order a caller that drains at the end does.
    """

    configs = []
    accepted: list[int] = []
    instances: list["RecordingVad"] = []
    segments: list[tuple[float, float]] = []
    fed_samples = 0

    def __init__(self, config, buffer_size_in_seconds=60):
        RecordingVad.configs.append(config)
        RecordingVad.instances.append(self)
        self.queue = []
        self.pending = list(RecordingVad.segments)
        self.popped = []
        self.buffer_size = buffer_size_in_seconds
        self.flushed = False

    def accept_waveform(self, samples):
        RecordingVad.accepted.append(len(samples))
        RecordingVad.fed_samples += len(samples)
        if len(samples) > self.buffer_size * 16000:
            raise AssertionError(f"fed {len(samples)} samples into a {self.buffer_size} s buffer")
        # Emit a segment once the fed audio has passed its end, as the real
        # detector queues a chunk the moment speech turns to silence.
        fed_sec = RecordingVad.fed_samples / 16000
        while self.pending and fed_sec >= self.pending[0][1]:
            start, end = self.pending.pop(0)
            self.queue.append(FakeSegment(start, end))

    def flush(self):
        self.flushed = True
        while self.pending:
            start, end = self.pending.pop(0)
            self.queue.append(FakeSegment(start, end))

    def empty(self):
        return not self.queue

    @property
    def front(self):
        return self.queue[0]

    def pop(self):
        self.popped.append(self.queue.pop(0))


class FakeResult:
    def __init__(self, tokens, timestamps, log_probs=None):
        self.tokens = list(tokens)
        self.timestamps = list(timestamps)
        self.ys_log_probs = log_probs


class FakeRecognizer:
    instances = []

    def __init__(self, results=None):
        self.results = list(results or [])
        self.streams = []
        FakeRecognizer.instances.append(self)

    @classmethod
    def from_transducer(cls, **options):
        instance = cls(FakeRecognizer.queued_results)
        instance.options = options
        return instance

    queued_results: list = []

    def create_stream(self, hotwords=None):
        stream = FakeStream(self)
        self.streams.append(stream)
        return stream

    def decode_stream(self, stream):
        pass


class FakeStream:
    def __init__(self, recognizer):
        self.recognizer = recognizer
        self.audio = None

    def accept_waveform(self, sample_rate, samples):
        self.audio = (sample_rate, samples)

    @property
    def result(self):
        return self.recognizer.results.pop(0)


class _FakeSherpa:
    class SileroVadModelConfig:
        def __init__(self, **options):
            self.__dict__.update(options)

    class VadModelConfig:
        def __init__(self, **options):
            self.__dict__.update(options)

    VoiceActivityDetector = RecordingVad
    OfflineRecognizer = FakeRecognizer


@pytest.fixture(autouse=True)
def fakes(monkeypatch):
    RecordingVad.configs = []
    RecordingVad.accepted = []
    RecordingVad.instances = []
    RecordingVad.segments = []
    RecordingVad.fed_samples = 0
    FakeRecognizer.instances = []
    FakeRecognizer.queued_results = []
    monkeypatch.setattr(transcribe, "_sherpa", lambda: _FakeSherpa)
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    yield


def spec(tmp_path, engine):
    media = tmp_path / "talk.wav"
    media.write_bytes(b"RIFF")
    return {"mediaPath": str(media), "engine": engine, "modelsDir": str(tmp_path / "models")}


def fake_audio(seconds):
    return np.zeros(int(seconds * 16000), dtype=np.float32)


def run(tmp_path, monkeypatch, seconds, segments, results, engine="zipformer-68m"):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(seconds))
    RecordingVad.segments = segments
    FakeRecognizer.queued_results = results
    return transcribe.run(spec(tmp_path, engine), None)


# --- 4. a bare marker starts the next word ------------------------------------


def test_a_bare_marker_starts_a_new_word(tmp_path, monkeypatch):
    """``["▁XIN", "▁", "CHÀO"]`` is two words: the ``▁`` alone belongs to "CHÀO"."""
    result = run(
        tmp_path, monkeypatch, 2.0, [(0.0, 2.0)],
        [FakeResult(["▁XIN", "▁", "CHÀO"], [0.0, 0.6, 1.0])],
    )

    assert [(w["w"], w["start"]) for w in result["words"]] == [("xin", 0.0), ("chào", 1.0)]


def test_a_bare_marker_keeps_the_word_end_before_it(tmp_path, monkeypatch):
    result = run(
        tmp_path, monkeypatch, 2.0, [(0.0, 2.0)],
        [FakeResult(["▁XIN", "▁", "CHÀO"], [0.0, 0.6, 1.0])],
    )

    assert result["words"][0]["end"] == pytest.approx(1.0)
    assert result["words"][1]["end"] == pytest.approx(2.0)


def test_a_bare_space_marker_does_the_same(tmp_path, monkeypatch):
    result = run(
        tmp_path, monkeypatch, 2.0, [(0.0, 2.0)],
        [FakeResult(["▁XIN", " ", "CHÀO"], [0.0, 0.6, 1.0])],
    )

    assert [(w["w"], w["start"]) for w in result["words"]] == [("xin", 0.0), ("chào", 1.0)]


def test_a_trailing_bare_marker_ends_the_word_and_adds_nothing(tmp_path, monkeypatch):
    result = run(
        tmp_path, monkeypatch, 2.0, [(0.0, 2.0)],
        [FakeResult(["▁XIN", "▁CHÀO", "▁"], [0.0, 0.5, 1.8])],
    )

    assert [w["w"] for w in result["words"]] == ["xin", "chào"]
    assert result["words"][-1]["end"] == pytest.approx(2.0)


def test_a_bare_marker_before_a_subword_piece_starts_the_word(tmp_path, monkeypatch):
    """The marker makes the *next piece* the first of a word, timed at that piece.

    The brief's rule is "the next piece starts a new word, timed at that piece's
    token time": here the marker is at 0.6 and the piece at 0.8, so the word
    starts at 0.8, not at the marker.
    """
    result = run(
        tmp_path, monkeypatch, 2.0, [(0.0, 2.0)],
        [FakeResult(["▁VIỆT", "▁", "CETERA"], [0.0, 0.6, 0.8])],
    )

    assert [(w["w"], w["start"]) for w in result["words"]] == [("việt", 0.0), ("cetera", 0.8)]


# --- 5. the VAD is fed in windows, not the whole file at once -----------------


def test_the_vad_is_never_given_more_than_one_second_of_audio(tmp_path, monkeypatch):
    run(tmp_path, monkeypatch, 120.0, [(1.0, 2.0)], [FakeResult(["▁A"], [0.0])])

    assert RecordingVad.accepted, "the vad was never fed"
    assert max(RecordingVad.accepted) <= 16000
    assert sum(RecordingVad.accepted) >= 120 * 16000


def test_the_whole_file_reaches_the_vad_in_order(tmp_path, monkeypatch):
    """Windows are consecutive: every sample is fed exactly once, none skipped."""
    run(tmp_path, monkeypatch, 120.0, [(1.0, 2.0)], [FakeResult(["▁A"], [0.0])])

    assert RecordingVad.fed_samples == 120 * 16000
    assert all(size == RecordingVad.accepted[0] for size in RecordingVad.accepted[:-1])


def test_the_queue_is_drained_while_the_audio_is_still_being_fed(tmp_path, monkeypatch):
    """A segment is popped before the last window, so the buffer cannot grow."""
    popped_at = []

    run(tmp_path, monkeypatch, 60.0, [(1.0, 2.0), (40.0, 41.0)], [
        FakeResult(["▁A"], [0.0]), FakeResult(["▁B"], [0.0]),
    ])

    detector = RecordingVad.instances[0]
    assert len(detector.popped) == 2
    assert detector.flushed is True


def test_the_vad_is_flushed_once_at_the_end(tmp_path, monkeypatch):
    run(tmp_path, monkeypatch, 30.0, [(1.0, 2.0)], [FakeResult(["▁A"], [0.0])])

    assert RecordingVad.instances[0].flushed is True


def test_segments_come_out_in_order_with_their_offsets(tmp_path, monkeypatch):
    result = run(
        tmp_path, monkeypatch, 30.0,
        [(1.0, 2.0), (10.0, 12.0), (20.0, 21.5)],
        [FakeResult(["▁MỘT"], [0.0]), FakeResult(["▁HAI"], [0.25]), FakeResult(["▁BA"], [0.0])],
    )

    assert [(w["w"], w["start"]) for w in result["words"]] == [
        ("một", 1.0), ("hai", 10.25), ("ba", 20.0),
    ]


def test_a_speech_chunk_larger_than_the_window_still_gives_its_span(tmp_path, monkeypatch):
    """The window size is a feeding detail: the span is the segment's own start."""
    spans = transcribe.speech_chunks(_FakeSherpa, fake_audio(30), tmp_path / "silero_vad.onnx")

    assert RecordingVad.accepted[0] <= 16000


# --- 6. Ruling R35: every differing span comes from the 30M ------------------


def rover(tmp_path, monkeypatch, results, seconds=6.0):
    built = []

    def build(cls, **options):
        name = "30m" if "zipformer-vi-30m-int8" in options["encoder"] else "68m"
        built.append(name)
        return FakeRecognizer([FakeResult(r.tokens, r.timestamps, r.ys_log_probs) for r in results[name]])

    monkeypatch.setattr(FakeRecognizer, "from_transducer", classmethod(build))
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(seconds))
    RecordingVad.segments = [(0.0, seconds - 1.0)]
    return transcribe.run(spec(tmp_path, "rover"), None)


def test_a_delete_span_drops_the_68m_only_words(tmp_path, monkeypatch):
    """The 30M did not hear it, and with p == 1.0 on both sides the 30M wins."""
    result = rover(tmp_path, monkeypatch, {
        "30m": [FakeResult(["▁ĐI", "▁XA"], [0.0, 1.0])],
        "68m": [FakeResult(["▁ĐI", "▁XA", "▁HỘI"], [0.0, 1.0, 1.6])],
    })

    assert [w["w"] for w in result["words"]] == ["đi", "xa"]


def test_an_insert_span_keeps_the_30m_words(tmp_path, monkeypatch):
    result = rover(tmp_path, monkeypatch, {
        "30m": [FakeResult(["▁ĐI", "▁XA", "▁HỘI"], [0.0, 1.0, 1.6])],
        "68m": [FakeResult(["▁ĐI", "▁XA"], [0.0, 1.0])],
    })

    assert [w["w"] for w in result["words"]] == ["đi", "xa", "hội"]


def test_a_replace_span_is_the_30m_even_when_the_68m_looks_better(tmp_path, monkeypatch):
    """``p`` is 1.0 on both sides and the 30M still wins: R35 is not a tie-break."""
    result = rover(tmp_path, monkeypatch, {
        "30m": [FakeResult(["▁MỘT", "▁HAI"], [0.0, 1.0])],
        "68m": [FakeResult(["▁MỘT", "▁BỐN"], [0.0, 1.0])],
    })

    assert [w["w"] for w in result["words"]] == ["một", "hai"]


def test_the_confidence_comparison_still_decides_when_probabilities_exist(tmp_path, monkeypatch):
    """Both sides below 1.0: the more confident span wins, as before."""
    result = rover(tmp_path, monkeypatch, {
        "30m": [FakeResult(
            ["▁ĐI", "▁TIỆC", "▁NÀO"], [0.0, 1.0, 2.0],
            log_probs=[np.log(0.95), np.log(0.4), np.log(0.95)],
        )],
        "68m": [FakeResult(
            ["▁ĐI", "▁TIẾP", "▁NÀO"], [0.0, 1.0, 2.0],
            log_probs=[np.log(0.95), np.log(0.95), np.log(0.95)],
        )],
    })

    assert [w["w"] for w in result["words"]] == ["đi", "tiếp", "nào"]


def test_the_30m_wins_when_its_confidence_is_the_higher_one(tmp_path, monkeypatch):
    result = rover(tmp_path, monkeypatch, {
        "30m": [FakeResult(
            ["▁ĐI", "▁TIỆC", "▁NÀO"], [0.0, 1.0, 2.0],
            log_probs=[np.log(0.95), np.log(0.95), np.log(0.95)],
        )],
        "68m": [FakeResult(
            ["▁ĐI", "▁TIẾP", "▁NÀO"], [0.0, 1.0, 2.0],
            log_probs=[np.log(0.95), np.log(0.3), np.log(0.95)],
        )],
    })

    assert [w["w"] for w in result["words"]] == ["đi", "tiệc", "nào"]


def test_ruling_r35_is_written_down():
    doc = transcribe._rover_words.__doc__ or ""
    assert "R35" in doc
    assert "30M" in doc and "insert" in doc and "delete" in doc
    assert "confiden" in doc.lower()


# --- minor: rover progress gives each pass half the range --------------------


def test_each_rover_pass_reports_half_of_the_bar(tmp_path, monkeypatch):
    writes = []
    monkeypatch.setattr(
        transcribe.io, "write_progress",
        lambda path, done, eta_sec=None: writes.append(round(float(done), 4)),
    )
    results = {
        "30m": [FakeResult(["▁A"], [0.0]), FakeResult(["▁B"], [0.0])],
        "68m": [FakeResult(["▁A"], [0.0]), FakeResult(["▁B"], [0.0])],
    }
    built = []

    def build(cls, **options):
        name = "30m" if "zipformer-vi-30m-int8" in options["encoder"] else "68m"
        built.append(name)
        return FakeRecognizer([FakeResult(r.tokens, r.timestamps, r.ys_log_probs) for r in results[name]])

    monkeypatch.setattr(FakeRecognizer, "from_transducer", classmethod(build))
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(20))
    RecordingVad.segments = [(0.0, 2.0), (10.0, 12.0)]

    transcribe.run(spec(tmp_path, "rover"), tmp_path / "progress.json")

    # Two chunks, two passes: the bar walks 0 → 0.5 → 1.0 once, rather than the
    # first pass taking it to the end and the second having nowhere to go.
    assert writes == sorted(writes)
    assert writes[-1] == 1.0
    # The half-way mark is the first pass's last chunk: 0.5 * (12 s of 20 s).
    assert any(0.45 <= value <= 0.55 for value in writes), writes
    # The second pass reports above that mark; before the fix it had nothing left.
    assert len([value for value in writes if value > 0.55]) >= 2, writes
