"""The Zipformer engines and ROVER, driven by fakes.

No model is loaded and no audio is decoded here: the VAD, the transducer and the
PCM reader are replaced with fakes, so what is asserted is exactly what the
sidecar asked of sherpa-onnx (model files, threads, VAD options) and what it made
of the answer (words, times, ``segEnd``, ``p``). The one real thing is the
sherpa-onnx package itself, which the fakes below may not drift from -- an
attribute name that does not exist in sherpa-onnx 2.0.1 is a test that passes
while production fails.
"""
import math

import numpy as np
import pytest

from premiere_mcp_sidecar import transcribe


# --- fakes -------------------------------------------------------------------


class FakeSegment:
    """One VAD speech segment, as a time range of the decoded audio.

    sherpa's ``SpeechSegment.start`` is a **sample index**, not seconds -- reading
    it as seconds put every chunk at the start of the file. The fake keeps the
    real semantics, so a test that passes here passes on the real VAD too.
    """

    def __init__(self, start, end):
        self.samples = np.zeros(int((end - start) * 16000), dtype=np.float32)
        self.start = int(start * 16000)


class FakeVad:
    """Divides the audio into ``segments`` and remembers how it was configured."""

    configs = []
    segments = []

    def __init__(self, config, buffer_size_in_seconds=60):
        FakeVad.configs.append(config)
        self._queue = list(FakeVad.segments)
        self.popped = 0

    def accept_waveform(self, samples):
        pass

    def flush(self):
        pass

    def empty(self):
        return not self._queue

    def is_speech_detected(self):
        return bool(self._queue)

    @property
    def front(self):
        return self._queue[0]

    def pop(self):
        self.popped += 1
        return self._queue.pop(0)


class FakeResult:
    def __init__(self, tokens, timestamps, log_probs=None):
        self.tokens = list(tokens)
        self.timestamps = list(timestamps)
        self.ys_log_probs = log_probs


class FakeRecognizer:
    """Returns the results queued for it, one per stream, in order."""

    instances = []

    def __init__(self, results=None):
        self.results = list(results or [])
        self.streams = []
        FakeRecognizer.instances.append(self)

    @classmethod
    def from_transducer(cls, **options):
        instance = cls.queued()
        instance.options = options
        return instance

    queued_results: list = []

    @classmethod
    def queued(cls):
        return cls(cls.queued_results)

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


@pytest.fixture(autouse=True)
def fakes(monkeypatch):
    FakeVad.configs = []
    FakeVad.segments = []
    FakeRecognizer.instances = []
    FakeRecognizer.queued_results = []
    monkeypatch.setattr(transcribe, "_sherpa", lambda: _FakeSherpa)
    # No weights on disk: `ensure` normally checks the folder and rebuilds the 30M
    # tokens.txt. Its own tests cover that; here it only has to hand the folder back.
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    yield


class _FakeSherpa:
    """What :func:`transcribe._sherpa` hands back: only the names the code uses."""

    class SileroVadModelConfig:
        def __init__(self, **options):
            self.__dict__.update(options)

    class VadModelConfig:
        def __init__(self, **options):
            self.__dict__.update(options)

    VoiceActivityDetector = FakeVad
    OfflineRecognizer = FakeRecognizer


def spec(tmp_path, engine, **overrides):
    media = tmp_path / "talk.wav"
    media.write_bytes(b"RIFF")  # io.pcm16k is faked: the file only has to exist
    base = {
        "mediaPath": str(media),
        "engine": engine,
        "modelsDir": str(tmp_path / "models"),
        "modelDir": str(tmp_path / "models" / "faster-whisper-large-v3-turbo"),
    }
    base.update(overrides)
    return base


def fake_audio(seconds):
    return np.zeros(int(seconds * 16000), dtype=np.float32)


def words_of(result):
    return [(w["w"], w["start"], w["end"]) for w in result["words"]]


# --- the model folder each engine resolves -----------------------------------


@pytest.mark.parametrize("engine,folder", [
    ("zipformer-68m", "zipformer-vi-68m-int8"),
    ("zipformer-30m", "zipformer-vi-30m-int8"),
])
def test_each_zipformer_engine_uses_its_own_folder(tmp_path, monkeypatch, engine, folder):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(1))
    FakeVad.segments = [FakeSegment(0.0, 1.0)]
    FakeRecognizer.queued_results = [FakeResult(["▁A"], [0.0])]
    downloaded = []
    monkeypatch.setattr(
        transcribe.sherpa_models, "ensure",
        lambda models_dir, name: downloaded.append((str(models_dir), name)) or models_dir / name,
    )

    transcribe.run(spec(tmp_path, engine), None)

    assert downloaded == [(str(tmp_path / "models"), folder)]
    options = FakeRecognizer.instances[0].options
    expected = transcribe.sherpa_models.ZIPFORMER[folder]["files"]
    assert options["encoder"] == str(tmp_path / "models" / folder / expected["encoder"])
    assert options["decoder"] == str(tmp_path / "models" / folder / expected["decoder"])
    assert options["joiner"] == str(tmp_path / "models" / folder / expected["joiner"])
    assert options["tokens"] == str(tmp_path / "models" / folder / "tokens.txt")


def test_zipformer_needs_models_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(1))
    (tmp_path / "talk.wav").write_bytes(b"RIFF")

    with pytest.raises(ValueError, match="modelsDir"):
        transcribe.run({"mediaPath": str(tmp_path / "talk.wav"), "engine": "zipformer-68m"}, None)


def test_a_missing_media_file_is_reported_before_the_engine_runs(tmp_path):
    with pytest.raises(FileNotFoundError, match="mediaPath"):
        transcribe.run({"mediaPath": str(tmp_path / "gone.wav"), "engine": "zipformer-68m"}, None)


def test_an_unknown_engine_is_refused(tmp_path):
    with pytest.raises(ValueError, match="engine"):
        transcribe.run({"mediaPath": str(tmp_path / "talk.wav"), "engine": "zipformer"}, None)


def test_whisper_runs_when_named(tmp_path, monkeypatch):
    model = type("FakeWhisperModel", (), {
        "__init__": lambda self, path, **kw: None,
        "transcribe": lambda self, audio, **kw: (iter([]), type("Info", (), {"duration": 1.0})()),
    })
    monkeypatch.setattr(transcribe, "cuda_available", lambda: False)
    monkeypatch.setattr(transcribe, "_import_whisper_model", lambda: model)
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(1))
    (tmp_path / "talk.wav").write_bytes(b"RIFF")

    result = transcribe.run(
        {"mediaPath": str(tmp_path / "talk.wav"), "modelDir": str(tmp_path / "turbo"), "engine": "whisper-turbo"}, None
    )

    # Fix round 1 (B8): the whisper result is exactly what it was before the
    # Zipformers -- no ``engine`` key, so a caller that compared the whole object
    # sees no change.
    assert set(result) == {"words", "device", "computeType", "durationSec"}
    assert result["words"] == []


def test_engine_dispatch_never_touches_whisper_for_zipformer(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(1))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    monkeypatch.setattr(
        transcribe, "_import_whisper_model",
        lambda: pytest.fail("a zipformer job must not import faster-whisper"),
    )
    FakeVad.segments = [FakeSegment(0.0, 1.0)]
    FakeRecognizer.queued_results = [FakeResult(["▁A"], [0.0])]

    result = transcribe.run(spec(tmp_path, "zipformer-68m"), None)

    assert result["engine"] == "zipformer-68m"


# --- what the transducer is asked for, and what it returns --------------------


def test_the_transducer_is_built_for_the_cpu_with_capped_threads(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(1))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    monkeypatch.setattr(transcribe.os, "cpu_count", lambda: 16)
    FakeVad.segments = [FakeSegment(0.0, 1.0)]
    FakeRecognizer.queued_results = [FakeResult(["▁A"], [0.0])]

    transcribe.run(spec(tmp_path, "zipformer-68m"), None)

    options = FakeRecognizer.instances[0].options
    assert options["num_threads"] == 4
    assert options["decoding_method"] == "modified_beam_search"
    assert set(options) >= {"encoder", "decoder", "joiner", "tokens"}


def test_a_small_machine_uses_all_its_cores(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(1))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    monkeypatch.setattr(transcribe.os, "cpu_count", lambda: 2)
    FakeVad.segments = [FakeSegment(0.0, 1.0)]
    FakeRecognizer.queued_results = [FakeResult(["▁A"], [0.0])]

    transcribe.run(spec(tmp_path, "zipformer-30m"), None)

    assert FakeRecognizer.instances[0].options["num_threads"] == 2


def test_the_vad_asks_for_half_a_second_of_silence_and_twenty_second_chunks(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(1))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    FakeVad.segments = [FakeSegment(0.0, 1.0)]
    FakeRecognizer.queued_results = [FakeResult(["▁A"], [0.0])]

    transcribe.run(spec(tmp_path, "zipformer-68m"), None)

    vad = FakeVad.configs[0]
    assert vad.silero_vad.min_silence_duration == pytest.approx(0.5)
    assert vad.silero_vad.max_speech_duration == pytest.approx(20.0)
    assert vad.silero_vad.model == str(tmp_path / "models" / "silero_vad.onnx")
    assert vad.sample_rate == 16000


def test_tokens_become_words_at_the_boundary_marker(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(2))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    FakeVad.segments = [FakeSegment(0.0, 2.0)]
    FakeRecognizer.queued_results = [
        FakeResult(["▁XIN", "▁CHÀO", "▁BẠN"], [0.0, 0.4, 0.9]),
    ]

    result = transcribe.run(spec(tmp_path, "zipformer-68m"), None)

    assert [word["w"] for word in result["words"]] == ["xin", "chào", "bạn"]


def test_subword_pieces_are_joined_into_one_word(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(2))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    FakeVad.segments = [FakeSegment(0.0, 2.0)]
    FakeRecognizer.queued_results = [
        FakeResult(["▁VIỆT", "CETERA", "▁TALK"], [0.0, 0.3, 1.0]),
    ]

    result = transcribe.run(spec(tmp_path, "zipformer-68m"), None)

    assert [word["w"] for word in result["words"]] == ["việtcetera", "talk"]


def test_a_word_may_begin_with_a_plain_space_instead_of_the_marker(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(2))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    FakeVad.segments = [FakeSegment(0.0, 2.0)]
    FakeRecognizer.queued_results = [FakeResult([" XIN", " CHÀO"], [0.0, 0.5])]

    result = transcribe.run(spec(tmp_path, "zipformer-68m"), None)

    assert [word["w"] for word in result["words"]] == ["xin", "chào"]


def test_a_word_belongs_to_the_boundary_it_was_seen_at(tmp_path, monkeypatch):
    """Pieces that continue a word must not start a new one, however they look."""
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(2))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    FakeVad.segments = [FakeSegment(0.0, 2.0)]
    FakeRecognizer.queued_results = [
        FakeResult(["▁A", "B", "▁C"], [0.0, 0.1, 0.5]),
    ]

    transcribe.run(spec(tmp_path, "zipformer-68m"), None)

    stream = FakeRecognizer.instances[0].streams[0]
    assert stream.audio[0] == 16000


def test_the_chunk_offset_moves_every_token_time(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(10))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    FakeVad.segments = [FakeSegment(4.0, 7.0)]
    FakeRecognizer.queued_results = [FakeResult(["▁HAI", "▁BA"], [0.0, 1.0])]

    result = transcribe.run(spec(tmp_path, "zipformer-68m"), None)

    assert words_of(result)[0][1] == pytest.approx(4.0)
    assert words_of(result)[1][1] == pytest.approx(5.0)


def test_a_word_ends_where_the_next_word_starts(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(10))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    FakeVad.segments = [FakeSegment(0.0, 5.0)]
    FakeRecognizer.queued_results = [FakeResult(["▁MỘT", "▁HAI", "▁BA"], [0.0, 1.5, 3.0])]

    result = transcribe.run(spec(tmp_path, "zipformer-68m"), None)

    assert words_of(result) == [("một", 0.0, 1.5), ("hai", 1.5, 3.0), ("ba", 3.0, 5.0)]


def test_a_word_never_ends_before_it_starts_plus_forty_milliseconds(tmp_path, monkeypatch):
    """Two words can share a token boundary: the caption needs a visible duration."""
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(5))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    FakeVad.segments = [FakeSegment(0.0, 5.0)]
    FakeRecognizer.queued_results = [FakeResult(["▁MỘT", "▁HAI", "▁BA"], [1.0, 1.0, 1.0])]

    result = transcribe.run(spec(tmp_path, "zipformer-68m"), None)

    for word in result["words"]:
        assert word["end"] >= word["start"] + transcribe.MIN_WORD_SEC - 1e-9


def test_the_last_word_of_each_vad_chunk_ends_the_segment(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(12))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    FakeVad.segments = [FakeSegment(0.0, 3.0), FakeSegment(5.0, 8.0)]
    FakeRecognizer.queued_results = [
        FakeResult(["▁MỘT", "▁HAI"], [0.0, 1.0]),
        FakeResult(["▁BA"], [0.0]),
    ]

    result = transcribe.run(spec(tmp_path, "zipformer-68m"), None)

    assert [word.get("segEnd") for word in result["words"]] == [None, True, True]


def test_an_empty_chunk_marks_no_word(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(8))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    FakeVad.segments = [FakeSegment(0.0, 2.0), FakeSegment(4.0, 6.0)]
    FakeRecognizer.queued_results = [FakeResult(["▁MỘT"], [0.0]), FakeResult([], [])]

    result = transcribe.run(spec(tmp_path, "zipformer-68m"), None)

    assert [word["w"] for word in result["words"]] == ["một"]
    assert result["words"][-1]["segEnd"] is True


def test_words_are_lowercased_nfc(tmp_path, monkeypatch):
    """The model emits uppercase; casing comes back in TypeScript, so it is folded here."""
    import unicodedata

    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(3))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    FakeVad.segments = [FakeSegment(0.0, 3.0)]
    decomposed = "VIE\u0302\u0323T"  # "VIỆT" as separate marks, not a precomposed Ệ
    FakeRecognizer.queued_results = [FakeResult(["▁" + decomposed, "▁ĐẸP"], [0.0, 1.0])]

    result = transcribe.run(spec(tmp_path, "zipformer-68m"), None)

    assert result["words"][0]["w"] == "việt"
    assert unicodedata.is_normalized("NFC", result["words"][0]["w"])


def test_probability_is_certain_without_log_probs(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(3))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    FakeVad.segments = [FakeSegment(0.0, 3.0)]
    FakeRecognizer.queued_results = [FakeResult(["▁MỘT"], [0.0])]

    result = transcribe.run(spec(tmp_path, "zipformer-68m"), None)

    assert result["words"][0]["p"] == 1.0


def test_probability_from_log_probs_when_sherpa_exposes_them(tmp_path, monkeypatch):
    """sherpa-onnx 2.0.1 reports no per-token log-probs, so ``p`` stays 1.0.

    If a later build starts filling ``ys_log_probs`` the word gets the mean
    probability of the tokens it was built from, here a subword pair.
    """
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(3))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    FakeVad.segments = [FakeSegment(0.0, 3.0)]
    FakeRecognizer.queued_results = [
        FakeResult(["▁VIỆT", "CETERA", "▁OK"], [0.0, 0.3, 2.0],
                   log_probs=[np.log(0.6), np.log(0.1), np.log(0.9)]),
    ]

    result = transcribe.run(spec(tmp_path, "zipformer-68m"), None)

    # Geometric mean of the two pieces: sqrt(0.6 * 0.1), not their arithmetic mean.
    assert result["words"][0]["p"] == pytest.approx(math.sqrt(0.06), abs=1e-3)
    assert result["words"][1]["p"] == pytest.approx(0.9, abs=1e-3)


def test_the_result_reports_the_engine_on_the_cpu(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(3))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    FakeVad.segments = [FakeSegment(0.0, 3.0)]
    FakeRecognizer.queued_results = [FakeResult(["▁MỘT"], [0.0])]

    result = transcribe.run(spec(tmp_path, "zipformer-68m"), None)

    assert result["device"] == "cpu"
    assert result["computeType"] == "int8"
    assert result["engine"] == "zipformer-68m"
    assert result["durationSec"] == pytest.approx(3.0)


def test_progress_is_written_while_the_chunks_decode(tmp_path, monkeypatch):
    writes = []
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(10))
    monkeypatch.setattr(transcribe.sherpa_models, "ensure", lambda models_dir, name: models_dir / name)
    monkeypatch.setattr(
        transcribe.io, "write_progress",
        lambda path, done, eta_sec=None: writes.append(done),
    )
    FakeVad.segments = [FakeSegment(0.0, 2.0), FakeSegment(4.0, 6.0)]
    FakeRecognizer.queued_results = [FakeResult(["▁A"], [0.0]), FakeResult(["▁B"], [0.0])]

    transcribe.run(spec(tmp_path, "zipformer-68m"), tmp_path / "progress.json")

    assert writes[-1] == 1.0
    assert writes == sorted(writes)
    assert any(0.0 < value < 1.0 for value in writes), writes


# --- ROVER -------------------------------------------------------------------


def rover_spec(tmp_path):
    return spec(tmp_path, "rover")


def build_from_folder(monkeypatch, results):
    """``from_transducer`` answers with the results of the folder the model is in."""
    built = []

    def build(cls, **options):
        name = "30m" if "zipformer-vi-30m-int8" in options["encoder"] else "68m"
        built.append(name)
        return FakeRecognizer([FakeResult(r.tokens, r.timestamps, r.ys_log_probs) for r in results[name]])

    monkeypatch.setattr(FakeRecognizer, "from_transducer", classmethod(build))
    return built


def test_rover_runs_both_zipformers_on_the_same_chunks(tmp_path, monkeypatch):
    results = {
        "30m": [FakeResult(["▁MỘT", "▁HAI"], [0.0, 1.0])],
        "68m": [FakeResult(["▁MỘT", "▁HAI"], [0.0, 1.0])],
    }
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(5))
    FakeVad.segments = [FakeSegment(0.0, 3.0)]
    results = {
        "30m": [FakeResult(["▁MỘT", "▁HAI"], [0.0, 1.0])],
        "68m": [FakeResult(["▁MỘT", "▁HAI"], [0.0, 1.0])],
    }
    built = build_from_folder(monkeypatch, results)

    result = transcribe.run(rover_spec(tmp_path), None)

    assert sorted(built) == ["30m", "68m"]
    assert result["engine"] == "rover"
    assert result["device"] == "cpu" and result["computeType"] == "int8"


def test_rover_keeps_the_68m_words_where_both_agree(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(5))
    FakeVad.segments = [FakeSegment(0.0, 3.0)]
    results = {
        # Same text, different times: the 68M side's word objects are the ones kept.
        "30m": [FakeResult(["▁MỘT", "▁HAI"], [0.1, 1.1])],
        "68m": [FakeResult(["▁MỘT", "▁HAI"], [0.0, 1.0])],
    }
    build_from_folder(monkeypatch, results)

    result = transcribe.run(rover_spec(tmp_path), None)

    assert words_of(result) == [("một", 0.0, 1.0), ("hai", 1.0, 3.0)]


def test_rover_takes_the_differing_span_from_the_side_with_the_higher_p(tmp_path, monkeypatch):
    """Both heard the same three words, differently: the more confident side wins.

    30M hears "tiệc" for the middle word, 68M hears "tiếp" -- a real disagreement,
    so ``difflib`` marks a replace span and the mean p decides it, not the text.
    """
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(6))
    FakeVad.segments = [FakeSegment(0.0, 4.0)]
    results = {
        "30m": [FakeResult(
            ["▁ĐI", "▁TIỆC", "▁NÀO"], [0.0, 1.0, 2.0],
            log_probs=[np.log(0.95), np.log(0.4), np.log(0.95)],
        )],
        "68m": [FakeResult(
            ["▁ĐI", "▁TIẾP", "▁NÀO"], [0.0, 1.0, 2.0],
            log_probs=[np.log(0.95), np.log(0.95), np.log(0.95)],
        )],
    }
    build_from_folder(monkeypatch, results)

    result = transcribe.run(rover_spec(tmp_path), None)

    assert [w["w"] for w in result["words"]] == ["đi", "tiếp", "nào"]


def test_rover_keeps_the_30m_when_the_68m_span_is_less_confident(tmp_path, monkeypatch):
    """The same replace span, the other way round: a lower mean p loses."""
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(6))
    FakeVad.segments = [FakeSegment(0.0, 4.0)]
    results = {
        "30m": [FakeResult(
            ["▁ĐI", "▁TIỆC", "▁NÀO"], [0.0, 1.0, 2.0],
            log_probs=[np.log(0.95), np.log(0.95), np.log(0.95)],
        )],
        "68m": [FakeResult(
            ["▁ĐI", "▁TIẾP", "▁NÀO"], [0.0, 1.0, 2.0],
            log_probs=[np.log(0.95), np.log(0.3), np.log(0.95)],
        )],
    }
    build_from_folder(monkeypatch, results)

    result = transcribe.run(rover_spec(tmp_path), None)

    assert [w["w"] for w in result["words"]] == ["đi", "tiệc", "nào"]


def test_rover_drops_a_word_only_the_68m_heard(tmp_path, monkeypatch):
    """Ruling R35 (fix round 1): a differing span takes the 30M side, empty or not.

    Before R35 an insert was added so the word was not lost; with no per-token
    probability on either side there is nothing to weigh, and the 30M's silence is
    its verdict. The insert and delete cases are covered in test_engines_fix1.py.
    """
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(6))
    FakeVad.segments = [FakeSegment(0.0, 4.0)]
    results = {
        "30m": [FakeResult(["▁ĐI", "▁XA"], [0.0, 1.0])],
        "68m": [FakeResult(["▁ĐI", "▁XA", "▁HỘI"], [0.0, 1.0, 1.6])],
    }
    build_from_folder(monkeypatch, results)

    result = transcribe.run(rover_spec(tmp_path), None)

    assert [w["w"] for w in result["words"]] == ["đi", "xa"]


def test_rover_prefers_the_30m_on_a_tie(tmp_path, monkeypatch):
    """Equal mean p: 30M has the better published WER, so its span is kept."""
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(6))
    FakeVad.segments = [FakeSegment(0.0, 4.0)]
    results = {
        "30m": [FakeResult(["▁MỘT", "▁HAI"], [0.0, 1.0])],
        "68m": [FakeResult(["▁MỘT", "▁BỐN"], [0.0, 1.0])],
    }
    build_from_folder(monkeypatch, results)

    result = transcribe.run(rover_spec(tmp_path), None)

    assert [w["w"] for w in result["words"]] == ["một", "hai"]


def test_rover_marks_the_end_of_every_chunk(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.io, "pcm16k", lambda path: fake_audio(12))
    FakeVad.segments = [FakeSegment(0.0, 3.0), FakeSegment(5.0, 8.0)]
    results = {
        "30m": [FakeResult(["▁A", "▁B"], [0.0, 1.0]), FakeResult(["▁C"], [0.0])],
        "68m": [FakeResult(["▁A", "▁B"], [0.0, 1.0]), FakeResult(["▁C"], [0.0])],
    }
    build_from_folder(monkeypatch, results)

    result = transcribe.run(rover_spec(tmp_path), None)

    assert [w.get("segEnd") for w in result["words"]] == [None, True, True]


def test_rover_align_rule_is_documented():
    """The rule is a docstring, because it is a judgement call nobody can re-derive."""
    doc = transcribe._rover_words.__doc__ or ""
    assert "difflib" in doc
    assert "68" in doc and "30" in doc


# --- the real sherpa-onnx, so the fakes above cannot drift --------------------


def test_the_options_are_accepted_by_the_real_constructor(tmp_path):
    """A bogus keyword would pass every fake here and fail the first real job."""
    import sherpa_onnx

    missing = tmp_path / "missing"
    missing.mkdir()

    with pytest.raises(Exception) as caught:
        transcribe._build_recognizer(
            {
                "encoder": str(missing / "encoder.onnx"),
                "decoder": str(missing / "decoder.onnx"),
                "joiner": str(missing / "joiner.onnx"),
                "tokens": str(missing / "tokens.txt"),
            },
            sherpa_onnx,
        )

    assert not isinstance(caught.value, TypeError), caught.value


def test_the_vad_config_is_accepted_by_the_real_class(tmp_path):
    import sherpa_onnx

    config = transcribe._vad_config(sherpa_onnx, tmp_path / "silero_vad.onnx")

    assert config.sample_rate == 16000
    assert config.silero_vad.min_silence_duration == pytest.approx(0.5)
    assert config.silero_vad.max_speech_duration == pytest.approx(20.0)


def test_module_import_does_not_load_sherpa():
    import subprocess
    import sys
    from pathlib import Path

    package_root = str(Path(__file__).resolve().parents[1])
    completed = subprocess.run(
        [sys.executable, "-c",
         "import sys, premiere_mcp_sidecar.transcribe;"
         "print('sherpa_onnx' in sys.modules)"],
        capture_output=True, text=True, cwd=package_root,
        env={"PYTHONPATH": package_root, "PATH": "", "SYSTEMROOT": "C:\\Windows"},
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == "False"
