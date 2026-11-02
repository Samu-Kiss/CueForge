import { describe, expect, it } from 'vitest';
import { analyzeStem, analysisSamples, removeReviewedCandidates } from '../stemAnalysis';
import { detectBandTransients } from '../multiBandAnalysis';
import { AudioStem, StemType } from '../stemManager';

const rate = 12000;
function signal(events: [number, number, number][], frequency = 100) {
  const samples = new Float32Array(rate * 5);
  for (const [start, duration, gain] of events) {
    for (let i = 0; i < Math.round(duration * rate); i++) {
      samples[Math.round(start * rate) + i] = Math.sin(2 * Math.PI * frequency * i / rate) * gain;
    }
  }
  return samples;
}
function stem(type: StemType, channels: Float32Array[], id = 'stem-a'): AudioStem {
  return { id, name: id, stemType: type, waveformPeaks: [], durationSeconds: 5,
    volume: 1, muted: false, solo: false, color: '#fff', candidates: [],
    audioBuffer: { sampleRate: rate, numberOfChannels: channels.length, getChannelData: (i: number) => channels[i] } as AudioBuffer };
}

describe('Stem-aware candidate detection', () => {
  it('finds quieter attacks after a much louder passage, including the beginning', () => {
    const audio = signal([[0, 0.1, 0.9], [1, 0.1, 0.04], [2, 0.1, 0.035]]);
    const candidates = detectBandTransients(audio, rate, 'full');
    for (const time of [0, 1, 2]) expect(candidates.some((c) => Math.abs(c.timestampSeconds - time) < 0.03)).toBe(true);
  });

  it('treats brief vocal pauses as one phrase, but detects a new entry after silence', () => {
    const audio = signal([[0.5, 0.4, 0.5], [1, 0.4, 0.4], [2.5, 0.7, 0.5]], 400);
    const entries = analyzeStem(stem('vocals', [audio]));
    expect(entries).toHaveLength(2);
    expect(entries.map((c) => c.timestampSeconds)).toEqual([0.5, 2.5]);
    expect(entries.every((c) => c.eventKind === 'entry')).toBe(true);
    expect(analyzeStem(stem('custom', [audio])).length).toBeGreaterThan(entries.length);
  });

  it('merges simultaneous drum-band attacks without merging different stems', () => {
    const audio = signal([[0.5, 0.08, 0.8], [1.5, 0.08, 0.5]], 1200);
    const first = analyzeStem(stem('drums', [audio]));
    const second = analyzeStem(stem('drums', [audio], 'stem-b'));
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second].map((c) => c.id)).size).toBe(4);
    expect(first.every((c) => c.sourceStemId === 'stem-a')).toBe(true);
  });

  it('detects audio in the right channel and does not cancel opposite-phase stereo', () => {
    const audio = signal([[1, 0.2, 0.5]]);
    const silent = new Float32Array(audio.length);
    const inverted = audio.map((value) => -value);
    expect(analyzeStem(stem('bass', [silent, audio]))).toHaveLength(1);
    expect(analyzeStem(stem('bass', [audio, inverted]))).toHaveLength(1);
    expect(analysisSamples([audio, inverted])).toEqual(audio);
  });

  it('rejects silence and steady energy after the initial entry', () => {
    expect(analyzeStem(stem('drums', [new Float32Array(rate * 5)]))).toEqual([]);
    const sustained = signal([[0.5, 4, 0.5]], 400);
    expect(analyzeStem(stem('vocals', [sustained]))).toHaveLength(1);
    expect(detectBandTransients(sustained, rate, 'full')).toHaveLength(1);
  });

  it('changes detection when sensitivity is reapplied', () => {
    const audio = signal([[0.5, 1, 0.5], [3, 0.3, 0.03]], 400);
    const input = stem('vocals', [audio]);
    expect(analyzeStem(input, 0.2)).toHaveLength(1);
    expect(analyzeStem(input, 0.9)).toHaveLength(2);
  });

  it('removes reviewed candidates from a stem without removing another stem at the same time', () => {
    const audio = signal([[1, 0.1, 0.5]]);
    const a = stem('drums', [audio]);
    const b = stem('drums', [audio], 'stem-b');
    a.candidates = analyzeStem(a);
    b.candidates = analyzeStem(b);
    const result = removeReviewedCandidates([a, b], new Set(a.candidates.map((c) => c.id)));
    expect(result[0].candidates).toHaveLength(0);
    expect(result[1].candidates).toHaveLength(1);
    expect(a.candidates).toHaveLength(1);
  });
});
