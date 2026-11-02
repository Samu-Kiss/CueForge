import {
  CompiledCue,
  CompiledShow,
  MarkerCategory,
  TimecodeTimestamp,
} from '../types/cueforge';
import {
  escapeLuaSingleQuotedString,
  escapeMa3CommandString,
  escapeXml,
  generateMa3ExportBundle,
  Ma3ExportBundle,
  Ma3MacroLine,
} from './ma3Exporter';
import { computeTimecodeTimestamp } from './timecodeMath';
import { validateCompiledShow } from './validator';

/**
 * All supported CueForge marker categories in canonical order.
 */
export const ALL_MARKER_CATEGORIES: readonly MarkerCategory[] = [
  'Structure',
  'Hit',
  'Effect',
  'Note',
  'Custom',
] as const;

/**
 * Color and grandMA3 Appearance pool specification for a MarkerCategory.
 */
export interface Ma3CategoryAppearanceSpec {
  category: MarkerCategory;
  poolId: number;
  name: string;
  hexColor: string;
  rgb: { r: number; g: number; b: number };
  /** grandMA3 normalized RGBA string ("R,G,B,A" in 0..1 float format) */
  ma3ColorRgba: string;
}

/**
 * A visual marker entry on the grandMA3 Timecode `MarkerTrack` (`tg[1]`).
 * Note: This is strictly an operator visual guide on the Timecode timeline header
 * and NEVER replaces the mandatory `CmdSubTrack` GO event for each cue.
 */
export interface Ma3TimecodeMarkerEntry {
  markerIndex: number;
  sourceMarkerId: string;
  cueNumber: number;
  label: string;
  category: MarkerCategory;
  appearancePoolId: number;
  timing: TimecodeTimestamp;
}

/**
 * Configuration options for grandMA3 2.5.x Appearance & MarkerTrack generation.
 */
export interface Ma3ExtrasOptions {
  /** Starting Appearance Pool ID for the 5 marker categories (default: 101 -> 101..105) */
  baseAppearancePoolId?: number;
  /** Whether to generate Appearance pool objects and assign them to Sequence Cues (default: true) */
  includeCueAppearances?: boolean;
  /** Whether to populate the Timecode MarkerTrack with visual markers (default: true) */
  includeMarkerTrack?: boolean;
  /**
   * Optional category filter for visual MarkerTrack entries (defaults to all 5 categories).
   * Note: Sequence Cues and CmdSubTrack GO events ALWAYS include all exportable markers
   * regardless of this visual MarkerTrack filter.
   */
  markerTrackCategories?: MarkerCategory[];
}

export interface Ma3EnhancedExportBundle extends Ma3ExportBundle {
  appearances: Record<MarkerCategory, Ma3CategoryAppearanceSpec>;
  markerTrackEntries: Ma3TimecodeMarkerEntry[];
}

const DEFAULT_CATEGORY_COLORS: Record<
  MarkerCategory,
  { hex: string; r: number; g: number; b: number }
> = {
  Structure: { hex: '#38bdf8', r: 56, g: 189, b: 248 },
  Hit: { hex: '#f43f5e', r: 244, g: 63, b: 94 },
  Effect: { hex: '#a855f7', r: 168, g: 85, b: 247 },
  Note: { hex: '#f59e0b', r: 245, g: 158, b: 11 },
  Custom: { hex: '#10b981', r: 16, g: 185, b: 129 },
};

/**
 * Builds the 5 grandMA3 Appearance pool specifications starting at `baseAppearancePoolId`.
 * Throws if `baseAppearancePoolId` is not a positive integer.
 */
export function getCategoryAppearanceSpecs(
  baseAppearancePoolId: number = 101
): Record<MarkerCategory, Ma3CategoryAppearanceSpec> {
  if (
    !Number.isSafeInteger(baseAppearancePoolId) ||
    baseAppearancePoolId < 1 ||
    !Number.isSafeInteger(baseAppearancePoolId + ALL_MARKER_CATEGORIES.length - 1)
  ) {
    throw new Error(
      `baseAppearancePoolId must be a safe positive integer (>= 1), received: ${baseAppearancePoolId}`
    );
  }

  const result = {} as Record<MarkerCategory, Ma3CategoryAppearanceSpec>;

  ALL_MARKER_CATEGORIES.forEach((category, offset) => {
    const color = DEFAULT_CATEGORY_COLORS[category];
    const rNorm = (color.r / 255).toFixed(3);
    const gNorm = (color.g / 255).toFixed(3);
    const bNorm = (color.b / 255).toFixed(3);

    result[category] = {
      category,
      poolId: baseAppearancePoolId + offset,
      name: `CF_${category}`,
      hexColor: color.hex,
      rgb: { r: color.r, g: color.g, b: color.b },
      ma3ColorRgba: `${rNorm},${gNorm},${bNorm},1.000`,
    };
  });

  return result;
}

/**
 * Generates grandMA3 Macro lines that create color-coded Appearance pool objects
 * for each MarkerCategory and assign them to every Cue in the Sequence.
 */
export function generateAppearanceMacroLines(
  cues: CompiledCue[],
  sequenceId: number,
  allowOverwrite: boolean,
  baseAppearancePoolId: number = 101,
  startIndex: number = 1
): Ma3MacroLine[] {
  if (!Number.isSafeInteger(sequenceId) || sequenceId < 1) {
    throw new Error(`sequenceId must be a positive integer (>= 1), received: ${sequenceId}`);
  }
  if (!Number.isSafeInteger(startIndex) || startIndex < 1) {
    throw new Error(`startIndex must be a positive integer (>= 1), received: ${startIndex}`);
  }
  const specs = getCategoryAppearanceSpecs(baseAppearancePoolId);
  const storeFlag = allowOverwrite ? '/Overwrite' : '/NoConfirm';
  const lines: Ma3MacroLine[] = [];

  const pushLine = (command: string, note: string, wait: string = 'Follow') => {
    lines.push({
      index: startIndex + lines.length,
      command,
      wait,
      note,
    });
  };

  // 1. Create the 5 category Appearances in the grandMA3 Appearance Pool
  for (const category of ALL_MARKER_CATEGORIES) {
    const spec = specs[category];
    const escapedName = escapeMa3CommandString(spec.name);
    pushLine(
      `Store Appearance ${spec.poolId} "${escapedName}" ${storeFlag}`,
      `Create Appearance ${spec.poolId} for ${category} cues (${spec.hexColor})`
    );
    pushLine(
      `Set Appearance ${spec.poolId} Property "Color" "${spec.ma3ColorRgba}" "BackR" "${spec.rgb.r}" "BackG" "${spec.rgb.g}" "BackB" "${spec.rgb.b}" "BackAlpha" "255"`,
      `Set RGB color (${spec.rgb.r}, ${spec.rgb.g}, ${spec.rgb.b}) on Appearance ${spec.poolId}`
    );
  }

  // 2. Assign the matching category Appearance to each compiled Cue (1..N)
  for (const cue of cues) {
    const spec = specs[cue.category] ?? specs.Custom;
    pushLine(
      `Assign Appearance ${spec.poolId} At Sequence ${sequenceId} Cue ${cue.cueNumber}`,
      `Color-code Sequence ${sequenceId} Cue ${cue.cueNumber} ("${cue.name}") as ${cue.category} (Appearance ${spec.poolId})`
    );
  }

  return lines;
}

/**
 * Compiles visual `MarkerTrack` entries from a `CompiledShow`.
 * Preserves exact marker labels, categories, cue numbers, and frame-accurate timestamps.
 */
export function buildTimecodeMarkerTrackEntries(
  show: CompiledShow,
  options: Ma3ExtrasOptions = {}
): Ma3TimecodeMarkerEntry[] {
  const baseAppearancePoolId = options.baseAppearancePoolId ?? 101;
  const specs = getCategoryAppearanceSpecs(baseAppearancePoolId);
  const allowedCategories = options.markerTrackCategories
    ? new Set<MarkerCategory>(options.markerTrackCategories)
    : null;

  const entries: Ma3TimecodeMarkerEntry[] = [];

  for (let i = 0; i < show.cues.length; i++) {
    const cue = show.cues[i];
    const event = show.events[i];
    if (!cue || !event) continue;

    if (allowedCategories && !allowedCategories.has(cue.category)) {
      continue;
    }

    const spec = specs[cue.category] ?? specs.Custom;
    entries.push({
      markerIndex: entries.length + 1,
      sourceMarkerId: cue.sourceMarkerId,
      cueNumber: cue.cueNumber,
      label: cue.name,
      category: cue.category,
      appearancePoolId: spec.poolId,
      timing: event.timing,
    });
  }

  return entries;
}

/**
 * Generates grandMA3 2.5.x Lua macro lines to populate the Timecode `MarkerTrack` (`tg[1]`)
 * with visual section/cue markers at frame-accurate internal tick positions.
 * Explicitly verifies that `mtrk` is the MarkerTrack (`tg[2] ~= nil and not mtrk.target`)
 * so it can never accidentally write to the Sequence Track's `CmdSubTrack`.
 */
export function generateMarkerTrackMacroLines(
  entries: Ma3TimecodeMarkerEntry[],
  timecodeId: number,
  startIndex: number = 1
): Ma3MacroLine[] {
  if (!Number.isSafeInteger(timecodeId) || timecodeId < 1) {
    throw new Error(`timecodeId must be a positive integer (>= 1), received: ${timecodeId}`);
  }
  if (!Number.isSafeInteger(startIndex) || startIndex < 1) {
    throw new Error(`startIndex must be a positive integer (>= 1), received: ${startIndex}`);
  }

  const lines: Ma3MacroLine[] = [];
  for (const entry of entries) {
    const escapedLabel = escapeLuaSingleQuotedString(entry.label);
    const luaCmd = [
      `local dp = DataPool()`,
      `local tc = dp.timecodes[${timecodeId}]`,
      `local tg = tc and tc[1]`,
      `local mtrk = tg and tg[2] and tg[1]`,
      `if mtrk and not mtrk.target then`,
      `  local tr = mtrk[1] or mtrk:Acquire()`,
      `  local sub = tr[1] or tr:Acquire('MarkerSubTrack')`,
      `  local mk = sub:Acquire()`,
      `  mk:Set('name', '${escapedLabel}')`,
      `  mk:Set('time', ${entry.timing.ma3InternalTicks})`,
      `end`,
    ].join('; ');

    lines.push({
      index: startIndex + lines.length,
      command: `Lua "${luaCmd}"`,
      wait: 'Follow',
      note: `MarkerTrack #${entry.markerIndex} @ ${entry.timing.formattedAbsoluteSmpte} -> "${entry.label}" (${entry.category}, Cue ${entry.cueNumber})`,
    });
  }

  return lines;
}

/**
 * Generates the `<MarkerTrack Name="Marker">...</MarkerTrack>` XML block for grandMA3 2.5.x.
 */
export function generateMarkerTrackXml(
  entries: Ma3TimecodeMarkerEntry[],
  indent: string = '            '
): string {
  if (entries.length === 0) {
    return `${indent}<MarkerTrack Name="Marker" />`;
  }

  const markerEventsXml = entries
    .map(
      (entry) =>
        `${indent}            <MarkerEvent Name="${escapeXml(entry.label)}" Time="${entry.timing.formattedMa3Time}" Category="${escapeXml(entry.category)}" CueIndex="${entry.cueNumber}" AppearancePoolId="${entry.appearancePoolId}" />`
    )
    .join('\n');

  return [
    `${indent}<MarkerTrack Name="Marker">`,
    `${indent}    <TimeRange Duration="To End" Play="" Rec="">`,
    `${indent}        <MarkerSubTrack>`,
    markerEventsXml,
    `${indent}        </MarkerSubTrack>`,
    `${indent}    </TimeRange>`,
    `${indent}</MarkerTrack>`,
  ].join('\n');
}

/**
 * Generates an enhanced grandMA3 2.5.x Export Bundle that preserves the strict
 * `1 Confirmed Marker = 1 Cue = 1 Timecode Event` invariant while optionally adding:
 * - Color-coded Appearance pool objects and Cue Appearance assignments
 * - Timecode `MarkerTrack` visual timeline markers
 */
export function generateEnhancedMa3ExportBundle(
  show: CompiledShow,
  options: Ma3ExtrasOptions = {}
): Ma3EnhancedExportBundle {
  const validation = validateCompiledShow(show);
  if (!validation.isValid) {
    throw new Error(`Export validation failed: ${validation.errors.join(' | ')}`);
  }

  const baseAppearancePoolId = options.baseAppearancePoolId ?? 101;
  const includeCueAppearances = options.includeCueAppearances ?? true;
  const includeMarkerTrack = options.includeMarkerTrack ?? true;

  const appearances = getCategoryAppearanceSpecs(baseAppearancePoolId);
  const markerTrackEntries = includeMarkerTrack
    ? buildTimecodeMarkerTrackEntries(show, options)
    : [];

  // Start from the validated core export bundle
  const coreBundle = generateMa3ExportBundle(show);
  const combinedMacroLines: Ma3MacroLine[] = coreBundle.macroLines.map((line, idx) => ({
    ...line,
    index: idx + 1,
  }));

  if (includeCueAppearances) {
    const endAppearancePoolId = baseAppearancePoolId + ALL_MARKER_CATEGORIES.length - 1;
    // Extend initial safety guard (or overwrite cleanup) to cover Appearance pool slots
    if (!show.config.allowOverwriteExistingObjects && combinedMacroLines.length > 0) {
      const seqId = show.config.sequenceId;
      const tcId = show.config.timecodeId;
      const appChecks = ALL_MARKER_CATEGORIES.map(
        (_, offset) => `GetObject('Appearance ${baseAppearancePoolId + offset}')`
      ).join(' or ');
      const safeGuardLua = [
        `local dp = DataPool()`,
        `if dp.sequences[${seqId}] or dp.timecodes[${tcId}] or ${appChecks} then`,
        `  Confirm('CueForge Safety Stop', 'Sequence ${seqId}, Timecode ${tcId}, or Appearance ${baseAppearancePoolId}-${endAppearancePoolId} already exists. Enable Overwrite in CueForge or choose unused Pool IDs.')`,
        `  Cmd('Off Macro ${show.config.macroId}')`,
        `  return`,
        `end`,
      ].join(' ');
      combinedMacroLines[0] = {
        index: 1,
        command: `Lua "${safeGuardLua}"`,
        wait: '0.05',
        note: `Abort macro safely if Sequence, Timecode, or Appearance (${baseAppearancePoolId}-${endAppearancePoolId}) pool object already exists (Overwrite not authorized)`,
      };
    }

    const appearanceLines = generateAppearanceMacroLines(
      show.cues,
      show.config.sequenceId,
      show.config.allowOverwriteExistingObjects,
      baseAppearancePoolId,
      combinedMacroLines.length + 1
    );
    combinedMacroLines.push(...appearanceLines);
  }

  if (includeMarkerTrack && markerTrackEntries.length > 0) {
    const markerLines = generateMarkerTrackMacroLines(
      markerTrackEntries,
      show.config.timecodeId,
      combinedMacroLines.length + 1
    );
    combinedMacroLines.push(...markerLines);
  }

  const { config, cues, events } = show;
  const xmlMacroLines = combinedMacroLines
    .map(
      (line) =>
        `        <MacroLine Name="${escapeXml(line.note || `Step ${line.index}`)}" Command="${escapeXml(line.command)}" Wait="${escapeXml(line.wait)}" Execute="Yes" Enabled="Yes" />`
    )
    .join('\n');

  const macroXml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<GMA3 DataVersion="2.5.0.0">`,
    `    <!-- Generated by CueForge for grandMA3 2.5.x -->`,
    `    <!-- Invariant: ${cues.length} Markers = ${cues.length} Cues = ${events.length} Timecode Events -->`,
    `    <Macro Name="${escapeXml(coreBundle.macroName)}" Index="${config.macroId}">`,
    xmlMacroLines,
    `    </Macro>`,
    `</GMA3>`,
  ].join('\n');

  const macroCommandText = combinedMacroLines
    .map((l) => `# [${l.index}] ${l.note ?? ''}\n${l.command}`)
    .join('\n\n');

  // Build Timecode XML with optional MarkerTrack entries alongside mandatory CmdSubTrack
  const lastEventAbsSeconds =
    events.length > 0
      ? events[events.length - 1].timing.absoluteSeconds
      : config.songDurationSeconds;
  const totalShowDurationSeconds = Math.max(
    config.timecodeOffsetSeconds + config.songDurationSeconds,
    lastEventAbsSeconds + 5
  );
  const durationTiming = computeTimecodeTimestamp(
    totalShowDurationSeconds,
    config.frameRate,
    0,
    0
  );
  const frameRateUnitMap: Record<number, string> = {
    24: '24 fps',
    25: '25 fps',
    29.97: '29.97 fps',
    30: '30 fps',
  };
  const frameReadout = frameRateUnitMap[config.frameRate] || '30 fps';

  const markerTrackXmlBlock = generateMarkerTrackXml(markerTrackEntries, '            ');

  const xmlCmdEvents = events
    .map((ev) => {
      const fadeAttr =
        ev.fadeOverrideSeconds !== undefined
          ? ` CueFade="${ev.fadeOverrideSeconds}"`
          : '';
      return [
        `                        <CmdEvent Name="${escapeXml(ev.token)}" Time="${ev.timing.formattedMa3Time}" CueDestination="${escapeXml(ev.cueDestinationName)}" CueDestinationIndex="${ev.cueDestinationNumber}" ExecuteCommand="Yes"${fadeAttr}>`,
        `                            <RealtimeCmd Type="Key" Source="Original" IsRealtime="1" Status="On" Object="ShowData.DataPools.Default.Sequences.${escapeXml(config.sequenceName)}" Token="${escapeXml(ev.token)}" />`,
        `                        </CmdEvent>`,
      ].join('\n');
    })
    .join('\n');

  const timecodeXml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<GMA3 DataVersion="2.5.0.0">`,
    `    <!-- Generated by CueForge for grandMA3 2.5.x -->`,
    `    <Timecode Name="${escapeXml(config.timecodeName)}" Duration="${durationTiming.formattedMa3Time}" FrameReadout="${escapeXml(frameReadout)}" TCSlot="0" AutoStop="No" SwitchOff="Keep Playbacks">`,
    `        <TrackGroup Name="${escapeXml(config.sequenceName)}" Play="" Rec="">`,
    markerTrackXmlBlock,
    `            <Track Name="${escapeXml(config.sequenceName)}" Target="ShowData.DataPools.Default.Sequences.${escapeXml(config.sequenceName)}" Play="" Rec="">`,
    `                <TimeRange Duration="To End" Play="" Rec="">`,
    `                    <CmdSubTrack>`,
    xmlCmdEvents,
    `                    </CmdSubTrack>`,
    `                </TimeRange>`,
    `            </Track>`,
    `        </TrackGroup>`,
    `    </Timecode>`,
    `</GMA3>`,
  ].join('\n');

  return {
    macroName: coreBundle.macroName,
    macroLines: combinedMacroLines,
    macroXml,
    macroCommandText,
    timecodeXml,
    appearances,
    markerTrackEntries,
  };
}
