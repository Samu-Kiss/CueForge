import {
  BeatGridPoint,
  ExportConfiguration,
  Marker,
  MarkerCategory,
  MarkerOrigin,
  TimecodeExecutionMode,
  TimecodeFrameRate,
} from '../types/cueforge';

export const CUEFORGE_PROJECT_FORMAT = 'CueForgeProject' as const;
export const CUEFORGE_PROJECT_SCHEMA_VERSION = '1.0' as const;
export const CUEFORGE_LOCAL_STORAGE_KEY = 'cueforge_project_autosave_v1';

const VALID_CATEGORIES: ReadonlySet<MarkerCategory> = new Set([
  'Structure',
  'Hit',
  'Effect',
  'Note',
  'Custom',
]);

const VALID_ORIGINS: ReadonlySet<MarkerOrigin> = new Set([
  'manual',
  'analysis',
]);

const VALID_FRAME_RATES: ReadonlySet<TimecodeFrameRate> = new Set([
  24,
  25,
  29.97,
  30,
]);

const VALID_EXECUTION_MODES: ReadonlySet<TimecodeExecutionMode> = new Set([
  'Go+',
  'Goto(Status)',
]);

export interface CueForgeProjectData {
  config: ExportConfiguration;
  markers: Marker[];
  beatGrid: BeatGridPoint[];
  bpm: number;
  timeSignature?: { beats: number; unit: number };
  waveformPeaks?: number[];
}

export interface CueForgeProjectFile extends CueForgeProjectData {
  format: typeof CUEFORGE_PROJECT_FORMAT;
  schemaVersion: typeof CUEFORGE_PROJECT_SCHEMA_VERSION;
  savedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CATEGORY_LOOKUP: Record<string, MarkerCategory> = {
  structure: 'Structure',
  hit: 'Hit',
  effect: 'Effect',
  note: 'Note',
  custom: 'Custom',
};

export function sanitizeMarker(raw: unknown, fallbackIndex: number): Marker {
  if (!isRecord(raw)) {
    throw new Error(`Invalid marker at index ${fallbackIndex}: expected object.`);
  }

  const id =
    typeof raw.id === 'string' && raw.id.trim().length > 0
      ? raw.id.trim()
      : `marker-${fallbackIndex + 1}`;

  const label =
    typeof raw.label === 'string' && raw.label.trim().length > 0
      ? raw.label.trim()
      : `Cue ${fallbackIndex + 1}`;

  const timestampSeconds = Number(raw.timestampSeconds);
  if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0) {
    throw new Error(
      `Invalid timestampSeconds for marker "${label}" at index ${fallbackIndex}.`
    );
  }

  const rawCategoryStr =
    typeof raw.category === 'string' ? raw.category.trim().toLowerCase() : '';
  const category: MarkerCategory = VALID_CATEGORIES.has(
    raw.category as MarkerCategory
  )
    ? (raw.category as MarkerCategory)
    : (CATEGORY_LOOKUP[rawCategoryStr] ?? 'Custom');

  const rawOriginStr =
    typeof raw.origin === 'string' ? raw.origin.trim().toLowerCase() : '';
  const origin: MarkerOrigin = VALID_ORIGINS.has(raw.origin as MarkerOrigin)
    ? (raw.origin as MarkerOrigin)
    : rawOriginStr === 'analysis'
      ? 'analysis'
      : 'manual';

  const confirmed = typeof raw.confirmed === 'boolean' ? raw.confirmed : true;
  const exportEnabled =
    typeof raw.exportEnabled === 'boolean' ? raw.exportEnabled : true;

  const fadeInSeconds =
    typeof raw.fadeInSeconds === 'number' &&
    Number.isFinite(raw.fadeInSeconds) &&
    raw.fadeInSeconds >= 0
      ? raw.fadeInSeconds
      : 0;

  const fadeOutSeconds =
    typeof raw.fadeOutSeconds === 'number' &&
    Number.isFinite(raw.fadeOutSeconds) &&
    raw.fadeOutSeconds >= 0
      ? raw.fadeOutSeconds
      : undefined;

  const delaySeconds =
    typeof raw.delaySeconds === 'number' &&
    Number.isFinite(raw.delaySeconds) &&
    raw.delaySeconds >= 0
      ? raw.delaySeconds
      : 0;

  const eventFadeOverrideSeconds =
    typeof raw.eventFadeOverrideSeconds === 'number' &&
    Number.isFinite(raw.eventFadeOverrideSeconds) &&
    raw.eventFadeOverrideSeconds >= 0
      ? raw.eventFadeOverrideSeconds
      : undefined;

  const notes =
    typeof raw.notes === 'string' && raw.notes.length > 0
      ? raw.notes
      : undefined;

  const marker: Marker = {
    id,
    label,
    timestampSeconds,
    category,
    origin,
    confirmed,
    exportEnabled,
    fadeInSeconds,
    delaySeconds,
  };

  if (fadeOutSeconds !== undefined) {
    marker.fadeOutSeconds = fadeOutSeconds;
  }
  if (eventFadeOverrideSeconds !== undefined) {
    marker.eventFadeOverrideSeconds = eventFadeOverrideSeconds;
  }
  if (notes !== undefined) {
    marker.notes = notes;
  }

  return marker;
}

export function ensureUniqueMarkerIds(markers: Marker[]): Marker[] {
  const usedIds = new Set<string>();
  return markers.map((marker) => {
    let uniqueId = marker.id;
    let suffix = 1;
    while (usedIds.has(uniqueId)) {
      uniqueId = `${marker.id}-${suffix}`;
      suffix++;
    }
    usedIds.add(uniqueId);
    return uniqueId === marker.id ? marker : { ...marker, id: uniqueId };
  });
}

export function sanitizeBeatGridPoint(
  raw: unknown,
  fallbackIndex: number
): BeatGridPoint {
  if (!isRecord(raw)) {
    throw new Error(
      `Invalid beat grid point at index ${fallbackIndex}: expected object.`
    );
  }

  const timestampSeconds = Number(raw.timestampSeconds);
  const bar = Math.max(1, Math.floor(Number(raw.bar) || 1));
  const beat = Math.max(1, Math.floor(Number(raw.beat) || 1));
  const bpm = Math.max(40, Math.min(240, Number(raw.bpm) || 120));

  if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0) {
    throw new Error(
      `Invalid timestampSeconds in beatGrid at index ${fallbackIndex}.`
    );
  }

  const id =
    typeof raw.id === 'string' && raw.id.trim().length > 0
      ? raw.id.trim()
      : `grid-${bar}-${beat}`;

  return {
    id,
    timestampSeconds,
    bar,
    beat,
    bpm,
  };
}

export function sanitizeExportConfiguration(raw: unknown): ExportConfiguration {
  if (!isRecord(raw)) {
    throw new Error('Invalid project configuration: expected object.');
  }

  const songTitle =
    typeof raw.songTitle === 'string' && raw.songTitle.trim().length > 0
      ? raw.songTitle.trim()
      : 'Untitled Show';

  const sequenceId = Math.max(1, Math.floor(Number(raw.sequenceId) || 101));
  const sequenceName =
    typeof raw.sequenceName === 'string' && raw.sequenceName.trim().length > 0
      ? raw.sequenceName.trim()
      : `${songTitle} Seq`;

  const timecodeId = Math.max(1, Math.floor(Number(raw.timecodeId) || 101));
  const timecodeName =
    typeof raw.timecodeName === 'string' && raw.timecodeName.trim().length > 0
      ? raw.timecodeName.trim()
      : `${songTitle} TC`;

  const macroId = Math.max(1, Math.floor(Number(raw.macroId) || 101));

  const rawFps = Number(raw.frameRate);
  const frameRate: TimecodeFrameRate = VALID_FRAME_RATES.has(
    rawFps as TimecodeFrameRate
  )
    ? (rawFps as TimecodeFrameRate)
    : 30;

  const timecodeOffsetSeconds =
    typeof raw.timecodeOffsetSeconds === 'number' &&
    Number.isFinite(raw.timecodeOffsetSeconds) &&
    raw.timecodeOffsetSeconds >= 0
      ? raw.timecodeOffsetSeconds
      : 0;

  const latencyCompensationMs =
    typeof raw.latencyCompensationMs === 'number' &&
    Number.isFinite(raw.latencyCompensationMs)
      ? raw.latencyCompensationMs
      : 0;

  const globalEventFadeOverrideSeconds =
    typeof raw.globalEventFadeOverrideSeconds === 'number' &&
    Number.isFinite(raw.globalEventFadeOverrideSeconds) &&
    raw.globalEventFadeOverrideSeconds >= 0
      ? raw.globalEventFadeOverrideSeconds
      : undefined;

  const executionMode: TimecodeExecutionMode = VALID_EXECUTION_MODES.has(
    raw.executionMode as TimecodeExecutionMode
  )
    ? (raw.executionMode as TimecodeExecutionMode)
    : 'Go+';

  const allowOverwriteExistingObjects =
    typeof raw.allowOverwriteExistingObjects === 'boolean'
      ? raw.allowOverwriteExistingObjects
      : false;

  const songDurationSeconds =
    typeof raw.songDurationSeconds === 'number' &&
    Number.isFinite(raw.songDurationSeconds) &&
    raw.songDurationSeconds > 0
      ? raw.songDurationSeconds
      : 60;

  const config: ExportConfiguration = {
    songTitle,
    ma3Version: '2.5.x',
    sequenceId,
    sequenceName,
    timecodeId,
    timecodeName,
    macroId,
    frameRate,
    timecodeOffsetSeconds,
    latencyCompensationMs,
    executionMode,
    allowOverwriteExistingObjects,
    songDurationSeconds,
  };

  if (globalEventFadeOverrideSeconds !== undefined) {
    config.globalEventFadeOverrideSeconds = globalEventFadeOverrideSeconds;
  }

  return config;
}

/**
 * Serializes a complete CueForge project into a formatted JSON string.
 */
export function serializeProjectToJson(project: CueForgeProjectData): string {
  const sanitizedMarkers = ensureUniqueMarkerIds(
    project.markers.map((m, idx) => sanitizeMarker(m, idx))
  );
  const sanitizedBeatGrid = project.beatGrid.map((g, idx) =>
    sanitizeBeatGridPoint(g, idx)
  );
  const sanitizedConfig = sanitizeExportConfiguration(project.config);
  const safeBpm = Math.max(40, Math.min(240, Number(project.bpm) || 120));

  const payload: CueForgeProjectFile = {
    format: CUEFORGE_PROJECT_FORMAT,
    schemaVersion: CUEFORGE_PROJECT_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    config: sanitizedConfig,
    markers: sanitizedMarkers,
    beatGrid: sanitizedBeatGrid,
    bpm: safeBpm,
    ...(project.timeSignature
      ? {
          timeSignature: {
            beats: Math.max(1, Math.min(16, Math.floor(Number(project.timeSignature.beats)) || 4)),
            unit: Number(project.timeSignature.unit) === 8 ? 8 : 4,
          },
        }
      : {}),
    ...(Array.isArray(project.waveformPeaks)
      ? {
          waveformPeaks: project.waveformPeaks.filter(
            (n): n is number => typeof n === 'number' && Number.isFinite(n)
          ),
        }
      : {}),
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * Deserializes and validates a CueForge project from a JSON string.
 * Throws a descriptive error if the JSON is malformed or missing mandatory project fields.
 */
export function deserializeProjectFromJson(
  jsonText: string
): CueForgeProjectFile {
  const cleanedJson = (jsonText ?? '').replace(/^\uFEFF/, '').trim();
  if (!cleanedJson) {
    throw new Error('Cannot deserialize empty project JSON.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanedJson);
  } catch (err) {
    throw new Error(
      `Malformed project JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!isRecord(parsed)) {
    throw new Error('Invalid project JSON root: expected an object.');
  }

  if (!isRecord(parsed.config)) {
    throw new Error('Invalid project JSON: missing "config" object.');
  }

  if (!Array.isArray(parsed.markers)) {
    throw new Error('Invalid project JSON: missing "markers" array.');
  }

  const config = sanitizeExportConfiguration(parsed.config);
  const markers = ensureUniqueMarkerIds(
    parsed.markers.map((m, idx) => sanitizeMarker(m, idx))
  );
  const beatGrid = Array.isArray(parsed.beatGrid)
    ? parsed.beatGrid.map((g, idx) => sanitizeBeatGridPoint(g, idx))
    : [];
  const bpm = Math.max(40, Math.min(240, Number(parsed.bpm) || 120));
  const savedAt =
    typeof parsed.savedAt === 'string' && parsed.savedAt.trim().length > 0
      ? parsed.savedAt
      : new Date().toISOString();

  const waveformPeaks = Array.isArray(parsed.waveformPeaks)
    ? parsed.waveformPeaks.filter(
        (n): n is number => typeof n === 'number' && Number.isFinite(n)
      )
    : undefined;

  return {
    format: CUEFORGE_PROJECT_FORMAT,
    schemaVersion: CUEFORGE_PROJECT_SCHEMA_VERSION,
    savedAt,
    config,
    markers,
    beatGrid,
    bpm,
    ...(isRecord(parsed.timeSignature)
      ? {
          timeSignature: {
            beats: Math.max(1, Math.min(16, Math.floor(Number(parsed.timeSignature.beats)) || 4)),
            unit: Number(parsed.timeSignature.unit) === 8 ? 8 : 4,
          },
        }
      : {}),
    ...(waveformPeaks !== undefined ? { waveformPeaks } : {}),
  };
}

/**
 * Saves a CueForge project to `localStorage` for automatic session persistence.
 */
export function saveProjectToLocalStorage(
  project: CueForgeProjectData,
  storageKey: string = CUEFORGE_LOCAL_STORAGE_KEY
): boolean {
  try {
    if (typeof globalThis.localStorage === 'undefined') {
      return false;
    }
    const serialized = serializeProjectToJson(project);
    globalThis.localStorage.setItem(storageKey, serialized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads a CueForge project from `localStorage`, returning `null` if none exists or if invalid.
 */
export function loadProjectFromLocalStorage(
  storageKey: string = CUEFORGE_LOCAL_STORAGE_KEY
): CueForgeProjectFile | null {
  try {
    if (typeof globalThis.localStorage === 'undefined') {
      return null;
    }
    const raw = globalThis.localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }
    return deserializeProjectFromJson(raw);
  } catch {
    return null;
  }
}

/**
 * Clears the saved CueForge project from `localStorage`.
 */
export function clearProjectFromLocalStorage(
  storageKey: string = CUEFORGE_LOCAL_STORAGE_KEY
): void {
  try {
    if (typeof globalThis.localStorage !== 'undefined') {
      globalThis.localStorage.removeItem(storageKey);
    }
  } catch {
    // Ignore storage access errors
  }
}
