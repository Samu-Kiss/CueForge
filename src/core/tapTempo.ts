/**
 * Interactive Tap Tempo tracker for CueForge.
 * Calculates musical BPM from user tap events with automatic outlier detection and timeout reset.
 */

export class TapTempoTracker {
  private tapTimestamps: number[] = [];
  private readonly maxTaps: number;
  private readonly timeoutMs: number;

  constructor(maxTaps: number = 8, timeoutMs: number = 2500) {
    this.maxTaps = Math.max(3, maxTaps);
    this.timeoutMs = timeoutMs;
  }

  /**
   * Records a tap at timestamp `now` (defaulting to performance.now()).
   * Returns the computed BPM if at least 2 valid taps exist, or null on first tap.
   */
  public tap(now: number = performance.now()): { bpm: number | null; tapCount: number } {
    const lastTap = this.tapTimestamps[this.tapTimestamps.length - 1];

    if (lastTap !== undefined && (now - lastTap > this.timeoutMs || now < lastTap)) {
      this.tapTimestamps = [];
    } else if (lastTap !== undefined && now - lastTap < 40) {
      // Reject hardware contact bounce (<40ms is physically impossible rhythm tap)
      return {
        bpm: this.calculateCurrentBpm(),
        tapCount: this.tapTimestamps.length,
      };
    }

    this.tapTimestamps.push(now);

    if (this.tapTimestamps.length > this.maxTaps) {
      this.tapTimestamps.shift();
    }

    const tapCount = this.tapTimestamps.length;
    if (tapCount < 2) {
      return { bpm: null, tapCount };
    }

    return { bpm: this.calculateCurrentBpm(), tapCount };
  }

  public calculateCurrentBpm(): number | null {
    if (this.tapTimestamps.length < 2) return null;
    const intervals: number[] = [];
    for (let i = 1; i < this.tapTimestamps.length; i++) {
      intervals.push(this.tapTimestamps[i] - this.tapTimestamps[i - 1]);
    }
    const avgIntervalMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (avgIntervalMs <= 0) return null;
    const rawBpm = 60000 / avgIntervalMs;
    return Math.max(30, Math.min(300, Math.round(rawBpm)));
  }

  public reset(): void {
    this.tapTimestamps = [];
  }

  public getTapCount(): number {
    return this.tapTimestamps.length;
  }
}
