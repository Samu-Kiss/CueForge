import { describe, expect, it } from 'vitest';
import { buildLtcFrameBits, generateLtcAudioWav } from '../ltcGenerator';

describe('SMPTE 12M Linear Timecode (LTC) Generator', () => {
  it('encodes an 80-bit LTC frame with valid sync word and BCD values', () => {
    // 01:23:45:12
    const bits = buildLtcFrameBits(1, 23, 45, 12, false);
    expect(bits.length).toBe(80);

    // Sync Word: bits 64-79 must match 0011 1111 1111 1101
    const syncWord = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];
    for (let i = 0; i < 16; i++) {
      expect(bits[64 + i]).toBe(syncWord[i]);
    }

    // Frame units: 12 % 10 = 2 -> 0010 (LSB first: 0, 1, 0, 0)
    expect(bits[0]).toBe(0);
    expect(bits[1]).toBe(1);
    expect(bits[2]).toBe(0);
    expect(bits[3]).toBe(0);

    // Frame tens: Math.floor(12 / 10) = 1 -> 01 (LSB first: 1, 0)
    expect(bits[8]).toBe(1);
    expect(bits[9]).toBe(0);
  });

  it('generates accurate sample count across all frame rates (24, 25, 29.97, 30 fps) without drift', async () => {
    const frameRates = [24, 25, 29.97, 30] as const;
    const duration = 2.0; // 2 seconds
    const sampleRate = 44100;
    const expectedDataBytes = 2.0 * sampleRate * 2; // 16-bit mono

    for (const fps of frameRates) {
      const blob = generateLtcAudioWav(duration, fps, 3600, sampleRate);
      expect(blob.type).toBe('audio/wav');
      // WAV header is 44 bytes, audio data is exactly expectedDataBytes
      expect(blob.size).toBe(44 + expectedDataBytes);
    }
  });

  it('sets drop frame flag bit 10 correctly for 29.97 fps', () => {
    const dropBits = buildLtcFrameBits(1, 0, 0, 0, true);
    expect(dropBits[10]).toBe(1);

    const nonDropBits = buildLtcFrameBits(1, 0, 0, 0, false);
    expect(nonDropBits[10]).toBe(0);
  });
});
