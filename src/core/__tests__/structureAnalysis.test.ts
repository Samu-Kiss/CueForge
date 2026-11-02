import { describe, expect, it } from 'vitest';
import { analyzeStructure, detectSections, SectionTrack } from '../structureAnalysis';
import { AudioStem } from '../stemManager';

const track = (type: SectionTrack['type'], energy: number[], density = energy.map(() => 0)): SectionTrack => ({ id: type, name: type, type, energy, density });
const repeat = (value: number, length: number) => Array<number>(length).fill(value);

describe('Musical structure proposals', () => {
  it('groups a constant eighth-note build and finds its drop and instrumental exit', () => {
    const result = detectSections([
      track('drums', [...repeat(0.1, 4), ...repeat(0.4, 4), ...repeat(0.8, 12)], [...repeat(1, 4), ...repeat(4, 4), ...repeat(2, 12)]),
      track('bass', [...repeat(0.02, 8), ...repeat(0.8, 12)]),
      track('vocals', [...repeat(0.5, 16), ...repeat(0, 4)]),
      track('other', repeat(0.4, 20)),
    ], 2);
    expect(result.filter((c) => c.sectionKind === 'build').map((c) => c.timestampSeconds)).toEqual([8]);
    expect(result.filter((c) => c.sectionKind === 'drop').map((c) => c.timestampSeconds)).toEqual([16]);
    expect(result.filter((c) => c.sectionKind === 'instrumental').map((c) => c.timestampSeconds)).toEqual([32]);
    expect(result).toHaveLength(3);
    expect(result.every((c) => c.eventKind === 'section' && !!c.explanation)).toBe(true);
  });

  it('does not turn a steady eighth-note rhythm into section markers', () => {
    expect(detectSections([track('drums', repeat(0.6, 40), repeat(4, 40))], 2)).toEqual([]);
  });

  it('finds the start of a multi-bar energy ramp instead of marking each rising bar', () => {
    const result = detectSections([track('other', [0.05, 0.05, 0.05, 0.05, 0.15, 0.25, 0.4, 0.6, 0.8, 0.8, 0.8, 0.8])], 2);
    expect(result.filter((c) => c.sectionKind === 'build')).toHaveLength(1);
    expect(result.find((c) => c.sectionKind === 'build')?.timestampSeconds).toBe(8);
    expect(result).toHaveLength(1);
  });

  it('ignores one-bar vocal pauses and isolated loud accents', () => {
    const vocals = repeat(0.5, 20); vocals[8] = 0;
    const bass = repeat(0.05, 20); bass[12] = 1;
    expect(detectSections([track('vocals', vocals), track('bass', bass), track('drums', repeat(0.4, 20))], 2)).toEqual([]);
  });

  it('does not call silence an instrumental section', () => {
    expect(detectSections([track('vocals', [...repeat(0.5, 8), ...repeat(0, 4)])], 2)).toEqual([]);
  });

  it('uses meter duration and remains safe on silent or short inputs', () => {
    expect(detectSections([], 2)).toEqual([]);
    expect(detectSections([track('other', [0])], 1.5)).toEqual([]);
    const result = detectSections([track('vocals', [...repeat(0.6, 6), ...repeat(0, 4)]), track('other', repeat(0.4, 10))], 1.5);
    expect(result.find((c) => c.sectionKind === 'instrumental')?.timestampSeconds).toBe(9);
  });

  it('extracts structure from stereo PCM without treating every eighth note as a marker', () => {
    const sampleRate = 8000, duration = 24;
    const samples = new Float32Array(sampleRate * duration);
    for (let hit = 0; hit < duration; hit += 0.25) {
      for (let i = 0; i < sampleRate * 0.08; i++) samples[Math.round(hit * sampleRate) + i] = Math.sin(2 * Math.PI * 120 * i / sampleRate) * 0.6;
    }
    const input: AudioStem = { id: 'drums', name: 'Drums', stemType: 'drums', color: '#fff', volume: 1, muted: true, solo: false,
      candidates: [], waveformPeaks: [], durationSeconds: duration,
      audioBuffer: { duration, sampleRate, length: samples.length, numberOfChannels: 2,
        getChannelData: (i: number) => i === 0 ? samples : samples.map((v) => -v) } as AudioBuffer };
    expect(analyzeStructure([input], { bpm: 120, beats: 4, unit: 4, sensitivity: 0.5 })).toEqual([]);
  });

  it('finds a build, drop and instrumental in separated audio tracks end to end', () => {
    const rate = 8000, duration = 40;
    function audio(type: AudioStem['stemType'], amplitude: (time: number) => number): AudioStem {
      const samples = Float32Array.from({ length: rate * duration }, (_, i) => Math.sin(2 * Math.PI * 200 * i / rate) * amplitude(i / rate));
      return { id: type, name: type, stemType: type, color: '#fff', volume: 1, muted: false, solo: false,
        candidates: [], waveformPeaks: [], durationSeconds: duration,
        audioBuffer: { duration, sampleRate: rate, length: samples.length, numberOfChannels: 1, getChannelData: (_channel: number) => samples } as AudioBuffer };
    }
    const result = analyzeStructure([
      audio('drums', (t) => {
        const period = t < 8 ? 1 : t < 16 ? 0.25 : 0.5;
        return t % period < 0.08 ? (t < 8 ? 0.15 : t < 16 ? 0.4 : 0.8) : 0;
      }),
      audio('bass', (t) => t >= 16 ? 0.8 : 0),
      audio('vocals', (t) => t < 32 ? 0.5 : 0),
      audio('other', () => 0.3),
    ], { bpm: 120, beats: 4, unit: 4, sensitivity: 0.5 });
    expect(result.map((c) => [c.sectionKind, c.timestampSeconds])).toEqual([
      ['build', 8], ['drop', 16], ['instrumental', 32],
    ]);
  });
});
