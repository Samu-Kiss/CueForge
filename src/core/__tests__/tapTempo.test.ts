import { describe, expect, it } from 'vitest';
import { TapTempoTracker } from '../tapTempo';

describe('Tap Tempo Tracker', () => {
  it('returns null on first tap and accurate BPM on subsequent regular taps', () => {
    const tracker = new TapTempoTracker(6, 2000);

    // First tap at t = 1000
    const res1 = tracker.tap(1000);
    expect(res1.bpm).toBeNull();
    expect(res1.tapCount).toBe(1);

    // Second tap 500ms later (120 BPM)
    const res2 = tracker.tap(1500);
    expect(res2.bpm).toBe(120);
    expect(res2.tapCount).toBe(2);

    // Third tap 500ms later
    const res3 = tracker.tap(2000);
    expect(res3.bpm).toBe(120);
    expect(res3.tapCount).toBe(3);
  });

  it('resets history after timeout exceeds 2500ms', () => {
    const tracker = new TapTempoTracker(4, 2000);
    tracker.tap(1000);
    tracker.tap(1500);

    // Jump forward 3000ms
    const resAfterTimeout = tracker.tap(4500);
    expect(resAfterTimeout.bpm).toBeNull();
    expect(resAfterTimeout.tapCount).toBe(1);
  });

  it('clamps BPM to safe range 30-300', () => {
    const tracker = new TapTempoTracker();
    // Super fast 100ms -> 600 BPM clamped to 300
    tracker.tap(1000);
    const resFast = tracker.tap(1100);
    expect(resFast.bpm).toBe(300);

    tracker.reset();
    // Super slow 3000ms
    tracker.tap(1000);
    const resSlow = tracker.tap(3200);
    expect(resSlow.bpm).toBe(30);
  });

  it('rejects contact bounce (<40ms) and resets on backward clock skew', () => {
    const tracker = new TapTempoTracker(6, 2000);
    tracker.tap(1000);
    tracker.tap(1500); // 120 bpm, tapCount=2

    // Immediate bounce 10ms later
    const bounceRes = tracker.tap(1510);
    expect(bounceRes.bpm).toBe(120);
    expect(bounceRes.tapCount).toBe(2); // bounce ignored

    // Clock skew / jump backwards
    const skewRes = tracker.tap(800);
    expect(skewRes.bpm).toBeNull();
    expect(skewRes.tapCount).toBe(1); // history reset
  });
});
