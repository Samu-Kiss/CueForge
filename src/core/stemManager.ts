import { MarkerCategory } from '../types/cueforge';
import { TransientCandidate } from './multiBandAnalysis';

export type StemType = 'drums' | 'bass' | 'vocals' | 'other' | 'custom';

export interface AudioStem {
  id: string;
  name: string;
  stemType: StemType;
  audioBuffer?: AudioBuffer;
  waveformPeaks: number[];
  durationSeconds: number;
  volume: number; // 0..1
  muted: boolean;
  solo: boolean;
  color: string;
  candidates: TransientCandidate[];
}

export const STEM_COLORS: Record<StemType, string> = {
  drums: '#f43f5e',   // Coral red (kicks, snares, percussion)
  bass: '#a855f7',    // Purple (sub, 808, bassline)
  vocals: '#06b6d4',  // Cyan (lead vocals, adlibs)
  other: '#3b82f6',   // Blue (synths, pads, guitars)
  custom: '#10b981',  // Emerald
};

export const STEM_SUGGESTED_CATEGORIES: Record<StemType, MarkerCategory> = {
  drums: 'Hit',
  bass: 'Hit',
  vocals: 'Structure',
  other: 'Effect',
  custom: 'Custom',
};

/**
 * Infers stem type from file name (e.g. "Song_Drums.wav", "vocals.mp3", "bassline.flac").
 */
export function inferStemType(filename: string): StemType {
  const lower = filename.toLowerCase();
  if (/(drum|drums|kick|snare|perc|percussion|beat|cymbals|hats)/.test(lower)) {
    return 'drums';
  }
  if (/(bass|808|sub|synthbass|bassline)/.test(lower)) {
    return 'bass';
  }
  if (/(vox|vocal|vocals|lead|acapella|accapella|voice|sing)/.test(lower)) {
    return 'vocals';
  }
  if (/(synth|guitar|keys|piano|pad|lead|fx|effects|other|inst|instrumental)/.test(lower)) {
    return 'other';
  }
  return 'custom';
}

/**
 * Extracts 600 downsampled waveform peaks from an AudioBuffer channel.
 */
export function extractWaveformPeaks(channelData: Float32Array, numBuckets: number = 600): number[] {
  const samplesPerBucket = Math.max(1, Math.floor(channelData.length / numBuckets));
  const peaks: number[] = [];

  for (let i = 0; i < numBuckets; i++) {
    const start = i * samplesPerBucket;
    const end = Math.min(channelData.length, start + samplesPerBucket);
    let max = 0;
    for (let j = start; j < end; j += 16) {
      const abs = Math.abs(channelData[j]);
      if (abs > max) max = abs;
    }
    peaks.push(Number(max.toFixed(3)));
  }

  return peaks;
}

/**
 * Mixes multiple active audio stems into a single composite Float32Array for global playback or composite visualization.
 */
export function mixStemsAudio(
  stems: AudioStem[],
  totalSamples: number
): Float32Array {
  const mixed = new Float32Array(totalSamples);
  const activeStems = stems.filter((s) => !s.muted);
  const hasSolo = stems.some((s) => s.solo);
  const audibleStems = hasSolo ? stems.filter((s) => s.solo && !s.muted) : activeStems;

  if (audibleStems.length === 0) return mixed;

  for (const stem of audibleStems) {
    if (!stem.audioBuffer) continue;
    const data = stem.audioBuffer.getChannelData(0);
    const vol = stem.volume;
    const len = Math.min(mixed.length, data.length);
    for (let i = 0; i < len; i++) {
      mixed[i] += data[i] * vol;
    }
  }

  // Soft-clip limit to avoid digital wrap distortion if sum > 1.0
  for (let i = 0; i < mixed.length; i++) {
    const s = mixed[i];
    if (s > 1.0) mixed[i] = 1.0;
    else if (s < -1.0) mixed[i] = -1.0;
  }

  return mixed;
}

/**
 * Encodes Float32Array audio samples into a standard 16-bit PCM mono WAV Blob for browser playback.
 */
export function audioSamplesToWavBlob(
  samples: Float32Array,
  sampleRate: number = 44100
): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  /* RIFF chunk descriptor */
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');

  /* "fmt " sub-chunk */
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // Linear PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample

  /* "data" sub-chunk */
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

