import { TimecodeFrameRate } from '../types/cueforge';
import { audioSamplesToWavBlob } from './stemManager';

/**
 * Builds the 80-bit SMPTE 12M Linear Timecode (LTC) frame for a given timecode value.
 */
export function buildLtcFrameBits(
  hours: number,
  minutes: number,
  seconds: number,
  frames: number,
  isDropFrame: boolean = false
): Uint8Array {
  const bits = new Uint8Array(80);

  // Helper to write 4-bit BCD (Least Significant Bit first)
  const writeBcd = (value: number, offset: number, count: number) => {
    for (let i = 0; i < count; i++) {
      bits[offset + i] = (value >> i) & 1;
    }
  };

  const frameUnits = frames % 10;
  const frameTens = Math.floor(frames / 10);
  const secUnits = seconds % 10;
  const secTens = Math.floor(seconds / 10);
  const minUnits = minutes % 10;
  const minTens = Math.floor(minutes / 10);
  const hrUnits = hours % 10;
  const hrTens = Math.floor(hours / 10);

  // Frames (bits 0-9)
  writeBcd(frameUnits, 0, 4);
  // User bits 1 (bits 4-7): zeros
  writeBcd(frameTens, 8, 2);
  bits[10] = isDropFrame ? 1 : 0; // Drop frame flag
  bits[11] = 0; // Color frame flag
  // User bits 2 (bits 12-15): zeros

  // Seconds (bits 16-27)
  writeBcd(secUnits, 16, 4);
  // User bits 3 (bits 20-23): zeros
  writeBcd(secTens, 24, 3);
  bits[27] = 0; // Biphase correction bit
  // User bits 4 (bits 28-31): zeros

  // Minutes (bits 32-43)
  writeBcd(minUnits, 32, 4);
  // User bits 5 (bits 36-39): zeros
  writeBcd(minTens, 40, 3);
  bits[43] = 0; // Biphase correction bit
  // User bits 6 (bits 44-47): zeros

  // Hours (bits 48-59)
  writeBcd(hrUnits, 48, 4);
  // User bits 7 (bits 52-55): zeros
  writeBcd(hrTens, 56, 2);
  bits[58] = 0; // Biphase correction bit
  bits[59] = 0; // Reserved
  // User bits 8 (bits 60-63): zeros

  // Sync Word (bits 64-79): 0011 1111 1111 1101 (LSB first)
  const syncWord = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];
  for (let i = 0; i < 16; i++) {
    bits[64 + i] = syncWord[i];
  }

  return bits;
}

/**
 * Synthesizes an audio SMPTE LTC stream (WAV format) matching a given duration,
 * frame rate, and initial SMPTE offset.
 *
 * GrandMA3 consoles accept this audio file directly on line-in or LTC input to run
 * real-time timecode synchronization.
 */
export function generateLtcAudioWav(
  durationSeconds: number,
  frameRate: TimecodeFrameRate,
  startOffsetSeconds: number = 3600, // 01:00:00:00 default
  sampleRate: number = 44100
): Blob {
  const safeDuration = Math.max(
    1,
    Math.min(7200, Number.isFinite(durationSeconds) ? durationSeconds : 1)
  );
  const totalSamples = Math.floor(safeDuration * sampleRate);
  const audioSamples = new Float32Array(totalSamples);

  const nominalFps = frameRate === 29.97 ? 30 : Math.round(frameRate);
  const isDrop = frameRate === 29.97;
  const totalFrames = Math.floor(safeDuration * frameRate);

  let currentPolarity = 1.0;

  // Total start frames based on configured timecode offset
  const totalStartFrames = Math.round(startOffsetSeconds * frameRate);

  for (let f = 0; f < totalFrames; f++) {
    const frameStartSample = Math.floor((f * sampleRate) / frameRate);
    const frameEndSample = Math.min(
      totalSamples,
      Math.floor(((f + 1) * sampleRate) / frameRate)
    );
    const frameSamples = frameEndSample - frameStartSample;
    if (frameSamples <= 0 || frameStartSample >= totalSamples) break;

    const absFrame = totalStartFrames + f;
    const wholeSecondsTotal = Math.floor(absFrame / nominalFps);
    const frameNumber = absFrame % nominalFps;
    const h = Math.floor(wholeSecondsTotal / 3600) % 24;
    const m = Math.floor((wholeSecondsTotal % 3600) / 60);
    const s = wholeSecondsTotal % 60;

    const frameBits = buildLtcFrameBits(h, m, s, frameNumber, isDrop);

    // Biphase Mark Encode all 80 bits into audio samples without drift
    for (let b = 0; b < 80; b++) {
      const bit = frameBits[b];
      const bitStartSample = frameStartSample + Math.floor((b * frameSamples) / 80);
      const bitEndSample = Math.min(
        totalSamples,
        frameStartSample + Math.floor(((b + 1) * frameSamples) / 80)
      );
      if (bitStartSample >= bitEndSample) continue;
      const bitMidSample = Math.floor((bitStartSample + bitEndSample) / 2);

      // Always invert at the start of each bit
      currentPolarity = -currentPolarity;

      if (bit === 1) {
        // '1' bit: first half polarity, then invert at middle
        for (let i = bitStartSample; i < bitMidSample; i++) {
          audioSamples[i] = currentPolarity * 0.85;
        }
        currentPolarity = -currentPolarity;
        for (let i = bitMidSample; i < bitEndSample; i++) {
          audioSamples[i] = currentPolarity * 0.85;
        }
      } else {
        // '0' bit: maintains polarity throughout whole bit cell
        for (let i = bitStartSample; i < bitEndSample; i++) {
          audioSamples[i] = currentPolarity * 0.85;
        }
      }
    }
  }

  return audioSamplesToWavBlob(audioSamples, sampleRate);
}
