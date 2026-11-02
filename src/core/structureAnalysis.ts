import { AudioStem } from './stemManager';
import { TransientCandidate } from './multiBandAnalysis';

export type AnalysisMode = 'structure' | 'accents';
export interface StructureOptions { bpm: number; beats: number; unit: number; sensitivity: number }
export interface SectionTrack { id: string; name: string; type: AudioStem['stemType']; energy: number[]; density: number[] }
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

/** Compare musical windows, not individual peaks. All tracks remain independent
 * of mixer mute/solo/gain: these are monitoring controls, not analysis controls. */
export function analyzeStructure(stems: AudioStem[], options: StructureOptions): TransientCandidate[] {
  const barSeconds = 60 / Math.max(30, Math.min(300, options.bpm)) * options.beats * 4 / options.unit;
  const tracks: SectionTrack[] = [];
  for (const stem of stems) {
    const buffer = stem.audioBuffer;
    if (!buffer) continue;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const hop = Math.max(1, Math.round(buffer.sampleRate * 0.02));
    const envelope: number[] = [];
    for (let offset = 0; offset < buffer.length; offset += hop) {
      let sum = 0;
      const end = Math.min(buffer.length, offset + hop);
      for (const channel of channels) for (let i = offset; i < end; i++) sum += channel[i] ** 2;
      envelope.push(Math.sqrt(sum / ((end - offset) * channels.length)));
    }
    const sorted = [...envelope].sort((a, b) => a - b);
    const reference = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    if (reference < 0.0001) continue;
    const count = Math.ceil(buffer.duration / barSeconds);
    const energy = Array<number>(count).fill(0);
    const density = Array<number>(count).fill(0);
    const sizes = Array<number>(count).fill(0);
    let lastAttack = -Infinity;
    envelope.forEach((rms, i) => {
      const time = i * hop / buffer.sampleRate;
      const bar = Math.min(count - 1, Math.floor(time / barSeconds));
      energy[bar] += Math.min(1.5, rms / reference);
      sizes[bar]++;
      if (rms > reference * 0.08 && rms > (envelope[i - 1] ?? 0) * 1.8 && time - lastAttack >= 0.07) {
        density[bar]++; lastAttack = time;
      }
    });
    tracks.push({ id: stem.id, name: stem.name, type: stem.stemType,
      energy: energy.map((value, i) => value / Math.max(1, sizes[i])),
      density: density.map((value) => value / barSeconds),
    });
  }
  return detectSections(tracks, barSeconds, options.sensitivity);
}

/** Deterministic, conservative section hypotheses. Labels describe evidence,
 * not a trained model's certainty; a vocal exit needs sustained absence. */
export function detectSections(tracks: SectionTrack[], barSeconds: number, sensitivity = 0.5): TransientCandidate[] {
  if (!tracks.length || !Number.isFinite(barSeconds) || barSeconds <= 0) return [];
  const bars = Math.max(...tracks.map((track) => track.energy.length));
  const threshold = 0.26 - Math.max(0.1, Math.min(1, sensitivity)) * 0.12;
  const at = (track: SectionTrack, bar: number) => track.energy[bar] ?? 0;
  const total = Array.from({ length: bars }, (_, i) => mean(tracks.map((track) => at(track, i))));
  const rhythmic = tracks.filter((track) => track.type === 'drums' || track.type === 'other' || track.type === 'custom');
  const drive = total.map((value, i) => value + mean(rhythmic.map((track) => Math.min(1, (track.density[i] ?? 0) / 8))) * 0.3);
  const builds: { start: number; end: number }[] = [];
  let start = -1;
  for (let i = 1; i <= bars; i++) {
    const rising = i < bars && drive[i] - drive[i - 1] > 0.018;
    if (rising && start < 0) start = i;
    if (!rising && start >= 0) {
      const end = i - 1;
      if (end - start >= 3 && drive[end] - drive[start] > threshold) builds.push({ start, end });
      start = -1;
    }
  }
  type Proposal = { bar: number; kind: 'build' | 'drop' | 'instrumental' | 'section'; reason: string; strength: number; priority: number };
  const proposals: Proposal[] = builds.map((build) => ({ bar: build.start, kind: 'build',
    reason: 'Energy or rhythmic density rises across several bars.', strength: drive[build.end] - drive[build.start], priority: 3 }));
  for (let bar = 2; bar < bars - 1; bar++) {
    const before = tracks.map((track) => mean([at(track, bar - 2), at(track, bar - 1)]));
    const after = tracks.map((track) => mean([at(track, bar), at(track, bar + 1)]));
    const group = (type: AudioStem['stemType'], values: number[]) => mean(values.filter((_, i) => tracks[i].type === type));
    const mixRise = mean(after) - mean(before);
    const bassRise = group('bass', after) - group('bass', before);
    const drumRise = group('drums', after) - group('drums', before);
    const followingBuild = builds.some((build) => Math.abs(bar - build.end) <= 1);
    const changed = tracks.filter((track, i) => Math.abs(after[i] - before[i]) > threshold &&
      (at(track, bar) - before[i]) * (at(track, bar + 1) - before[i]) > 0 &&
      Math.min(Math.abs(at(track, bar) - before[i]), Math.abs(at(track, bar + 1) - before[i])) > threshold * 0.5);
    const vocalsBefore = group('vocals', before), vocalsAfter = group('vocals', after);
    const instrumentsAfter = mean(after.filter((_, i) => tracks[i].type !== 'vocals'));
    const sustainedBass = tracks.some((track, i) => track.type === 'bass' && Math.min(at(track, bar), at(track, bar + 1)) > before[i] + threshold * 0.5);
    if (vocalsBefore > 0.12 && vocalsAfter < 0.045 && instrumentsAfter > 0.08) {
      proposals.push({ bar, kind: 'instrumental', reason: 'Vocals stop for at least two bars while instruments continue.', strength: vocalsBefore, priority: 5 });
    } else if ((sustainedBass && bassRise > threshold && group('drums', after) > 0.12 && (drumRise > 0.08 || followingBuild || mixRise > 0.1)) ||
        (followingBuild && total[bar] - total[bar - 1] > threshold * 1.3 && mixRise > threshold && changed.length >= Math.min(2, tracks.length))) {
      proposals.push({ bar, kind: 'drop', reason: 'A sustained energy jump or bass entry coincides with the rhythmic section.', strength: Math.max(bassRise, mixRise), priority: 4 });
    } else if (changed.length && Math.max(...after) > 0.08 &&
        !builds.some((build) => bar >= build.start && bar <= build.end + 1)) {
      const change = mean(after.map((value, i) => Math.abs(value - before[i])));
      if (change > threshold || changed.length >= 2) proposals.push({ bar, kind: 'section',
        reason: 'Sustained change in the activity of: ' + changed.map((track) => track.name).join(', '), strength: change, priority: 1 });
    }
  }
  // A steady eighth-note roll can be a build even without an amplitude ramp.
  // Only label it in context: sustained dense percussion, low bass, then a drop.
  for (const drop of proposals.filter((proposal) => proposal.kind === 'drop')) {
    if (builds.some((build) => Math.abs(build.end - drop.bar) <= 2)) continue;
    const drums = tracks.filter((track) => track.type === 'drums');
    const bass = tracks.filter((track) => track.type === 'bass');
    let first = drop.bar;
    const dense = (bar: number) => mean(drums.map((track) => track.density[bar] ?? 0)) >= 6 / barSeconds &&
      mean(bass.map((track) => at(track, bar))) < 0.12;
    while (first > Math.max(0, drop.bar - 8) && dense(first - 1)) first--;
    if (drop.bar - first >= 3 && (first === 0 || !dense(first - 1))) {
      proposals.push({ bar: first, kind: 'build', priority: 3, strength: 0.5,
        reason: 'Repeated percussion continues for several bars with little bass before the proposed drop.' });
    }
  }
  // Pick the strongest boundary in a two-bar neighborhood. This suppresses
  // duplicate windows around one change without thinning individual attacks.
  const chosen: Proposal[] = [];
  for (const proposal of proposals.sort((a, b) => b.priority - a.priority || b.strength - a.strength || a.bar - b.bar)) {
    if (!chosen.some((other) => Math.abs(other.bar - proposal.bar) < 2)) chosen.push(proposal);
  }
  const names = { build: 'Build start', drop: 'Drop', instrumental: 'Instrumental start', section: 'Section change' };
  return chosen.sort((a, b) => a.bar - b.bar).map((proposal) => ({
    id: `structure:${proposal.kind}:${Math.round(proposal.bar * barSeconds * 1000)}`,
    timestampSeconds: Number((proposal.bar * barSeconds).toFixed(3)), band: 'full',
    eventKind: 'section', sectionKind: proposal.kind, explanation: proposal.reason,
    energyScore: Math.min(1, proposal.strength), suggestedLabel: names[proposal.kind] + ' (suggested)',
    suggestedCategory: 'Structure', suggestedFadeIn: proposal.kind === 'drop' ? 0 : 0.5, suggestedDelay: 0,
  }));
}
