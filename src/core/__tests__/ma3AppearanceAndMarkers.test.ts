import { describe, expect, it } from 'vitest';
import { compileShow } from '../compiler';
import { generateMa3ExportBundle } from '../ma3Exporter';
import {
  ALL_MARKER_CATEGORIES,
  buildTimecodeMarkerTrackEntries,
  generateAppearanceMacroLines,
  generateEnhancedMa3ExportBundle,
  generateMarkerTrackMacroLines,
  generateMarkerTrackXml,
  getCategoryAppearanceSpecs,
} from '../ma3AppearanceAndMarkers';
import { computeTimecodeTimestamp, MA3_TICKS_PER_SECOND } from '../timecodeMath';
import { ExportConfiguration, Marker } from '../../types/cueforge';

const baseConfig: ExportConfiguration = {
  songTitle: 'Neon Horizon',
  ma3Version: '2.5.x',
  sequenceId: 201,
  sequenceName: 'Neon Horizon Seq',
  timecodeId: 201,
  timecodeName: 'Neon Horizon TC',
  macroId: 201,
  frameRate: 30,
  timecodeOffsetSeconds: 3600, // 01:00:00:00
  latencyCompensationMs: 0,
  executionMode: 'Go+',
  allowOverwriteExistingObjects: false,
  songDurationSeconds: 180,
};

const fiveCategoryMarkers: Marker[] = [
  {
    id: 'mk-1',
    label: 'Intro Verse',
    timestampSeconds: 2.0,
    category: 'Structure',
    origin: 'manual',
    confirmed: true,
    exportEnabled: true,
    fadeInSeconds: 2.0,
    delaySeconds: 0,
  },
  {
    id: 'mk-2',
    label: 'Brass Hit #1',
    timestampSeconds: 8.5,
    category: 'Hit',
    origin: 'analysis',
    confirmed: true,
    exportEnabled: true,
    fadeInSeconds: 0,
    delaySeconds: 0,
  },
  {
    id: 'mk-3',
    label: 'Prism Sweep & Blind',
    timestampSeconds: 16.25,
    category: 'Effect',
    origin: 'manual',
    confirmed: true,
    exportEnabled: true,
    fadeInSeconds: 0.5,
    fadeOutSeconds: 1.0,
    delaySeconds: 0.1,
  },
  {
    id: 'mk-4',
    label: "Singer's Spotlight \"Center\"",
    timestampSeconds: 24.0,
    category: 'Note',
    origin: 'manual',
    confirmed: true,
    exportEnabled: true,
    fadeInSeconds: 1.5,
    delaySeconds: 0,
  },
  {
    id: 'mk-5',
    label: 'Pyro <Safety> Trigger',
    timestampSeconds: 40.75,
    category: 'Custom',
    origin: 'manual',
    confirmed: true,
    exportEnabled: true,
    fadeInSeconds: 0,
    delaySeconds: 0,
  },
];

describe('grandMA3 2.5.x Appearance & Timecode MarkerTrack Integration', () => {
  it('generates distinct color-coded Appearance specs for all 5 MarkerCategories', () => {
    const specs = getCategoryAppearanceSpecs(301);

    expect(Object.keys(specs)).toEqual(ALL_MARKER_CATEGORIES);
    expect(specs.Structure.poolId).toBe(301);
    expect(specs.Hit.poolId).toBe(302);
    expect(specs.Effect.poolId).toBe(303);
    expect(specs.Note.poolId).toBe(304);
    expect(specs.Custom.poolId).toBe(305);

    const uniqueHexColors = new Set(
      ALL_MARKER_CATEGORIES.map((cat) => specs[cat].hexColor)
    );
    expect(uniqueHexColors.size).toBe(5);

    for (const category of ALL_MARKER_CATEGORIES) {
      const spec = specs[category];
      expect(spec.name).toBe(`CF_${category}`);
      expect(spec.ma3ColorRgba).toMatch(/^\d+\.\d{3},\d+\.\d{3},\d+\.\d{3},1\.000$/);
    }
  });

  it('rejects invalid pool IDs and start indices across Appearance and MarkerTrack generators', () => {
    expect(() => getCategoryAppearanceSpecs(0)).toThrow(/positive integer/i);
    expect(() => getCategoryAppearanceSpecs(-10)).toThrow(/positive integer/i);
    expect(() => getCategoryAppearanceSpecs(10.5)).toThrow(/positive integer/i);
    expect(() => getCategoryAppearanceSpecs(Number.NaN)).toThrow(/positive integer/i);
    expect(() => getCategoryAppearanceSpecs(Number.MAX_SAFE_INTEGER)).toThrow(
      /safe positive integer/i
    );

    expect(() => generateAppearanceMacroLines([], 0, false, 101)).toThrow(
      /sequenceId must be a positive integer/i
    );
    expect(() => generateAppearanceMacroLines([], 1, false, 101, 0)).toThrow(
      /startIndex must be a positive integer/i
    );
    expect(() => generateMarkerTrackMacroLines([], 0)).toThrow(
      /timecodeId must be a positive integer/i
    );
    expect(() => generateMarkerTrackMacroLines([], 1, 0)).toThrow(
      /startIndex must be a positive integer/i
    );
  });

  it('assigns the matching category Appearance to every Cue while respecting overwrite flags', () => {
    const compiled = compileShow(fiveCategoryMarkers, baseConfig);

    const safeLines = generateAppearanceMacroLines(
      compiled.cues,
      baseConfig.sequenceId,
      false,
      401,
      10
    );
    // 5 categories * 2 lines (Store + Set) + 5 Cue Assignments = 15 lines
    expect(safeLines).toHaveLength(15);
    expect(safeLines[0].index).toBe(10);
    expect(safeLines[0].command).toBe('Store Appearance 401 "CF_Structure" /NoConfirm');

    // Verify each cue 1..5 is assigned its corresponding category Appearance (401..405)
    expect(safeLines[10].command).toBe('Assign Appearance 401 At Sequence 201 Cue 1');
    expect(safeLines[11].command).toBe('Assign Appearance 402 At Sequence 201 Cue 2');
    expect(safeLines[12].command).toBe('Assign Appearance 403 At Sequence 201 Cue 3');
    expect(safeLines[13].command).toBe('Assign Appearance 404 At Sequence 201 Cue 4');
    expect(safeLines[14].command).toBe('Assign Appearance 405 At Sequence 201 Cue 5');

    const overwriteLines = generateAppearanceMacroLines(
      compiled.cues,
      baseConfig.sequenceId,
      true,
      401,
      1
    );
    expect(overwriteLines[0].command).toBe('Store Appearance 401 "CF_Structure" /Overwrite');
  });

  it('preserves all marker labels, categories, and frame-accurate timestamps on MarkerTrack XML and Lua', () => {
    const config25FpsWithLatency: ExportConfiguration = {
      ...baseConfig,
      frameRate: 25,
      timecodeOffsetSeconds: 7200, // 02:00:00:00
      latencyCompensationMs: -40, // -1 frame at 25fps
    };
    const compiled = compileShow(fiveCategoryMarkers, config25FpsWithLatency);
    const entries = buildTimecodeMarkerTrackEntries(compiled, {
      baseAppearancePoolId: 101,
    });

    expect(entries).toHaveLength(5);

    entries.forEach((entry, idx) => {
      const marker = fiveCategoryMarkers[idx];
      const expectedTiming = computeTimecodeTimestamp(
        marker.timestampSeconds,
        25,
        7200,
        -40
      );
      expect(entry.markerIndex).toBe(idx + 1);
      expect(entry.cueNumber).toBe(idx + 1);
      expect(entry.label).toBe(marker.label);
      expect(entry.category).toBe(marker.category);
      expect(entry.timing.totalFrames).toBe(expectedTiming.totalFrames);
      expect(entry.timing.formattedAbsoluteSmpte).toBe(
        expectedTiming.formattedAbsoluteSmpte
      );
      expect(entry.timing.formattedMa3Time).toBe(expectedTiming.formattedMa3Time);
      expect(entry.timing.ma3InternalTicks).toBe(
        Math.round(expectedTiming.absoluteSeconds * MA3_TICKS_PER_SECOND)
      );
    });

    // Verify XML escaping and attributes on MarkerTrack XML
    const markerXml = generateMarkerTrackXml(entries, '');
    expect(markerXml).toContain('<MarkerTrack Name="Marker">');
    expect(markerXml).toContain('<MarkerSubTrack>');
    expect(markerXml).toContain(
      'Name="Prism Sweep &amp; Blind" Time="2h00m16.200s" Category="Effect" CueIndex="3" AppearancePoolId="103"'
    );
    expect(markerXml).toContain(
      'Name="Singer&apos;s Spotlight &quot;Center&quot;" Time="2h00m23.960s" Category="Note" CueIndex="4" AppearancePoolId="104"'
    );
    expect(markerXml).toContain(
      'Name="Pyro &lt;Safety&gt; Trigger" Time="2h00m40.720s" Category="Custom" CueIndex="5" AppearancePoolId="105"'
    );

    // Verify Lua escaping, tick accuracy, and MarkerTrack vs SequenceTrack isolation guard
    const luaLines = generateMarkerTrackMacroLines(entries, 201, 1);
    expect(luaLines).toHaveLength(5);
    expect(luaLines[0].command).toContain('local mtrk = tg and tg[2] and tg[1]');
    expect(luaLines[0].command).toContain('if mtrk and not mtrk.target then');
    expect(luaLines[0].command).toContain("tr:Acquire('MarkerSubTrack')");
    expect(luaLines[3].command).toContain(
      `mk:Set('name', 'Singer\\'s Spotlight \\"Center\\"')`
    );
    expect(luaLines[3].command).toContain(
      `mk:Set('time', ${entries[3].timing.ma3InternalTicks})`
    );
  });

  it('supports filtering visual MarkerTrack by category and protects Appearance pool IDs in safe mode', () => {
    const compiled = compileShow(fiveCategoryMarkers, baseConfig);

    // Filter visual MarkerTrack to only 'Structure' and 'Hit', while keeping all 5 Cues and 5 CmdEvents
    const bundle = generateEnhancedMa3ExportBundle(compiled, {
      baseAppearancePoolId: 101,
      includeCueAppearances: true,
      includeMarkerTrack: true,
      markerTrackCategories: ['Structure', 'Hit'],
    });

    // Safe mode guard (line 1) must check Sequence, Timecode, AND Appearance 101..105
    expect(bundle.macroLines[0].command).toContain("GetObject('Appearance 101')");
    expect(bundle.macroLines[0].command).toContain("GetObject('Appearance 105')");
    expect(bundle.macroLines[0].command).toContain('Appearance 101-105 already exists');

    // Visual MarkerTrack has 2 filtered entries
    expect(bundle.markerTrackEntries).toHaveLength(2);
    expect(bundle.markerTrackEntries.map((e) => e.label)).toEqual([
      'Intro Verse',
      'Brass Hit #1',
    ]);

    // Mandatory CmdSubTrack still has ALL 5 events targeting Cue 1..5
    const cmdEventMatches = bundle.timecodeXml.match(/<CmdEvent /g) ?? [];
    expect(cmdEventMatches).toHaveLength(5);

    const markerEventMatches = bundle.timecodeXml.match(/<MarkerEvent /g) ?? [];
    expect(markerEventMatches).toHaveLength(2);

    // Macro lines still store all 5 cues and assign appearances to all 5 cues
    for (let cueNum = 1; cueNum <= 5; cueNum++) {
      expect(bundle.macroCommandText).toContain(
        `Store Sequence 201 Cue ${cueNum} `
      );
      expect(bundle.macroCommandText).toContain(
        `Assign Appearance ${100 + cueNum} At Sequence 201 Cue ${cueNum}`
      );
    }
  });

  it('produces identical output to core generateMa3ExportBundle when extras are disabled', () => {
    const compiled = compileShow(fiveCategoryMarkers, baseConfig);
    const coreBundle = generateMa3ExportBundle(compiled);
    const enhancedDisabled = generateEnhancedMa3ExportBundle(compiled, {
      includeCueAppearances: false,
      includeMarkerTrack: false,
    });

    expect(enhancedDisabled.macroLines).toEqual(coreBundle.macroLines);
    expect(enhancedDisabled.macroXml).toBe(coreBundle.macroXml);
    expect(enhancedDisabled.macroCommandText).toBe(coreBundle.macroCommandText);
    expect(enhancedDisabled.timecodeXml).toBe(coreBundle.timecodeXml);
    expect(enhancedDisabled.markerTrackEntries).toHaveLength(0);
  });

  it('throws on invalid CompiledShow (e.g. zero exportable markers)', () => {
    const emptyCompiled = compileShow([], baseConfig);
    expect(() => generateEnhancedMa3ExportBundle(emptyCompiled)).toThrow(
      /Export validation failed/i
    );
  });
});
