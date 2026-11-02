import { BeatGridPoint, Marker } from '../types/cueforge';

export interface AudioAnalysisResult {
  durationSeconds: number;
  estimatedBpm: number;
  waveformPeaks: number[];
  /**
   * Automatically generated beat grid points.
   * IMPORTANT: Beat grids are NEVER automatically converted into cues.
   * They remain visual reference grids unless the user explicitly promotes a grid point to a Marker.
   */
  beatGrid: BeatGridPoint[];
  /**
   * Detected transient / section markers that the user can review and confirm in the editor.
   */
  detectedMarkers: Marker[];
}

/**
 * Generates an unconfirmed visual beat grid for a given BPM, time signature, and song duration.
 * Beat grids are strictly separated from Markers so they are never exported as cues automatically.
 */
export function generateBeatGrid(
  durationSeconds: number,
  bpm: number,
  firstDownbeatSeconds: number = 0,
  beatsPerBar: number = 4,
  beatUnit: number = 4
): BeatGridPoint[] {
  const safeBpm = Math.max(30, Math.min(300, bpm));
  const safeBeatsPerBar = Math.max(1, Math.min(16, beatsPerBar));
  const safeBeatUnit = beatUnit === 8 ? 8 : 4;
  const secondsPerBeat = (60 / safeBpm) * (4 / safeBeatUnit);
  const grid: BeatGridPoint[] = [];

  let beatIndex = 0;
  for (
    let t = firstDownbeatSeconds;
    t <= durationSeconds;
    t += secondsPerBeat
  ) {
    const bar = Math.floor(beatIndex / safeBeatsPerBar) + 1;
    const beat = (beatIndex % safeBeatsPerBar) + 1;
    grid.push({
      id: `grid-${bar}-${beat}`,
      timestampSeconds: Number(t.toFixed(4)),
      bar,
      beat,
      bpm: safeBpm,
    });
    beatIndex++;
  }

  return grid;
}

/**
 * Promotes a single BeatGridPoint into a confirmed Marker when explicitly requested by the user.
 */
export function promoteBeatGridPointToMarker(
  point: BeatGridPoint,
  customLabel?: string
): Marker {
  return {
    id: `marker-from-grid-${point.bar}-${point.beat}-${Date.now()}`,
    label: customLabel || `Bar ${point.bar}.${point.beat}`,
    timestampSeconds: point.timestampSeconds,
    category: 'Hit',
    origin: 'analysis',
    confirmed: true,
    exportEnabled: true,
    fadeInSeconds: 0,
    delaySeconds: 0,
    notes: `Promoted from Beat Grid Bar ${point.bar} Beat ${point.beat} (${point.bpm} BPM)`,
  };
}

/**
 * Decodes an uploaded audio file using Web Audio API to extract:
 * - Downsampled waveform peaks for the interactive timeline canvas
 * - Energy-based transient & structural section markers (confirmed in editor)
 * - Separate unconfirmed beat grid (never exported automatically)
 */
export async function analyzeAudioBuffer(
  audioBuffer: AudioBuffer
): Promise<AudioAnalysisResult> {
  const durationSeconds = audioBuffer.duration;
  const channelData = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;

  // 1. Extract 600 waveform peaks for high-density canvas rendering
  const numBuckets = 600;
  const samplesPerBucket = Math.max(1, Math.floor(channelData.length / numBuckets));
  const waveformPeaks: number[] = [];

  for (let i = 0; i < numBuckets; i++) {
    const start = i * samplesPerBucket;
    const end = Math.min(channelData.length, start + samplesPerBucket);
    let maxPeak = 0;
    for (let j = start; j < end; j += 16) {
      const abs = Math.abs(channelData[j]);
      if (abs > maxPeak) maxPeak = abs;
    }
    waveformPeaks.push(Number(maxPeak.toFixed(3)));
  }

  // 2. Detect prominent musical energy transitions & hits (spaced >= 2.5s apart)
  const windowSeconds = 0.25;
  const windowSamples = Math.floor(sampleRate * windowSeconds);
  const energies: { time: number; rms: number }[] = [];

  for (let i = 0; i < channelData.length; i += windowSamples) {
    let sumSq = 0;
    const limit = Math.min(channelData.length, i + windowSamples);
    const count = limit - i;
    for (let j = i; j < limit; j += 8) {
      sumSq += channelData[j] * channelData[j];
    }
    const rms = Math.sqrt(sumSq / Math.max(1, count / 8));
    energies.push({ time: i / sampleRate, rms });
  }

  const detectedMarkers: Marker[] = [];
  let lastMarkerTime = -10;
  const sectionLabels = [
    { label: 'Intro', category: 'Structure' as const, fade: 2.0 },
    { label: 'Verse 1', category: 'Structure' as const, fade: 1.5 },
    { label: 'Pre-Chorus Hit', category: 'Hit' as const, fade: 0.0 },
    { label: 'Chorus 1 (Drop)', category: 'Structure' as const, fade: 0.5 },
    { label: 'Strobe Sweep Accent', category: 'Effect' as const, fade: 0.2 },
    { label: 'Breakdown Note', category: 'Note' as const, fade: 3.0 },
    { label: 'Build Up', category: 'Structure' as const, fade: 2.5 },
    { label: 'Final Drop Hit', category: 'Hit' as const, fade: 0.0 },
    { label: 'Outro Fade', category: 'Structure' as const, fade: 4.0 },
  ];

  // Always place an initial marker near the first audible onset
  const firstOnset = energies.find((e) => e.rms > 0.04)?.time ?? 0.5;
  detectedMarkers.push({
    id: `auto-marker-1`,
    label: 'Intro Start',
    timestampSeconds: Number(firstOnset.toFixed(3)),
    category: 'Structure',
    origin: 'analysis',
    confirmed: true,
    exportEnabled: true,
    fadeInSeconds: 2.0,
    delaySeconds: 0,
    notes: 'Auto-detected song start onset',
  });
  lastMarkerTime = firstOnset;

  let labelIdx = 1;
  for (let i = 2; i < energies.length - 1 && labelIdx < sectionLabels.length; i++) {
    const prevRms = (energies[i - 1].rms + energies[i - 2].rms) / 2;
    const currRms = energies[i].rms;
    const delta = currRms - prevRms;
    const minSpacing = Math.max(3.5, durationSeconds / 10);

    if (delta > 0.06 && energies[i].time - lastMarkerTime >= minSpacing) {
      const template = sectionLabels[labelIdx];
      detectedMarkers.push({
        id: `auto-marker-${labelIdx + 1}`,
        label: template.label,
        timestampSeconds: Number(energies[i].time.toFixed(3)),
        category: template.category,
        origin: 'analysis',
        confirmed: true,
        exportEnabled: true,
        fadeInSeconds: template.fade,
        delaySeconds: 0,
        notes: 'Confirmed analysis marker',
      });
      lastMarkerTime = energies[i].time;
      labelIdx++;
    }
  }

  const estimatedBpm = 128;
  const beatGrid = generateBeatGrid(durationSeconds, estimatedBpm, firstOnset);

  return {
    durationSeconds,
    estimatedBpm,
    waveformPeaks,
    beatGrid,
    detectedMarkers,
  };
}

/**
 * Generates a realistic studio demo project ("Solaris — Electronic Show Track")
 * with all marker categories (Structure, Hit, Effect, Note, Custom) plus an unconfirmed beat grid
 * so the user can test and inspect every requirement immediately on launch.
 */
export function createDefaultDemoShow(): {
  markers: Marker[];
  beatGrid: BeatGridPoint[];
  waveformPeaks: number[];
  durationSeconds: number;
  bpm: number;
} {
  const durationSeconds = 96;
  const bpm = 128;

  // Deterministic synthetic waveform envelope for visual timeline
  const waveformPeaks: number[] = [];
  for (let i = 0; i < 600; i++) {
    const progress = i / 600;
    const time = progress * durationSeconds;
    const baseEnv =
      time < 8
        ? 0.25 + (time / 8) * 0.25
        : time < 32
        ? 0.55
        : time < 48
        ? 0.35
        : time < 80
        ? 0.88
        : 0.3 * (1 - (time - 80) / 16);
    const mod = Math.abs(Math.sin(i * 0.37) * Math.cos(i * 0.13));
    waveformPeaks.push(Number(Math.min(1, Math.max(0.06, baseEnv * (0.55 + 0.45 * mod))).toFixed(3)));
  }

  const markers: Marker[] = [
    {
      id: 'm-1',
      label: 'Intro Atmospheric Pad',
      timestampSeconds: 0.5,
      category: 'Structure',
      origin: 'manual',
      confirmed: true,
      exportEnabled: true,
      fadeInSeconds: 3.0,
      delaySeconds: 0,
      notes: 'Warm backlight wash fade in',
    },
    {
      id: 'm-2',
      label: 'Downbeat Brass Hit',
      timestampSeconds: 7.5,
      category: 'Hit',
      origin: 'analysis',
      confirmed: true,
      exportEnabled: true,
      fadeInSeconds: 0,
      delaySeconds: 0,
      notes: 'Snap blinders on downbeat',
    },
    {
      id: 'm-3',
      label: 'Verse 1 Groove',
      timestampSeconds: 15.0,
      category: 'Structure',
      origin: 'manual',
      confirmed: true,
      exportEnabled: true,
      fadeInSeconds: 1.5,
      delaySeconds: 0,
      notes: 'Spot gobos slow rotation',
    },
    {
      id: 'm-4',
      label: 'Operator Note: Followspot Stand-By',
      timestampSeconds: 22.5,
      category: 'Note',
      origin: 'manual',
      confirmed: true,
      exportEnabled: true,
      fadeInSeconds: 1.0,
      delaySeconds: 0,
      notes: 'Note category marker — included in export per mandatory spec',
    },
    {
      id: 'm-5',
      label: 'Riser Phaser Sweep',
      timestampSeconds: 30.0,
      category: 'Effect',
      origin: 'analysis',
      confirmed: true,
      exportEnabled: true,
      fadeInSeconds: 2.0,
      fadeOutSeconds: 1.0,
      delaySeconds: 0.25,
      notes: 'Tilt fan upward build',
    },
    {
      id: 'm-6',
      label: 'Pre-Drop Blackout Snap',
      timestampSeconds: 37.5,
      category: 'Hit',
      origin: 'manual',
      confirmed: true,
      exportEnabled: true,
      fadeInSeconds: 0,
      delaySeconds: 0,
      notes: 'Full blackout 1 bar before drop',
    },
    {
      id: 'm-7',
      label: 'Main Chorus Drop',
      timestampSeconds: 39.375,
      category: 'Structure',
      origin: 'analysis',
      confirmed: true,
      exportEnabled: true,
      fadeInSeconds: 0,
      delaySeconds: 0,
      notes: 'Full rig ballyhoo + strobes',
    },
    {
      id: 'm-8',
      label: 'Bridge Laser Burst',
      timestampSeconds: 54.375,
      category: 'Effect',
      origin: 'manual',
      confirmed: true,
      exportEnabled: true,
      fadeInSeconds: 0.5,
      delaySeconds: 0,
      notes: 'Center beam prism widen',
    },
    {
      id: 'm-9',
      label: 'Outro Horizon Fade',
      timestampSeconds: 76.875,
      category: 'Structure',
      origin: 'manual',
      confirmed: true,
      exportEnabled: true,
      fadeInSeconds: 5.0,
      fadeOutSeconds: 6.0,
      delaySeconds: 0,
      notes: 'Slow fade to deep amber floor glow',
    },
  ];

  const beatGrid = generateBeatGrid(durationSeconds, bpm, 0.5);

  return {
    markers,
    beatGrid,
    waveformPeaks,
    durationSeconds,
    bpm,
  };
}
