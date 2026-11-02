import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  importMarkersFromFileContent,
  inferMarkerCategory,
  mergeImportedMarkers,
  parseAudacityLabelTrack,
  parseCsvLine,
  parseCueForgeJsonMarkers,
  parseFlexibleTimestamp,
  parseReaperMarkerCsv,
} from '../dawImporter';
import {
  clearProjectFromLocalStorage,
  CUEFORGE_PROJECT_FORMAT,
  CUEFORGE_PROJECT_SCHEMA_VERSION,
  deserializeProjectFromJson,
  loadProjectFromLocalStorage,
  saveProjectToLocalStorage,
  serializeProjectToJson,
} from '../projectPersistence';
import { compileShow } from '../compiler';
import { validateCompiledShow } from '../validator';
import { createDefaultDemoShow } from '../audioAnalysis';
import { ExportConfiguration } from '../../types/cueforge';

const testConfig: ExportConfiguration = {
  songTitle: 'Hyperion Live',
  ma3Version: '2.5.x',
  sequenceId: 201,
  sequenceName: 'Hyperion Seq',
  timecodeId: 201,
  timecodeName: 'Hyperion TC',
  macroId: 201,
  frameRate: 30,
  timecodeOffsetSeconds: 3600,
  latencyCompensationMs: -20,
  globalEventFadeOverrideSeconds: 0.5,
  executionMode: 'Go+',
  allowOverwriteExistingObjects: true,
  songDurationSeconds: 180,
};

describe('DAW Marker Importer (Reaper CSV, Audacity TXT/TSV, CueForge JSON)', () => {
  describe('parseFlexibleTimestamp & parseCsvLine helpers', () => {
    it('parses decimal seconds, European comma seconds, M:SS.mmm, H:MM:SS.mmm, SMPTE HH:MM:SS:FF / drop-frame, and Reaper Measures.Beats accurately', () => {
      expect(parseFlexibleTimestamp('12.500')).toBe(12.5);
      expect(parseFlexibleTimestamp('12,500')).toBe(12.5);
      expect(parseFlexibleTimestamp('0:04.250')).toBe(4.25);
      expect(parseFlexibleTimestamp('01:30.500')).toBe(90.5);
      expect(parseFlexibleTimestamp('01:00:10.125')).toBe(3610.125);
      // 00:00:10:15 at 30 fps = 10.5s (both colon and drop-frame semicolon)
      expect(parseFlexibleTimestamp('00:00:10:15', 30)).toBe(10.5);
      expect(parseFlexibleTimestamp('00:00:10;15', 30)).toBe(10.5);
      // Reaper Measures.Beats.Hundredths: 1.1.00 = 0s, 2.1.00 at 120 BPM (4/4) = 2.0s, 3.3.50 = 5.25s
      expect(parseFlexibleTimestamp('1.1.00', 30, 120, 4)).toBe(0);
      expect(parseFlexibleTimestamp('2.1.00', 30, 120, 4)).toBe(2.0);
      expect(parseFlexibleTimestamp('3.3.50', 30, 120, 4)).toBe(5.25);
      // Invalid inputs and out-of-range bounds
      expect(parseFlexibleTimestamp('')).toBeNull();
      expect(parseFlexibleTimestamp('-5.0')).toBeNull();
      expect(parseFlexibleTimestamp('not-a-time')).toBeNull();
      expect(parseFlexibleTimestamp('1:75.000')).toBeNull();
      expect(parseFlexibleTimestamp('00:00:10:30', 30)).toBeNull();
      expect(parseFlexibleTimestamp('0.1.00', 30, 120, 4)).toBeNull();
      expect(parseFlexibleTimestamp('1.5.00', 30, 120, 4)).toBeNull();
    });

    it('parses RFC-4180 CSV lines with quoted commas, escaped quotes, and semicolon delimiters', () => {
      const row = 'M1,"Chorus, Part ""A""",0:30.000,,,FF0000';
      expect(parseCsvLine(row)).toEqual([
        'M1',
        'Chorus, Part "A"',
        '0:30.000',
        '',
        '',
        'FF0000',
      ]);

      const semiRow = 'M1;"Chorus; Part A";0:30,000;;;FF0000';
      expect(parseCsvLine(semiRow, ';')).toEqual([
        'M1',
        'Chorus; Part A',
        '0:30,000',
        '',
        '',
        'FF0000',
      ]);
    });

    it('infers marker categories from explicit tags or musical/lighting keywords', () => {
      expect(inferMarkerCategory('Intro Wash')).toBe('Structure');
      expect(inferMarkerCategory('Heavy Brass Hit')).toBe('Hit');
      expect(inferMarkerCategory('Strobe Sweep')).toBe('Effect');
      expect(inferMarkerCategory('Followspot Stand-By Note')).toBe('Note');
      expect(inferMarkerCategory('[Custom] Pyro Arm')).toBe('Custom');
      expect(inferMarkerCategory('Any Label', 'Effect')).toBe('Effect');
    });
  });

  describe('Reaper Marker CSV Import', () => {
    it('imports standard Reaper Marker & Region CSV and compiles 1:1:1 into grandMA3 Cues and Events', () => {
      const reaperCsv = [
        '#,Name,Start,End,Length,Color',
        'M1,Intro Atmospheric Pad,0:00.500,,,',
        'M2,"Pre-Chorus, Blinder Hit",0:15.250,,,FF0000',
        'R1,Chorus 1 Section,0:30.000,0:45.000,0:15.000,00FF00',
        'M3,Laser Prism Sweep,1:02.750,,,',
        'M4,Operator Note: Haze Check,1:15.000,,,',
      ].join('\n');

      const result = parseReaperMarkerCsv(reaperCsv, { defaultFadeInSeconds: 1.0 });
      expect(result.format).toBe('reaper-csv');
      expect(result.warnings).toHaveLength(0);
      expect(result.markers).toHaveLength(5);

      // Every imported marker must be confirmed and exportEnabled
      for (const m of result.markers) {
        expect(m.confirmed).toBe(true);
        expect(m.exportEnabled).toBe(true);
        expect(m.fadeInSeconds).toBe(1.0);
      }

      expect(result.markers[0].label).toBe('Intro Atmospheric Pad');
      expect(result.markers[0].timestampSeconds).toBe(0.5);
      expect(result.markers[0].category).toBe('Structure');

      expect(result.markers[1].label).toBe('Pre-Chorus, Blinder Hit');
      expect(result.markers[1].timestampSeconds).toBe(15.25);
      expect(result.markers[1].category).toBe('Hit');

      expect(result.markers[2].label).toBe('Chorus 1 Section');
      expect(result.markers[2].timestampSeconds).toBe(30.0);
      expect(result.markers[2].notes).toContain('45.000s');

      expect(result.markers[3].category).toBe('Effect');
      expect(result.markers[4].category).toBe('Note');

      // Verify 1 Confirmed Marker = 1 Cue = 1 Timecode Event invariant
      const compiled = compileShow(result.markers, testConfig);
      const validation = validateCompiledShow(compiled);
      expect(validation.isValid).toBe(true);
      expect(compiled.cues).toHaveLength(5);
      expect(compiled.events).toHaveLength(5);
      expect(compiled.cues.map((c) => c.name)).toEqual(
        result.markers.map((m) => m.label)
      );
    });

    it('supports headerless Reaper CSV rows, custom timing columns without false End/ID collisions, and skips malformed rows with warnings', () => {
      const csvWithCustomCols = [
        '#,Name,Start,Category,FadeIn,FadeOut,Delay,Notes',
        'M1,Opening Look,2.0,Custom,3.5,4.0,0.5,Warm tungsten',
        'M2,Bad Row,not_a_timestamp,Hit,0,0,0,',
      ].join('\n');

      const res = parseReaperMarkerCsv(csvWithCustomCols);
      expect(res.markers).toHaveLength(1);
      expect(res.warnings).toHaveLength(1);
      expect(res.markers[0]).toMatchObject({
        label: 'Opening Look',
        timestampSeconds: 2.0,
        category: 'Custom',
        fadeInSeconds: 3.5,
        fadeOutSeconds: 4.0,
        delaySeconds: 0.5,
        notes: 'Warm tungsten',
        confirmed: true,
        exportEnabled: true,
      });

      // Custom header without End or Notes must not misread column 3 (FadeIn) as Region End note
      const csvWithoutEndOrNotes = '#,Name,Start,FadeIn\nM1,Opening Look,2.0,3.5';
      const noEndRes = parseReaperMarkerCsv(csvWithoutEndOrNotes);
      expect(noEndRes.markers[0].fadeInSeconds).toBe(3.5);
      expect(noEndRes.markers[0].notes).toBeUndefined();

      // Reordered header without # column ("Start,Name") must not misread Start as ID
      const reorderedHeaderCsv = 'Start,Name\n2.5,Verse Groove';
      const reorderedRes = parseReaperMarkerCsv(reorderedHeaderCsv);
      expect(reorderedRes.markers[0].id).toBe('reaper-1-1');
      expect(reorderedRes.markers[0].label).toBe('Verse Groove');
      expect(reorderedRes.markers[0].timestampSeconds).toBe(2.5);

      // Headerless CSV where the first marker is literally named "Start" must not be skipped as a header
      const headerlessWithStartName = 'M1,Start,0:01.000\nM2,Outro Fade,0:12.000';
      const headerlessStartRes = parseReaperMarkerCsv(headerlessWithStartName);
      expect(headerlessStartRes.markers).toHaveLength(2);
      expect(headerlessStartRes.markers[0].label).toBe('Start');
      expect(headerlessStartRes.markers[0].timestampSeconds).toBe(1.0);
      expect(headerlessStartRes.markers[1].label).toBe('Outro Fade');
    });

    it('supports semicolon-delimited Reaper CSVs, UTF-8 BOM, Measures.Beats timestamps, and chronological sorting', () => {
      const semicolonMusicalCsv = [
        '\uFEFF#;Name;Start;End;Length;Color',
        'M2;Chorus Blinder Hit;5.1.00;;;FF0000',
        'R1;Intro Pad;1.1.00;3.1.00;2.0.00;00FF00',
      ].join('\n');

      // At 120 BPM (4/4): 1.1.00 = 0s, 3.1.00 = 4s, 5.1.00 = 8s
      const res = parseReaperMarkerCsv(semicolonMusicalCsv, {
        bpm: 120,
        beatsPerBar: 4,
      });
      expect(res.markers).toHaveLength(2);
      // Sorted chronologically: R1 (0s) before M2 (8s)
      expect(res.markers[0].label).toBe('Intro Pad');
      expect(res.markers[0].timestampSeconds).toBe(0);
      expect(res.markers[0].notes).toContain('4.000s');
      expect(res.markers[1].label).toBe('Chorus Blinder Hit');
      expect(res.markers[1].timestampSeconds).toBe(8.0);
    });

    it('throws on an empty Reaper CSV input', () => {
      expect(() => parseReaperMarkerCsv('   \n  ')).toThrow(/empty/i);
    });
  });

  describe('Audacity Label Track (.txt / .tsv) Import', () => {
    it('imports point labels, region labels, space-separated multi-word labels, and ignores spectral selection & comment lines', () => {
      const audacityTxt = [
        '\uFEFF# Audacity Label Track export',
        '1.250000\t1.250000\tIntro Wash',
        '\\\t440.000000\t880.000000',
        '14.500000\t14.500000\tDownbeat Hit',
        '28.000000\t36.000000\tStrobe Riser Sweep',
        '42.125000\t42.125000\tCue Note: Spot 1 Enter',
        '55.000000 55.000000 [Custom] Confetti Relay Arm',
      ].join('\n');

      const result = parseAudacityLabelTrack(audacityTxt);
      expect(result.format).toBe('audacity-txt');
      expect(result.warnings).toHaveLength(0);
      expect(result.markers).toHaveLength(5);

      expect(result.markers.map((m) => m.label)).toEqual([
        'Intro Wash',
        'Downbeat Hit',
        'Strobe Riser Sweep',
        'Cue Note: Spot 1 Enter',
        '[Custom] Confetti Relay Arm',
      ]);
      expect(result.markers.map((m) => m.category)).toEqual([
        'Structure',
        'Hit',
        'Effect',
        'Note',
        'Custom',
      ]);
      expect(result.markers[2].notes).toContain('36.000s');

      // Verify 1:1:1 compilation invariant
      const compiled = compileShow(result.markers, testConfig);
      expect(compiled.cues).toHaveLength(5);
      expect(compiled.events).toHaveLength(5);
      expect(validateCompiledShow(compiled).isValid).toBe(true);
    });

    it('handles unlabeled Audacity timestamps and throws on empty files', () => {
      const unlabeled = '10.000000\t10.000000\t\n20.500000\t20.500000';
      const res = parseAudacityLabelTrack(unlabeled);
      expect(res.markers).toHaveLength(2);
      expect(res.markers[0].label).toBe('Label 1');
      expect(res.markers[1].label).toBe('Label 2');

      expect(() => parseAudacityLabelTrack('# only comments\n\n')).toThrow(
        /empty/i
      );
    });
  });

  describe('CueForge JSON Import & Auto-Detection', () => {
    it('imports markers from both full CueForge project JSON and raw marker arrays, normalizing to confirmed & exportEnabled and deduplicating IDs', () => {
      const rawMarkerArrayJson =
        '\uFEFF' +
        JSON.stringify([
          {
            id: 'dup-id',
            label: 'Drop Blinder Hit',
            timestampSeconds: 24.0,
            category: 'hit',
            confirmed: true,
            exportEnabled: true,
            fadeInSeconds: 0,
            delaySeconds: 0,
          },
          {
            id: 'dup-id',
            label: 'Verse Groove',
            timestampSeconds: 8.5,
            confirmed: false,
            exportEnabled: false,
            fadeInSeconds: 2.0,
            delaySeconds: 0.1,
          },
        ]);

      const imported = parseCueForgeJsonMarkers(rawMarkerArrayJson);
      expect(imported.format).toBe('cueforge-json');
      expect(imported.markers).toHaveLength(2);
      expect(imported.markers.every((m) => m.confirmed && m.exportEnabled)).toBe(
        true
      );
      // Chronologically sorted (8.5s first, then 24.0s) and unique IDs
      expect(imported.markers.map((m) => m.timestampSeconds)).toEqual([8.5, 24.0]);
      expect(imported.markers[0].category).toBe('Structure');
      expect(imported.markers[1].category).toBe('Hit');
      expect(new Set(imported.markers.map((m) => m.id)).size).toBe(2);

      // Must pass 1:1:1 show compilation & validation without duplicate ID errors
      const compiled = compileShow(imported.markers, testConfig);
      expect(validateCompiledShow(compiled).isValid).toBe(true);

      // Test auto-detection by filename and content (including space-separated Audacity with comma in label and semicolon CSV)
      expect(
        importMarkersFromFileContent(rawMarkerArrayJson, 'markers.json').format
      ).toBe('cueforge-json');
      expect(
        importMarkersFromFileContent('M1,Intro,1.5', 'reaper.csv').format
      ).toBe('reaper-csv');
      expect(
        importMarkersFromFileContent('M1;Intro;1.5').format
      ).toBe('reaper-csv');
      expect(
        importMarkersFromFileContent('1.5 1.5 Intro, Part A').format
      ).toBe('audacity-txt');
      expect(
        importMarkersFromFileContent('1.5\t1.5\tIntro', 'labels.txt').format
      ).toBe('audacity-txt');
    });

    it('merges imported markers in replace or append mode with collision-free IDs and chronological sorting', () => {
      const existing = createDefaultDemoShow().markers.slice(0, 2); // m-1 at 0.5s, m-2 at 7.5s
      const incoming = [
        {
          ...existing[0],
          id: 'm-1', // intentional ID collision
          label: 'Inserted Mid Cue',
          timestampSeconds: 4.0,
        },
      ];

      const appended = mergeImportedMarkers(existing, incoming, 'append');
      expect(appended).toHaveLength(3);
      expect(appended.map((m) => m.timestampSeconds)).toEqual([0.5, 4.0, 7.5]);
      expect(new Set(appended.map((m) => m.id)).size).toBe(3);

      const replaced = mergeImportedMarkers(existing, incoming, 'replace');
      expect(replaced).toHaveLength(1);
      expect(replaced[0].label).toBe('Inserted Mid Cue');
    });
  });
});

describe('CueForge Project Persistence (JSON Round-Trip & localStorage Auto-Save)', () => {
  const memoryStorage = new Map<string, string>();
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    memoryStorage.clear();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => memoryStorage.get(key) ?? null,
        setItem: (key: string, val: string) => {
          memoryStorage.set(key, val);
        },
        removeItem: (key: string) => {
          memoryStorage.delete(key);
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  it('serializes and deserializes a complete CueForge project without loss (including UTF-8 BOM)', () => {
    const demo = createDefaultDemoShow();
    const projectInput = {
      config: testConfig,
      markers: demo.markers,
      beatGrid: demo.beatGrid.slice(0, 16),
      bpm: demo.bpm,
      waveformPeaks: demo.waveformPeaks.slice(0, 20),
    };

    const json = serializeProjectToJson(projectInput);
    const restored = deserializeProjectFromJson('\uFEFF' + json);

    expect(restored.format).toBe(CUEFORGE_PROJECT_FORMAT);
    expect(restored.schemaVersion).toBe(CUEFORGE_PROJECT_SCHEMA_VERSION);
    expect(restored.config).toEqual(testConfig);
    expect(restored.markers).toEqual(demo.markers);
    expect(restored.beatGrid).toEqual(demo.beatGrid.slice(0, 16));
    expect(restored.bpm).toBe(demo.bpm);
    expect(restored.waveformPeaks).toEqual(demo.waveformPeaks.slice(0, 20));

    // Also verify parseCueForgeJsonMarkers returns the full project when given a full project JSON
    const dawProjectImport = parseCueForgeJsonMarkers(json);
    expect(dawProjectImport.project).toBeDefined();
    expect(dawProjectImport.markers).toHaveLength(demo.markers.length);
  });

  it('saves, loads, and clears project state in localStorage and recovers gracefully from corrupt storage', () => {
    const demo = createDefaultDemoShow();
    const projectInput = {
      config: testConfig,
      markers: demo.markers,
      beatGrid: demo.beatGrid.slice(0, 8),
      bpm: 132,
    };

    const savedOk = saveProjectToLocalStorage(projectInput);
    expect(savedOk).toBe(true);

    const loaded = loadProjectFromLocalStorage();
    expect(loaded).not.toBeNull();
    expect(loaded?.config.songTitle).toBe('Hyperion Live');
    expect(loaded?.markers).toHaveLength(demo.markers.length);
    expect(loaded?.bpm).toBe(132);

    // Corrupt localStorage data should return null instead of crashing
    globalThis.localStorage.setItem(
      'cueforge_project_autosave_v1',
      '{bad-json'
    );
    expect(loadProjectFromLocalStorage()).toBeNull();

    clearProjectFromLocalStorage();
    expect(loadProjectFromLocalStorage()).toBeNull();
  });

  it('rejects malformed or incomplete JSON in deserializeProjectFromJson', () => {
    expect(() => deserializeProjectFromJson('')).toThrow(/empty/i);
    expect(() => deserializeProjectFromJson('{not valid json}')).toThrow(
      /Malformed/i
    );
    expect(() => deserializeProjectFromJson(JSON.stringify({}))).toThrow(
      /missing "config"/i
    );
    expect(() =>
      deserializeProjectFromJson(JSON.stringify({ config: testConfig }))
    ).toThrow(/missing "markers"/i);
  });
});
