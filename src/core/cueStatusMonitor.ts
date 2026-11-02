import { CompiledCue, Marker, MarkerCategory, TimecodeFrameRate } from '../types/cueforge';

export interface CueMonitorStatus {
  activeCue: {
    cueNumber: number;
    name: string;
    category: MarkerCategory;
    timestampSeconds: number;
    fadeInSeconds: number;
  } | null;
  nextCue: {
    cueNumber: number;
    name: string;
    category: MarkerCategory;
    timestampSeconds: number;
  } | null;
  fadeProgress: number; // 0.0 to 1.0
  countdownSeconds: number;
  countdownFrames: number;
  isTriggerMoment: boolean;
}

/**
 * Computes real-time HUD monitor state for playback and cue triggering.
 */
export function computeCueMonitorStatus(
  cues: CompiledCue[],
  markers: Marker[],
  playheadSeconds: number,
  frameRate: TimecodeFrameRate,
  triggerThresholdSeconds: number = 0.25
): CueMonitorStatus {
  if (cues.length === 0) {
    return {
      activeCue: null,
      nextCue: null,
      fadeProgress: 1.0,
      countdownSeconds: 0,
      countdownFrames: 0,
      isTriggerMoment: false,
    };
  }

  // Create a fast lookup map for source markers
  const markerMap = new Map<string, Marker>();
  for (const m of markers) {
    markerMap.set(m.id, m);
  }

  const safePlayhead = Number.isFinite(playheadSeconds) ? Math.max(0, playheadSeconds) : 0;

  // Cues with timestamps
  const cuesWithTimestamps = cues.map((cue) => {
    const marker = markerMap.get(cue.sourceMarkerId);
    const timestampSeconds = marker ? marker.timestampSeconds : 0;
    return {
      cueNumber: cue.cueNumber,
      name: cue.name,
      category: cue.category,
      timestampSeconds,
      fadeInSeconds: Math.max(0, cue.cueFadeIn || 0),
    };
  });

  // Sort by timestamp, tie-breaking deterministically by cueNumber
  cuesWithTimestamps.sort(
    (a, b) => a.timestampSeconds - b.timestampSeconds || a.cueNumber - b.cueNumber
  );

  // Active cue: highest timestamp <= safePlayhead
  let activeCue: (typeof cuesWithTimestamps)[0] | null = null;
  for (let i = cuesWithTimestamps.length - 1; i >= 0; i--) {
    if (cuesWithTimestamps[i].timestampSeconds <= safePlayhead + 0.001) {
      activeCue = cuesWithTimestamps[i];
      break;
    }
  }

  // Next cue: lowest timestamp > safePlayhead
  let nextCue: (typeof cuesWithTimestamps)[0] | null = null;
  for (let i = 0; i < cuesWithTimestamps.length; i++) {
    if (cuesWithTimestamps[i].timestampSeconds > safePlayhead + 0.001) {
      nextCue = cuesWithTimestamps[i];
      break;
    }
  }

  // Fade progress computation
  let fadeProgress = 1.0;
  let isTriggerMoment = false;

  if (activeCue) {
    const elapsed = safePlayhead - activeCue.timestampSeconds;
    if (activeCue.fadeInSeconds > 0) {
      fadeProgress = Math.min(1.0, Math.max(0.0, elapsed / activeCue.fadeInSeconds));
    } else {
      fadeProgress = 1.0;
    }

    if (elapsed >= -0.01 && elapsed <= triggerThresholdSeconds) {
      isTriggerMoment = true;
    }
  }

  // Countdown computation
  let countdownSeconds = 0;
  let countdownFrames = 0;

  if (nextCue) {
    countdownSeconds = Math.max(0, nextCue.timestampSeconds - safePlayhead);
    countdownFrames = Math.max(0, Math.round(countdownSeconds * frameRate));
  }

  return {
    activeCue: activeCue
      ? {
          cueNumber: activeCue.cueNumber,
          name: activeCue.name,
          category: activeCue.category,
          timestampSeconds: activeCue.timestampSeconds,
          fadeInSeconds: activeCue.fadeInSeconds,
        }
      : null,
    nextCue: nextCue
      ? {
          cueNumber: nextCue.cueNumber,
          name: nextCue.name,
          category: nextCue.category,
          timestampSeconds: nextCue.timestampSeconds,
        }
      : null,
    fadeProgress,
    countdownSeconds,
    countdownFrames,
    isTriggerMoment,
  };
}
