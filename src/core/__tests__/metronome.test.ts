import { describe, expect, it } from 'vitest';
import {
  getSecondsPerBeat,
  isMeasureDownbeat,
  MetronomeEngine,
} from '../metronome';
import { generateBeatGrid } from '../audioAnalysis';

describe('Metronome and Time Signature', () => {
  it('calculates seconds per beat correctly for 4/4 and 6/8', () => {
    // In 4/4 at 120 BPM: 60 / 120 = 0.5s per beat
    expect(getSecondsPerBeat(120, 4)).toBeCloseTo(0.5);

    // In 4/4 at 60 BPM: 60 / 60 = 1.0s per beat
    expect(getSecondsPerBeat(60, 4)).toBeCloseTo(1.0);

    // In 6/8 at 120 BPM: (60 / 120) * (4 / 8) = 0.25s per eighth beat
    expect(getSecondsPerBeat(120, 8)).toBeCloseTo(0.25);
  });

  it('accurately identifies measure downbeats based on time signature', () => {
    // 4/4 time signature: beats 0, 4, 8 are downbeats
    expect(isMeasureDownbeat(0, 4)).toBe(true);
    expect(isMeasureDownbeat(1, 4)).toBe(false);
    expect(isMeasureDownbeat(2, 4)).toBe(false);
    expect(isMeasureDownbeat(3, 4)).toBe(false);
    expect(isMeasureDownbeat(4, 4)).toBe(true);

    // 3/4 time signature (e.g. waltz): beats 0, 3, 6 are downbeats
    expect(isMeasureDownbeat(0, 3)).toBe(true);
    expect(isMeasureDownbeat(1, 3)).toBe(false);
    expect(isMeasureDownbeat(2, 3)).toBe(false);
    expect(isMeasureDownbeat(3, 3)).toBe(true);

    // 6/8 time signature: beats 0, 6 are downbeats
    expect(isMeasureDownbeat(0, 6)).toBe(true);
    expect(isMeasureDownbeat(5, 6)).toBe(false);
    expect(isMeasureDownbeat(6, 6)).toBe(true);
  });

  it('generates unconfirmed beat grids matching custom time signatures', () => {
    // 3/4 at 120 BPM for 3 seconds -> 6 beats total
    const grid34 = generateBeatGrid(3.0, 120, 0, 3, 4);
    expect(grid34[0]).toMatchObject({ bar: 1, beat: 1 });
    expect(grid34[1]).toMatchObject({ bar: 1, beat: 2 });
    expect(grid34[2]).toMatchObject({ bar: 1, beat: 3 });
    expect(grid34[3]).toMatchObject({ bar: 2, beat: 1 }); // Measure 2 beat 1
    expect(grid34[4]).toMatchObject({ bar: 2, beat: 2 });
    expect(grid34[5]).toMatchObject({ bar: 2, beat: 3 });

    // 6/8 at 120 BPM for 2 seconds (0.25s per eighth note)
    const grid68 = generateBeatGrid(2.0, 120, 0, 6, 8);
    expect(grid68[0]).toMatchObject({ bar: 1, beat: 1 });
    expect(grid68[5]).toMatchObject({ bar: 1, beat: 6 });
    expect(grid68[6]).toMatchObject({ bar: 2, beat: 1 }); // Measure 2 beat 1
  });

  it('initializes MetronomeEngine with volume clamping', () => {
    const metronome = new MetronomeEngine();
    expect(metronome.getVolume()).toBe(0.7);

    metronome.setVolume(1.5);
    expect(metronome.getVolume()).toBe(1.0);

    metronome.setVolume(-0.5);
    expect(metronome.getVolume()).toBe(0.0);
  });
});
