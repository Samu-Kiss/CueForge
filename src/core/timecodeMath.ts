import { TimecodeFrameRate, TimecodeTimestamp } from '../types/cueforge';

/**
 * grandMA3 internal clock resolution: 1 second = 16,777,216 (2^24) ticks.
 */
export const MA3_TICKS_PER_SECOND = 16777216;

/**
 * Converts an audio timestamp in seconds into a complete `TimecodeTimestamp`
 * preserving exact frame alignment, configurable offset, and latency compensation.
 *
 * Do NOT introduce any additional timing offset without explicit configuration.
 */
export function computeTimecodeTimestamp(
  rawAudioSeconds: number,
  frameRate: TimecodeFrameRate,
  timecodeOffsetSeconds: number = 0,
  latencyCompensationMs: number = 0
): TimecodeTimestamp {
  const latencySeconds = latencyCompensationMs / 1000;
  // Relative time within the song after latency compensation (clamped to >= 0)
  const relativeSeconds = Math.max(0, rawAudioSeconds + latencySeconds);
  // Final absolute time including configured timecode offset
  const absoluteSeconds = Math.max(0, timecodeOffsetSeconds + relativeSeconds);

  // Use exact frame math based on configured frame rate
  const totalFrames = Math.round(absoluteSeconds * frameRate);
  const relativeFrames = Math.round(relativeSeconds * frameRate);

  // Decompose into HH:MM:SS:FF using integer frame base (30 for 29.97/30, 25 for 25, 24 for 24)
  const nominalFps = frameRate === 29.97 ? 30 : frameRate;
  const exactSecFromFrames = totalFrames / frameRate;

  const wholeSecondsTotal = Math.floor(totalFrames / nominalFps);
  const frames = totalFrames % nominalFps;
  const hours = Math.floor(wholeSecondsTotal / 3600);
  const minutes = Math.floor((wholeSecondsTotal % 3600) / 60);
  const seconds = wholeSecondsTotal % 60;

  const formattedAbsoluteSmpte = [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
    String(frames).padStart(2, '0'),
  ].join(':');

  // Relative display: MM:SS.mmm (with hours if >= 3600s)
  const relWholeSeconds = Math.floor(relativeSeconds);
  const relMillis = Math.round((relativeSeconds - relWholeSeconds) * 1000);
  const relMin = Math.floor(relWholeSeconds / 60);
  const relSec = relWholeSeconds % 60;
  const formattedRelative = `${String(relMin).padStart(2, '0')}:${String(relSec).padStart(2, '0')}.${String(relMillis).padStart(3, '0')}`;

  // grandMA3 native time format: XhXXmXX.XXXs
  const ma3Hours = Math.floor(exactSecFromFrames / 3600);
  const ma3Minutes = Math.floor((exactSecFromFrames % 3600) / 60);
  const ma3RemSeconds = (exactSecFromFrames % 60).toFixed(3);
  const formattedMa3Time = `${ma3Hours}h${String(ma3Minutes).padStart(2, '0')}m${ma3RemSeconds.padStart(6, '0')}s`;

  // grandMA3 internal ticks derived from exact frame-aligned absolute time
  const ma3InternalTicks = Math.round(exactSecFromFrames * MA3_TICKS_PER_SECOND);

  return {
    rawAudioSeconds,
    relativeSeconds,
    absoluteSeconds: exactSecFromFrames,
    totalFrames,
    relativeFrames,
    formattedRelative,
    formattedAbsoluteSmpte,
    formattedMa3Time,
    ma3InternalTicks,
    hours,
    minutes,
    seconds,
    frames,
  };
}

/**
 * Parses an SMPTE string (HH:MM:SS:FF) into seconds at the given frame rate.
 */
export function parseSmpteOffsetToSeconds(
  smpte: string,
  frameRate: TimecodeFrameRate
): number {
  const parts = smpte.trim().split(':').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0)) {
    return 0;
  }
  const [hh, mm, ss, ff] = parts;
  const nominalFps = frameRate === 29.97 ? 30 : frameRate;
  const totalFrames = ((hh * 3600 + mm * 60 + ss) * nominalFps) + ff;
  return totalFrames / frameRate;
}

/**
 * Formats seconds into an SMPTE offset string (HH:MM:SS:FF).
 */
export function formatSecondsToSmpte(
  seconds: number,
  frameRate: TimecodeFrameRate
): string {
  return computeTimecodeTimestamp(seconds, frameRate, 0, 0).formattedAbsoluteSmpte;
}
