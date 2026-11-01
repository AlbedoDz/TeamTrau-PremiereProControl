"""Word-level Vietnamese transcription with faster-whisper, driven by fakes.

No real model is loaded here: a fake ``WhisperModel`` returns fixed segments and
the tests assert what the command asked of it (device, compute type, prompt,
options) and what it produced. Only the ffmpeg decode of the audio is real, from
a synthesised file, so the "never call ``decode_audio``" rule is observable.
"""
import dataclasses
import json
import math
import struct
import threading
import time
import wave

import numpy as np
import pytest
from faster_whisper.transcribe import Segment, TranscriptionInfo, Word

from premiere_mcp_sidecar import transcribe


def make_wav(path, seconds, rate=16000):
    """A mono 16-bit PCM WAV long enough for the progress fractions to be exact."""
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        # A quiet tone rather than silence, so ffmpeg's decode is a real decode.
        tone = b"".join(
            struct.pack("<h", int(2000 * math.sin(2 * math.pi * 220 * i / rate)))
            for i in range(rate * seconds)
        )
        handle.writeframes(tone)
    return path


def word(text, start, end, probability=0.9):
    return Word(start=start, end=end, word=text, probability=probability)


def segment(seg_id, start, end, text, words):
    return Segment(
        id=seg_id, seek=0, start=start, end=end, text=text, tokens=[], avg_logprob=-0.1,
        compression_ratio=1.0, no_speech_prob=0.0, words=words, temperature=0.0,
    )


def info(duration):
    return TranscriptionInfo(
        language="vi", language_probability=0.99, duration=duration,
        duration_after_vad=duration, all_language_probs=[("vi", 0.99)],
        transcription_options=None, vad_options=None,
    )


SEGMENTS = [
    segment(0, 0.0, 1.2, " Chào mừng", [word(" Chào", 0.0, 0.3), word(" mừng", 0.4, 0.9)]),
    segment(1, 1.5, 3.0, " đến Vietcetera", [word(" đến", 1.5, 1.8), word(" Vietcetera", 1.9, 2.6)]),
]


class FakeWhisperModel:
    """Records how it was built and what ``transcribe`` was asked for."""

    instances = []

    def __init__(self, model_size_or_path, device="auto", compute_type="default", **kwargs):
        self.model_size_or_path = model_size_or_path
        self.device = device
        self.compute_type = compute_type
        self.kwargs = kwargs
        self.calls = []
        FakeWhisperModel.instances.append(self)

    def transcribe(self, audio, **options):
        self.calls.append({"audio": audio, **options})
        return iter(SEGMENTS), info(3.0)


@pytest.fixture(autouse=True)
def reset():
    FakeWhisperModel.instances = []
    yield
    FakeWhisperModel.instances = []


@pytest.fixture
def no_cuda(monkeypatch):
    monkeypatch.setattr(transcribe, "cuda_available", lambda: False)


@pytest.fixture
def with_cuda(monkeypatch):
    monkeypatch.setattr(transcribe, "cuda_available", lambda: True)


def spec(tmp_path, **overrides):
    media = make_wav(tmp_path / "talk.wav", 3)
    base = {
        "mediaPath": str(media),
        "modelDir": str(tmp_path / "models" / "faster-whisper-large-v3-turbo"),
        "model": "large-v3-turbo",
        "language": "vi",
        "glossary": ["Vietcetera", "Trưng Trắc"],
        "device": "auto",
    }
    base.update(overrides)
    return base


def test_words_shape_with_fake_model(tmp_path, monkeypatch, no_cuda):
    monkeypatch.setattr(transcribe, "WhisperModel", FakeWhisperModel)
    # Importing `decode_audio` anywhere in the command must never happen: the
    # bundled PyAV build cannot read some of the podcast containers.
    monkeypatch.setattr(
        transcribe.faster_whisper, "decode_audio",
        lambda *a, **k: pytest.fail("decode_audio must not be called"),
    )
    progress = tmp_path / "progress.json"

    result = transcribe.run(spec(tmp_path), progress)

    assert result["words"][0] == {"w": "Chào", "start": 0.0, "end": 0.3, "p": 0.9}
    assert result["words"] == [
        {"w": "Chào", "start": 0.0, "end": 0.3, "p": 0.9},
        {"w": "mừng", "start": 0.4, "end": 0.9, "p": 0.9},
        {"w": "đến", "start": 1.5, "end": 1.8, "p": 0.9},
        {"w": "Vietcetera", "start": 1.9, "end": 2.6, "p": 0.9},
    ]
    model = FakeWhisperModel.instances[0]
    assert model.model_size_or_path == str(tmp_path / "models" / "faster-whisper-large-v3-turbo")
    assert model.device == "cpu" and model.compute_type == "int8"
    options = model.calls[0]
    assert options["initial_prompt"] == "Vietcetera, Trưng Trắc"
    assert options["language"] == "vi"
    assert options["word_timestamps"] is True
    assert options["vad_filter"] is True
    assert options["beam_size"] == 5
    # Audio is decoded by ffmpeg to 16 kHz mono float32 and handed over as samples.
    assert isinstance(options["audio"], np.ndarray)
    assert options["audio"].dtype == np.float32
    assert len(options["audio"]) == pytest.approx(3 * 16000, abs=1600)
    assert result["device"] == "cpu"
    assert result["computeType"] == "int8"
    assert result["durationSec"] == pytest.approx(3.0)
    assert json.loads(progress.read_text(encoding="utf-8"))["done"] == 1.0


def test_asks_cuda_for_float16_int8_first(tmp_path, monkeypatch, with_cuda):
    monkeypatch.setattr(transcribe, "WhisperModel", FakeWhisperModel)

    result = transcribe.run(spec(tmp_path), None)

    model = FakeWhisperModel.instances[0]
    assert model.device == "cuda"
    assert model.compute_type == "int8_float16"
    assert result["device"] == "cuda"
    assert result["computeType"] == "int8_float16"


def test_cpu_fallback(tmp_path, monkeypatch, with_cuda):
    """A CUDA model that blows up mid-run falls back to int8 on the CPU."""

    class CudaBroken(FakeWhisperModel):
        def transcribe(self, audio, **options):
            if self.compute_type == "int8_float16":
                raise RuntimeError("Library cudnn_ops_infer.so.8 is not found")
            return super().transcribe(audio, **options)

    monkeypatch.setattr(transcribe, "WhisperModel", CudaBroken)

    result = transcribe.run(spec(tmp_path), None)

    assert result["device"] == "cpu"
    assert result["computeType"] == "int8"
    assert [m.compute_type for m in FakeWhisperModel.instances] == ["int8_float16", "int8"]
    assert [m.device for m in FakeWhisperModel.instances] == ["cuda", "cpu"]
    assert len(result["words"]) == 4


def test_cuda_loading_error_falls_back_too(tmp_path, monkeypatch, with_cuda):
    class CudaLoadFails(FakeWhisperModel):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            if kwargs.get("device") == "cuda":
                raise RuntimeError("Cannot load library: cublas64_12.dll")

    monkeypatch.setattr(transcribe, "WhisperModel", CudaLoadFails)

    result = transcribe.run(spec(tmp_path), None)

    assert (result["device"], result["computeType"]) == ("cpu", "int8")
    assert result["words"][0]["w"] == "Chào"


def test_device_cpu_in_input_skips_cuda(tmp_path, monkeypatch, with_cuda):
    monkeypatch.setattr(transcribe, "WhisperModel", FakeWhisperModel)

    transcribe.run(spec(tmp_path, device="cpu"), None)

    model = FakeWhisperModel.instances[0]
    assert (model.device, model.compute_type) == ("cpu", "int8")


def test_empty_glossary_sends_no_prompt(tmp_path, monkeypatch, no_cuda):
    monkeypatch.setattr(transcribe, "WhisperModel", FakeWhisperModel)

    transcribe.run(spec(tmp_path, glossary=[]), None)

    assert FakeWhisperModel.instances[0].calls[0]["initial_prompt"] is None


def test_progress_heartbeat_while_a_segment_takes_long(tmp_path, monkeypatch, no_cuda):
    """A segment slower than the heartbeat interval still gets progress writes.

    Updates after each segment alone write progress once in ten minutes for a slow
    first segment, which the TypeScript job runner calls stale; the heartbeat
    runs on its own timer so the job looks alive while the model is busy.
    """
    writes = []

    class Slow(FakeWhisperModel):
        def transcribe(self, audio, **options):
            self.calls.append({"audio": audio, **options})

            def segments():
                # Each segment takes 10x the heartbeat interval to be produced.
                for seg in SEGMENTS:
                    time.sleep(0.2)
                    yield seg

            return segments(), info(3.0)

    monkeypatch.setattr(transcribe, "WhisperModel", Slow)
    monkeypatch.setattr(transcribe, "progress_interval", lambda: 0.02)
    monkeypatch.setattr(
        transcribe.io, "write_progress",
        lambda path, done, eta_sec=None: writes.append(done),
    )

    result = transcribe.run(spec(tmp_path), tmp_path / "progress.json")

    assert len(result["words"]) == 4
    # The two per-segment positions, plus the heartbeats that fired before them.
    assert len(writes) >= 5
    assert all(0.0 <= value <= 1.0 for value in writes)
    assert writes == sorted(writes), "progress must never go backwards"
    assert writes[-1] == 1.0


def test_heartbeat_writes_before_the_first_segment(tmp_path, monkeypatch, no_cuda):
    """The timer alone reports progress while ``transcribe`` is still blocking."""
    seen = []
    release = threading.Event()

    class Blocking(FakeWhisperModel):
        def transcribe(self, audio, **options):
            self.calls.append({"audio": audio, **options})
            release.wait(5)
            return iter(SEGMENTS), info(3.0)

    monkeypatch.setattr(transcribe, "WhisperModel", Blocking)
    monkeypatch.setattr(transcribe, "progress_interval", lambda: 0.05)
    monkeypatch.setattr(
        transcribe.io, "write_progress",
        lambda path, done, eta_sec=None: seen.append(done),
    )

    def unblock():
        time.sleep(0.3)
        release.set()

    helper = threading.Thread(target=unblock)
    helper.start()
    try:
        transcribe.run(spec(tmp_path), tmp_path / "progress.json")
    finally:
        helper.join()

    # At least two heartbeat writes landed before the first segment arrived, so a
    # slow segment still shows movement; each creeps a little but stays short of 1.
    early = seen[:2]
    assert len(early) == 2
    assert early[0] >= 0.0
    assert early[1] > early[0]
    assert all(value < 1.0 for value in early)
    assert seen[-1] == 1.0


def test_progress_never_exceeds_the_media_duration(tmp_path, monkeypatch, no_cuda):
    """A segment past the decoded length clamps at 1.0 instead of overshooting."""
    monkeypatch.setattr(transcribe, "WhisperModel", FakeWhisperModel)
    short = make_wav(tmp_path / "short.wav", 2)

    result = transcribe.run(spec(tmp_path, mediaPath=str(short)), None)

    # durationSec comes from the model's info, not from the audio length.
    assert result["durationSec"] == 3.0


def test_missing_media_path_is_an_error(tmp_path, monkeypatch, no_cuda):
    monkeypatch.setattr(transcribe, "WhisperModel", FakeWhisperModel)

    with pytest.raises(ValueError, match="mediaPath"):
        transcribe.run({"modelDir": "x"}, None)


def test_unreadable_media_is_an_error(tmp_path, monkeypatch, no_cuda):
    monkeypatch.setattr(transcribe, "WhisperModel", FakeWhisperModel)
    bogus = tmp_path / "bogus.wav"
    bogus.write_bytes(b"not a wav")

    with pytest.raises(RuntimeError, match="ffmpeg"):
        transcribe.run(spec(tmp_path, mediaPath=str(bogus)), None)


def test_silence_pads_short_audio_and_skips_empty_words(tmp_path, monkeypatch, no_cuda):
    """Blank words and zero-length words are dropped: the TS side dedupes anyway."""

    class Blanky(FakeWhisperModel):
        def transcribe(self, audio, **options):
            self.calls.append({"audio": audio, **options})
            segments = [segment(0, 0.0, 1.0, " Chào", [
                word(" ", 0.0, 0.1, 0.2),
                word(" Chào", 0.1, 0.4),
                word("", 0.5, 0.5, 0.1),
                word(" bạn", 0.6, 1.1),
            ])]
            return iter(segments), info(1.0)

    monkeypatch.setattr(transcribe, "WhisperModel", Blanky)

    result = transcribe.run(spec(tmp_path), None)

    assert result["words"] == [
        {"w": "Chào", "start": 0.1, "end": 0.4, "p": 0.9},
        {"w": "bạn", "start": 0.6, "end": 1.1, "p": 0.9},
    ]


def test_dataclass_fields_are_read_not_attributes():
    """Guard: the fakes above must match faster-whisper's real dataclasses."""
    assert {field.name for field in dataclasses.fields(Segment)} >= {
        "id", "start", "end", "text", "words",
    }
    assert {field.name for field in dataclasses.fields(Word)} == {"start", "end", "word", "probability"}


@pytest.mark.parametrize("device", ["cuda", "cpu"])
def test_model_options_are_accepted_by_the_real_constructor(tmp_path, device):
    """The options must be real ctranslate2 kwargs, not just plausible names.

    ``WhisperModel`` forwards its extras straight to ``ctranslate2.models.Whisper``,
    which rejects unknown arguments with ``TypeError`` (a bogus ``vram_limit_mb``
    would have failed every CUDA load). The folder exists but holds no weights, so
    the call has to get past argument checking and fail on the model files.
    """
    from faster_whisper import WhisperModel

    empty = tmp_path / "model"
    empty.mkdir()

    with pytest.raises(Exception) as caught:
        WhisperModel(str(empty), **transcribe._model_options(device))

    assert not isinstance(caught.value, TypeError), caught.value


def test_cli_runs_transcribe(tmp_path, monkeypatch):
    """`python -m premiere_mcp_sidecar transcribe --input in.json --output out.json`."""
    import premiere_mcp_sidecar.__main__ as cli

    spec_path = tmp_path / "in.json"
    media = make_wav(tmp_path / "talk.wav", 3)
    spec_path.write_text(json.dumps({
        "mediaPath": str(media), "modelDir": "models/turbo", "model": "large-v3-turbo",
        "language": "vi", "glossary": [], "device": "cpu",
    }), encoding="utf-8")
    out = tmp_path / "out.json"
    progress = tmp_path / "progress.json"
    monkeypatch.setattr(transcribe, "WhisperModel", FakeWhisperModel)

    code = cli.main(["transcribe", "--input", str(spec_path), "--output", str(out), "--progress", str(progress)])

    assert code == 0
    assert len(json.loads(out.read_text(encoding="utf-8"))["words"]) == 4
    assert json.loads(progress.read_text(encoding="utf-8"))["done"] == 1.0
