import {
  CompiledCue,
  CompiledShow,
  CompiledTimecodeEvent,
  ExportConfiguration,
  Marker,
} from '../types/cueforge';
import { computeTimecodeTimestamp } from './timecodeMath';

/**
 * Compiles confirmed & enabled markers into a grandMA3 Sequence and synchronized Timecode Show.
 *
 * Enforces the core requirement:
 * - Markers are the single source of truth for both sequences and timecode events.
 * - Automatically generated beat grids are NOT included here (they live in BeatGridPoint[]).
 * - Every confirmed marker with `exportEnabled: true` is included regardless of its category
 *   (Structure, Hit, Effect, Note, Custom are NEVER silently excluded).
 * - Markers are sorted chronologically.
 * - Sequentially numbered cues (Cue 1 -> First marker, Cue 2 -> Second marker, ...).
 * - Trigger type is always 'Go' (never 'Follow' or 'Time').
 * - 1-to-1-to-1 mapping: 1 Marker = 1 Cue = 1 Timecode Event targeting that Cue.
 */
export function compileShow(
  markers: Marker[],
  config: ExportConfiguration
): CompiledShow {
  const exportableMarkers: Marker[] = [];
  const excludedMarkers: Marker[] = [];

  for (const marker of markers) {
    if (marker.confirmed && marker.exportEnabled) {
      exportableMarkers.push(marker);
    } else {
      excludedMarkers.push(marker);
    }
  }

  // Sort all exportable markers chronologically (tie-break deterministically by ID)
  exportableMarkers.sort((a, b) => {
    if (a.timestampSeconds !== b.timestampSeconds) {
      return a.timestampSeconds - b.timestampSeconds;
    }
    return a.id.localeCompare(b.id);
  });

  const cues: CompiledCue[] = [];
  const events: CompiledTimecodeEvent[] = [];

  const token: 'Go+' | 'Goto' =
    config.executionMode === 'Goto(Status)' ? 'Goto' : 'Go+';

  exportableMarkers.forEach((marker, idx) => {
    const cueNumber = idx + 1; // Sequential 1-based numbering: Cue 1, Cue 2, ...
    const cleanLabel = marker.label.trim() || `Cue ${cueNumber}`;

    const cue: CompiledCue = {
      cueNumber,
      sourceMarkerId: marker.id,
      name: cleanLabel,
      category: marker.category,
      trigType: 'Go', // Mandatory: GO, never Follow or Time
      cueFadeIn: Math.max(0, marker.fadeInSeconds),
      cueFadeOut:
        marker.fadeOutSeconds !== undefined
          ? Math.max(0, marker.fadeOutSeconds)
          : undefined,
      cueDelay: Math.max(0, marker.delaySeconds),
    };

    const timing = computeTimecodeTimestamp(
      marker.timestampSeconds,
      config.frameRate,
      config.timecodeOffsetSeconds,
      config.latencyCompensationMs
    );

    const fadeOverrideSeconds =
      marker.eventFadeOverrideSeconds !== undefined
        ? marker.eventFadeOverrideSeconds
        : config.globalEventFadeOverrideSeconds;

    const event: CompiledTimecodeEvent = {
      eventIndex: cueNumber,
      sourceMarkerId: marker.id,
      label: cleanLabel,
      token,
      executionMode: config.executionMode,
      targetSequenceId: config.sequenceId,
      targetTrackGroupIndex: 1,
      targetTrackIndex: 1,
      cueDestinationNumber: cueNumber,
      cueDestinationName: cleanLabel,
      timing,
      fadeOverrideSeconds,
    };

    cues.push(cue);
    events.push(event);
  });

  return {
    config,
    exportableMarkers,
    excludedMarkers,
    cues,
    events,
  };
}
