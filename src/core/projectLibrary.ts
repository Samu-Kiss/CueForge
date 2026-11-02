import JSZip from 'jszip';
import { CueForgeProjectData, deserializeProjectFromJson, serializeProjectToJson } from './projectPersistence';
import { AudioStem } from './stemManager';
import { TransientCandidate } from './multiBandAnalysis';

export interface PackedAudio { sampleRate: number; channels: number; length: number; data: Blob }
export interface SavedStem extends Omit<AudioStem, 'audioBuffer'> { audio?: PackedAudio }
export interface ProjectSnapshot {
  id: string;
  updatedAt: string;
  project: CueForgeProjectData;
  stems: SavedStem[];
  candidates: TransientCandidate[];
  reviewedIds: string[];
  audio?: Blob;
  audioName: string;
  sensitivity: number;
  analysisMode?: 'structure' | 'accents';
  options: { includeCueAppearances: boolean; baseAppearancePoolId: number; includeMarkerTrack: boolean };
}
export type ProjectSummary = { id: string; name: string; updatedAt: string; markerCount: number; stemCount: number };

const audioCache = new WeakMap<AudioBuffer, PackedAudio>();
export function packStem(stem: AudioStem): SavedStem {
  const { audioBuffer, ...rest } = stem;
  if (!audioBuffer) return rest;
  let audio = audioCache.get(audioBuffer);
  if (!audio) {
    audio = { sampleRate: audioBuffer.sampleRate, channels: audioBuffer.numberOfChannels,
      length: audioBuffer.length,
      data: new Blob(Array.from({ length: audioBuffer.numberOfChannels }, (_, i) => audioBuffer.getChannelData(i))) };
    audioCache.set(audioBuffer, audio);
  }
  return { ...rest, audio };
}

export async function unpackStem(stem: SavedStem): Promise<AudioStem> {
  const { audio, ...rest } = stem;
  if (!audio) return rest;
  const bytes = await audio.data.arrayBuffer();
  if (bytes.byteLength !== audio.channels * audio.length * 4) throw new Error('Incomplete stem audio.');
  const buffer = new AudioBuffer({ numberOfChannels: audio.channels, length: audio.length, sampleRate: audio.sampleRate });
  for (let channel = 0; channel < audio.channels; channel++) {
    buffer.copyToChannel(new Float32Array(bytes, channel * audio.length * 4, audio.length), channel);
  }
  audioCache.set(buffer, audio);
  return { ...rest, audioBuffer: buffer };
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('cueforge-library', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('projects', { keyPath: 'id' });
      request.result.createObjectStore('settings');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
  return database;
}

export async function saveLibraryProject(snapshot: ProjectSnapshot): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['projects', 'settings'], 'readwrite');
    tx.objectStore('projects').put(snapshot);
    tx.objectStore('settings').put(snapshot.id, 'active');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Project could not be saved.'));
    tx.onerror = () => reject(tx.error);
  });
}

export async function readLibraryProject(id?: string): Promise<ProjectSnapshot | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['projects', 'settings'], 'readonly');
    const read = (key?: string) => {
      if (!key) { resolve(undefined); return; }
      const request = tx.objectStore('projects').get(key);
      request.onsuccess = () => resolve(request.result);
    };
    if (id) read(id);
    else {
      const request = tx.objectStore('settings').get('active');
      request.onsuccess = () => read(request.result);
    }
    tx.onerror = () => reject(tx.error);
  });
}

export async function listLibraryProjects(): Promise<ProjectSummary[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('projects').objectStore('projects').getAll();
    request.onsuccess = () => resolve((request.result as ProjectSnapshot[]).map((item) => ({
      id: item.id, name: item.project.config.songTitle, updatedAt: item.updatedAt,
      markerCount: item.project.markers.length, stemCount: item.stems.length,
    })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    request.onerror = () => reject(request.error);
  });
}

/** A portable project contains settings, pending review and original-channel PCM stems. */
export async function exportProjectArchive(snapshot: ProjectSnapshot): Promise<Blob> {
  const zip = new JSZip();
  const stems = snapshot.stems.map((stem, index) => ({ ...stem, audio: stem.audio ? {
    ...stem.audio, data: `audio/stem-${index}.pcm`,
  } : undefined }));
  for (let i = 0; i < snapshot.stems.length; i++) {
    const audio = snapshot.stems[i].audio;
    if (audio) zip.file(`audio/stem-${i}.pcm`, await audio.data.arrayBuffer());
  }
  if (snapshot.audio) zip.file('audio/playback', await snapshot.audio.arrayBuffer());
  zip.file('project.json', JSON.stringify({ ...snapshot,
    format: 'CueForgeArchive', version: 1,
    project: JSON.parse(serializeProjectToJson(snapshot.project)),
    stems, audio: snapshot.audio ? 'audio/playback' : undefined,
    audioMime: snapshot.audio?.type,
  }));
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

function validateCandidates(value: unknown): TransientCandidate[] {
  if (!Array.isArray(value)) throw new Error('Invalid candidate list.');
  return value.map((item) => {
    if (!item || typeof item.id !== 'string' || !Number.isFinite(item.timestampSeconds) || item.timestampSeconds < 0 ||
        !['low', 'mid', 'high', 'full'].includes(item.band) || !Number.isFinite(item.energyScore) ||
        typeof item.suggestedLabel !== 'string' || !['Hit', 'Structure', 'Effect', 'Note', 'Custom'].includes(item.suggestedCategory) ||
        !Number.isFinite(item.suggestedFadeIn) || item.suggestedFadeIn < 0 || !Number.isFinite(item.suggestedDelay) || item.suggestedDelay < 0 ||
        (item.explanation !== undefined && typeof item.explanation !== 'string') ||
        (item.eventKind !== undefined && !['attack', 'entry', 'section'].includes(item.eventKind))) {
      throw new Error('Invalid candidate data.');
    }
    return item as TransientCandidate;
  });
}

export async function importProjectArchive(file: Blob): Promise<ProjectSnapshot> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const manifest = zip.file('project.json');
  if (!manifest) throw new Error('This file is not a CueForge project.');
  const raw = JSON.parse(await manifest.async('string'));
  if (raw.format !== 'CueForgeArchive' || raw.version !== 1 || !Array.isArray(raw.stems)) throw new Error('Unsupported project format.');
  const project = deserializeProjectFromJson(JSON.stringify(raw.project));
  const stems: SavedStem[] = [];
  for (const stem of raw.stems) {
    if (!stem || typeof stem.id !== 'string' || typeof stem.name !== 'string' ||
        !['drums', 'bass', 'vocals', 'other', 'custom'].includes(stem.stemType) ||
        !Array.isArray(stem.waveformPeaks) || !stem.waveformPeaks.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) ||
        !Number.isFinite(stem.durationSeconds) || stem.durationSeconds <= 0 ||
        !Number.isFinite(stem.volume) || stem.volume < 0 || stem.volume > 1 ||
        typeof stem.muted !== 'boolean' || typeof stem.solo !== 'boolean' || typeof stem.color !== 'string') throw new Error('Invalid stem settings.');
    const restored: SavedStem = { ...stem, candidates: validateCandidates(stem.candidates), audio: undefined };
    if (stem.audio) {
      const audio = stem.audio;
      if (!Number.isInteger(audio.channels) || audio.channels < 1 || audio.channels > 32 ||
          !Number.isInteger(audio.length) || audio.length < 1 || !Number.isFinite(audio.sampleRate) ||
          audio.sampleRate < 8000 || audio.sampleRate > 96000 || typeof audio.data !== 'string') throw new Error('Invalid stem audio format.');
      const entry = zip.file(audio.data);
      if (!entry) throw new Error(`Missing audio for ${stem.name}.`);
      const bytes = await entry.async('arraybuffer');
      if (bytes.byteLength !== audio.length * audio.channels * 4) throw new Error(`Incomplete audio for ${stem.name}.`);
      restored.audio = { ...audio, data: new Blob([bytes]) };
    }
    stems.push(restored);
  }
  let audio: Blob | undefined;
  if (raw.audio) {
    const entry = typeof raw.audio === 'string' ? zip.file(raw.audio) : null;
    if (!entry) throw new Error('Missing playback audio.');
    audio = new Blob([await entry.async('arraybuffer')], { type: typeof raw.audioMime === 'string' ? raw.audioMime : 'audio/wav' });
  }
  return { id: crypto.randomUUID(), updatedAt: new Date().toISOString(), project, stems, audio,
    audioName: typeof raw.audioName === 'string' ? raw.audioName : 'Project audio',
    candidates: validateCandidates(raw.candidates),
    reviewedIds: Array.isArray(raw.reviewedIds) ? raw.reviewedIds.filter((id: unknown) => typeof id === 'string') : [],
    sensitivity: Number.isFinite(raw.sensitivity) ? Math.max(0.1, Math.min(1, raw.sensitivity)) : 0.5,
    analysisMode: raw.analysisMode === 'accents' ? 'accents' : 'structure',
    options: { includeCueAppearances: raw.options?.includeCueAppearances !== false,
      includeMarkerTrack: raw.options?.includeMarkerTrack !== false,
      baseAppearancePoolId: Math.max(1, Math.floor(Number(raw.options?.baseAppearancePoolId) || 101)) },
  };
}
