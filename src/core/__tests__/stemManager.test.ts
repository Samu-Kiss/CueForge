import { describe, expect, it } from 'vitest';
import {
  audioSamplesToWavBlob,
  extractWaveformPeaks,
  inferStemType,
  mixStemsAudio,
  AudioStem,
} from '../stemManager';

describe('Multi-Stem Audio Manager', () => {
  it('correctly infers stem types from filenames', () => {
    expect(inferStemType('Track_Drums.wav')).toBe('drums');
    expect(inferStemType('kick_snare_loop.mp3')).toBe('drums');
    expect(inferStemType('Sub_Bassline_808.flac')).toBe('bass');
    expect(inferStemType('Lead_Vocals_Wet.wav')).toBe('vocals');
    expect(inferStemType('Synth_Guitars_Arp.wav')).toBe('other');
    expect(inferStemType('random_stem_01.aif')).toBe('custom');
  });

  it('extracts downsampled waveform peaks from channel audio samples', () => {
    const samples = new Float32Array(44100);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / 44100);
    }
    const peaks = extractWaveformPeaks(samples, 100);
    expect(peaks).toHaveLength(100);
    expect(Math.max(...peaks)).toBeGreaterThan(0.95);
  });

  it('mixes multiple active stems and respects mute and solo flags', () => {
    const len = 1000;
    const buf1Data = new Float32Array(len).fill(0.3);
    const buf2Data = new Float32Array(len).fill(0.2);

    const stem1: AudioStem = {
      id: 's1',
      name: 'Drums',
      stemType: 'drums',
      waveformPeaks: [],
      durationSeconds: 1,
      volume: 1.0,
      muted: false,
      solo: false,
      color: '#f43f5e',
      candidates: [],
      audioBuffer: {
        length: len,
        duration: 1,
        sampleRate: 44100,
        numberOfChannels: 1,
        getChannelData: () => buf1Data,
        copyFromChannel: () => {},
        copyToChannel: () => {},
      } as unknown as AudioBuffer,
    };

    const stem2: AudioStem = {
      id: 's2',
      name: 'Bass',
      stemType: 'bass',
      waveformPeaks: [],
      durationSeconds: 1,
      volume: 1.0,
      muted: false,
      solo: false,
      color: '#a855f7',
      candidates: [],
      audioBuffer: {
        length: len,
        duration: 1,
        sampleRate: 44100,
        numberOfChannels: 1,
        getChannelData: () => buf2Data,
        copyFromChannel: () => {},
        copyToChannel: () => {},
      } as unknown as AudioBuffer,
    };

    // Both active: 0.3 + 0.2 = 0.5
    const mixedBoth = mixStemsAudio([stem1, stem2], len);
    expect(mixedBoth[100]).toBeCloseTo(0.5);

    // Stem 1 muted: only Stem 2 audible = 0.2
    stem1.muted = true;
    const mixedMuted = mixStemsAudio([stem1, stem2], len);
    expect(mixedMuted[100]).toBeCloseTo(0.2);

    // Stem 1 soloed & unmuted: only Stem 1 audible = 0.3
    stem1.muted = false;
    stem1.solo = true;
    const mixedSolo = mixStemsAudio([stem1, stem2], len);
    expect(mixedSolo[100]).toBeCloseTo(0.3);
  });

  it('converts float32 audio samples into a playable WAV blob', async () => {
    const samples = new Float32Array(100).fill(0.5);
    const blob = audioSamplesToWavBlob(samples, 44100);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 100 * 2);

    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);
    // Check RIFF header
    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    expect(riff).toBe('RIFF');
    // Check WAVE format
    const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    expect(wave).toBe('WAVE');
  });
});
