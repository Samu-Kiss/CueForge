/** Cached min/max pyramid. Every sample and channel contributes, including short transients. */
export interface WaveformDetail {
  channels: Float32Array[];
  sampleRate: number;
  length: number;
  levels: { min: Float32Array; max: Float32Array }[];
}
export function createWaveformDetail(channels: Float32Array[], sampleRate: number): WaveformDetail {
  const length = channels[0]?.length ?? 0;
  const count = Math.ceil(length / 64);
  const min = new Float32Array(count), max = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    let lo = Infinity, hi = -Infinity;
    for (const channel of channels) for (let i = b * 64; i < Math.min(length, (b + 1) * 64); i++) {
      lo = Math.min(lo, channel[i] ?? 0); hi = Math.max(hi, channel[i] ?? 0);
    }
    min[b] = lo; max[b] = hi;
  }
  const levels = [{ min, max }];
  while (levels[levels.length - 1].min.length > 1) {
    const prev = levels[levels.length - 1], n = Math.ceil(prev.min.length / 2);
    const next = { min: new Float32Array(n), max: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
      next.min[i] = Math.min(prev.min[i * 2], prev.min[i * 2 + 1] ?? Infinity);
      next.max[i] = Math.max(prev.max[i * 2], prev.max[i * 2 + 1] ?? -Infinity);
    }
    levels.push(next);
  }
  return { channels, sampleRate, length, levels };
}
const cache = new WeakMap<AudioBuffer, WaveformDetail>();
export function detailFromBuffer(buffer: AudioBuffer): WaveformDetail {
  let detail = cache.get(buffer);
  if (!detail) {
    detail = createWaveformDetail(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)), buffer.sampleRate);
    cache.set(buffer, detail);
  }
  return detail;
}
/** Exact range query: cached aligned blocks plus raw samples at the boundaries. */
export function waveformRange(detail: WaveformDetail, start: number, end: number): [number, number] {
  let i = Math.max(0, Math.floor(start));
  const stop = Math.min(detail.length, Math.ceil(end));
  if (i >= stop) return [0, 0];
  let lo = Infinity, hi = -Infinity;
  while (i < stop) {
    if (i % 64 === 0 && stop - i >= 64) {
      let level = Math.min(detail.levels.length - 1, Math.floor(Math.log2((stop - i) / 64)));
      while (level > 0 && i % (64 * 2 ** level) !== 0) level--;
      const block = 64 * 2 ** level, index = i / block;
      lo = Math.min(lo, detail.levels[level].min[index]);
      hi = Math.max(hi, detail.levels[level].max[index]);
      i += block;
    } else {
      for (const channel of detail.channels) { lo = Math.min(lo, channel[i] ?? 0); hi = Math.max(hi, channel[i] ?? 0); }
      i++;
    }
  }
  return [lo, hi];
}
