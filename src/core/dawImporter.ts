import {
  Marker,
  MarkerCategory,
  TimecodeFrameRate,
} from '../types/cueforge';
import {
  CueForgeProjectFile,
  deserializeProjectFromJson,
  ensureUniqueMarkerIds,
  sanitizeMarker,
} from './projectPersistence';

export type DawImportFormat = 'reaper-csv' | 'audacity-txt' | 'cueforge-json';

export interface DawImportOptions {
  /** Frame rate used if timestamps are formatted as SMPTE HH:MM:SS:FF (default: 30) */
  frameRate?: TimecodeFrameRate;
  /** Default fade-in time in seconds for imported DAW markers without explicit fade (default: 0) */
  defaultFadeInSeconds?: number;
  /** Default delay time in seconds for imported DAW markers without explicit delay (default: 0) */
  defaultDelaySeconds?: number;
  /** Tempo in BPM used when converting Reaper musical Measures.Beats (M.B.xx) timestamps (default: 120) */
  bpm?: number;
  /** Time signature numerator (beats per bar) used for Reaper Measures.Beats (M.B.xx) timestamps (default: 4) */
  beatsPerBar?: number;
}

export interface DawImportResult {
  format: DawImportFormat;
  markers: Marker[];
  warnings: string[];
  /** Present when importing a full CueForge Project JSON file */
  project?: CueForgeProjectFile;
}

const VALID_CATEGORIES_MAP: Record<string, MarkerCategory> = {
  structure: 'Structure',
  hit: 'Hit',
  effect: 'Effect',
  note: 'Note',
  custom: 'Custom',
};

function sortMarkersChronologically(markers: Marker[]): Marker[] {
  return [...markers].sort((a, b) => {
    if (a.timestampSeconds !== b.timestampSeconds) {
      return a.timestampSeconds - b.timestampSeconds;
    }
    return a.id.localeCompare(b.id);
  });
}

/**
 * Infers or preserves a `MarkerCategory` from an explicit category string or marker label.
 */
export function inferMarkerCategory(
  label: string,
  explicitCategory?: string
): MarkerCategory {
  if (explicitCategory) {
    const normalized = explicitCategory.trim().toLowerCase();
    if (VALID_CATEGORIES_MAP[normalized]) {
      return VALID_CATEGORIES_MAP[normalized];
    }
  }

  const trimmed = label.trim();

  // Check bracketed or prefixed tags like "[Hit] Brass" or "Effect: Strobe"
  const tagMatch = trimmed.match(/^\[?(structure|hit|effect|note|custom)\]?[:\s-]/i);
  if (tagMatch) {
    const tagKey = tagMatch[1].toLowerCase();
    if (VALID_CATEGORIES_MAP[tagKey]) {
      return VALID_CATEGORIES_MAP[tagKey];
    }
  }

  const lower = trimmed.toLowerCase();

  if (/\b(note|comment|stand-?by|operator|memo|cue\s*note)\b/.test(lower)) {
    return 'Note';
  }
  if (
    /\b(effect|fx|strobe|sweep|laser|phaser|riser|flyout|ballyhoo|prism|chase)\b/.test(
      lower
    )
  ) {
    return 'Effect';
  }
  if (
    /\b(hit|drop|snap|impact|accent|stab|punch|blinder|blackout|burst|downbeat)\b/.test(
      lower
    )
  ) {
    return 'Hit';
  }
  if (
    /\b(intro|verse|chorus|bridge|outro|build|breakdown|pre-?chorus|hook|interlude|solo|coda|section|pad|groove|wash|fade)\b/.test(
      lower
    )
  ) {
    return 'Structure';
  }
  if (/\b(custom)\b/.test(lower)) {
    return 'Custom';
  }

  return 'Structure';
}

/**
 * Parses a timestamp string into seconds.
 * Supports:
 * - Decimal seconds: "12.500", "0.5", "45" (and European decimal comma "12,500")
 * - MM:SS.mmm: "0:01.500", "01:30.250"
 * - HH:MM:SS.mmm: "00:01:30.500"
 * - SMPTE HH:MM:SS:FF or drop-frame HH:MM:SS;FF: "00:01:10:15", "00:01:10;15"
 * - Reaper Measures.Beats (M.B.xx): "1.1.00", "5.3.50" (using bpm & beatsPerBar)
 */
export function parseFlexibleTimestamp(
  raw: string,
  frameRate: TimecodeFrameRate = 30,
  bpm: number = 120,
  beatsPerBar: number = 4
): number | null {
  const cleaned = (raw ?? '').replace(/^\uFEFF/, '').trim();
  if (!cleaned) {
    return null;
  }

  // Plain decimal seconds (dot or European comma decimal separator, non-negative)
  if (/^\d+([.,]\d+)?$/.test(cleaned)) {
    const val = Number(cleaned.replace(',', '.'));
    return Number.isFinite(val) && val >= 0 ? val : null;
  }

  // Reaper musical Measures.Beats.Hundredths format: e.g. "1.1.00" or "12.3.50"
  const measuresBeatsMatch = cleaned.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (measuresBeatsMatch) {
    const bar = Number(measuresBeatsMatch[1]);
    const beat = Number(measuresBeatsMatch[2]);
    const subStr = measuresBeatsMatch[3];
    const subVal = Number(subStr);
    const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
    const safeBeatsPerBar =
      Number.isInteger(beatsPerBar) && beatsPerBar >= 1 ? beatsPerBar : 4;

    if (
      !Number.isInteger(bar) ||
      bar < 1 ||
      !Number.isInteger(beat) ||
      beat < 1 ||
      beat > safeBeatsPerBar ||
      !Number.isInteger(subVal) ||
      subVal < 0
    ) {
      return null;
    }

    const divisor = subStr.length === 3 ? 1000 : 100;
    if (subVal >= divisor) {
      return null;
    }

    const totalBeats =
      (bar - 1) * safeBeatsPerBar + (beat - 1) + subVal / divisor;
    const seconds = totalBeats * (60 / safeBpm);
    return Number(seconds.toFixed(4));
  }

  // Normalize SMPTE drop-frame semicolon (HH:MM:SS;FF -> HH:MM:SS:FF)
  const colonNormalized = cleaned.replace(/^(\d+:\d+:\d+);(\d+)$/, '$1:$2');
  const parts = colonNormalized.split(':');

  // M:SS or M:SS.mmm
  if (parts.length === 2) {
    const minutes = Number(parts[0]);
    const seconds = Number(parts[1].replace(',', '.'));
    if (
      !Number.isInteger(minutes) ||
      minutes < 0 ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      seconds >= 60
    ) {
      return null;
    }
    return minutes * 60 + seconds;
  }

  // H:MM:SS or H:MM:SS.mmm
  if (parts.length === 3) {
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    const seconds = Number(parts[2].replace(',', '.'));
    if (
      !Number.isInteger(hours) ||
      hours < 0 ||
      !Number.isInteger(minutes) ||
      minutes < 0 ||
      minutes >= 60 ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      seconds >= 60
    ) {
      return null;
    }
    return hours * 3600 + minutes * 60 + seconds;
  }

  // HH:MM:SS:FF (SMPTE frames)
  if (parts.length === 4) {
    const [hh, mm, ss, ff] = parts.map(Number);
    const nominalFps = frameRate === 29.97 ? 30 : frameRate;
    if (
      [hh, mm, ss, ff].some((n) => !Number.isInteger(n) || n < 0) ||
      mm >= 60 ||
      ss >= 60 ||
      ff >= nominalFps
    ) {
      return null;
    }
    const totalFrames = (hh * 3600 + mm * 60 + ss) * nominalFps + ff;
    return Number((totalFrames / frameRate).toFixed(4));
  }

  return null;
}

/**
 * Detects whether a CSV line is comma-delimited or semicolon-delimited outside quotes.
 */
function detectCsvDelimiter(line: string): ',' | ';' {
  let inQuotes = false;
  let commaCount = 0;
  let semicolonCount = 0;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes) {
      if (ch === ',') commaCount++;
      else if (ch === ';') semicolonCount++;
    }
  }

  return semicolonCount > commaCount ? ';' : ',';
}

/**
 * Parses a single RFC-4180 CSV line into fields, handling quoted strings and escaped quotes.
 */
export function parseCsvLine(
  line: string,
  delimiter: ',' | ';' = ','
): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

const KNOWN_HEADER_COLUMNS = new Set([
  '#',
  'id',
  'number',
  'name',
  'label',
  'title',
  'start',
  'time',
  'timestamp',
  'position',
  'end',
  'length',
  'color',
  'category',
  'type',
  'fadein',
  'fade_in',
  'fade',
  'fadeout',
  'fade_out',
  'delay',
  'notes',
  'note',
  'comment',
]);

/**
 * Parses Reaper Marker/Region CSV exports into confirmed CueForge `Marker` objects.
 *
 * Typical Reaper CSV columns: `#,Name,Start,End,Length,Color`
 * Also supports `;` delimiters, `Measures.Beats` timestamps, and optional
 * `Category`, `FadeIn`, `FadeOut`, `Delay`, `Notes` columns.
 */
export function parseReaperMarkerCsv(
  csvContent: string,
  options: DawImportOptions = {}
): DawImportResult {
  const frameRate = options.frameRate ?? 30;
  const defaultFadeIn = options.defaultFadeInSeconds ?? 0;
  const defaultDelay = options.defaultDelaySeconds ?? 0;
  const bpm = options.bpm ?? 120;
  const beatsPerBar = options.beatsPerBar ?? 4;

  const cleanedContent = (csvContent ?? '').replace(/^\uFEFF/, '');
  const lines = cleanedContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'));

  if (lines.length === 0) {
    throw new Error('Reaper CSV file is empty.');
  }

  const delimiter = detectCsvDelimiter(lines[0]);
  const warnings: string[] = [];
  const markers: Marker[] = [];

  // Default column indices for headerless Reaper export: #, Name, Start, End
  let idCol = 0;
  let nameCol = 1;
  let startCol = 2;
  let endCol = 3;
  let categoryCol = -1;
  let fadeInCol = -1;
  let fadeOutCol = -1;
  let delayCol = -1;
  let notesCol = -1;

  let startRowIndex = 0;
  const firstRow = parseCsvLine(lines[0], delimiter);
  const firstRowLower = firstRow.map((c) => c.replace(/^\uFEFF/, '').trim().toLowerCase());

  // Determine whether the first row is a header row vs a headerless data row.
  // A headerless data row like "M1,Start,0:01.000" has a valid timestamp in col 2 and non-header col 0.
  const thirdColIsTimestamp =
    firstRow.length > 2 &&
    parseFlexibleTimestamp(firstRow[2], frameRate, bpm, beatsPerBar) !== null;
  const firstColIsHeaderKeyword = KNOWN_HEADER_COLUMNS.has(firstRowLower[0] ?? '');
  const allColsAreHeaderKeywords =
    firstRowLower.length > 0 &&
    firstRowLower.every((col) => col === '' || KNOWN_HEADER_COLUMNS.has(col));

  const looksLikeHeader =
    allColsAreHeaderKeywords ||
    firstRowLower[0] === '#' ||
    firstRowLower[0] === 'id' ||
    (firstColIsHeaderKeyword && !thirdColIsTimestamp);

  if (looksLikeHeader) {
    startRowIndex = 1;
    // Reset column indices so unmapped optional columns (like End or #) do not collide with custom columns
    idCol = -1;
    nameCol = -1;
    startCol = -1;
    endCol = -1;

    firstRowLower.forEach((colName, idx) => {
      if (colName === '#' || colName === 'id' || colName === 'number') {
        idCol = idx;
      } else if (colName === 'name' || colName === 'label' || colName === 'title') {
        nameCol = idx;
      } else if (
        colName === 'start' ||
        colName === 'time' ||
        colName === 'timestamp' ||
        colName === 'position'
      ) {
        startCol = idx;
      } else if (colName === 'end') {
        endCol = idx;
      } else if (colName === 'category' || colName === 'type') {
        categoryCol = idx;
      } else if (colName === 'fadein' || colName === 'fade_in' || colName === 'fade') {
        fadeInCol = idx;
      } else if (colName === 'fadeout' || colName === 'fade_out') {
        fadeOutCol = idx;
      } else if (colName === 'delay') {
        delayCol = idx;
      } else if (colName === 'notes' || colName === 'note' || colName === 'comment') {
        notesCol = idx;
      }
    });

    if (startCol < 0) {
      startCol = 2;
    }
    if (nameCol < 0) {
      nameCol = startCol === 1 ? 0 : 1;
    }
  }

  for (let rowIdx = startRowIndex; rowIdx < lines.length; rowIdx++) {
    const rawLine = lines[rowIdx];
    const cols = parseCsvLine(rawLine, delimiter);
    if (cols.length <= startCol) {
      warnings.push(`Row ${rowIdx + 1}: skipped (insufficient columns).`);
      continue;
    }

    const rawStart = cols[startCol] ?? '';
    const timestampSeconds = parseFlexibleTimestamp(
      rawStart,
      frameRate,
      bpm,
      beatsPerBar
    );
    if (timestampSeconds === null) {
      warnings.push(
        `Row ${rowIdx + 1}: skipped (invalid Start timestamp "${rawStart}").`
      );
      continue;
    }

    const rawId = idCol >= 0 ? (cols[idCol] ?? '') : '';
    const rawName = nameCol >= 0 ? (cols[nameCol] ?? '') : '';
    const markerIndex = markers.length + 1;
    const label = rawName.trim() || `Marker ${rawId || markerIndex}`;

    const explicitCategory =
      categoryCol >= 0 ? cols[categoryCol] : undefined;
    const category = inferMarkerCategory(label, explicitCategory);

    const parsedFadeIn =
      fadeInCol >= 0 && cols[fadeInCol] !== undefined && cols[fadeInCol] !== ''
        ? Number(cols[fadeInCol].replace(',', '.'))
        : defaultFadeIn;
    const fadeInSeconds =
      Number.isFinite(parsedFadeIn) && parsedFadeIn >= 0
        ? parsedFadeIn
        : defaultFadeIn;

    const parsedFadeOut =
      fadeOutCol >= 0 && cols[fadeOutCol] !== undefined && cols[fadeOutCol] !== ''
        ? Number(cols[fadeOutCol].replace(',', '.'))
        : undefined;
    const fadeOutSeconds =
      parsedFadeOut !== undefined &&
      Number.isFinite(parsedFadeOut) &&
      parsedFadeOut >= 0
        ? parsedFadeOut
        : undefined;

    const parsedDelay =
      delayCol >= 0 && cols[delayCol] !== undefined && cols[delayCol] !== ''
        ? Number(cols[delayCol].replace(',', '.'))
        : defaultDelay;
    const delaySeconds =
      Number.isFinite(parsedDelay) && parsedDelay >= 0
        ? parsedDelay
        : defaultDelay;

    let notes =
      notesCol >= 0 && cols[notesCol] ? cols[notesCol].trim() : undefined;

    if (!notes && endCol >= 0 && cols[endCol]) {
      const endSec = parseFlexibleTimestamp(
        cols[endCol],
        frameRate,
        bpm,
        beatsPerBar
      );
      if (endSec !== null && endSec > timestampSeconds) {
        notes = `Reaper Region (${rawId || markerIndex}) End: ${endSec.toFixed(3)}s`;
      }
    }

    const strippedId = rawId.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const cleanIdToken = strippedId || String(markerIndex);

    const marker: Marker = {
      id: `reaper-${cleanIdToken}-${markerIndex}`,
      label,
      timestampSeconds,
      category,
      origin: 'manual',
      confirmed: true,
      exportEnabled: true,
      fadeInSeconds,
      delaySeconds,
    };

    if (fadeOutSeconds !== undefined) {
      marker.fadeOutSeconds = fadeOutSeconds;
    }
    if (notes) {
      marker.notes = notes;
    }

    markers.push(marker);
  }

  return {
    format: 'reaper-csv',
    markers: sortMarkersChronologically(ensureUniqueMarkerIds(markers)),
    warnings,
  };
}

/**
 * Parses Audacity Label Track (`.txt` / `.tsv`) exports into confirmed CueForge `Marker` objects.
 *
 * Standard Audacity format: `<start_seconds>\t<end_seconds>\t<label>`
 */
export function parseAudacityLabelTrack(
  txtContent: string,
  options: DawImportOptions = {}
): DawImportResult {
  const frameRate = options.frameRate ?? 30;
  const defaultFadeIn = options.defaultFadeInSeconds ?? 0;
  const defaultDelay = options.defaultDelaySeconds ?? 0;
  const bpm = options.bpm ?? 120;
  const beatsPerBar = options.beatsPerBar ?? 4;

  const cleanedContent = (txtContent ?? '').replace(/^\uFEFF/, '');
  const rawLines = cleanedContent.split(/\r?\n/);
  const warnings: string[] = [];
  const markers: Marker[] = [];

  let hasAnyContent = false;

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i];
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    // Audacity spectral selection continuation line starts with backslash
    if (line.startsWith('\\')) {
      continue;
    }

    hasAnyContent = true;

    const isTabSeparated = rawLine.includes('\t');
    const parts = isTabSeparated
      ? rawLine.split('\t').map((p) => p.trim())
      : line.split(/\s+/);

    if (parts.length < 2) {
      warnings.push(`Line ${i + 1}: skipped (unrecognized Audacity label format).`);
      continue;
    }

    const startSec = parseFlexibleTimestamp(parts[0], frameRate, bpm, beatsPerBar);
    if (startSec === null) {
      warnings.push(
        `Line ${i + 1}: skipped (invalid start timestamp "${parts[0]}").`
      );
      continue;
    }

    let endSec: number | null = null;
    let labelPart = '';
    let explicitCategory: string | undefined;

    if (parts.length >= 3) {
      const maybeEnd = parseFlexibleTimestamp(
        parts[1],
        frameRate,
        bpm,
        beatsPerBar
      );
      if (maybeEnd !== null) {
        endSec = maybeEnd;
        if (isTabSeparated) {
          if (
            parts.length >= 4 &&
            VALID_CATEGORIES_MAP[parts[3].trim().toLowerCase()]
          ) {
            labelPart = parts[2];
            explicitCategory = parts[3];
          } else {
            labelPart = parts.slice(2).filter(Boolean).join(' ');
          }
        } else {
          // Space-separated line: preserve all words of multi-word labels
          labelPart = parts.slice(2).join(' ');
        }
      } else {
        labelPart = parts.slice(1).join(' ');
      }
    } else {
      // 2 parts: either "<start>\t<end>" with empty label, or "<start>\t<label>"
      const maybeEnd = parseFlexibleTimestamp(
        parts[1],
        frameRate,
        bpm,
        beatsPerBar
      );
      if (maybeEnd !== null) {
        endSec = maybeEnd;
        labelPart = '';
      } else {
        labelPart = parts[1];
      }
    }

    const markerIndex = markers.length + 1;
    const label = labelPart.trim() || `Label ${markerIndex}`;
    const category = inferMarkerCategory(label, explicitCategory);

    const marker: Marker = {
      id: `audacity-${markerIndex}`,
      label,
      timestampSeconds: startSec,
      category,
      origin: 'manual',
      confirmed: true,
      exportEnabled: true,
      fadeInSeconds: defaultFadeIn,
      delaySeconds: defaultDelay,
    };

    if (endSec !== null && endSec > startSec) {
      marker.notes = `Audacity Region End: ${endSec.toFixed(3)}s`;
    }

    markers.push(marker);
  }

  if (!hasAnyContent) {
    throw new Error('Audacity label track file is empty.');
  }

  return {
    format: 'audacity-txt',
    markers: sortMarkersChronologically(ensureUniqueMarkerIds(markers)),
    warnings,
  };
}

function normalizeImportedJsonMarker(raw: unknown, idx: number): Marker {
  const sanitized = sanitizeMarker(raw, idx);
  const hasExplicitCategory =
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as Record<string, unknown>).category === 'string' &&
    VALID_CATEGORIES_MAP[
      ((raw as Record<string, unknown>).category as string).trim().toLowerCase()
    ] !== undefined;

  const category = hasExplicitCategory
    ? sanitized.category
    : inferMarkerCategory(sanitized.label);

  return {
    ...sanitized,
    category,
    confirmed: true,
    exportEnabled: true,
  };
}

/**
 * Parses a CueForge Project JSON file (or JSON marker array) into confirmed `Marker` objects.
 * All imported markers are normalized to `confirmed: true` and `exportEnabled: true`
 * to uphold the `1 Confirmed Marker = 1 Cue = 1 Timecode Event` invariant.
 */
export function parseCueForgeJsonMarkers(jsonContent: string): DawImportResult {
  const cleanedJson = (jsonContent ?? '').replace(/^\uFEFF/, '').trim();
  if (!cleanedJson) {
    throw new Error('CueForge JSON file is empty.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanedJson);
  } catch (err) {
    throw new Error(
      `Malformed CueForge JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const warnings: string[] = [];

  if (Array.isArray(parsed)) {
    const markers = sortMarkersChronologically(
      ensureUniqueMarkerIds(
        parsed.map((raw, idx) => normalizeImportedJsonMarker(raw, idx))
      )
    );
    return {
      format: 'cueforge-json',
      markers,
      warnings,
    };
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    if (record.config && Array.isArray(record.markers)) {
      const project = deserializeProjectFromJson(cleanedJson);
      const confirmedMarkers = sortMarkersChronologically(
        ensureUniqueMarkerIds(
          project.markers.map((m) => ({
            ...m,
            confirmed: true,
            exportEnabled: true,
          }))
        )
      );
      return {
        format: 'cueforge-json',
        markers: confirmedMarkers,
        warnings,
        project: {
          ...project,
          markers: confirmedMarkers,
        },
      };
    }

    if (Array.isArray(record.markers)) {
      const markers = sortMarkersChronologically(
        ensureUniqueMarkerIds(
          record.markers.map((raw, idx) => normalizeImportedJsonMarker(raw, idx))
        )
      );
      return {
        format: 'cueforge-json',
        markers,
        warnings,
      };
    }
  }

  throw new Error(
    'Unrecognized CueForge JSON structure: expected a project object with "markers" or an array of markers.'
  );
}

/**
 * Auto-detects the DAW / project format from filename or content and imports confirmed markers.
 */
export function importMarkersFromFileContent(
  content: string,
  filenameOrFormat?: string,
  options: DawImportOptions = {}
): DawImportResult {
  const hint = (filenameOrFormat ?? '').trim().toLowerCase();

  if (hint === 'cueforge-json' || hint.endsWith('.json')) {
    return parseCueForgeJsonMarkers(content);
  }
  if (hint === 'reaper-csv' || hint.endsWith('.csv')) {
    return parseReaperMarkerCsv(content, options);
  }
  if (
    hint === 'audacity-txt' ||
    hint.endsWith('.txt') ||
    hint.endsWith('.tsv')
  ) {
    return parseAudacityLabelTrack(content, options);
  }

  const trimmed = (content ?? '').replace(/^\uFEFF/, '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseCueForgeJsonMarkers(content);
  }
  if (trimmed.includes('\t')) {
    return parseAudacityLabelTrack(content, options);
  }

  // Inspect first non-empty, non-comment line to disambiguate CSV vs space-separated Audacity
  const firstActiveLine = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('//') && !l.startsWith('\\'));

  if (firstActiveLine) {
    const spaceTokens = firstActiveLine.split(/\s+/);
    if (
      spaceTokens.length >= 2 &&
      parseFlexibleTimestamp(spaceTokens[0], options.frameRate) !== null &&
      parseFlexibleTimestamp(spaceTokens[1], options.frameRate) !== null
    ) {
      return parseAudacityLabelTrack(content, options);
    }
  }

  if (trimmed.includes(',') || trimmed.includes(';')) {
    return parseReaperMarkerCsv(content, options);
  }

  return parseAudacityLabelTrack(content, options);
}

/**
 * Merges imported markers with existing markers (`replace` or `append`),
 * ensuring unique IDs and chronological ordering.
 */
export function mergeImportedMarkers(
  existingMarkers: Marker[],
  importedMarkers: Marker[],
  mode: 'replace' | 'append' = 'replace'
): Marker[] {
  const base = mode === 'replace' ? [] : [...existingMarkers];
  const usedIds = new Set(base.map((m) => m.id));

  for (let i = 0; i < importedMarkers.length; i++) {
    const candidate = importedMarkers[i];
    let uniqueId = candidate.id;
    let suffix = 1;
    while (usedIds.has(uniqueId)) {
      uniqueId = `${candidate.id}-${suffix}`;
      suffix++;
    }
    usedIds.add(uniqueId);
    base.push({
      ...candidate,
      id: uniqueId,
      confirmed: true,
    });
  }

  return sortMarkersChronologically(base);
}
