import { describe, expect, it } from 'vitest';
import { compileShow } from '../compiler';
import { validateCompiledShow } from '../validator';
import { generateMa3ExportBundle } from '../ma3Exporter';
import { computeTimecodeTimestamp, MA3_TICKS_PER_SECOND } from '../timecodeMath';
import { generateBeatGrid, promoteBeatGridPointToMarker } from '../audioAnalysis';
import {
  clampMarkerTime,
  computeZoomedViewport,
  ensureTimeVisibleInViewport,
  nudgeMarkerTimestamp,
  panViewport,
  shouldIgnoreGlobalShortcut,
  snapTimeToBeatGrid,
  timeToViewportPercent,
  viewportRatioToTime,
} from '../timelineNavigation';
import { ExportConfiguration, Marker } from '../../types/cueforge';

const baseConfig: ExportConfiguration = {
  songTitle: 'Test Track',
  ma3Version: '2.5.x',
  sequenceId: 101,
  sequenceName: 'Test Track Seq',
  timecodeId: 101,
  timecodeName: 'Test Track TC',
  macroId: 101,
  frameRate: 30,
  timecodeOffsetSeconds: 3600, // 01:00:00:00
  latencyCompensationMs: 0,
  executionMode: 'Go+',
  allowOverwriteExistingObjects: false,
  songDurationSeconds: 120,
};

const sampleMarkers: Marker[] = [
  {
    id: 'm3',
    label: 'Chorus Drop',
    timestampSeconds: 30.0,
    category: 'Hit',
    origin: 'analysis',
    confirmed: true,
    exportEnabled: true,
    fadeInSeconds: 0,
    delaySeconds: 0,
  },
  {
    id: 'm1',
    label: 'Intro Wash',
    timestampSeconds: 1.5,
    category: 'Structure',
    origin: 'manual',
    confirmed: true,
    exportEnabled: true,
    fadeInSeconds: 2.5,
    fadeOutSeconds: 3.0,
    delaySeconds: 0.5,
  },
  {
    id: 'm2',
    label: 'Spot Cue Note',
    timestampSeconds: 12.0,
    category: 'Note',
    origin: 'manual',
    confirmed: true,
    exportEnabled: true,
    fadeInSeconds: 1.0,
    delaySeconds: 0,
  },
  {
    id: 'm4',
    label: 'Strobe Sweep',
    timestampSeconds: 45.25,
    category: 'Effect',
    origin: 'analysis',
    confirmed: true,
    exportEnabled: true,
    fadeInSeconds: 0.2,
    delaySeconds: 0,
  },
];

describe('CueForge Core Requirement: One Marker = One Cue = One Timecode Event', () => {
  it('enforces 1:1:1 relationship and preserves all marker categories (Structure, Note, Hit, Effect)', () => {
    const compiled = compileShow(sampleMarkers, baseConfig);

    expect(compiled.exportableMarkers).toHaveLength(4);
    expect(compiled.cues).toHaveLength(4);
    expect(compiled.events).toHaveLength(4);

    // Chronological sorting: m1 (1.5s) -> Cue 1, m2 (12.0s) -> Cue 2, m3 (30.0s) -> Cue 3, m4 (45.25s) -> Cue 4
    expect(compiled.cues.map((c) => c.cueNumber)).toEqual([1, 2, 3, 4]);
    expect(compiled.cues.map((c) => c.name)).toEqual([
      'Intro Wash',
      'Spot Cue Note',
      'Chorus Drop',
      'Strobe Sweep',
    ]);

    // Trigger type must strictly be 'Go', never Follow or Time
    for (const cue of compiled.cues) {
      expect(cue.trigType).toBe('Go');
    }

    // Events must have 1:1 explicit cue destinations and Go+ token by default
    compiled.events.forEach((ev, idx) => {
      expect(ev.eventIndex).toBe(idx + 1);
      expect(ev.cueDestinationNumber).toBe(idx + 1);
      expect(ev.cueDestinationName).toBe(compiled.cues[idx].name);
      expect(ev.targetSequenceId).toBe(101);
      expect(ev.token).toBe('Go+');
    });
  });

  it('allows users to explicitly disable export for individual markers while keeping others sequential', () => {
    const markersWithDisabled: Marker[] = sampleMarkers.map((m) =>
      m.id === 'm2' ? { ...m, exportEnabled: false } : m
    );
    const compiled = compileShow(markersWithDisabled, baseConfig);

    expect(compiled.exportableMarkers).toHaveLength(3);
    expect(compiled.excludedMarkers).toHaveLength(1);
    expect(compiled.cues.map((c) => c.cueNumber)).toEqual([1, 2, 3]);
    expect(compiled.cues.map((c) => c.name)).toEqual([
      'Intro Wash',
      'Chorus Drop',
      'Strobe Sweep',
    ]);
    expect(compiled.events.map((e) => e.cueDestinationNumber)).toEqual([1, 2, 3]);
  });

  it('never automatically converts beat grid points into cues unless explicitly promoted', () => {
    const grid = generateBeatGrid(60, 120, 0);
    expect(grid.length).toBeGreaterThan(100);

    // Compiling markers without promoting beat grid produces only confirmed markers
    const compiledBefore = compileShow(sampleMarkers, baseConfig);
    expect(compiledBefore.cues).toHaveLength(4);

    // Explicitly promoting one beat grid point adds exactly 1 confirmed marker -> 1 cue -> 1 event
    const promoted = promoteBeatGridPointToMarker(grid[8], 'Bar 3 Downbeat');
    const compiledAfter = compileShow([...sampleMarkers, promoted], baseConfig);
    expect(compiledAfter.cues).toHaveLength(5);
    expect(compiledAfter.events).toHaveLength(5);
  });

  it('computes frame-accurate SMPTE timestamps, offsets, and latency compensation without hidden offsets', () => {
    // 10.5 seconds at 30 fps with 01:00:00:00 (3600s) offset and 0ms latency
    const t1 = computeTimecodeTimestamp(10.5, 30, 3600, 0);
    expect(t1.relativeSeconds).toBe(10.5);
    expect(t1.absoluteSeconds).toBe(3610.5);
    expect(t1.formattedAbsoluteSmpte).toBe('01:00:10:15');
    expect(t1.ma3InternalTicks).toBe(Math.round(3610.5 * MA3_TICKS_PER_SECOND));

    // With -50ms latency compensation at 25 fps (10.5s - 0.05s = 10.45s -> 261.25 frames -> frame 261 = 10s 11f)
    const t2 = computeTimecodeTimestamp(10.5, 25, 0, -50);
    expect(t2.relativeFrames).toBe(261);
    expect(t2.formattedAbsoluteSmpte).toBe('00:00:10:11');
  });

  it('supports Goto(Status) as an optional advanced execution mode', () => {
    const gotoConfig: ExportConfiguration = {
      ...baseConfig,
      executionMode: 'Goto(Status)',
    };
    const compiled = compileShow(sampleMarkers, gotoConfig);
    expect(compiled.events.every((e) => e.token === 'Goto')).toBe(true);

    const bundle = generateMa3ExportBundle(compiled);
    expect(bundle.macroCommandText).toContain("ev:Set('token', 'Goto')");
    expect(bundle.macroXml).toContain("ev:Set(&apos;token&apos;, &apos;Goto&apos;)");
    expect(bundle.timecodeXml).toContain('<CmdEvent Name="Goto"');
  });

  it('validates all mandatory export checks and generates valid grandMA3 2.5.x Macro & Timecode XML', () => {
    const compiled = compileShow(sampleMarkers, baseConfig);
    const report = validateCompiledShow(compiled);
    expect(report.isValid).toBe(true);
    expect(report.errors).toHaveLength(0);

    const bundle = generateMa3ExportBundle(compiled);
    expect(bundle.macroXml).toContain('<GMA3 DataVersion="2.5.0.0">');
    expect(bundle.macroXml).toContain('Store Sequence 101 &quot;Test Track Seq&quot; /NoConfirm');
    expect(bundle.macroXml).toContain('Set Sequence 101 Cue 1 Property &quot;TrigType&quot; &quot;Go&quot;');
    expect(bundle.macroXml).toContain('Sequence 101 Cue 1 CueFade 2.5/3 CueDelay 0.5');
    expect(bundle.macroXml).toContain('CueForge Safety Stop');
    expect(bundle.timecodeXml).toContain('CueDestination="Intro Wash" CueDestinationIndex="1"');
  });
});

describe('Interactive Timeline UX: Zoom/Pan, Marker Dragging, Snap-to-Beat-Grid & Shortcuts', () => {
  it('computes zoomed viewports centered on anchor and clamps zoom factor to [1x..256x]', () => {
    // 1x full song view
    const vp1 = computeZoomedViewport(120, 1, 45);
    expect(vp1).toEqual({
      startSeconds: 0,
      visibleDurationSeconds: 120,
      zoomFactor: 1,
    });

    // 4x zoom centered around 60s -> 30s window from 45s to 75s
    const vp4 = computeZoomedViewport(120, 4, 60);
    expect(vp4.zoomFactor).toBe(4);
    expect(vp4.visibleDurationSeconds).toBe(30);
    expect(vp4.startSeconds).toBe(45);

    // Clamps zoom factor boundaries (< 1 -> 1, > 256 -> 256) and handles edge anchors
    const vpUnder = computeZoomedViewport(120, 0.25, 10);
    expect(vpUnder.zoomFactor).toBe(1);
    expect(vpUnder.startSeconds).toBe(0);

    const vpOver = computeZoomedViewport(120, 1000, 120);
    expect(vpOver.zoomFactor).toBe(256);
    expect(vpOver.visibleDurationSeconds).toBe(0.4688);
    expect(vpOver.startSeconds).toBe(119.5313);
  });

  it('pans the viewport within [0, songDuration - visibleDuration] and maps ratios/percentages', () => {
    const vp = computeZoomedViewport(120, 4, 60); // 45s .. 75s
    const pannedLeft = panViewport(vp, -100, 120);
    expect(pannedLeft.startSeconds).toBe(0);

    const pannedRight = panViewport(vp, 100, 120);
    expect(pannedRight.startSeconds).toBe(90); // 90s .. 120s

    // Midpoint of [45..75] is 60s -> 50%
    expect(timeToViewportPercent(60, vp)).toBeCloseTo(50, 3);
    expect(timeToViewportPercent(45, vp)).toBeCloseTo(0, 3);
    expect(timeToViewportPercent(75, vp)).toBeCloseTo(100, 3);
    // Outside viewport returns null
    expect(timeToViewportPercent(10, vp)).toBeNull();
    expect(timeToViewportPercent(100, vp)).toBeNull();

    // Pointer ratio to time in [45..75]
    expect(viewportRatioToTime(0.5, vp, 120)).toBe(60);
    expect(viewportRatioToTime(-0.5, vp, 120)).toBe(45);
    expect(viewportRatioToTime(1.5, vp, 120)).toBe(75);
  });

  it('snaps dragged marker timestamps to the nearest BeatGridPoint when enabled without auto-exporting grid points', () => {
    // 120 BPM = 0.5s per beat (0.0, 0.5, 1.0, 1.5, 2.0, ...)
    const grid = generateBeatGrid(30, 120, 0);

    // Within 0.18s of 10.0s beat -> snaps to 10.000s
    const snapped = snapTimeToBeatGrid(10.12, grid, true, 30, 0.18);
    expect(snapped.timestampSeconds).toBe(10.0);
    expect(snapped.snappedBeat).not.toBeNull();

    // When snapEnabled is false -> preserves exact dragged timestamp
    const unsnapped = snapTimeToBeatGrid(10.12, grid, false, 30, 0.18);
    expect(unsnapped.timestampSeconds).toBe(10.12);
    expect(unsnapped.snappedBeat).toBeNull();

    // Outside snap distance (e.g., 10.25s with maxSnapDistance = 0.10s) -> does not snap
    const far = snapTimeToBeatGrid(10.25, grid, true, 30, 0.1);
    expect(far.timestampSeconds).toBe(10.25);
    expect(far.snappedBeat).toBeNull();
  });

  it('clamps and nudges markers via keyboard arrows and re-compiles chronological cues & events when dragged past another marker', () => {
    expect(clampMarkerTime(-5, 120)).toBe(0);
    expect(clampMarkerTime(150, 120)).toBe(120);
    expect(nudgeMarkerTimestamp(0.02, -0.05, 120)).toBe(0);
    expect(nudgeMarkerTimestamp(119.98, 0.05, 120)).toBe(120);
    expect(nudgeMarkerTimestamp(12.0, 0.25, 120)).toBe(12.25);

    // Drag marker 'm3' ("Chorus Drop", originally at 30.0s) to 5.0s (before 'm2' at 12.0s)
    const draggedMarkers = sampleMarkers.map((m) =>
      m.id === 'm3' ? { ...m, timestampSeconds: 5.0 } : m
    );
    const recompiled = compileShow(draggedMarkers, baseConfig);
    expect(recompiled.cues.map((c) => c.name)).toEqual([
      'Intro Wash',
      'Chorus Drop',
      'Spot Cue Note',
      'Strobe Sweep',
    ]);
    expect(recompiled.events[1].cueDestinationNumber).toBe(2);
    expect(recompiled.events[1].cueDestinationName).toBe('Chorus Drop');
    expect(recompiled.events[1].timing.relativeSeconds).toBe(5.0);
    expect(validateCompiledShow(recompiled).isValid).toBe(true);
  });

  it('auto-pans zoomed viewports to keep nudged markers and jumped playheads visible', () => {
    const vp = computeZoomedViewport(120, 4, 60); // [45s .. 75s]

    // Target already inside [45..75] does not pan
    expect(ensureTimeVisibleInViewport(vp, 55, 120)).toEqual(vp);

    // Nudging left past 45s pans left so target is at the start edge
    const pannedLeft = ensureTimeVisibleInViewport(vp, 44.75, 120);
    expect(pannedLeft.startSeconds).toBe(44.75);
    expect(timeToViewportPercent(44.75, pannedLeft)).toBeCloseTo(0, 3);

    // Nudging right past 75s pans right so target is at the end edge
    const pannedRight = ensureTimeVisibleInViewport(vp, 75.25, 120);
    expect(pannedRight.startSeconds).toBe(45.25);
    expect(timeToViewportPercent(75.25, pannedRight)).toBeCloseTo(100, 3);
  });

  it('filters global keyboard shortcut targets and key-repeat events so typing, holding keys, or activating buttons is not hijacked', () => {
    expect(shouldIgnoreGlobalShortcut({ tagName: 'INPUT' }, 'Space')).toBe(true);
    expect(shouldIgnoreGlobalShortcut({ tagName: 'TEXTAREA' }, 'KeyM')).toBe(true);
    expect(shouldIgnoreGlobalShortcut({ tagName: 'SELECT' }, 'Space')).toBe(true);
    expect(shouldIgnoreGlobalShortcut({ tagName: 'DIV', isContentEditable: true }, 'KeyM')).toBe(true);
    expect(shouldIgnoreGlobalShortcut({ tagName: 'BUTTON' }, 'Space')).toBe(true);
    expect(shouldIgnoreGlobalShortcut({ tagName: 'BUTTON' }, 'KeyM')).toBe(false);
    expect(shouldIgnoreGlobalShortcut({ tagName: 'DIV' }, 'Space')).toBe(false);
    expect(shouldIgnoreGlobalShortcut(null, 'Space')).toBe(false);

    // Key-repeat events (e.g., holding down Space or M) must be ignored
    expect(shouldIgnoreGlobalShortcut({ tagName: 'DIV' }, 'Space', true)).toBe(true);
    expect(shouldIgnoreGlobalShortcut(null, 'KeyM', true)).toBe(true);

    // Nested child elements inside a button or input are detected via closest()
    const nestedInButton = {
      tagName: 'SPAN',
      closest: (sel: string) => (sel.includes('button') ? {} : null),
    };
    expect(shouldIgnoreGlobalShortcut(nestedInButton, 'Space')).toBe(true);
    expect(shouldIgnoreGlobalShortcut(nestedInButton, 'KeyM')).toBe(false);
  });
});


