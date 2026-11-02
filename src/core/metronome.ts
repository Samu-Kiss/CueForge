/**
 * Metronome Audio Engine for CueForge.
 * Synthesizes crisp, zero-latency downbeat and offbeat clicks using Web Audio API.
 */

export interface TimeSignature {
  beats: number; // e.g. 4 for 4/4, 3 for 3/4, 6 for 6/8
  unit: number;  // e.g. 4 for quarter note, 8 for eighth note
}

export class MetronomeEngine {
  private audioCtx: AudioContext | null = null;
  private volume: number = 0.7;

  constructor(audioContext?: AudioContext) {
    if (audioContext) {
      this.audioCtx = audioContext;
    }
  }

  public setAudioContext(audioContext: AudioContext): void {
    this.audioCtx = audioContext;
  }

  public setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1, vol));
  }

  public getVolume(): number {
    return this.volume;
  }

  /**
   * Plays a synthesized metronome click.
   * @param isDownbeat whether this is beat 1 of the measure (higher pitch, stronger accent)
   * @param when optional AudioContext schedule time (seconds)
   */
  public playClick(isDownbeat: boolean, when?: number): void {
    if (!this.audioCtx) {
      try {
        this.audioCtx = new AudioContext();
      } catch {
        return;
      }
    }
    const ctx = this.audioCtx;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const t = when !== undefined ? when : ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    // High woodblock pitch for downbeat (1600 Hz), crisp lower click for offbeat (850 Hz)
    osc.type = isDownbeat ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(isDownbeat ? 1600 : 850, t);
    osc.frequency.exponentialRampToValueAtTime(isDownbeat ? 400 : 250, t + 0.03);

    const peakGain = isDownbeat ? this.volume * 0.9 : this.volume * 0.55;
    gain.gain.setValueAtTime(peakGain, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(t);
    osc.stop(t + 0.05);
  }
}

/**
 * Calculates whether a given beat index corresponds to beat 1 (downbeat) based on beatsPerMeasure.
 */
export function isMeasureDownbeat(beatIndex: number, beatsPerMeasure: number): boolean {
  if (beatsPerMeasure <= 0) return false;
  return beatIndex % beatsPerMeasure === 0;
}

/**
 * Computes the duration in seconds of a single beat for a given BPM and beat unit.
 */
export function getSecondsPerBeat(bpm: number, beatUnit: number = 4): number {
  const safeBpm = Math.max(30, Math.min(300, bpm));
  const safeUnit = beatUnit === 8 ? 8 : 4;
  return (60 / safeBpm) * (4 / safeUnit);
}
