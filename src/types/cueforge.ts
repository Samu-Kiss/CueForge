/**
 * CueForge Core Domain Types
 *
 * Implements the strict invariant:
 * ONE Confirmed Exportable Marker = ONE grandMA3 Cue = ONE Timecode Event
 */

/**
 * Marker categories supported in CueForge.
 * All confirmed markers in any of these categories are exported by default
 * unless explicitly disabled by the user (`exportEnabled: false`).
 * Note: Unconfirmed beat grids live in `BeatGridPoint` and are NEVER exported automatically.
 */
export type MarkerCategory =
  | 'Structure'
  | 'Hit'
  | 'Effect'
  | 'Note'
  | 'Custom';

export type MarkerOrigin = 'manual' | 'analysis';

/**
 * A confirmed marker in the CueForge timeline editor.
 * Markers are the single source of truth for both sequences and timecode events.
 */
export interface Marker {
  /** Unique internal identifier */
  id: string;
  /** Label that will become the exact grandMA3 Cue Name */
  label: string;
  /** Audio timestamp in seconds (e.g. 12.500) */
  timestampSeconds: number;
  /** Category for organization (never silently excluded from export) */
  category: MarkerCategory;
  /** How the marker was created */
  origin: MarkerOrigin;
  /** Whether the marker is confirmed in the editor */
  confirmed: boolean;
  /** Users may explicitly disable export for individual markers if needed (default: true) */
  exportEnabled: boolean;
  /** Editable cue fade time in seconds (in-fade, optional out-fade) */
  fadeInSeconds: number;
  fadeOutSeconds?: number;
  /** Editable cue delay time in seconds */
  delaySeconds: number;
  /** Optional per-event fade override when supported */
  eventFadeOverrideSeconds?: number;
  /** Optional programmer note/comment */
  notes?: string;
}

/**
 * Automatically generated beat grid point.
 * Beat grids are NEVER automatically converted into cues unless the user
 * explicitly promotes/confirms a beat grid point into a Marker.
 */
export interface BeatGridPoint {
  id: string;
  timestampSeconds: number;
  bar: number;
  beat: number;
  bpm: number;
}

/**
 * Supported SMPTE / grandMA3 Timecode frame rates.
 */
export type TimecodeFrameRate = 24 | 25 | 29.97 | 30;

/**
 * Timecode execution mode.
 * - 'Go+': Default target-specific Go+ action (`Go+` with explicit `CueDestination`).
 * - 'Goto(Status)': Optional advanced execution mode (`Goto` with status tracking).
 */
export type TimecodeExecutionMode = 'Go+' | 'Goto(Status)';

/**
 * Configuration for timing, synchronization, and grandMA3 object addressing.
 */
export interface ExportConfiguration {
  /** Song / Show title */
  songTitle: string;
  /** Target grandMA3 version (validated against 2.5.x) */
  ma3Version: '2.5.x';
  /** Target Sequence pool ID in grandMA3 (e.g., 101) */
  sequenceId: number;
  /** Sequence name (defaults to songTitle) */
  sequenceName: string;
  /** Target Timecode Show pool ID in grandMA3 (e.g., 101) */
  timecodeId: number;
  /** Timecode Show name (defaults to songTitle) */
  timecodeName: string;
  /** Target Macro pool ID in grandMA3 (e.g., 101) */
  macroId: number;
  /** Timecode frame rate (fps) */
  frameRate: TimecodeFrameRate;
  /** Base timecode offset in seconds (e.g., 3600 for 01:00:00:00) */
  timecodeOffsetSeconds: number;
  /** Global latency compensation in milliseconds (can be negative or positive, default 0) */
  latencyCompensationMs: number;
  /** Optional global event fade override in seconds (undefined = use cue timing) */
  globalEventFadeOverrideSeconds?: number;
  /** Execution mode: 'Go+' (default) or 'Goto(Status)' (advanced) */
  executionMode: TimecodeExecutionMode;
  /** Explicit user authorization required to overwrite existing MA3 objects */
  allowOverwriteExistingObjects: boolean;
  /** Total song duration in seconds */
  songDurationSeconds: number;
}

/**
 * A compiled grandMA3 Sequence Cue.
 * Contains no programmed lighting values (placeholder for subsequent programming in MA3).
 */
export interface CompiledCue {
  /** Sequential 1-based Cue number (1, 2, 3...) */
  cueNumber: number;
  /** Source marker ID */
  sourceMarkerId: string;
  /** Cue name preserved strictly from source marker label */
  name: string;
  /** Source marker category */
  category: MarkerCategory;
  /** Always 'Go' per core requirement (never Follow or Time) */
  trigType: 'Go';
  /** Cue in-fade time in seconds */
  cueFadeIn: number;
  /** Optional cue out-fade time in seconds */
  cueFadeOut?: number;
  /** Cue delay time in seconds */
  cueDelay: number;
}

/**
 * Structured SMPTE Timecode representation (HH:MM:SS:FF) and MA3 internal tick count.
 */
export interface TimecodeTimestamp {
  /** Original marker audio position in seconds */
  rawAudioSeconds: number;
  /** Relative song time after latency compensation (seconds) */
  relativeSeconds: number;
  /** Final absolute timecode time after timecode offset + latency compensation (seconds) */
  absoluteSeconds: number;
  /** Total discrete timecode frames from 00:00:00:00 */
  totalFrames: number;
  /** Relative discrete frames from song start */
  relativeFrames: number;
  /** Formatted relative time (MM:SS.mmm) */
  formattedRelative: string;
  /** Formatted absolute SMPTE timecode (HH:MM:SS:FF) */
  formattedAbsoluteSmpte: string;
  /** Formatted grandMA3 time string (e.g. 1h00m12.500s) */
  formattedMa3Time: string;
  /** grandMA3 internal high-resolution ticks (1 second = 16,777,216 ticks) */
  ma3InternalTicks: number;
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
}

/**
 * A compiled grandMA3 Timecode Event on the Sequence's CmdSubTrack.
 */
export interface CompiledTimecodeEvent {
  /** 1-based event index on the track's CmdSubTrack */
  eventIndex: number;
  /** Source marker ID */
  sourceMarkerId: string;
  /** Event label (matches cue name / marker label) */
  label: string;
  /** Action token ('Go+' by default, or 'Goto' when Goto(Status) is enabled) */
  token: 'Go+' | 'Goto';
  /** Explicit execution mode */
  executionMode: TimecodeExecutionMode;
  /** Target Sequence pool ID */
  targetSequenceId: number;
  /** Target TrackGroup index (1) */
  targetTrackGroupIndex: 1;
  /** Target Track index (1 for user sequence track, or 2 after Marker track in Lua) */
  targetTrackIndex: 1;
  /** Explicit destination cue number (1, 2, 3...) */
  cueDestinationNumber: number;
  /** Explicit destination cue name */
  cueDestinationName: string;
  /** Computed timing and frame synchronization metadata */
  timing: TimecodeTimestamp;
  /** Optional fade override in seconds */
  fadeOverrideSeconds?: number;
}

/**
 * Compiled Show Output enforcing:
 * - ONE sequence containing all markers as cues
 * - ONE timecode show
 * - ONE track targeting that sequence
 * - ONE timecode event per cue
 * - ONE GO action per event, with an explicit cue destination
 */
export interface CompiledShow {
  config: ExportConfiguration;
  exportableMarkers: Marker[];
  excludedMarkers: Marker[];
  cues: CompiledCue[];
  events: CompiledTimecodeEvent[];
}

/**
 * Individual validation check item for Export Validation.
 */
export interface ValidationCheckResult {
  id: string;
  title: string;
  passed: boolean;
  details: string;
  severity: 'error' | 'warning';
}

/**
 * Comprehensive Export Validation Report.
 */
export interface ExportValidationReport {
  isValid: boolean;
  checks: ValidationCheckResult[];
  errors: string[];
  warnings: string[];
}
