import { describe, expect, it } from 'vitest';
import {
  bulkDeleteMarkers,
  bulkNudgeTime,
  bulkUpdateCategory,
  bulkUpdateDelay,
  bulkUpdateExportEnabled,
  bulkUpdateFadeIn,
  selectMarkersByCategory,
} from '../bulkOperations';
import { computeCueMonitorStatus } from '../cueStatusMonitor';
import {
  getCountInBeatInfo,
  getCountInTotalBars,
  getCountInTotalBeats,
} from '../countIn';
import { CompiledCue, Marker } from '../../types/cueforge';

const sampleMarkers: Marker[] = [
  {
    id: 'm1',
    label: 'Intro',
    timestampSeconds: 5.0,
    category: 'Structure',
    origin: 'manual',
    confirmed: true,
    exportEnabled: true,
    fadeInSeconds: 1.0,
    delaySeconds: 0,
  },
  {
    id: 'm2',
    label: 'Verse 1',
    timestampSeconds: 15.0,
    category: 'Structure',
    origin: 'manual',
    confirmed: true,
    exportEnabled: true,
    fadeInSeconds: 2.0,
    delaySeconds: 0.5,
  },
  {
    id: 'm3',
    label: 'Snare Hit',
    timestampSeconds: 25.0,
    category: 'Hit',
    origin: 'analysis',
    confirmed: true,
    exportEnabled: false,
    fadeInSeconds: 0,
    delaySeconds: 0,
  },
];

const sampleCues: CompiledCue[] = [
  {
    cueNumber: 1,
    sourceMarkerId: 'm1',
    name: 'Intro',
    category: 'Structure',
    trigType: 'Go',
    cueFadeIn: 1.0,
    cueDelay: 0,
  },
  {
    cueNumber: 2,
    sourceMarkerId: 'm2',
    name: 'Verse 1',
    category: 'Structure',
    trigType: 'Go',
    cueFadeIn: 2.0,
    cueDelay: 0.5,
  },
  {
    cueNumber: 3,
    sourceMarkerId: 'm3',
    name: 'Snare Hit',
    category: 'Hit',
    trigType: 'Go',
    cueFadeIn: 0,
    cueDelay: 0,
  },
];

describe('Bulk Marker Operations', () => {
  it('updates Fade In only for selected markers', () => {
    const selected = new Set(['m1', 'm3']);
    const updated = bulkUpdateFadeIn(sampleMarkers, selected, 0.5);

    expect(updated[0].fadeInSeconds).toBe(0.5);
    expect(updated[1].fadeInSeconds).toBe(2.0); // unchanged
    expect(updated[2].fadeInSeconds).toBe(0.5);
  });

  it('updates Delay only for selected markers', () => {
    const selected = new Set(['m2']);
    const updated = bulkUpdateDelay(sampleMarkers, selected, 1.2);

    expect(updated[0].delaySeconds).toBe(0);
    expect(updated[1].delaySeconds).toBe(1.2);
    expect(updated[2].delaySeconds).toBe(0);
  });

  it('nudges time by positive and negative offsets and clamps to bounds', () => {
    const selected = new Set(['m1', 'm2']);
    // Nudge backward 10s: m1 (5s) -> clamped to 0s, m2 (15s) -> 5s
    const nudgedBack = bulkNudgeTime(sampleMarkers, selected, -10.0, 100);
    expect(nudgedBack[0].timestampSeconds).toBe(0);
    expect(nudgedBack[1].timestampSeconds).toBe(5);
    expect(nudgedBack[2].timestampSeconds).toBe(25); // unchanged

    // Nudge forward past max duration: max = 30s
    const nudgedForward = bulkNudgeTime(sampleMarkers, selected, 50.0, 30);
    expect(nudgedForward[0].timestampSeconds).toBe(30);
    expect(nudgedForward[1].timestampSeconds).toBe(30);
  });

  it('updates Category for selected markers', () => {
    const selected = new Set(['m1', 'm2']);
    const updated = bulkUpdateCategory(sampleMarkers, selected, 'Effect');

    expect(updated[0].category).toBe('Effect');
    expect(updated[1].category).toBe('Effect');
    expect(updated[2].category).toBe('Hit');
  });

  it('updates exportEnabled flag for selected markers', () => {
    const selected = new Set(['m3']);
    const updated = bulkUpdateExportEnabled(sampleMarkers, selected, true);
    expect(updated[2].exportEnabled).toBe(true);
  });

  it('deletes selected markers', () => {
    const selected = new Set(['m2']);
    const updated = bulkDeleteMarkers(sampleMarkers, selected);
    expect(updated).toHaveLength(2);
    expect(updated.map((m) => m.id)).toEqual(['m1', 'm3']);
  });

  it('selects markers by category', () => {
    const structureIds = selectMarkersByCategory(sampleMarkers, 'Structure');
    expect(Array.from(structureIds)).toEqual(['m1', 'm2']);

    const hitIds = selectMarkersByCategory(sampleMarkers, 'Hit');
    expect(Array.from(hitIds)).toEqual(['m3']);
  });
});

describe('Cue Status Monitor HUD Calculations', () => {
  it('correctly reports standby status when playhead is before first cue', () => {
    const status = computeCueMonitorStatus(sampleCues, sampleMarkers, 2.0, 30);
    expect(status.activeCue).toBeNull();
    expect(status.nextCue?.cueNumber).toBe(1);
    expect(status.nextCue?.name).toBe('Intro');
    expect(status.countdownSeconds).toBe(3.0);
    expect(status.countdownFrames).toBe(90); // 3s * 30fps
    expect(status.isTriggerMoment).toBe(false);
  });

  it('reports active cue, trigger moment, and fade progress during cue 1', () => {
    // Exactly at cue 1 timestamp 5.0s
    const statusAtTrigger = computeCueMonitorStatus(sampleCues, sampleMarkers, 5.0, 30);
    expect(statusAtTrigger.activeCue?.cueNumber).toBe(1);
    expect(statusAtTrigger.isTriggerMoment).toBe(true);
    expect(statusAtTrigger.fadeProgress).toBe(0);

    // 0.5s into 1.0s fade -> 50%
    const statusMidFade = computeCueMonitorStatus(sampleCues, sampleMarkers, 5.5, 30);
    expect(statusMidFade.activeCue?.cueNumber).toBe(1);
    expect(statusMidFade.fadeProgress).toBe(0.5);
    expect(statusMidFade.nextCue?.cueNumber).toBe(2);

    // 1.5s past cue 1 -> fade is 100% complete
    const statusPostFade = computeCueMonitorStatus(sampleCues, sampleMarkers, 6.5, 30);
    expect(statusPostFade.activeCue?.cueNumber).toBe(1);
    expect(statusPostFade.fadeProgress).toBe(1.0);
    expect(statusPostFade.isTriggerMoment).toBe(false);
  });

  it('handles 0s fade time as immediately 100%', () => {
    // Cue 3 has fadeIn = 0s at t = 25.0s
    const statusCue3 = computeCueMonitorStatus(sampleCues, sampleMarkers, 25.0, 30);
    expect(statusCue3.activeCue?.cueNumber).toBe(3);
    expect(statusCue3.fadeProgress).toBe(1.0);
    expect(statusCue3.nextCue).toBeNull();
  });
});

describe('Count-In Calculations', () => {
  it('computes total bars and beats correctly', () => {
    expect(getCountInTotalBars('off')).toBe(0);
    expect(getCountInTotalBars('1bar')).toBe(1);
    expect(getCountInTotalBars('2bars')).toBe(2);

    expect(getCountInTotalBeats('1bar', 4)).toBe(4);
    expect(getCountInTotalBeats('2bars', 4)).toBe(8);
    expect(getCountInTotalBeats('2bars', 3)).toBe(6);
  });

  it('returns accurate bar and beat breakdown during count-in', () => {
    // 2 bars of 4/4 = 8 beats (indices 0..7)
    const beat0 = getCountInBeatInfo(0, '2bars', 4);
    expect(beat0.barNumber).toBe(1);
    expect(beat0.beatInBar).toBe(1);
    expect(beat0.isDownbeat).toBe(true);
    expect(beat0.remainingBeats).toBe(8);

    const beat3 = getCountInBeatInfo(3, '2bars', 4);
    expect(beat3.barNumber).toBe(1);
    expect(beat3.beatInBar).toBe(4);
    expect(beat3.isDownbeat).toBe(false);

    const beat4 = getCountInBeatInfo(4, '2bars', 4);
    expect(beat4.barNumber).toBe(2);
    expect(beat4.beatInBar).toBe(1);
    expect(beat4.isDownbeat).toBe(true);

    const beat7 = getCountInBeatInfo(7, '2bars', 4);
    expect(beat7.barNumber).toBe(2);
    expect(beat7.beatInBar).toBe(4);
    expect(beat7.remainingBeats).toBe(1);
  });

  it('handles mode=off or zero bars safely without producing NaN or out-of-bounds bars', () => {
    const offInfo = getCountInBeatInfo(0, 'off', 4);
    expect(offInfo.barNumber).toBe(0);
    expect(offInfo.beatInBar).toBe(0);
    expect(offInfo.remainingBeats).toBe(0);
    expect(offInfo.totalBars).toBe(0);
    expect(offInfo.isDownbeat).toBe(false);

    // Negative beat index or non-finite inputs
    const safeInfo = getCountInBeatInfo(-5, '1bar', Number.NaN);
    expect(safeInfo.barNumber).toBe(1);
    expect(safeInfo.beatInBar).toBe(1);
    expect(safeInfo.remainingBeats).toBe(4);
  });
});

describe('Edge Cases & Defensive Invariants', () => {
  it('bulk operations safely sanitize non-finite inputs (NaN, Infinity)', () => {
    const selected = new Set(['m1']);
    const badFade = bulkUpdateFadeIn(sampleMarkers, selected, Number.NaN);
    expect(badFade[0].fadeInSeconds).toBe(0);

    const infDelay = bulkUpdateDelay(sampleMarkers, selected, Infinity);
    expect(infDelay[0].delaySeconds).toBe(0);

    const nanNudge = bulkNudgeTime(sampleMarkers, selected, Number.NaN, 100);
    expect(nanNudge[0].timestampSeconds).toBe(5.0); // unchanged
  });

  it('cue monitor handles identical timestamps and non-finite playheads deterministically', () => {
    const tiedCues: CompiledCue[] = [
      {
        cueNumber: 1,
        sourceMarkerId: 'm1',
        name: 'First',
        category: 'Structure',
        trigType: 'Go',
        cueFadeIn: 1.0,
        cueDelay: 0,
      },
      {
        cueNumber: 2,
        sourceMarkerId: 'm2',
        name: 'Second',
        category: 'Hit',
        trigType: 'Go',
        cueFadeIn: 0,
        cueDelay: 0,
      },
    ];
    const tiedMarkers: Marker[] = [
      {
        id: 'm1',
        label: 'First',
        timestampSeconds: 10.0,
        category: 'Structure',
        origin: 'manual',
        confirmed: true,
        exportEnabled: true,
        fadeInSeconds: 1.0,
        delaySeconds: 0,
      },
      {
        id: 'm2',
        label: 'Second',
        timestampSeconds: 10.0,
        category: 'Hit',
        origin: 'manual',
        confirmed: true,
        exportEnabled: true,
        fadeInSeconds: 0,
        delaySeconds: 0,
      },
    ];

    // Negative playhead defaults to 0
    const negStatus = computeCueMonitorStatus(tiedCues, tiedMarkers, -5.0, 30);
    expect(negStatus.activeCue).toBeNull();
    expect(negStatus.nextCue?.cueNumber).toBe(1);

    // Non-finite playhead
    const nanStatus = computeCueMonitorStatus(tiedCues, tiedMarkers, Number.NaN, 30);
    expect(nanStatus.activeCue).toBeNull();

    // At t=10.0s, Cue 2 is the highest matching cue at that timestamp
    const tiedStatus = computeCueMonitorStatus(tiedCues, tiedMarkers, 10.0, 30);
    expect(tiedStatus.activeCue?.cueNumber).toBe(2);
  });
});
