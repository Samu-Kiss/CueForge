export type CountInMode = 'off' | '1bar' | '2bars';

export interface CountInBeatInfo {
  barNumber: number; // 1-based (e.g. Bar 1 or Bar 2)
  beatInBar: number; // 1-based (e.g. Beat 1, 2, 3, 4)
  isDownbeat: boolean; // True on beat 1 of each bar
  remainingBeats: number; // How many beats left before playback starts
  totalBars: number;
}

/**
 * Returns number of bars for count-in mode.
 */
export function getCountInTotalBars(mode: CountInMode): number {
  if (mode === '1bar') return 1;
  if (mode === '2bars') return 2;
  return 0;
}

/**
 * Returns total count-in beats for given mode and time signature numerator.
 */
export function getCountInTotalBeats(mode: CountInMode, beatsPerMeasure: number): number {
  const bars = getCountInTotalBars(mode);
  const safeBeats = Number.isFinite(beatsPerMeasure) ? Math.max(1, Math.floor(beatsPerMeasure)) : 4;
  return bars * safeBeats;
}

/**
 * Calculates current bar and beat info given a 0-based beat index during count-in.
 */
export function getCountInBeatInfo(
  beatIndex0: number,
  mode: CountInMode,
  beatsPerMeasure: number
): CountInBeatInfo {
  const safeBeats = Number.isFinite(beatsPerMeasure) ? Math.max(1, Math.floor(beatsPerMeasure)) : 4;
  const totalBars = getCountInTotalBars(mode);
  const totalBeats = totalBars * safeBeats;

  if (totalBeats === 0) {
    return {
      barNumber: 0,
      beatInBar: 0,
      isDownbeat: false,
      remainingBeats: 0,
      totalBars: 0,
    };
  }

  const safeIndex = Number.isFinite(beatIndex0) ? beatIndex0 : 0;
  const clampedIndex = Math.max(0, Math.min(totalBeats - 1, safeIndex));
  const barNumber = Math.floor(clampedIndex / safeBeats) + 1;
  const beatInBar = (clampedIndex % safeBeats) + 1;
  const isDownbeat = beatInBar === 1;
  const remainingBeats = totalBeats - clampedIndex;

  return {
    barNumber,
    beatInBar,
    isDownbeat,
    remainingBeats,
    totalBars,
  };
}
