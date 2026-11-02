import 'fake-indexeddb/auto';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { ProjectSnapshot, exportProjectArchive, importProjectArchive, listLibraryProjects, packStem, readLibraryProject, saveLibraryProject } from '../projectLibrary';

function project(id: string): ProjectSnapshot {
  return { id, updatedAt: new Date().toISOString(),
    project: { config: { songTitle: id, ma3Version: '2.5.x', sequenceId: 101, sequenceName: 'Seq', timecodeId: 101,
      timecodeName: 'TC', macroId: 101, frameRate: 30, timecodeOffsetSeconds: 3600, latencyCompensationMs: 0,
      executionMode: 'Go+', allowOverwriteExistingObjects: false, songDurationSeconds: 60 },
      markers: [], beatGrid: [], bpm: 128, timeSignature: { beats: 3, unit: 4 }, waveformPeaks: [0.2, 0.8] },
    stems: [], candidates: [], reviewedIds: ['reviewed'], audioName: 'mix.wav', sensitivity: 0.7,
    options: { includeCueAppearances: false, baseAppearancePoolId: 201, includeMarkerTrack: true } };
}

describe('Project library and portable archives', () => {
  it('keeps multiple projects independently and restores the last active project', async () => {
    await saveLibraryProject(project('first'));
    await saveLibraryProject(project('second'));
    expect((await readLibraryProject())?.id).toBe('second');
    const first = (await readLibraryProject('first'))!;
    first.project.config.songTitle = 'Renamed';
    await saveLibraryProject(first);
    expect((await readLibraryProject())?.project.config.songTitle).toBe('Renamed');
    expect((await readLibraryProject('second'))?.project.config.songTitle).toBe('second');
    expect((await listLibraryProjects()).filter((p) => ['first', 'second'].includes(p.id))).toHaveLength(2);
  });

  it('round-trips stereo PCM, playback audio, mixer settings and review state', async () => {
    const original = project('portable');
    original.analysisMode = 'structure';
    const left = new Float32Array([0.25, -0.75, 0]);
    const right = new Float32Array([-0.4, 0.1, 0.9]);
    const buffer = { sampleRate: 48000, length: 3, numberOfChannels: 2,
      getChannelData: (i: number) => i === 0 ? left : right } as AudioBuffer;
    original.stems = [packStem({ id: 'stem', name: 'Drums', stemType: 'drums', audioBuffer: buffer,
      waveformPeaks: [0.75], durationSeconds: 3 / 48000, volume: 0.4, muted: true, solo: false, color: '#f43f5e', candidates: [] })];
    original.audio = new Blob(['playback bytes'], { type: 'audio/wav' });
    original.candidates = [{ id: 'stem:attack:100', timestampSeconds: 0.1, band: 'low', energyScore: 0.8,
      suggestedLabel: 'Drums attack', suggestedCategory: 'Hit', suggestedFadeIn: 0, suggestedDelay: 0, sourceStemId: 'stem' }];
    original.stems[0].candidates = original.candidates;
    const imported = await importProjectArchive(await exportProjectArchive(original));
    expect(imported.id).not.toBe(original.id);
    expect(imported.project.timeSignature).toEqual({ beats: 3, unit: 4 });
    expect(imported.options).toEqual(original.options);
    expect(imported.analysisMode).toBe('structure');
    expect(imported.reviewedIds).toEqual(original.reviewedIds);
    expect(imported.candidates).toEqual(original.candidates);
    expect(imported.stems[0].muted).toBe(true);
    expect(imported.stems[0].volume).toBe(0.4);
    expect(await imported.audio?.text()).toBe('playback bytes');
    expect(new Float32Array(await imported.stems[0].audio!.data.arrayBuffer())).toEqual(new Float32Array([...left, ...right]));
  });

  it('exports empty projects without inventing audio', async () => {
    const result = await importProjectArchive(await exportProjectArchive(project('empty')));
    expect(result.stems).toEqual([]);
    expect(result.audio).toBeUndefined();
    expect(result.project.markers).toEqual([]);
  });

  it('rejects a project with missing audio before opening it', async () => {
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify({ ...project('broken'), format: 'CueForgeArchive', version: 1, audio: 'missing.wav' }));
    await expect(importProjectArchive(await zip.generateAsync({ type: 'blob' }))).rejects.toThrow('Missing playback audio');
  });

  it('rejects unsupported archive versions', async () => {
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify({ ...project('future'), format: 'CueForgeArchive', version: 200 }));
    await expect(importProjectArchive(await zip.generateAsync({ type: 'blob' }))).rejects.toThrow('Unsupported');
  });

  it('stores media as blobs in the local library', async () => {
    const value = project('media');
    value.audio = new Blob(['saved audio']);
    await saveLibraryProject(value);
    expect(await (await readLibraryProject('media'))?.audio?.text()).toBe('saved audio');
  });
});
