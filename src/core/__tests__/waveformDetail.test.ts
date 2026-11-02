import { describe, it, expect } from 'vitest';
import { createWaveformDetail, waveformRange } from '../waveformDetail';
describe('Detailed waveform', () => {
  it('retains single-sample transients and the final sample', () => {
    const audio = new Float32Array(10003);
    audio[123] = 1; audio[10002] = -0.75;
    const detail = createWaveformDetail([audio], 48000);
    expect(waveformRange(detail, 0, audio.length)).toEqual([-0.75, 1]);
    expect(waveformRange(detail, 122, 124)).toEqual([0, 1]);
    expect(waveformRange(detail, 124, 10002)).toEqual([0, 0]);
  });
  it('preserves stereo without phase cancellation', () => {
    const left = new Float32Array(256).fill(0.5), right = new Float32Array(256).fill(-0.5);
    expect(waveformRange(createWaveformDetail([left, right], 48000), 0, 256)).toEqual([-0.5, 0.5]);
  });
  it('matches original samples across unaligned and zoomed ranges', () => {
    const audio = Float32Array.from({length: 12001}, (_, i) => Math.sin(i * 0.73) * Math.cos(i * 0.013));
    const detail = createWaveformDetail([audio], 48000);
    for (const [start, end] of [[0,12001], [63,8193], [128,8192], [321,324], [11000,12001]]) {
      const original = audio.slice(start, end);
      expect(waveformRange(detail, start, end)).toEqual([Math.min(...original), Math.max(...original)]);
    }
    expect(waveformRange(detail, 13000, 14000)).toEqual([0,0]);
  });
});
