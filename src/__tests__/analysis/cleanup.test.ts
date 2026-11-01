import {
  liveSegments,
  loudnessGainDb,
  planSilenceCuts,
  preflightIssues,
  subtractIntervals,
  unionIntervals,
  type SequenceClip,
} from '../../analysis/cleanup.js';
import {
  parseBlackIntervals,
  parseFreezeIntervals,
  parseIntegratedLoudness,
  parseProbe,
  parseSilenceIntervals,
} from '../../analysis/ffmpeg.js';

const iv = (start: number, end: number) => ({ start, end, duration: Math.round((end - start) * 1000) / 1000 });
const FRAME = 1 / 25;

const audioClip = (over: Partial<SequenceClip> = {}): SequenceClip => ({
  id: 'a1', trackType: 'audio', trackIndex: 0, start: 0, end: 20, inPoint: 0, outPoint: 20, mediaPath: 'talk.wav', ...over,
});

describe('interval helpers', () => {
  it('merges overlapping and touching intervals', () => {
    expect(unionIntervals([iv(5, 6), iv(0, 2), iv(1, 3), iv(3, 4)])).toEqual([iv(0, 4), iv(5, 6)]);
  });

  it('subtracts holes from a base', () => {
    expect(subtractIntervals([iv(0, 10)], [iv(2, 3), iv(8, 12)])).toEqual([iv(0, 2), iv(3, 8)]);
  });

  it('returns the live complement of dead segments', () => {
    expect(liveSegments([iv(0, 1), iv(4, 5)], 10)).toEqual([iv(1, 4), iv(5, 10)]);
  });
});

describe('planSilenceCuts', () => {
  const opts = { paddingSeconds: 0.1, minCutSeconds: 0.25, frameDuration: FRAME };

  it('cuts a silence on the only audio clip, keeping padding on both sides', () => {
    const plan = planSilenceCuts([audioClip()], new Map([['talk.wav', [iv(5, 8)]]]), opts);
    expect(plan.cuts).toEqual([iv(5.12, 7.88)]);
  });

  it('maps source time through the clip in-point onto the timeline', () => {
    const clip = audioClip({ start: 100, end: 110, inPoint: 5, outPoint: 15 });
    const plan = planSilenceCuts([clip], new Map([['talk.wav', [iv(8, 12)]]]), opts);
    // source 8..12 -> timeline 103..107
    expect(plan.cuts).toEqual([iv(103.12, 106.88)]);
  });

  it('ignores silence outside the trimmed source range', () => {
    const clip = audioClip({ start: 0, end: 10, inPoint: 5, outPoint: 15 });
    expect(planSilenceCuts([clip], new Map([['talk.wav', [iv(0, 4)]]]), opts).cuts).toEqual([]);
  });

  it('does not cut where another audio track still has sound', () => {
    const music = audioClip({ id: 'a2', trackIndex: 1, mediaPath: 'music.wav' });
    const plan = planSilenceCuts(
      [audioClip(), music],
      new Map([['talk.wav', [iv(5, 8)]], ['music.wav', []]]),
      opts,
    );
    expect(plan.cuts).toEqual([]);
  });

  it('lets audioTrackIndices ignore a music bed', () => {
    const music = audioClip({ id: 'a2', trackIndex: 1, mediaPath: 'music.wav' });
    const plan = planSilenceCuts(
      [audioClip(), music],
      new Map([['talk.wav', [iv(5, 8)]], ['music.wav', []]]),
      { ...opts, audioTrackIndices: [0] },
    );
    expect(plan.cuts).toEqual([iv(5.12, 7.88)]);
  });

  it('cuts only where every linked stereo pair is silent', () => {
    const left = audioClip({ id: 'l' });
    const right = audioClip({ id: 'r', trackIndex: 1 });
    const plan = planSilenceCuts([left, right], new Map([['talk.wav', [iv(5, 8)]]]), opts);
    expect(plan.cuts).toEqual([iv(5.12, 7.88)]);
  });

  it('never cuts a stretch with no audio clip (video-only B-roll)', () => {
    const first = audioClip({ id: 'a1', start: 0, end: 5, outPoint: 5 });
    const second = audioClip({ id: 'a2', start: 15, end: 20, inPoint: 15, outPoint: 20 });
    const plan = planSilenceCuts([first, second], new Map([['talk.wav', []]]), opts);
    expect(plan.cuts).toEqual([]);
  });

  it('skips clips whose speed is not 100%', () => {
    const fast = audioClip({ start: 0, end: 5, inPoint: 0, outPoint: 10 });
    const plan = planSilenceCuts([fast], new Map([['talk.wav', [iv(1, 4)]]]), opts);
    expect(plan.cuts).toEqual([]);
    expect(plan.skippedClips).toEqual([{ clipId: 'a1', reason: expect.stringContaining('speed') }]);
  });

  it('drops cuts that are too short once padded', () => {
    const plan = planSilenceCuts([audioClip()], new Map([['talk.wav', [iv(5, 5.4)]]]), opts);
    expect(plan.cuts).toEqual([]);
  });

  it('snaps cut edges inward onto the frame grid', () => {
    const plan = planSilenceCuts([audioClip()], new Map([['talk.wav', [iv(5.013, 8.017)]]]), { ...opts, paddingSeconds: 0 });
    for (const cut of plan.cuts) {
      expect(Math.abs(cut.start / FRAME - Math.round(cut.start / FRAME))).toBeLessThan(1e-3);
      expect(Math.abs(cut.end / FRAME - Math.round(cut.end / FRAME))).toBeLessThan(1e-3);
      expect(cut.start).toBeGreaterThanOrEqual(5.013);
      expect(cut.end).toBeLessThanOrEqual(8.017);
    }
  });
});

describe('ffmpeg output parsing', () => {
  it('parses silencedetect, blackdetect and freezedetect lines', () => {
    expect(parseSilenceIntervals('[silencedetect @ x] silence_start: 1.5\n[silencedetect @ x] silence_end: 3.25 | silence_duration: 1.75')).toEqual([iv(1.5, 3.25)]);
    expect(parseBlackIntervals('[blackdetect @ x] black_start:0 black_end:2.5 black_duration:2.5')).toEqual([iv(0, 2.5)]);
    expect(parseFreezeIntervals('[freezedetect @ x] lavfi.freezedetect.freeze_start: 4\n[freezedetect @ x] lavfi.freezedetect.freeze_duration: 3\n[freezedetect @ x] lavfi.freezedetect.freeze_end: 7')).toEqual([iv(4, 7)]);
  });

  it('reads integrated loudness from the ebur128 summary only', () => {
    const stderr = '[Parsed_ebur128_0 @ x] t: 1 M: -20 S: -20 I: -30.0 LUFS LRA: 0\nSummary:\n\n  Integrated loudness:\n    I:         -18.4 LUFS\n    Threshold: -28.4 LUFS\n';
    expect(parseIntegratedLoudness(stderr)).toBe(-18.4);
    expect(parseIntegratedLoudness('no summary here')).toBeNull();
  });

  it('parses ffprobe json into streams', () => {
    const probe = parseProbe(JSON.stringify({
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1', avg_frame_rate: '2997/100' },
        { codec_type: 'audio', codec_name: 'aac', channels: 1, sample_rate: '44100' },
      ],
      format: { duration: '12.5' },
    }));
    expect(probe.durationSeconds).toBe(12.5);
    expect(probe.streams[0]).toMatchObject({ type: 'video', rFrameRate: 30, avgFrameRate: 29.97 });
    expect(probe.streams[1]).toMatchObject({ type: 'audio', channels: 1, sampleRate: 44100 });
  });
});

describe('parseProbe cover art', () => {
  it('ignores an embedded picture so an MP3 is not mistaken for 90000 fps video', () => {
    const probe = parseProbe(JSON.stringify({
      streams: [
        { codec_type: 'audio', codec_name: 'mp3', channels: 2, sample_rate: '44100' },
        { codec_type: 'video', codec_name: 'mjpeg', r_frame_rate: '90000/1', avg_frame_rate: '0/0', disposition: { attached_pic: 1 } },
      ],
      format: { duration: '550' },
    }));
    expect(probe.streams.map((s) => s.type)).toEqual(['audio']);
    expect(preflightIssues(probe, { sequenceFps: 30 })).toEqual([]);
  });
});

describe('preflightIssues', () => {
  const base = parseProbe(JSON.stringify({
    streams: [
      { codec_type: 'video', width: 1920, height: 1080, r_frame_rate: '25/1', avg_frame_rate: '25/1' },
      { codec_type: 'audio', channels: 2, sample_rate: '48000' },
    ],
    format: { duration: '10' },
  }));

  it('reports nothing for a clean file', () => {
    expect(preflightIssues(base, { sequenceFps: 25, targetSampleRate: 48000 })).toEqual([]);
  });

  it('flags variable frame rate, fps mismatch, mono and sample-rate mismatch', () => {
    const probe = parseProbe(JSON.stringify({
      streams: [
        { codec_type: 'video', r_frame_rate: '30/1', avg_frame_rate: '24/1' },
        { codec_type: 'audio', channels: 1, sample_rate: '44100' },
      ],
    }));
    const codes = preflightIssues(probe, { sequenceFps: 25, targetSampleRate: 48000 }).map((i) => i.code);
    expect(codes).toEqual(['VFR_SOURCE', 'FPS_MISMATCH', 'AUDIO_MONO', 'AUDIO_RATE_MISMATCH']);
  });

  it('flags multichannel audio', () => {
    const probe = parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio', channels: 6, sample_rate: '48000' }] }));
    expect(preflightIssues(probe, {}).map((i) => i.code)).toEqual(['AUDIO_MULTICHANNEL']);
  });
});

describe('loudnessGainDb', () => {
  it('returns the difference to the target', () => {
    expect(loudnessGainDb(-20, -14)).toBe(6);
    expect(loudnessGainDb(-10, -14)).toBe(-4);
  });

  it('clamps to what the clip Volume can express', () => {
    expect(loudnessGainDb(-60, -14)).toBe(15);
    expect(loudnessGainDb(10, -60)).toBe(-40);
  });
});
