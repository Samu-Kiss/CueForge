import { analyzeAudioMultiBand, applyBiquadFilter, detectBandTransients, TransientCandidate } from './multiBandAnalysis';
import { AudioStem, STEM_SUGGESTED_CATEGORIES, StemType } from './stemManager';

/** Preserve energy in either stereo channel, including opposite-phase audio. */
export function analysisSamples(channels: Float32Array[]): Float32Array {
  const output = new Float32Array(channels[0]?.length ?? 0);
  for (let i = 0; i < output.length; i++) {
    let strongest = 0;
    for (const channel of channels) {
      const value = channel[i] ?? 0;
      if (Math.abs(value) > Math.abs(strongest)) strongest = value;
    }
    output[i] = strongest;
  }
  return output;
}

// Phrase entries use hysteresis: breaths and brief gaps should not create a cue
// for every syllable. These are energy-based entries, not semantic song sections.
function detectEntries(samples: Float32Array, sampleRate: number, sensitivity: number): TransientCandidate[] {
  const hop = Math.max(1, Math.round(sampleRate * 0.02));
  const envelope: number[] = [];
  for (let i = 0; i < samples.length; i += hop) {
    let sum = 0;
    const end = Math.min(samples.length, i + hop);
    for (let j = i; j < end; j++) sum += samples[j] ** 2;
    envelope.push(Math.sqrt(sum / (end - i)));
  }
  const sorted = [...envelope].sort((a, b) => a - b);
  const reference = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const threshold = Math.max(0.0003, reference * (0.16 - sensitivity * 0.12));
  const releaseFrames = Math.round((0.55 - sensitivity * 0.25) / 0.02);
  let active = false;
  let quietFrames = 0;
  const result: TransientCandidate[] = [];
  for (let i = 0; i < envelope.length; i++) {
    if (!active && envelope[i] >= threshold && (envelope[i + 1] ?? 0) >= threshold) {
      const time = Number((i * hop / sampleRate).toFixed(3));
      result.push({ id: `entry-${time}`, timestampSeconds: time, band: 'full',
        energyScore: Math.min(1, envelope[i] / Math.max(reference, threshold)),
        suggestedLabel: 'Entry', suggestedCategory: 'Structure', suggestedFadeIn: 0.3,
        suggestedDelay: 0, eventKind: 'entry' });
      active = true;
    }
    quietFrames = envelope[i] < threshold * 0.55 ? quietFrames + 1 : 0;
    if (quietFrames >= releaseFrames) active = false;
  }
  return result;
}

export const STEM_ANALYSIS_LABELS: Record<StemType, string> = {
  drums: 'Percussive attacks · nearby bands merged',
  bass: 'Low-frequency attacks',
  vocals: 'Vocal entries · short pauses ignored',
  other: 'Instrument entries · sustained sounds grouped',
  custom: 'Full-range attacks',
};

export function analyzeStem(stem: Pick<AudioStem, 'id' | 'name' | 'stemType' | 'audioBuffer'>, sensitivity = 0.5): TransientCandidate[] {
  if (!stem.audioBuffer) return [];
  const buffer = stem.audioBuffer;
  const samples = analysisSamples(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)));
  const level = Math.max(0.1, Math.min(1, sensitivity));
  const options = { sensitivity: level, minSpacingSeconds: stem.stemType === 'bass' ? 0.16 : 0.12 };
  let candidates: TransientCandidate[];
  if (stem.stemType === 'vocals' || stem.stemType === 'other') {
    candidates = detectEntries(samples, buffer.sampleRate, level);
  } else if (stem.stemType === 'drums') {
    const detected = analyzeAudioMultiBand(samples, buffer.sampleRate, options).allCandidates;
    candidates = [];
    for (const candidate of detected) {
      const previous = candidates[candidates.length - 1];
      if (previous && candidate.timestampSeconds - previous.timestampSeconds < 0.06) {
        previous.energyScore = Math.max(previous.energyScore, candidate.energyScore);
      } else candidates.push({ ...candidate });
    }
  } else {
    const bass = stem.stemType === 'bass';
    candidates = detectBandTransients(bass ? applyBiquadFilter(samples, buffer.sampleRate, 'lowpass', 350) : samples,
      buffer.sampleRate, bass ? 'low' : 'full', options);
  }
  return candidates.map((candidate) => ({ ...candidate,
    id: `${stem.id}:${candidate.eventKind}:${Math.round(candidate.timestampSeconds * 1000)}`,
    sourceStemId: stem.id, sourceStemName: stem.name,
    suggestedLabel: `${stem.name} · ${candidate.eventKind === 'entry' ? 'Entry' : 'Attack'}`,
    suggestedCategory: STEM_SUGGESTED_CATEGORIES[stem.stemType],
    suggestedFadeIn: candidate.eventKind === 'entry' ? 0.3 : 0,
  }));
}

/** Remove exactly reviewed IDs; candidates from other stems/bands stay pending. */
export function removeReviewedCandidates(stems: AudioStem[], ids: Set<string>): AudioStem[] {
  return stems.map((stem) => ({ ...stem, candidates: stem.candidates.filter((candidate) => !ids.has(candidate.id)) }));
}
