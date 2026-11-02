import { Marker, MarkerCategory } from '../types/cueforge';

export type FrequencyBand = 'low' | 'mid' | 'high' | 'full';

export interface TransientCandidate {
  id: string;
  sourceStemId?: string;
  sourceStemName?: string;
  eventKind?: 'attack' | 'entry' | 'section';
  sectionKind?: 'build' | 'drop' | 'instrumental' | 'section';
  explanation?: string;
  timestampSeconds: number;
  band: FrequencyBand;
  energyScore: number;
  suggestedLabel: string;
  suggestedCategory: MarkerCategory;
  suggestedFadeIn: number;
  suggestedDelay: number;
}

export interface MultiBandAnalysisOptions {
  /** Low-frequency shelf upper cutoff in Hz (default: 180Hz - kicks, sub drops) */
  lowCutoffHz?: number;
  /** High-frequency shelf lower cutoff in Hz (default: 3200Hz - hi-hats, claps, air sweeps) */
  highCutoffHz?: number;
  /** Minimum spacing between candidates in seconds (default: 0.25s) */
  minSpacingSeconds?: number;
  /** Sensitivity threshold factor (0.1 to 1.0, default: 0.45) */
  sensitivity?: number;
}

/**
 * Applies a simple second-order IIR biquad filter (Direct Form I) to channel audio samples.
 */
export function applyBiquadFilter(
  input: Float32Array,
  sampleRate: number,
  type: 'lowpass' | 'bandpass' | 'highpass',
  frequency: number,
  q: number = 0.707
): Float32Array {
  const output = new Float32Array(input.length);
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * q);

  let b0 = 0, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

  if (type === 'lowpass') {
    b0 = (1 - cosW0) / 2;
    b1 = 1 - cosW0;
    b2 = (1 - cosW0) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosW0;
    a2 = 1 - alpha;
  } else if (type === 'highpass') {
    b0 = (1 + cosW0) / 2;
    b1 = -(1 + cosW0);
    b2 = (1 + cosW0) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosW0;
    a2 = 1 - alpha;
  } else {
    // Bandpass
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
    a0 = 1 + alpha;
    a1 = -2 * cosW0;
    a2 = 1 - alpha;
  }

  // Normalize by a0
  const nb0 = b0 / a0;
  const nb1 = b1 / a0;
  const nb2 = b2 / a0;
  const na1 = a1 / a0;
  const na2 = a2 / a0;

  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    output[i] = y0;
  }

  return output;
}

/**
 * Computes energy envelops and spectral flux on a filtered audio stream to locate transient onsets.
 */
export function detectBandTransients(
  filteredSamples: Float32Array,
  sampleRate: number,
  band: FrequencyBand,
  options: MultiBandAnalysisOptions = {}
): TransientCandidate[] {
  // Short energy windows locate attacks; a trailing local baseline tolerates
  // large changes in track loudness without letting one loud hit set the threshold.
  const hopSize = Math.max(1, Math.round(sampleRate * 0.01));
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !filteredSamples.length) return [];
  const sensitivity = Math.max(0.1, Math.min(1, options.sensitivity ?? 0.45));
  const minSpacing = Math.max(0.04, options.minSpacingSeconds ?? 0.18);
  const energies: number[] = [];
  for (let i = 0; i < filteredSamples.length; i += hopSize) {
    let sum = 0;
    const end = Math.min(i + hopSize, filteredSamples.length);
    for (let j = i; j < end; j++) sum += filteredSamples[j] ** 2;
    energies.push(Math.sqrt(sum / (end - i)));
  }
  const sorted = [...energies].sort((a, b) => a - b);
  const reference = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const floor = Math.max(0.0001, reference * (0.035 - sensitivity * 0.025));
  const candidates: TransientCandidate[] = [];
  let lastTimestamp = -Infinity;
  for (let i = 0; i < energies.length; i++) {
    const history = energies.slice(Math.max(0, i - 40), i);
    const baseline = history.reduce((sum, value) => sum + value, 0) / Math.max(1, history.length);
    const current = energies[i];
    const previous = energies[i - 1] ?? 0;
    const rise = current - previous;
    const time = i * hopSize / sampleRate;
    if (current < floor || current < Math.min(baseline, previous) * (2.8 - sensitivity * 1.5) ||
        rise < Math.max(floor * 0.5, current * (0.42 - sensitivity * 0.25)) ||
        time - lastTimestamp < minSpacing) continue;
    const label = band === 'low' ? 'Low attack' : band === 'mid' ? 'Mid attack' : band === 'high' ? 'High attack' : 'Attack';
    candidates.push({
      id: 'cand-' + band + '-' + Math.round(time * 1000),
      timestampSeconds: Number(time.toFixed(3)), band,
      energyScore: Number(Math.min(1, current / Math.max(reference, current, 0.0001)).toFixed(2)),
      suggestedLabel: label,
      suggestedCategory: band === 'mid' ? 'Structure' : band === 'high' ? 'Effect' : 'Hit',
      suggestedFadeIn: band === 'mid' ? 1 : band === 'high' ? 0.2 : 0,
      suggestedDelay: 0,
      eventKind: 'attack',
    });
    lastTimestamp = time;
  }

  return candidates;
}

/**
 * Promotes a TransientCandidate from the review shelf into a confirmed Marker.
 * Strictly guarantees the invariant: 1 Confirmed Marker = 1 grandMA3 Cue = 1 Timecode Event.
 */
export function promoteCandidateToMarker(
  candidate: TransientCandidate,
  customLabel?: string,
  customCategory?: MarkerCategory
): Marker {
  return {
    id: `m-cand-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    label: customLabel?.trim() || candidate.suggestedLabel,
    timestampSeconds: candidate.timestampSeconds,
    category: customCategory || candidate.suggestedCategory,
    origin: 'analysis',
    confirmed: true,
    exportEnabled: true,
    fadeInSeconds: candidate.suggestedFadeIn,
    delaySeconds: candidate.suggestedDelay,
    notes: `Source: ${candidate.sourceStemName ?? "Audio"}; ${candidate.eventKind ?? "attack"}; ${candidate.band} band; energy: ${candidate.energyScore}${candidate.explanation ? "; " + candidate.explanation : ""}`,
  };
}

/**
 * Performs full multi-band audio analysis, extracting separated Low, Mid, and High candidates.
 */
export function analyzeAudioMultiBand(
  channelData: Float32Array,
  sampleRate: number,
  options: MultiBandAnalysisOptions = {}
): {
  lowBandCandidates: TransientCandidate[];
  midBandCandidates: TransientCandidate[];
  highBandCandidates: TransientCandidate[];
  allCandidates: TransientCandidate[];
} {
  const lowCutoff = options.lowCutoffHz ?? 180;
  const highCutoff = options.highCutoffHz ?? 3200;

  const lowSamples = applyBiquadFilter(channelData, sampleRate, 'lowpass', lowCutoff);
  const midSamples = applyBiquadFilter(channelData, sampleRate, 'bandpass', (lowCutoff + highCutoff) / 2);
  const highSamples = applyBiquadFilter(channelData, sampleRate, 'highpass', highCutoff);

  const lowBandCandidates = detectBandTransients(lowSamples, sampleRate, 'low', options);
  const midBandCandidates = detectBandTransients(midSamples, sampleRate, 'mid', options);
  const highBandCandidates = detectBandTransients(highSamples, sampleRate, 'high', options);

  const allCandidates = [
    ...lowBandCandidates,
    ...midBandCandidates,
    ...highBandCandidates,
  ].sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  return {
    lowBandCandidates,
    midBandCandidates,
    highBandCandidates,
    allCandidates,
  };
}
