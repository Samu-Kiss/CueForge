import { describe, expect, it } from 'vitest';
import {
  analyzeAudioMultiBand,
  promoteCandidateToMarker,
} from '../multiBandAnalysis';
import { compileShow } from '../compiler';
import { validateCompiledShow } from '../validator';
import { ExportConfiguration } from '../../types/cueforge';

const sampleRate = 44100;
const durationSeconds = 3;
const totalSamples = sampleRate * durationSeconds;

function createSyntheticAudio(): Float32Array {
  const buffer = new Float32Array(totalSamples);
  // Low kick hit at 0.5s (80Hz burst)
  const kickStart = Math.floor(0.5 * sampleRate);
  for (let i = 0; i < sampleRate * 0.15; i++) {
    buffer[kickStart + i] += Math.sin((2 * Math.PI * 80 * i) / sampleRate) * 0.8;
  }

  // Mid snare hit at 1.5s (400Hz burst)
  const snareStart = Math.floor(1.5 * sampleRate);
  for (let i = 0; i < sampleRate * 0.15; i++) {
    buffer[snareStart + i] += Math.sin((2 * Math.PI * 400 * i) / sampleRate) * 0.7;
  }

  // High hi-hat burst at 2.2s (6000Hz burst)
  const hatStart = Math.floor(2.2 * sampleRate);
  for (let i = 0; i < sampleRate * 0.1; i++) {
    buffer[hatStart + i] += Math.sin((2 * Math.PI * 6000 * i) / sampleRate) * 0.6;
  }

  return buffer;
}

const mockConfig: ExportConfiguration = {
  songTitle: 'MultiBand Test',
  ma3Version: '2.5.x',
  sequenceId: 101,
  sequenceName: 'MultiBand Seq',
  timecodeId: 101,
  timecodeName: 'MultiBand TC',
  macroId: 101,
  frameRate: 30,
  timecodeOffsetSeconds: 0,
  latencyCompensationMs: 0,
  executionMode: 'Go+',
  allowOverwriteExistingObjects: false,
  songDurationSeconds: 10,
};

describe('Multi-Band Audio Analysis & Candidate Staging', () => {
  it('filters audio into Low, Mid, High bands and isolates band-specific transients', () => {
    const audio = createSyntheticAudio();
    const result = analyzeAudioMultiBand(audio, sampleRate, {
      lowCutoffHz: 180,
      highCutoffHz: 3200,
      sensitivity: 0.5,
    });

    expect(result.allCandidates.length).toBeGreaterThanOrEqual(2);

    // Verify Low band detects the 0.5s kick
    const kick = result.lowBandCandidates.find(
      (c) => Math.abs(c.timestampSeconds - 0.5) < 0.1
    );
    expect(kick).toBeDefined();
    expect(kick?.band).toBe('low');
    expect(kick?.suggestedCategory).toBe('Hit');

    // Verify Mid band detects the 1.5s hit
    const snare = result.midBandCandidates.find(
      (c) => Math.abs(c.timestampSeconds - 1.5) < 0.1
    );
    expect(snare).toBeDefined();
    expect(snare?.band).toBe('mid');

    // Verify High band detects the 2.2s hit
    const hat = result.highBandCandidates.find(
      (c) => Math.abs(c.timestampSeconds - 2.2) < 0.1
    );
    expect(hat).toBeDefined();
    expect(hat?.band).toBe('high');
    expect(hat?.suggestedCategory).toBe('Effect');
  });

  it('promotes staged candidates to confirmed markers preserving the 1:1:1 grandMA3 invariant', () => {
    const audio = createSyntheticAudio();
    const { allCandidates } = analyzeAudioMultiBand(audio, sampleRate);
    expect(allCandidates.length).toBeGreaterThan(0);

    // Promote first candidate
    const marker1 = promoteCandidateToMarker(allCandidates[0]);
    expect(marker1.confirmed).toBe(true);
    expect(marker1.exportEnabled).toBe(true);
    expect(marker1.timestampSeconds).toBe(allCandidates[0].timestampSeconds);

    // Compile into grandMA3 show and validate
    const compiled = compileShow([marker1], mockConfig);
    expect(compiled.cues).toHaveLength(1);
    expect(compiled.events).toHaveLength(1);
    expect(compiled.cues[0].name).toBe(marker1.label);
    expect(compiled.events[0].cueDestinationName).toBe(marker1.label);

    const report = validateCompiledShow(compiled);
    expect(report.isValid).toBe(true);
    expect(report.errors).toHaveLength(0);
  });
});
