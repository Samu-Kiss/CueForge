import { createWaveformDetail, detailFromBuffer, waveformRange, WaveformDetail } from './core/waveformDetail';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Bell,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Code2,
  Copy,
  Download,
  FileAudio,
  FileCode,
  Grid,
  Layers,
  Magnet,
  Maximize2,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Volume2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  BeatGridPoint,
  ExportConfiguration,
  Marker,
  MarkerCategory,
  TimecodeExecutionMode,
  TimecodeFrameRate,
} from './types/cueforge';
import { analyzeStructure, AnalysisMode } from './core/structureAnalysis';
import { analyzeStem, STEM_ANALYSIS_LABELS, removeReviewedCandidates } from './core/stemAnalysis';
import { ProjectManager } from './ProjectManager';
import { ProjectSnapshot, ProjectSummary, packStem, unpackStem, saveLibraryProject, readLibraryProject, listLibraryProjects, exportProjectArchive, importProjectArchive } from './core/projectLibrary';
import { compileShow } from './core/compiler';
import { validateCompiledShow } from './core/validator';
import { generateMa3ExportBundle } from './core/ma3Exporter';
import { generateEnhancedMa3ExportBundle } from './core/ma3AppearanceAndMarkers';
import { buildGrandMa3UsbZip } from './core/zipExporter';
import { generateLtcAudioWav } from './core/ltcGenerator';
import { TapTempoTracker } from './core/tapTempo';
import {
  bulkDeleteMarkers,
  bulkNudgeTime,
  bulkUpdateCategory,
  bulkUpdateDelay,
  bulkUpdateExportEnabled,
  bulkUpdateFadeIn,
  selectMarkersByCategory,
} from './core/bulkOperations';
import { computeCueMonitorStatus } from './core/cueStatusMonitor';
import {
  CountInMode,
  getCountInBeatInfo,
  getCountInTotalBeats,
} from './core/countIn';
import { importMarkersFromFileContent } from './core/dawImporter';
import {
  AudioStem,
  audioSamplesToWavBlob,
  extractWaveformPeaks,
  inferStemType,
  mixStemsAudio,
  STEM_COLORS,
  StemType,
} from './core/stemManager';
import {
  analyzeAudioMultiBand,
  promoteCandidateToMarker,
  TransientCandidate,
  FrequencyBand,
} from './core/multiBandAnalysis';
import {
  getSecondsPerBeat,
  isMeasureDownbeat,
  MetronomeEngine,
  TimeSignature,
} from './core/metronome';
import {
  CueForgeProjectData,
  deserializeProjectFromJson,
  loadProjectFromLocalStorage,
  saveProjectToLocalStorage,
} from './core/projectPersistence';
import {
  computeTimecodeTimestamp,
  formatSecondsToSmpte,
  parseSmpteOffsetToSeconds,
} from './core/timecodeMath';
import {
  analyzeAudioBuffer,
  createDefaultDemoShow,
  generateBeatGrid,
  promoteBeatGridPointToMarker,
} from './core/audioAnalysis';
import {
  TimelineViewport,
  clampMarkerTime,
  computeZoomedViewport,
  ensureTimeVisibleInViewport,
  nudgeMarkerTimestamp,
  panViewport,
  shouldIgnoreGlobalShortcut,
  snapTimeToBeatGrid,
  timeToViewportPercent,
  viewportRatioToTime,
} from './core/timelineNavigation';

const CATEGORY_COLORS: Record<MarkerCategory, string> = {
  Structure: '#3b82f6',
  Hit: '#f59e0b',
  Effect: '#a855f7',
  Note: '#10b981',
  Custom: '#ec4899',
};

type ActiveTab = 'markers' | 'stems' | 'candidate-shelf' | 'sequence-preview' | 'validation-export' | 'beat-grid';

function StemCanvasWaveform({
  peaks,
  color,
  playheadFraction,
  onSeekFraction,
}: {
  peaks: number[];
  color: string;
  playheadFraction: number;
  onSeekFraction: (fraction: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRevision = useCanvasResize(canvasRef);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    if (peaks.length === 0) {
      ctx.fillStyle = '#334155';
      ctx.fillRect(0, height / 2 - 1, width, 2);
      return;
    }

    const barWidth = width / peaks.length;
    ctx.fillStyle = color;
    for (let i = 0; i < peaks.length; i++) {
      const p = peaks[i];
      const barH = Math.max(2, p * height * 0.9);
      const x = i * barWidth;
      const y = (height - barH) / 2;
      ctx.fillRect(x, y, Math.max(1, barWidth - 0.4), barH);
    }

    if (playheadFraction >= 0 && playheadFraction <= 1) {
      const px = playheadFraction * width;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(px - 1, 0, 2, height);
    }
  }, [peaks, color, playheadFraction, canvasRevision]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeekFraction(frac);
  };

  return (
    <div className="stem-waveform-box">
      <canvas
        ref={canvasRef}
        width={800}
        height={56}
        onClick={handleClick}
        title="Click to jump playhead to this position"
      />
    </div>
  );
}

function useCanvasResize(ref: React.RefObject<HTMLCanvasElement>) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(() => setRevision((value) => value + 1));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref.current]);
  return revision;
}

/**
 * Draws a single waveform lane (used for master composite and multitrack stem lanes).
 */
function drawWaveformLane({
  ctx,
  width,
  height,
  peaks,
  stemColor,
  viewport,
  songDurationSeconds,
  playheadSeconds,
  beatGrid,
  showBeatGridOverlay,
  snappedBeatId,
  showTimeRuler,
  detail,
}: {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  peaks: number[];
  stemColor?: string;
  viewport: TimelineViewport;
  songDurationSeconds: number;
  playheadSeconds: number;
  beatGrid: BeatGridPoint[];
  showBeatGridOverlay: boolean;
  snappedBeatId?: string;
  showTimeRuler?: boolean;
  detail?: WaveformDetail;
}) {
  ctx.clearRect(0, 0, width, height);

  // 1. Draw Beat Grid lines (if enabled)
  if (showBeatGridOverlay && songDurationSeconds > 0) {
    for (const gp of beatGrid) {
      const pct = timeToViewportPercent(gp.timestampSeconds, viewport);
      if (pct === null) continue;
      const x = (pct / 100) * width;
      const isSnappedTarget = snappedBeatId === gp.id;

      ctx.beginPath();
      if (isSnappedTarget) {
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.95)';
        ctx.lineWidth = 2;
      } else {
        ctx.strokeStyle =
          gp.beat === 1 ? 'rgba(245, 158, 11, 0.38)' : 'rgba(148, 163, 184, 0.09)';
        ctx.lineWidth = gp.beat === 1 ? 1.2 : 0.5;
      }
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  // 2. Draw Center Zero Line
  const midY = height / 2;
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.moveTo(0, midY);
  ctx.lineTo(width, midY);
  ctx.stroke();

  // One min/max column per screen pixel, derived from original audio at the current zoom.
  if (songDurationSeconds > 0) {
    for (let x = 0; x < Math.ceil(width); x++) {
      const start = viewport.startSeconds + x / width * viewport.visibleDurationSeconds;
      const end = viewport.startSeconds + (x + 1) / width * viewport.visibleDurationSeconds;
      let low = 0, high = 0;
      if (detail) {
        [low, high] = waveformRange(detail, start * detail.sampleRate, end * detail.sampleRate);
      } else if (peaks.length) {
        // Legacy projects without audio can only display their saved overview.
        const first = Math.max(0, Math.floor(start / songDurationSeconds * peaks.length));
        const last = Math.min(peaks.length, Math.max(first + 1, Math.ceil(end / songDurationSeconds * peaks.length)));
        for (let i = first; i < last; i++) high = Math.max(high, peaks[i]);
        low = -high;
      }
      ctx.fillStyle = stemColor
        ? (start <= playheadSeconds ? stemColor : stemColor + 'aa')
        : (start <= playheadSeconds ? '#b8d6ff' : '#6da7d0');
      const scale = height * 0.40;
      const top = midY - Math.min(1, high) * scale;
      const bottom = midY - Math.max(-1, low) * scale;
      ctx.fillRect(x, top, 1, Math.max(0.5, bottom - top));
    }
  }

  // 4. Subtle Viewport Time Ruler along bottom edge (if showTimeRuler)
  if (showTimeRuler) {
    const tickCount = 6;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
    ctx.font = '10px JetBrains Mono, Consolas, monospace';
    for (let t = 0; t <= tickCount; t++) {
      const ratio = t / tickCount;
      const tickSec = viewport.startSeconds + ratio * viewport.visibleDurationSeconds;
      const x = ratio * width;
      ctx.fillRect(x, height - 6, 1, 6);
      if (t < tickCount) {
        ctx.fillText(`${tickSec.toFixed(viewport.visibleDurationSeconds < 10 ? 3 : 1)}s`, x + 4, height - 4);
      }
    }
  }
}

/**
 * Renders an individual stem track lane canvas in the multitrack timeline.
 */
function MultitrackLaneCanvas({
  stem,
  viewport,
  songDurationSeconds,
  playheadSeconds,
  beatGrid,
  showBeatGridOverlay,
  snappedBeatId,
  isLast,
}: {
  stem: AudioStem;
  viewport: TimelineViewport;
  songDurationSeconds: number;
  playheadSeconds: number;
  beatGrid: BeatGridPoint[];
  showBeatGridOverlay: boolean;
  snappedBeatId?: string;
  isLast: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRevision = useCanvasResize(canvasRef);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    drawWaveformLane({
      ctx,
      width,
      height,
      peaks: stem.waveformPeaks,
      detail: stem.audioBuffer ? detailFromBuffer(stem.audioBuffer) : undefined,
      stemColor: stem.color,
      viewport,
      songDurationSeconds,
      playheadSeconds,
      beatGrid,
      showBeatGridOverlay,
      snappedBeatId,
      showTimeRuler: isLast,
    });
  }, [
    canvasRevision,
    stem.waveformPeaks,
    stem.audioBuffer,
    stem.color,
    viewport,
    songDurationSeconds,
    playheadSeconds,
    beatGrid,
    showBeatGridOverlay,
    snappedBeatId,
    isLast,
  ]);

  return <canvas ref={canvasRef} className="multitrack-lane-canvas" />;
}

export function App() {
  const [masterDetail, setMasterDetail] = useState<WaveformDetail>();
  const defaultDemo = useMemo(() => createDefaultDemoShow(), []);

  // Try restoring saved session from localStorage on initial boot
  const initialSavedProject = useMemo(() => loadProjectFromLocalStorage(), []);

  const [projectId, setProjectId] = useState<string>(() => crypto.randomUUID());
  const [projectReady, setProjectReady] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [projectList, setProjectList] = useState<ProjectSummary[]>([]);
  const [projectStatus, setProjectStatus] = useState('Opening project…');
  const [projectError, setProjectError] = useState('');
  const playbackBlob = useRef<Blob>();
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const latestProject = useRef<ProjectSnapshot>();
  const projectEpoch = useRef(0);

  const [markers, setMarkers] = useState<Marker[]>(
    () => initialSavedProject?.markers ?? defaultDemo.markers
  );
  const [beatGrid, setBeatGrid] = useState<BeatGridPoint[]>(
    () => initialSavedProject?.beatGrid ?? defaultDemo.beatGrid
  );
  const [waveformPeaks, setWaveformPeaks] = useState<number[]>(
    () => initialSavedProject?.waveformPeaks ?? defaultDemo.waveformPeaks
  );
  const [bpm, setBpm] = useState<number>(
    () => initialSavedProject?.bpm ?? defaultDemo.bpm
  );
  // Time Signature & Metronome
  const [timeSignature, setTimeSignature] = useState<TimeSignature>(
    () => initialSavedProject?.timeSignature ?? { beats: 4, unit: 4 }
  );
  const [metronomeEnabled, setMetronomeEnabled] = useState<boolean>(false);
  const [metronomeVolume, setMetronomeVolume] = useState<number>(0.7);
  const metronomeRef = useRef<MetronomeEngine>(new MetronomeEngine());
  const lastBeatClickIndexRef = useRef<number>(-1);

  // Multitrack timeline view mode
  const [multitrackView, setMultitrackView] = useState<boolean>(true);

  const [showBeatGridOverlay, setShowBeatGridOverlay] = useState<boolean>(false);
  const [snapToBeatGrid, setSnapToBeatGrid] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>('markers');
  const [showMarkerDetails, setShowMarkerDetails] = useState(false);

  // Multi-band analysis transient candidate review shelf
  const [stagedCandidates, setStagedCandidates] = useState<TransientCandidate[]>([]);
  const [bandFilter, setBandFilter] = useState<FrequencyBand | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [isAnalyzingStems, setIsAnalyzingStems] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState('');
  const reviewedCandidateIds = useRef(new Set<string>());
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('structure');
  const [analysisSensitivity, setAnalysisSensitivity] = useState<number>(0.5);

  // Multi-Stem Audio Workspace
  const [stems, setStems] = useState<AudioStem[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);

  // grandMA3 Appearance & MarkerTrack options
  const [includeCueAppearances, setIncludeCueAppearances] = useState<boolean>(true);
  const [baseAppearancePoolId, setBaseAppearancePoolId] = useState<number>(101);
  const [includeMarkerTrack, setIncludeMarkerTrack] = useState<boolean>(true);

  const [config, setConfig] = useState<ExportConfiguration>(() => ({
    songTitle: initialSavedProject?.config?.songTitle ?? 'Solaris_MainShow',
    ma3Version: '2.5.x',
    sequenceId: initialSavedProject?.config?.sequenceId ?? 101,
    sequenceName: initialSavedProject?.config?.sequenceName ?? 'Solaris_Seq',
    timecodeId: initialSavedProject?.config?.timecodeId ?? 101,
    timecodeName: initialSavedProject?.config?.timecodeName ?? 'Solaris_TC',
    macroId: initialSavedProject?.config?.macroId ?? 101,
    frameRate: initialSavedProject?.config?.frameRate ?? 30,
    timecodeOffsetSeconds: initialSavedProject?.config?.timecodeOffsetSeconds ?? 3600, // 01:00:00:00
    latencyCompensationMs: initialSavedProject?.config?.latencyCompensationMs ?? 0,
    globalEventFadeOverrideSeconds: initialSavedProject?.config?.globalEventFadeOverrideSeconds,
    executionMode: initialSavedProject?.config?.executionMode ?? 'Go+',
    allowOverwriteExistingObjects: initialSavedProject?.config?.allowOverwriteExistingObjects ?? false,
    songDurationSeconds: initialSavedProject?.config?.songDurationSeconds ?? defaultDemo.durationSeconds,
  }));

  // Timeline zoom & pan viewport state
  const [viewport, setViewport] = useState<TimelineViewport>(() =>
    computeZoomedViewport(defaultDemo.durationSeconds, 1, 0)
  );

  // SMPTE offset text input state synced with config.timecodeOffsetSeconds
  const [smpteOffsetInput, setSmpteOffsetInput] = useState<string>('01:00:00:00');

  // Audio playback / playhead transport state
  const [playheadSeconds, setPlayheadSeconds] = useState<number>(0);
  const playheadSecondsRef = useRef<number>(0);
  playheadSecondsRef.current = playheadSeconds;

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [audioFileName, setAudioFileName] = useState<string>('Solaris — Demo Track (Built-in)');
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioObjectUrlRef = useRef<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRevision = useCanvasResize(canvasRef);
  const waveformContainerRef = useRef<HTMLDivElement | null>(null);
  const [copiedType, setCopiedType] = useState<string | null>(null);

  // Pointer-captured marker drag state
  const [draggingMarkerState, setDraggingMarkerState] = useState<{
    markerId: string;
    snappedBeat: BeatGridPoint | null;
  } | null>(null);
  const dragPointerRef = useRef<{
    markerId: string;
    pointerId: number;
    offsetX: number;
    startClientX: number;
    hasExceededThreshold: boolean;
  } | null>(null);
  const suppressNextWaveformClickRef = useRef<boolean>(false);

  // Compile show & run mandatory export validation in real time
  const compiledShow = useMemo(
    () => compileShow(markers, config),
    [markers, config]
  );

  const validationReport = useMemo(
    () => validateCompiledShow(compiledShow),
    [compiledShow]
  );

  const exportBundle = useMemo(() => {
    if (!validationReport.isValid) return null;
    try {
      if (includeCueAppearances || includeMarkerTrack) {
        return generateEnhancedMa3ExportBundle(compiledShow, {
          includeCueAppearances,
          baseAppearancePoolId,
          includeMarkerTrack,
        });
      }
      return generateMa3ExportBundle(compiledShow);
    } catch {
      return null;
    }
  }, [compiledShow, validationReport.isValid, includeCueAppearances, baseAppearancePoolId, includeMarkerTrack]);

  const playheadTiming = useMemo(
    () =>
      computeTimecodeTimestamp(
        playheadSeconds,
        config.frameRate,
        config.timecodeOffsetSeconds,
        config.latencyCompensationMs
      ),
    [playheadSeconds, config.frameRate, config.timecodeOffsetSeconds, config.latencyCompensationMs]
  );

  // Lookup map from marker ID to its compiled Cue & Event
  const compiledByMarkerId = useMemo(() => {
    const map = new Map<
      string,
      {
        cueNumber: number;
        eventIndex: number;
        token: string;
        relativeTime: string;
        absoluteSmpte: string;
        ma3Time: string;
        totalFrames: number;
      }
    >();
    compiledShow.cues.forEach((cue, i) => {
      const ev = compiledShow.events[i];
      if (ev) {
        map.set(cue.sourceMarkerId, {
          cueNumber: cue.cueNumber,
          eventIndex: ev.eventIndex,
          token: ev.token,
          relativeTime: ev.timing.formattedRelative,
          absoluteSmpte: ev.timing.formattedAbsoluteSmpte,
          ma3Time: ev.timing.formattedMa3Time,
          totalFrames: ev.timing.totalFrames,
        });
      }
    });
    return map;
  }, [compiledShow]);

  // Tap Tempo State & Tracker
  const tapTrackerRef = useRef<TapTempoTracker>(new TapTempoTracker(8, 2500));
  const [tapFeedback, setTapFeedback] = useState<{ count: number; active: boolean }>({
    count: 0,
    active: false,
  });

  // Pre-Roll / Count-In with Metronome State
  const [countInMode, setCountInMode] = useState<CountInMode>('off');
  const [countInState, setCountInState] = useState<{
    active: boolean;
    currentBeatIndex: number;
  } | null>(null);
  const countInTimeoutRef = useRef<number | null>(null);

  const cancelCountIn = useCallback(() => {
    if (countInTimeoutRef.current) {
      clearTimeout(countInTimeoutRef.current);
      countInTimeoutRef.current = null;
    }
    setCountInState(null);
  }, []);

  // Clean up count-in timer on unmount
  useEffect(() => {
    return () => {
      if (countInTimeoutRef.current) {
        clearTimeout(countInTimeoutRef.current);
      }
    };
  }, []);

  // Bulk Edit Selection State (Tab 1)
  const [selectedMarkerIds, setSelectedMarkerIds] = useState<Set<string>>(new Set());
  const [bulkCustomFade, setBulkCustomFade] = useState<string>('0');
  const [bulkCustomDelay, setBulkCustomDelay] = useState<string>('0');

  // Prune any dangling selected marker IDs that no longer exist in markers
  useEffect(() => {
    setSelectedMarkerIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(markers.map((m) => m.id));
      let hasDangling = false;
      for (const id of prev) {
        if (!validIds.has(id)) {
          hasDangling = true;
          break;
        }
      }
      if (!hasDangling) return prev;
      const pruned = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) pruned.add(id);
      }
      return pruned;
    });
  }, [markers]);

  // Export Loading States (USB ZIP & LTC WAV)
  const [isExportingZip, setIsExportingZip] = useState<boolean>(false);
  const [isGeneratingLtc, setIsGeneratingLtc] = useState<boolean>(false);

  // Real-time Cue Status Monitor State
  const cueMonitorStatus = useMemo(
    () =>
      computeCueMonitorStatus(
        compiledShow.cues,
        markers,
        playheadSeconds,
        config.frameRate
      ),
    [compiledShow.cues, markers, playheadSeconds, config.frameRate]
  );

  // Bulk Edit Callbacks
  const toggleMarkerSelection = useCallback((id: string) => {
    setSelectedMarkerIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelectAllMarkers = useCallback(() => {
    setSelectedMarkerIds(new Set(markers.map((m) => m.id)));
  }, [markers]);

  const handleClearMarkerSelection = useCallback(() => {
    setSelectedMarkerIds(new Set());
  }, []);

  const handleInvertMarkerSelection = useCallback(() => {
    setSelectedMarkerIds((prev) => {
      const next = new Set<string>();
      for (const m of markers) {
        if (!prev.has(m.id)) next.add(m.id);
      }
      return next;
    });
  }, [markers]);

  const handleSelectByCategory = useCallback(
    (cat: MarkerCategory) => {
      const ids = selectMarkersByCategory(markers, cat);
      setSelectedMarkerIds(ids);
    },
    [markers]
  );

  const handleBulkFade = useCallback(
    (seconds: number) => {
      setMarkers((prev) => bulkUpdateFadeIn(prev, selectedMarkerIds, seconds));
    },
    [selectedMarkerIds]
  );

  const handleBulkDelay = useCallback(
    (seconds: number) => {
      setMarkers((prev) => bulkUpdateDelay(prev, selectedMarkerIds, seconds));
    },
    [selectedMarkerIds]
  );

  const handleBulkNudge = useCallback(
    (deltaSeconds: number) => {
      setMarkers((prev) =>
        bulkNudgeTime(prev, selectedMarkerIds, deltaSeconds, config.songDurationSeconds)
      );
    },
    [selectedMarkerIds, config.songDurationSeconds]
  );

  const handleBulkCategory = useCallback(
    (category: MarkerCategory) => {
      setMarkers((prev) => bulkUpdateCategory(prev, selectedMarkerIds, category));
    },
    [selectedMarkerIds]
  );

  const handleBulkExportEnabled = useCallback(
    (exportEnabled: boolean) => {
      setMarkers((prev) => bulkUpdateExportEnabled(prev, selectedMarkerIds, exportEnabled));
    },
    [selectedMarkerIds]
  );

  const handleBulkDelete = useCallback(() => {
    if (selectedMarkerIds.size === 0) return;
    if (confirm(`Delete ${selectedMarkerIds.size} selected marker(s)?`)) {
      setMarkers((prev) => bulkDeleteMarkers(prev, selectedMarkerIds));
      setSelectedMarkerIds(new Set());
    }
  }, [selectedMarkerIds]);

  // Zoom & Pan helpers
  const handleZoom = useCallback(
    (targetZoom: number, anchorSeconds: number = playheadSecondsRef.current) => {
      setViewport(
        computeZoomedViewport(config.songDurationSeconds, targetZoom, anchorSeconds)
      );
    },
    [config.songDurationSeconds]
  );

  const handlePan = useCallback(
    (deltaSeconds: number) => {
      setViewport((prev) => panViewport(prev, deltaSeconds, config.songDurationSeconds));
    },
    [config.songDurationSeconds]
  );

  const seekPlayheadTo = useCallback(
    (targetSeconds: number, ensureVisible: boolean = false) => {
      cancelCountIn();
      const clamped = clampMarkerTime(targetSeconds, config.songDurationSeconds);
      setPlayheadSeconds(clamped);
      if (audioElRef.current && audioObjectUrlRef.current) {
        audioElRef.current.currentTime = clamped;
      }
      if (ensureVisible) {
        setViewport((prev) =>
          ensureTimeVisibleInViewport(prev, clamped, config.songDurationSeconds)
        );
      }
    },
    [config.songDurationSeconds, cancelCountIn]
  );

  // Add a manual marker at current playhead position
  const addManualMarkerAtPlayhead = useCallback(
    (category: MarkerCategory = 'Structure') => {
      const currentPlayhead = clampMarkerTime(
        playheadSecondsRef.current,
        config.songDurationSeconds
      );
      setMarkers((prev) => {
        const nextNum = prev.length + 1;
        const newMarker: Marker = {
          id: `m-manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          label: `${category} Cue ${nextNum}`,
          timestampSeconds: currentPlayhead,
          category,
          origin: 'manual',
          confirmed: true,
          exportEnabled: true,
          fadeInSeconds: category === 'Hit' ? 0 : 1.5,
          delaySeconds: 0,
        };
        return [...prev, newMarker];
      });
      setViewport((prev) =>
        ensureTimeVisibleInViewport(prev, currentPlayhead, config.songDurationSeconds)
      );
    },
    [config.songDurationSeconds]
  );

  // Transport Play/Pause toggle with Pre-Roll Count-In support
  const handleTogglePlay = useCallback(() => {
    if (isPlaying || countInState?.active) {
      cancelCountIn();
      setIsPlaying(false);
      return;
    }

    if (countInMode !== 'off' && playheadSecondsRef.current <= 0.05) {
      const totalBeats = getCountInTotalBeats(countInMode, timeSignature.beats);
      const secPerBeat = getSecondsPerBeat(bpm, timeSignature.unit);
      const intervalMs = secPerBeat * 1000;

      // Immediately play beat 0 downbeat
      const info0 = getCountInBeatInfo(0, countInMode, timeSignature.beats);
      metronomeRef.current.playClick(info0.isDownbeat);
      setCountInState({ active: true, currentBeatIndex: 0 });

      let currentIdx = 0;
      const scheduleNext = () => {
        countInTimeoutRef.current = window.setTimeout(() => {
          currentIdx++;
          if (currentIdx < totalBeats) {
            const info = getCountInBeatInfo(currentIdx, countInMode, timeSignature.beats);
            metronomeRef.current.playClick(info.isDownbeat);
            setCountInState({ active: true, currentBeatIndex: currentIdx });
            scheduleNext();
          } else {
            setCountInState(null);
            countInTimeoutRef.current = null;
            setIsPlaying(true);
          }
        }, intervalMs);
      };

      scheduleNext();
    } else {
      setIsPlaying(true);
    }
  }, [isPlaying, countInState, countInMode, timeSignature, bpm, cancelCountIn]);

  // Global keyboard shortcuts: Space to Play/Pause, M to drop confirmed marker at playhead
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (projectsOpen || projectBusy || !projectReady || e.ctrlKey || e.metaKey || e.altKey) return;
      if (
        shouldIgnoreGlobalShortcut(
          e.target as HTMLElement | null,
          e.code,
          e.repeat
        )
      ) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        addManualMarkerAtPlayhead('Structure');
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [handleTogglePlay, addManualMarkerAtPlayhead, projectsOpen, projectBusy, projectReady]);

  // Non-passive wheel listener on waveform container for Ctrl/Alt+Wheel zoom and Shift+Wheel pan
  useEffect(() => {
    const container = waveformContainerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        const zoomDelta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        if (zoomDelta === 0) return;
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / Math.max(1, rect.width);
        const anchorTime = viewportRatioToTime(
          ratio,
          viewport,
          config.songDurationSeconds
        );
        const factor = zoomDelta < 0 ? 1.25 : 1 / 1.25;
        handleZoom(viewport.zoomFactor * factor, anchorTime);
      } else if (
        viewport.zoomFactor > 1 &&
        (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))
      ) {
        const rawDelta = Math.abs(e.deltaX) > 0 ? e.deltaX : e.deltaY;
        if (rawDelta === 0) return;
        e.preventDefault();
        const deltaSec = (rawDelta / 320) * viewport.visibleDurationSeconds;
        handlePan(deltaSec);
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [viewport, config.songDurationSeconds, handleZoom, handlePan]);

  // Transport loop when playing synthetic demo or real uploaded audio
  useEffect(() => {
    if (!isPlaying) return;

    if (audioElRef.current && audioObjectUrlRef.current) {
      audioElRef.current.currentTime = playheadSecondsRef.current;
      audioElRef.current.play().catch(() => setIsPlaying(false));
      const handleTimeUpdate = () => {
        if (audioElRef.current) {
          setPlayheadSeconds(audioElRef.current.currentTime);
        }
      };
      const handleEnded = () => setIsPlaying(false);
      const el = audioElRef.current;
      el.addEventListener('timeupdate', handleTimeUpdate);
      el.addEventListener('ended', handleEnded);
      return () => {
        el.pause();
        el.removeEventListener('timeupdate', handleTimeUpdate);
        el.removeEventListener('ended', handleEnded);
      };
    }

    // Synthetic transport clock when no external file is loaded
    let lastTick = performance.now();
    let rafId = 0;
    const step = (now: number) => {
      const dt = (now - lastTick) / 1000;
      lastTick = now;
      setPlayheadSeconds((prev) => {
        const next = prev + dt;
        if (next >= config.songDurationSeconds) {
          setIsPlaying(false);
          return 0;
        }
        return next;
      });
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, config.songDurationSeconds]);

  // Metronome Sound Engine Click Scheduler
  useEffect(() => {
    if (!isPlaying || !metronomeEnabled) {
      lastBeatClickIndexRef.current = -1;
      return;
    }

    const secPerBeat = getSecondsPerBeat(bpm, timeSignature.unit);
    const currentBeatIdx = Math.floor(playheadSeconds / secPerBeat);

    if (currentBeatIdx > lastBeatClickIndexRef.current) {
      const isDownbeat = isMeasureDownbeat(currentBeatIdx, timeSignature.beats);
      metronomeRef.current.playClick(isDownbeat);
      lastBeatClickIndexRef.current = currentBeatIdx;
    }
  }, [playheadSeconds, isPlaying, metronomeEnabled, bpm, timeSignature]);

  // Render Master Waveform + Unconfirmed Beat Grid on Canvas within Active Viewport
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    drawWaveformLane({
      ctx,
      width,
      height,
      peaks: waveformPeaks,
      detail: masterDetail,
      viewport,
      songDurationSeconds: config.songDurationSeconds,
      playheadSeconds,
      beatGrid,
      showBeatGridOverlay,
      snappedBeatId: draggingMarkerState?.snappedBeat?.id,
      showTimeRuler: true,
    });
  }, [
    canvasRevision,
    waveformPeaks,
    masterDetail,
    multitrackView,
    stems.length,
    beatGrid,
    showBeatGridOverlay,
    playheadSeconds,
    config.songDurationSeconds,
    viewport,
    draggingMarkerState,
  ]);

  // Handle Audio Upload & Analysis
  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsPlaying(false);
    setAudioFileName(file.name);

    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current);
    }
    const objUrl = URL.createObjectURL(file);
    audioObjectUrlRef.current = objUrl;
    if (!audioElRef.current) {
      audioElRef.current = new Audio();
    }
    audioElRef.current.src = objUrl;
    playbackBlob.current = file;
    const epoch = projectEpoch.current;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioCtx = new AudioContext();
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      const analysis = await analyzeAudioBuffer(decoded);
      await audioCtx.close();
      if (epoch !== projectEpoch.current) return;

      const cleanTitle = file.name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
      const newDuration = Number(analysis.durationSeconds.toFixed(3));
      setWaveformPeaks(analysis.waveformPeaks);
      setMasterDetail(detailFromBuffer(decoded));
      setBeatGrid(analysis.beatGrid);
      setBpm(analysis.estimatedBpm);
      setMarkers([]);

      // Perform multi-band transient extraction for the Candidate Review Shelf
      const multiBand = analyzeAudioMultiBand(
        decoded.getChannelData(0),
        decoded.sampleRate,
        { sensitivity: analysisSensitivity }
      );
      setStagedCandidates(analysisMode === 'structure'
        ? analyzeStructure([masterAnalysisStem(decoded)], { bpm: analysis.estimatedBpm, beats: timeSignature.beats, unit: timeSignature.unit, sensitivity: analysisSensitivity })
        : multiBand.allCandidates);

      setPlayheadSeconds(0);
      setViewport(computeZoomedViewport(newDuration, 1, 0));
      setConfig((prev) => ({
        ...prev,
        songTitle: cleanTitle || prev.songTitle,
        sequenceName: `${cleanTitle}_Seq`,
        timecodeName: `${cleanTitle}_TC`,
        songDurationSeconds: newDuration,
      }));
    } catch (err) {
      console.error('Failed to decode audio file:', err);
    }
  };

  // Handle Multi-Stem File Uploads (Multiple audio files: Drums, Bass, Vocals, Synths, etc.)
  const handleStemUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || isAnalyzingStems) return;

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    const audioCtx = audioContextRef.current;
    const newStems: AudioStem[] = [];
    const epoch = projectEpoch.current;

    let maxDuration = config.songDurationSeconds;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const arrayBuffer = await file.arrayBuffer();
        const decoded = await audioCtx.decodeAudioData(arrayBuffer);
        const stemType = inferStemType(file.name);
        const peaks = extractWaveformPeaks(decoded.getChannelData(0));
        const duration = Number(decoded.duration.toFixed(3));
        if (duration > maxDuration) {
          maxDuration = duration;
        }

        const stemId = crypto.randomUUID();
        const stemName = file.name.replace(/\.[^/.]+$/, '');
        const stemCandidates = analysisMode === 'accents' ? analyzeStem({ id: stemId, name: stemName, stemType, audioBuffer: decoded }, analysisSensitivity) : [];

        newStems.push({
          id: stemId,
          name: file.name.replace(/\.[^/.]+$/, ''),
          stemType,
          audioBuffer: decoded,
          waveformPeaks: peaks,
          durationSeconds: duration,
          volume: 1.0,
          muted: false,
          solo: false,
          color: STEM_COLORS[stemType],
          candidates: stemCandidates,
        });
      } catch (err) {
        console.error(`Failed to decode stem file ${file.name}:`, err);
      }
    }

    if (epoch !== projectEpoch.current) return;
    if (newStems.length > 0) {
      const combined = [...stems, ...newStems];
      rebuildCompositeFromStems(combined);
      setConfig((prev) => ({ ...prev, songDurationSeconds: maxDuration }));
      publishAnalysis(combined, analysisMode);
      setMultitrackView(true);
      setActiveTab('stems');
    }
    e.target.value = '';
  };

  const rebuildCompositeFromStems = useCallback(
    (currentStems: AudioStem[]) => {
      if (currentStems.length === 0) return;
      const sampleRate = currentStems[0]?.audioBuffer?.sampleRate || 44100;
      const maxSamples = Math.max(...currentStems.map((s) => s.audioBuffer?.length || 0));
      if (maxSamples === 0) return;

      const mixedData = mixStemsAudio(currentStems, maxSamples);
      const peaks = extractWaveformPeaks(mixedData);
      setMasterDetail(createWaveformDetail([mixedData], sampleRate));
      setWaveformPeaks(peaks);

      const wavBlob = audioSamplesToWavBlob(mixedData, sampleRate);
      playbackBlob.current = wavBlob;
      if (audioObjectUrlRef.current) {
        URL.revokeObjectURL(audioObjectUrlRef.current);
      }
      const objUrl = URL.createObjectURL(wavBlob);
      audioObjectUrlRef.current = objUrl;
      if (!audioElRef.current) {
        audioElRef.current = new Audio();
      }
      const currTime = playheadSecondsRef.current;
      audioElRef.current.src = objUrl;
      audioElRef.current.currentTime = currTime;
      setAudioFileName(`Multi-Stem Mix (${currentStems.length} Stems)`);
    },
    []
  );

  const handleToggleStemMute = useCallback(
    (stemId: string) => {
      setStems((prev) => {
        const next = prev.map((s) => (s.id === stemId ? { ...s, muted: !s.muted } : s));
        rebuildCompositeFromStems(next);
        return next;
      });
    },
    [rebuildCompositeFromStems]
  );

  const handleToggleStemSolo = useCallback(
    (stemId: string) => {
      setStems((prev) => {
        const next = prev.map((s) => (s.id === stemId ? { ...s, solo: !s.solo } : s));
        rebuildCompositeFromStems(next);
        return next;
      });
    },
    [rebuildCompositeFromStems]
  );

  const handleStemVolumeChange = useCallback(
    (stemId: string, volume: number) => {
      setStems((prev) => {
        const next = prev.map((s) => (s.id === stemId ? { ...s, volume } : s));
        rebuildCompositeFromStems(next);
        return next;
      });
    },
    [rebuildCompositeFromStems]
  );

  const removeCandidates = (ids: Set<string>) => {
    ids.forEach((id) => reviewedCandidateIds.current.add(id));
    setStagedCandidates((prev) => prev.filter((candidate) => !ids.has(candidate.id)));
    setStems((prev) => removeReviewedCandidates(prev, ids));
  };

  function masterAnalysisStem(buffer: AudioBuffer): AudioStem {
    return { id: 'master', name: 'Full mix', stemType: 'custom', audioBuffer: buffer, waveformPeaks: [],
      durationSeconds: buffer.duration, volume: 1, muted: false, solo: false, color: '#aaa', candidates: [] };
  }

  function publishAnalysis(inputs: AudioStem[], mode: AnalysisMode, masterOnly = false) {
    const pending = (candidate: TransientCandidate) => !reviewedCandidateIds.current.has(candidate.id);
    const updated = inputs.map((stem) => ({ ...stem, candidates: mode === 'accents' ? analyzeStem(stem, analysisSensitivity).filter(pending) : [] }));
    const candidates = mode === 'structure'
      ? analyzeStructure(inputs, { bpm, beats: timeSignature.beats, unit: timeSignature.unit, sensitivity: analysisSensitivity }).filter(pending)
      : updated.flatMap((stem) => stem.candidates);
    if (!masterOnly) setStems(updated);
    setStagedCandidates(candidates.sort((a, b) => a.timestampSeconds - b.timestampSeconds));
    setSourceFilter('all'); setBandFilter('all');
    setAnalysisMessage(candidates.length + (mode === 'structure' ? ' section suggestions · confirmed markers unchanged' : ' accent suggestions · confirmed markers unchanged'));
  }

  const handleStemTypeChange = (stemId: string, newType: StemType) => {
    publishAnalysis(stems.map((stem) => stem.id === stemId ? { ...stem, stemType: newType, color: STEM_COLORS[newType] } : stem), analysisMode);
  };

  const handleReanalyzeStems = async (mode: AnalysisMode = analysisMode) => {
    if (isAnalyzingStems) return;
    setIsAnalyzingStems(true);
    setAnalysisMessage('Analyzing musical changes…');
    const epoch = projectEpoch.current;
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (stems.length) publishAnalysis(stems, mode);
      else if (playbackBlob.current) {
        const context = new AudioContext();
        try {
          const buffer = await context.decodeAudioData(await playbackBlob.current.arrayBuffer());
          if (epoch === projectEpoch.current) publishAnalysis([masterAnalysisStem(buffer)], mode, true);
        } finally { await context.close(); }
      }
    } catch {
      setAnalysisMessage('Analysis failed. Your existing markers are unchanged.');
    } finally { setIsAnalyzingStems(false); }
  };

  const handleRemoveStem = useCallback(
    (stemId: string) => {
      setStagedCandidates((prev) => prev.filter((c) => c.sourceStemId !== stemId && c.eventKind !== 'section'));
      setAnalysisMessage('Sources changed. Analyze again to update section suggestions.');
      setSourceFilter((prev) => prev === stemId ? "all" : prev);
      setStems((prev) => {
        const next = prev.filter((s) => s.id !== stemId);
        if (next.length > 0) {
          rebuildCompositeFromStems(next);
        }
        return next;
      });
    },
    [rebuildCompositeFromStems]
  );

  const handlePromoteStemCandidates = (stemId: string) => {
    const candidates = stems.find((stem) => stem.id === stemId)?.candidates ?? [];
    setMarkers((prev) => [...prev, ...candidates.map((candidate) => promoteCandidateToMarker(candidate))]);
    removeCandidates(new Set(candidates.map((candidate) => candidate.id)));
  };

  const handlePromoteAllStemCandidates = () => {
    const candidates = stems.flatMap((stem) => stem.candidates);
    setMarkers((prev) => [...prev, ...candidates.map((candidate) => promoteCandidateToMarker(candidate))]);
    removeCandidates(new Set(candidates.map((candidate) => candidate.id)));
  };

  const handleDawFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const result = importMarkersFromFileContent(text, file.name, {
        frameRate: config.frameRate,
        bpm,
      });

      if (result.project) {
        const importedProject = result.project;
        await runProjectAction(async () => {
          await persistCurrentProject();
          await applyProject(makeProjectSnapshot(importedProject));
        });
      } else if (result.markers.length > 0) {
        setMarkers(result.markers);
        const maxTime = Math.max(...result.markers.map((m) => m.timestampSeconds));
        if (maxTime > config.songDurationSeconds) {
          setConfig((prev) => ({
            ...prev,
            songDurationSeconds: Number((maxTime + 10).toFixed(3)),
          }));
        }
      }
      setActiveTab('markers');
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      e.target.value = '';
    }
  };

  const handleDownloadProject = () => runProjectAction(async () => {
    const snapshot = latestProject.current!;
    const archive = await exportProjectArchive(snapshot);
    const url = URL.createObjectURL(archive);
    const link = document.createElement('a');
    link.href = url;
    link.download = (snapshot.project.config.songTitle.replace(/[^a-zA-Z0-9_-]/g, '_') || 'Project') + '.cueforge';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setProjectStatus('Project downloaded with audio and stems.');
  });

  const handleResetToDemo = () => runProjectAction(async () => {
    await persistCurrentProject();
    await applyProject(makeProjectSnapshot({ config: { ...config, songTitle: 'Solaris Demo', songDurationSeconds: defaultDemo.durationSeconds },
      markers: defaultDemo.markers, beatGrid: defaultDemo.beatGrid, waveformPeaks: defaultDemo.waveformPeaks,
      bpm: defaultDemo.bpm, timeSignature: { beats: 4, unit: 4 } }));
  });

  // Update a specific marker property
  const updateMarker = (id: string, patch: Partial<Marker>) => {
    setMarkers((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  };

  // Delete a marker
  const deleteMarker = (id: string) => {
    setMarkers((prev) => prev.filter((m) => m.id !== id));
    setSelectedMarkerIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  // Promote a Beat Grid point to a confirmed Marker
  const handlePromoteBeatGridPoint = (point: BeatGridPoint) => {
    const promoted = promoteBeatGridPointToMarker(point);
    setMarkers((prev) => [...prev, promoted]);
    setActiveTab('markers');
  };

  // Update BPM and regenerate unconfirmed beat grid with active time signature
  const handleBpmChange = useCallback(
    (newBpm: number) => {
      const clamped = Math.max(30, Math.min(300, newBpm || 120));
      setBpm(clamped);
      setAnalysisMessage('Tempo changed. Analyze again to update section suggestions.');
      setBeatGrid(
        generateBeatGrid(
          config.songDurationSeconds,
          clamped,
          0,
          timeSignature.beats,
          timeSignature.unit
        )
      );
    },
    [config.songDurationSeconds, timeSignature]
  );

  const handleTimeSignatureChange = useCallback(
    (beats: number, unit: number) => {
      const safeBeats = Math.max(1, Math.min(16, beats));
      const safeUnit = unit === 8 ? 8 : 4;
      setTimeSignature({ beats: safeBeats, unit: safeUnit });
      setAnalysisMessage('Meter changed. Analyze again to update section suggestions.');
      setBeatGrid(
        generateBeatGrid(
          config.songDurationSeconds,
          bpm,
          0,
          safeBeats,
          safeUnit
        )
      );
    },
    [config.songDurationSeconds, bpm]
  );

  const handleTapTempo = useCallback(() => {
    const res = tapTrackerRef.current.tap();
    setTapFeedback({ count: res.tapCount, active: true });
    window.setTimeout(() => {
      setTapFeedback((prev) => ({ ...prev, active: false }));
    }, 200);
    if (res.bpm !== null) {
      handleBpmChange(res.bpm);
    }
  }, [handleBpmChange]);

  const handleExportUsbZip = useCallback(async () => {
    if (!exportBundle) return;
    try {
      setIsExportingZip(true);
      const zipBlob = await buildGrandMa3UsbZip(compiledShow, config, {
        includeCueAppearances,
        baseAppearancePoolId,
        includeMarkerTrack,
      });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      const cleanTitle = config.songTitle.replace(/[^a-zA-Z0-9_-]/g, '_');
      a.download = `${cleanTitle}_MA3_USB_Structure.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export USB ZIP:', err);
      alert('Failed to generate grandMA3 USB structure ZIP');
    } finally {
      setIsExportingZip(false);
    }
  }, [
    exportBundle,
    compiledShow,
    config,
    includeCueAppearances,
    baseAppearancePoolId,
    includeMarkerTrack,
  ]);

  const handleDownloadLtcWav = useCallback(() => {
    try {
      setIsGeneratingLtc(true);
      const wavBlob = generateLtcAudioWav(
        config.songDurationSeconds,
        config.frameRate,
        config.timecodeOffsetSeconds
      );
      const url = URL.createObjectURL(wavBlob);
      const a = document.createElement('a');
      a.href = url;
      const cleanTitle = config.songTitle.replace(/[^a-zA-Z0-9_-]/g, '_');
      a.download = `${cleanTitle}_LTC_${config.frameRate}fps.wav`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to generate LTC Audio WAV:', err);
      alert('Failed to generate SMPTE LTC Audio WAV');
    } finally {
      setIsGeneratingLtc(false);
    }
  }, [
    config.songDurationSeconds,
    config.frameRate,
    config.timecodeOffsetSeconds,
    config.songTitle,
  ]);

  // Download helper
  const downloadFile = (content: string, filename: string, mime = 'application/xml') => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedType(label);
    setTimeout(() => setCopiedType(null), 2000);
  };

  // Sorted markers for display in the editor table
  const sortedMarkers = useMemo(() => {
    return [...markers].sort((a, b) => {
      if (a.timestampSeconds !== b.timestampSeconds) {
        return a.timestampSeconds - b.timestampSeconds;
      }
      return a.id.localeCompare(b.id);
    });
  }, [markers]);

  const playheadViewportPct = timeToViewportPercent(playheadSeconds, viewport);
  const maxPanStart = Math.max(0, config.songDurationSeconds - viewport.visibleDurationSeconds);

  function makeProjectSnapshot(project: CueForgeProjectData): ProjectSnapshot {
    return { id: crypto.randomUUID(), updatedAt: new Date().toISOString(), project,
      stems: [], candidates: [], reviewedIds: [], audioName: 'No audio attached', sensitivity: 0.5, analysisMode: 'structure',
      options: { includeCueAppearances: true, baseAppearancePoolId: 101, includeMarkerTrack: true } };
  }

  async function applyProject(snapshot: ProjectSnapshot, cancelled = () => false) {
    // Decode first: an invalid project must not partially replace the current one.
    const restoredStems = await Promise.all(snapshot.stems.map(unpackStem));
    let restoredDetail: WaveformDetail | undefined;
    if (snapshot.audio) {
      const context = new AudioContext();
      try { restoredDetail = detailFromBuffer(await context.decodeAudioData(await snapshot.audio.arrayBuffer())); }
      finally { await context.close(); }
    }
    if (cancelled()) return;
    setMasterDetail(restoredDetail);
    projectEpoch.current++;
    cancelCountIn();
    setIsPlaying(false);
    audioElRef.current?.pause();
    if (audioObjectUrlRef.current) URL.revokeObjectURL(audioObjectUrlRef.current);
    audioObjectUrlRef.current = snapshot.audio ? URL.createObjectURL(snapshot.audio) : null;
    playbackBlob.current = snapshot.audio;
    if (snapshot.audio) {
      audioElRef.current = new Audio(audioObjectUrlRef.current!);
    } else { audioElRef.current = null; }
    setProjectId(snapshot.id);
    setConfig(snapshot.project.config);
    setSmpteOffsetInput(formatSecondsToSmpte(snapshot.project.config.timecodeOffsetSeconds, snapshot.project.config.frameRate));
    setMarkers(snapshot.project.markers);
    setBeatGrid(snapshot.project.beatGrid);
    setBpm(snapshot.project.bpm);
    setTimeSignature(snapshot.project.timeSignature ?? { beats: 4, unit: 4 });
    setWaveformPeaks(snapshot.project.waveformPeaks ?? []);
    setStems(restoredStems);
    setStagedCandidates(snapshot.candidates);
    reviewedCandidateIds.current = new Set(snapshot.reviewedIds);
    setAnalysisSensitivity(snapshot.sensitivity);
    setAnalysisMode(snapshot.analysisMode ?? 'structure');
    setAnalysisMessage('');
    setSourceFilter('all'); setBandFilter('all');
    setSelectedMarkerIds(new Set());
    setMetronomeEnabled(false);
    setCountInMode('off');
    setPlayheadSeconds(0); playheadSecondsRef.current = 0;
    setViewport(computeZoomedViewport(snapshot.project.config.songDurationSeconds, 1, 0));
    setIncludeCueAppearances(snapshot.options.includeCueAppearances);
    setBaseAppearancePoolId(snapshot.options.baseAppearancePoolId);
    setIncludeMarkerTrack(snapshot.options.includeMarkerTrack);
    setAudioFileName(snapshot.audioName);
    setActiveTab('markers');
    setProjectStatus(snapshot.audio ? 'Project opened with audio.' : 'Project opened · no audio attached.');
  }

  const snapshot = useMemo<ProjectSnapshot>(() => ({ id: projectId, updatedAt: new Date().toISOString(),
    project: { config, markers, beatGrid, bpm, timeSignature, waveformPeaks },
    stems: stems.map(packStem), candidates: stagedCandidates, reviewedIds: [...reviewedCandidateIds.current],
    audio: playbackBlob.current, audioName: audioFileName, sensitivity: analysisSensitivity, analysisMode,
    options: { includeCueAppearances, baseAppearancePoolId, includeMarkerTrack },
  }), [projectId, config, markers, beatGrid, bpm, timeSignature, waveformPeaks, stems, stagedCandidates,
    audioFileName, analysisSensitivity, analysisMode, includeCueAppearances, baseAppearancePoolId, includeMarkerTrack]);
  latestProject.current = snapshot;
  const savedSnapshot = useRef<ProjectSnapshot>();

  async function persistCurrentProject(value = latestProject.current!) {
    const operation = saveQueue.current.catch(() => {}).then(() => saveLibraryProject(value));
    saveQueue.current = operation;
    await operation;
    if (latestProject.current === value) {
      savedSnapshot.current = value;
      setProjectStatus('Saved in this browser');
      saveProjectToLocalStorage(value.project);
    }
    setProjectList(await listLibraryProjects());
  }

  async function runProjectAction(action: () => Promise<void>) {
    if (projectBusy || isAnalyzingStems) return;
    setProjectBusy(true);
    setProjectError('');
    try { await action(); }
    catch (error) { setProjectError('Could not complete: ' + (error instanceof Error ? error.message : String(error))); }
    finally { setProjectBusy(false); }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const saved = await readLibraryProject();
        if (cancelled) return;
        if (saved) await applyProject(saved, () => cancelled);
        if (cancelled) return;
        setProjectList(await listLibraryProjects());
        setProjectReady(true);
      } catch {
        if (!cancelled) {
          setProjectStatus('Local storage unavailable. Download your project to keep a copy.');
          setProjectReady(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!projectReady || projectBusy || savedSnapshot.current === snapshot) return;
    setProjectStatus('Unsaved changes…');
    const timer = window.setTimeout(() => {
      setProjectStatus('Saving…');
      void persistCurrentProject(snapshot).catch(() => setProjectError('Not saved: browser storage unavailable or full. Download a backup.'));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [snapshot, projectReady, projectBusy]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (projectReady && savedSnapshot.current !== latestProject.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [projectReady]);

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!projectReady || projectBusy) return;
        if (event.shiftKey) void handleDownloadProject();
        else void runProjectAction(() => persistCurrentProject());
      }
    };
    window.addEventListener('keydown', handleSaveShortcut);
    return () => window.removeEventListener('keydown', handleSaveShortcut);
  });

  const openProjectFile = (file: File) => runProjectAction(async () => {
    const incoming = file.name.toLowerCase().endsWith('.json')
      ? makeProjectSnapshot(deserializeProjectFromJson(await file.text()))
      : await importProjectArchive(file);
    await persistCurrentProject();
    await applyProject(incoming);
  });

  return (
    <div className="app-shell" aria-busy={projectBusy || !projectReady}>
      <ProjectManager open={projectsOpen} busy={projectBusy || isAnalyzingStems} currentId={projectId} name={config.songTitle}
        projects={projectList} status={projectError || projectStatus} onClose={() => setProjectsOpen(false)}
        onRename={(name) => setConfig((prev) => ({ ...prev, songTitle: name }))}
        onDownload={handleDownloadProject} onImport={openProjectFile}
        onNew={() => void runProjectAction(async () => {
          await persistCurrentProject();
          await applyProject(makeProjectSnapshot({ config: { ...config, songTitle: 'Untitled project', sequenceName: 'Untitled_Seq', timecodeName: 'Untitled_TC', songDurationSeconds: 60, allowOverwriteExistingObjects: false },
            markers: [], beatGrid: [], bpm: 120, timeSignature: { beats: 4, unit: 4 }, waveformPeaks: [] }));
        })}
        onDuplicate={() => void runProjectAction(async () => {
          await persistCurrentProject();
          const copy = { ...latestProject.current!, id: crypto.randomUUID(), project: { ...latestProject.current!.project,
            config: { ...config, songTitle: config.songTitle + ' copy' } } };
          await applyProject(copy);
        })}
        onOpen={(id) => void runProjectAction(async () => {
          await persistCurrentProject();
          const saved = await readLibraryProject(id);
          if (!saved) throw new Error('Project not found.');
          await applyProject(saved);
        })} />
      {!projectReady && <div className="project-loading" role="status">Opening your workspace…</div>}
      {/* Top Header & Live 1:1:1 Invariant Telemetry */}
      <header className="app-header">
        <div className="brand-group">
          <div className="brand-logo">CF</div>
          <div>
            <div className="brand-title">
              CueForge
              <span className="version-pill">grandMA3 2.5</span>
            </div>
            <div className="brand-subtitle">
              <span role="status">{projectError || projectStatus}</span>
            </div>
          </div>
        </div>

        <div className="invariant-ribbon" aria-label="Core Invariant Status">
          <div className="invariant-stat">
            <span>Markers</span>
            <strong className="mono">{compiledShow.exportableMarkers.length}</strong>
          </div>
          <span className="invariant-equals">=</span>
          <div className="invariant-stat">
            <span>Cues</span>
            <strong className="mono">{compiledShow.cues.length}</strong>
          </div>
          <span className="invariant-equals">=</span>
          <div className="invariant-stat">
            <span>Events</span>
            <strong className="mono">{compiledShow.events.length}</strong>
          </div>
          <div
            className="invariant-stat"
            style={{
              borderColor: validationReport.isValid
                ? 'rgba(16, 185, 129, 0.45)'
                : 'rgba(239, 68, 68, 0.5)',
            }}
          >
            {validationReport.isValid ? (
              <CheckCircle2 size={16} color="#10b981" />
            ) : (
              <AlertTriangle size={16} color="#ef4444" />
            )}
            <span style={{ color: validationReport.isValid ? '#6ee7b7' : '#fca5a5', fontWeight: 600 }}>
              {validationReport.isValid ? 'In sync' : `${validationReport.errors.length} Validation Error(s)`}
            </span>
          </div>
        </div>
      </header>

      <aside className="media-browser" aria-label="Project tracks">
        <div className="dock-heading"><Layers size={14} /><strong>Tracks</strong><span>{stems.length || 1}</span></div>
        <label className="btn track-import"><Plus size={14} /> Import stems
          <input type="file" multiple accept="audio/*" onChange={handleStemUpload} disabled={isAnalyzingStems} />
        </label>
        <div className="track-list">
          {stems.length === 0 ? <div className="browser-track">
            <div className="track-name"><FileAudio size={15} /><strong>Master audio</strong></div>
            <small>{audioFileName}</small>
            <span className="track-kind">Stereo mix</span>
          </div> : stems.map((stem, index) => <div className="browser-track" key={stem.id} style={{ borderLeftColor: stem.color }}>
            <div className="track-name"><span className="track-number">{String(index + 1).padStart(2, '0')}</span><strong title={stem.name}>{stem.name}</strong></div>
            <div className="track-controls"><span className="track-kind">{stem.stemType}</span>
              <button className="track-switch" aria-label={`Mute ${stem.name}`} aria-pressed={stem.muted} onClick={() => handleToggleStemMute(stem.id)}>M</button>
              <button className="track-switch solo" aria-label={`Solo ${stem.name}`} aria-pressed={stem.solo} onClick={() => handleToggleStemSolo(stem.id)}>S</button>
            </div>
            <label className="track-volume"><Volume2 size={12} /><input aria-label={`Volume ${stem.name}`} type="range" min="0" max="1" step="0.01" value={stem.volume} onChange={(e) => handleStemVolumeChange(stem.id, Number(e.target.value))} /></label>
          </div>)}
        </div>
        <button className="btn btn-sm" onClick={() => setActiveTab('stems')}>Open mixer</button>
        <div className="browser-footer"><span>KEYBOARD</span><p><kbd>Space</kbd> Play / pause</p><p><kbd>M</kbd> Add marker</p><p><kbd>Ctrl + wheel</kbd> Zoom timeline</p></div>
      </aside>

      {/* Interactive Audio Waveform & Marker Timeline */}
      <section className="timeline-card" aria-label="Audio and Marker Timeline">
        <div className="workspace-heading">
          <div><span className="eyebrow">TIMELINE</span><h1>{config.songTitle.replaceAll('_', ' ')}</h1></div>
          <span className="workspace-meta"><span className="status-dot" />{audioFileName}</span>
        </div>
        <div className="timeline-toolbar">
          <div className="transport-group"><span className="transport-time mono" aria-label="Playback position">{playheadTiming.formattedRelative}</span>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleTogglePlay}
              title="Play / Pause (Shortcut: Space)"
            >
              {isPlaying || countInState?.active ? <Pause size={15} /> : <Play size={15} />}
              {isPlaying || countInState?.active ? 'Pause' : 'Play'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                cancelCountIn();
                setIsPlaying(false);
                seekPlayheadTo(0, true);
              }}
              title="Return to 00:00.000"
            >
              <RotateCcw size={15} />
              Return
            </button>

            <button
              type="button"
              className="btn"
              onClick={() => addManualMarkerAtPlayhead('Structure')}
              title="Drop a confirmed marker at the current playhead (Shortcut: M)"
            >
              <Plus size={15} />
              Add marker
            </button>

            <button
              type="button"
              className={`btn ${snapToBeatGrid ? 'btn-toggle-active' : ''}`}
              aria-pressed={snapToBeatGrid}
              onClick={() => setSnapToBeatGrid((s) => !s)}
              title="Toggle snapping dragged markers to the nearest Beat Grid point (Hold Alt while dragging to bypass)"
            >
              <Magnet size={15} />
              Snap {snapToBeatGrid ? 'on' : 'off'}
            </button>

          </div>
            <label className="btn" style={{ cursor: 'pointer' }}>
              <FileAudio size={15} />
              Add audio
              <input
                type="file"
                accept="audio/*"
                onChange={handleAudioUpload}
                style={{ display: 'none' }}
              />
            </label>
<button className="btn" disabled={!projectReady || projectBusy || isAnalyzingStems} onClick={() => { setProjectsOpen(true); void listLibraryProjects().then(setProjectList).catch(() => setProjectStatus('Could not read project library.')); }}>Projects</button>
<details className="disclosure project-menu"><summary>More</summary><div className="project-actions">
            <label className="btn" style={{ cursor: 'pointer' }} title="Import markers from Reaper (.csv), Audacity (.txt), or CueForge (.json)">
              <FileCode size={15} />
              Import markers / JSON
              <input
                type="file"
                accept=".csv,.txt,.tsv,.json"
                onChange={handleDawFileImport}
                style={{ display: 'none' }}
              />
            </label>

            <button
              type="button"
              className="btn"
              onClick={handleDownloadProject}
              title="Download complete project with audio and stems (.cueforge)"
            >
              <Download size={15} />
              Download project
            </button>

            <button
              type="button"
              className="btn btn-sm"
              onClick={handleResetToDemo}
              title="Reset to default demo show"
            >
              Open demo as new project
            </button>



            <label
              className="btn"
              style={{
                cursor: 'pointer',
                background: 'rgba(56, 189, 248, 0.12)',
                borderColor: 'rgba(56, 189, 248, 0.4)',
              }}
              title="Upload multi-track stems (Drums, Bass, Vocals, Synths, etc.)"
            >
              <Layers size={15} color="#38bdf8" />
              Add stems ({stems.length})
              <input
                type="file"
                multiple
                accept="audio/*"
                onChange={handleStemUpload}
                style={{ display: 'none' }}
              />
            </label>

          </div></details>

        </div>

        <div className="edit-toolbar" aria-label="Timeline view controls">
          <span className="edit-toolbar-label"><Layers size={13} /> Arrangement <span className="zoom-readout">{viewport.zoomFactor.toFixed(1)}×</span></span>
          <span className="tempo-chip">{bpm} BPM <span>·</span> {timeSignature.beats}/{timeSignature.unit}</span>
          <div className="edit-toolbar-actions">
            {stems.length > 0 && <button className="btn btn-sm" aria-pressed={multitrackView} onClick={() => setMultitrackView((value) => !value)}>{multitrackView ? 'Tracks' : 'Mix'}</button>}
            <button className="btn btn-sm" aria-label="Zoom timeline out" onClick={() => handleZoom(viewport.zoomFactor / 1.5)} disabled={viewport.zoomFactor <= 1}><ZoomOut size={14} /></button>
            <button className="btn btn-sm" onClick={() => handleZoom(1)} title="Fit entire song">Fit</button>
            <button className="btn btn-sm" aria-label="Zoom timeline in" onClick={() => handleZoom(viewport.zoomFactor * 1.5)} disabled={viewport.zoomFactor >= 256}><ZoomIn size={14} /></button>
          </div>
        </div>
        {/* Waveform Canvas with Interactive Confirmed Marker Flags */}
        <div
          ref={waveformContainerRef}
          className={`waveform-container ${stems.length > 0 && multitrackView ? 'multitrack-mode' : ''}`}
          style={
            stems.length > 0 && multitrackView
              ? { height: `${Math.max(148, stems.length * 64)}px` }
              : undefined
          }
          onClick={(e) => {
            if (suppressNextWaveformClickRef.current) {
              suppressNextWaveformClickRef.current = false;
              return;
            }
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / Math.max(1, rect.width);
            const targetTime = viewportRatioToTime(
              ratio,
              viewport,
              config.songDurationSeconds
            );
            seekPlayheadTo(targetTime);
          }}
          title="Click anywhere on the waveform or stem lanes to scrub playhead (Ctrl/Alt+Wheel to zoom, Shift+Wheel to pan)"
        >
          {stems.length > 0 && multitrackView ? (
            <div className="multitrack-lanes-wrapper">
              {stems.map((stem, idx) => (
                <div
                  key={stem.id}
                  className="multitrack-lane"
                  style={{
                    height: '64px',
                    borderBottom: idx < stems.length - 1 ? '1px solid rgba(255, 255, 255, 0.08)' : 'none',
                    opacity: stem.muted ? 0.35 : 1,
                  }}
                >
                  <div className="multitrack-lane-badge" style={{ borderColor: `${stem.color}55` }}>
                    <span className="multitrack-dot" style={{ backgroundColor: stem.color }} />
                    <span className="multitrack-name">{stem.name}</span>
                    <span className="multitrack-type" style={{ color: stem.color }}>{stem.stemType}</span>
                    {stem.muted && <span className="multitrack-flag-m" title="Muted">M</span>}
                    {stem.solo && <span className="multitrack-flag-s" title="Solo">S</span>}
                  </div>
                  <MultitrackLaneCanvas
                    stem={stem}
                    viewport={viewport}
                    songDurationSeconds={config.songDurationSeconds}
                    playheadSeconds={playheadSeconds}
                    beatGrid={beatGrid}
                    showBeatGridOverlay={showBeatGridOverlay}
                    snappedBeatId={draggingMarkerState?.snappedBeat?.id}
                    isLast={idx === stems.length - 1}
                  />
                </div>
              ))}
            </div>
          ) : (
            <canvas ref={canvasRef} className="waveform-canvas" />
          )}

          {/* Confirmed Markers Overlay — Rendered in stable ID order to preserve pointer capture during drag */}
          {markers.map((m) => {
            const isThisDragging = draggingMarkerState?.markerId === m.id;
            const rawLeftPct = timeToViewportPercent(m.timestampSeconds, viewport);
            if (rawLeftPct === null && !isThisDragging) return null;
            const leftPct =
              rawLeftPct !== null
                ? rawLeftPct
                : m.timestampSeconds <= viewport.startSeconds
                ? 0
                : 100;

            const compiledInfo = compiledByMarkerId.get(m.id);
            const color = CATEGORY_COLORS[m.category];
            const snappedBeat = isThisDragging ? draggingMarkerState?.snappedBeat : null;

            return (
              <div
                key={m.id}
                className={`marker-pin ${isThisDragging ? 'is-dragging' : ''}`}
                style={{
                  left: `${leftPct}%`,
                  backgroundColor: m.exportEnabled ? color : '#475569',
                  opacity: m.exportEnabled ? 1 : 0.45,
                }}
                onClick={(ev) => {
                  ev.stopPropagation();
                  suppressNextWaveformClickRef.current = false;
                }}
                title={
                  compiledInfo
                    ? `Cue ${compiledInfo.cueNumber}: ${m.label} (${compiledInfo.absoluteSmpte}) — Drag flag or use Left/Right Arrow keys to reposition`
                    : `${m.label} (Export Disabled)`
                }
              >
                <div
                  tabIndex={0}
                  className={`marker-pin-flag drag-handle ${isThisDragging ? 'dragging' : ''}`}
                  aria-label={`${
                    compiledInfo ? `Cue ${compiledInfo.cueNumber}: ` : ''
                  }${m.label} at ${m.timestampSeconds.toFixed(
                    3
                  )} seconds. Drag handle or use Left and Right arrow keys to move marker.`}
                  style={{
                    backgroundColor: m.exportEnabled ? color : '#64748b',
                  }}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    suppressNextWaveformClickRef.current = false;
                  }}
                  onPointerDown={(ev) => {
                    if (ev.button !== 0) return;
                    ev.stopPropagation();
                    const pinEl = ev.currentTarget.parentElement;
                    const pinRect = pinEl
                      ? pinEl.getBoundingClientRect()
                      : ev.currentTarget.getBoundingClientRect();
                    const offsetX = ev.clientX - pinRect.left;
                    dragPointerRef.current = {
                      markerId: m.id,
                      pointerId: ev.pointerId,
                      offsetX,
                      startClientX: ev.clientX,
                      hasExceededThreshold: false,
                    };
                    ev.currentTarget.setPointerCapture(ev.pointerId);
                  }}
                  onPointerMove={(ev) => {
                    const drag = dragPointerRef.current;
                    if (
                      !drag ||
                      drag.markerId !== m.id ||
                      !ev.currentTarget.hasPointerCapture(ev.pointerId)
                    ) {
                      return;
                    }
                    if (
                      !drag.hasExceededThreshold &&
                      Math.abs(ev.clientX - drag.startClientX) < 4
                    ) {
                      return;
                    }
                    drag.hasExceededThreshold = true;
                    suppressNextWaveformClickRef.current = true;

                    const container = waveformContainerRef.current;
                    if (!container) return;
                    const rect = container.getBoundingClientRect();
                    const ratio =
                      (ev.clientX - drag.offsetX - rect.left) / Math.max(1, rect.width);
                    const candidateTime = viewportRatioToTime(
                      ratio,
                      viewport,
                      config.songDurationSeconds
                    );
                    const effectiveSnap = snapToBeatGrid && !ev.altKey;
                    const maxSnapDist = Math.min(
                      0.18,
                      viewport.visibleDurationSeconds * 0.025
                    );
                    const visibleEnd =
                      viewport.startSeconds + viewport.visibleDurationSeconds;
                    const visibleBeatGrid = beatGrid.filter(
                      (gp) =>
                        gp.timestampSeconds >= viewport.startSeconds - 1e-4 &&
                        gp.timestampSeconds <= visibleEnd + 1e-4
                    );
                    const snapped = snapTimeToBeatGrid(
                      candidateTime,
                      visibleBeatGrid,
                      effectiveSnap,
                      config.songDurationSeconds,
                      maxSnapDist
                    );
                    setDraggingMarkerState({
                      markerId: m.id,
                      snappedBeat: snapped.snappedBeat,
                    });
                    updateMarker(m.id, { timestampSeconds: snapped.timestampSeconds });
                  }}
                  onLostPointerCapture={() => {
                    const drag = dragPointerRef.current;
                    if (drag && drag.markerId === m.id && !drag.hasExceededThreshold) {
                      seekPlayheadTo(m.timestampSeconds);
                    }
                    if (drag?.markerId === m.id) {
                      dragPointerRef.current = null;
                    }
                    setDraggingMarkerState((prev) =>
                      prev?.markerId === m.id ? null : prev
                    );
                    window.setTimeout(() => {
                      suppressNextWaveformClickRef.current = false;
                    }, 0);
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
                      ev.preventDefault();
                      ev.stopPropagation();
                      const step = ev.shiftKey ? 0.25 : 0.05;
                      const delta = ev.key === 'ArrowLeft' ? -step : step;
                      const nextTime = nudgeMarkerTimestamp(
                        m.timestampSeconds,
                        delta,
                        config.songDurationSeconds
                      );
                      updateMarker(m.id, { timestampSeconds: nextTime });
                      setViewport((prev) =>
                        ensureTimeVisibleInViewport(
                          prev,
                          nextTime,
                          config.songDurationSeconds
                        )
                      );
                    }
                  }}
                >
                  {compiledInfo ? `Q${compiledInfo.cueNumber}: ${m.label}` : `[OFF] ${m.label}`}
                </div>

                {isThisDragging && (
                  <div className="marker-drag-tooltip mono">
                    {m.timestampSeconds.toFixed(3)}s
                    {compiledInfo ? ` (${compiledInfo.absoluteSmpte})` : ''}
                    {snappedBeat ? ` • Snapped Bar ${snappedBeat.bar}.${snappedBeat.beat}` : ''}
                  </div>
                )}
              </div>
            );
          })}

          {/* Playhead Line */}
          {playheadViewportPct !== null && (
            <div
              className="playhead-line"
              style={{
                left: `${playheadViewportPct}%`,
              }}
            />
          )}

          {/* Visual Pre-Roll / Count-In Metronome Overlay */}
          {countInState?.active && (() => {
            const beatInfo = getCountInBeatInfo(
              countInState.currentBeatIndex,
              countInMode,
              timeSignature.beats
            );
            return (
              <div className="count-in-overlay" aria-live="assertive">
                <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.06em' }}>
                  COUNT-IN: BAR {beatInfo.barNumber} OF {beatInfo.totalBars}
                </div>
                <div className="count-in-number">{beatInfo.beatInBar}</div>
                <div className="count-in-subtext">
                  Audio playback begins in {beatInfo.remainingBeats} beat{beatInfo.remainingBeats === 1 ? '' : 's'}
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  style={{ marginTop: '0.5rem', pointerEvents: 'auto' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    cancelCountIn();
                  }}
                >
                  Cancel Count-In
                </button>
              </div>
            );
          })()}
        </div>

<details className="disclosure timeline-options"><summary>Timeline tools <span>Tempo, zoom & sync</span></summary><div className="disclosure-content">          <div className="timecode-readout-group">
            <div className="tc-readout-box">
              <span className="tc-readout-label">Relative Song Time</span>
              <span className="tc-readout-value relative mono">
                {playheadTiming.formattedRelative}
              </span>
            </div>
            <div className="tc-readout-box">
              <span className="tc-readout-label">
                Final Absolute SMPTE ({config.frameRate} fps)
              </span>
              <span className="tc-readout-value mono">
                {playheadTiming.formattedAbsoluteSmpte}
              </span>
            </div>
            <div className="tc-readout-box">
              <span className="tc-readout-label">MA3 Frame / Ticks</span>
              <span className="tc-readout-value mono" style={{ fontSize: '0.82rem', color: '#cbd5e1' }}>
                F#{playheadTiming.totalFrames} ({playheadTiming.ma3InternalTicks}t)
              </span>
            </div>
          </div>

        {/* Real-Time Virtual Cue Trigger Simulator (Cue Status Monitor HUD) */}
        <div
          className={`cue-monitor-hud ${cueMonitorStatus.isTriggerMoment && isPlaying ? 'cue-monitor-flash' : ''}`}
          aria-label="Live grandMA3 Cue Status Monitor"
        >
          <div className="cue-monitor-active">
            <span className="cue-monitor-badge">
              {cueMonitorStatus.activeCue ? `CUE ${cueMonitorStatus.activeCue.cueNumber}` : 'STANDBY'}
            </span>
            <div>
              <div className="cue-monitor-title">
                {cueMonitorStatus.activeCue ? cueMonitorStatus.activeCue.name : 'Waiting for Cue 1...'}
              </div>
              <div style={{ fontSize: '0.73rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                {cueMonitorStatus.activeCue ? (
                  <>
                    <span
                      className={`cat-badge cat-${cueMonitorStatus.activeCue.category}`}
                      style={{ padding: '0.1rem 0.35rem', fontSize: '0.66rem', marginRight: '0.4rem' }}
                    >
                      {cueMonitorStatus.activeCue.category}
                    </span>
                    Trigger: <span className="mono">{cueMonitorStatus.activeCue.timestampSeconds.toFixed(2)}s</span> • Fade: <span className="mono">{cueMonitorStatus.activeCue.fadeInSeconds}s</span>
                  </>
                ) : (
                  'Playhead before first confirmed cue'
                )}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', alignItems: 'flex-end' }}>
              <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Fade Progress: {Math.round(cueMonitorStatus.fadeProgress * 100)}%
              </span>
              <div className="cue-monitor-fade-bar">
                <div
                  className="cue-monitor-fade-fill"
                  style={{ width: `${Math.round(cueMonitorStatus.fadeProgress * 100)}%` }}
                />
              </div>
            </div>

            <div className="cue-monitor-next">
              {cueMonitorStatus.nextCue ? (
                <div>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>Next: </span>
                  <strong style={{ color: 'var(--accent-ma3)' }}>Q{cueMonitorStatus.nextCue.cueNumber}</strong> ({cueMonitorStatus.nextCue.name})
                  <div className="mono" style={{ fontSize: '0.75rem', color: 'var(--accent-cyan)' }}>
                    T - {cueMonitorStatus.countdownSeconds.toFixed(2)}s ({cueMonitorStatus.countdownFrames} frames)
                  </div>
                </div>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>End of Cue List</span>
              )}
            </div>
          </div>
        </div>

        {/* Tempo, Time Signature & Metronome Control Bar */}
        <div className="tempo-transport-bar" aria-label="Tempo, Time Signature, and Metronome">
          {/* Tempo / BPM Input + Interactive Tap Tempo */}
          <div className="tempo-item">
            <Clock size={15} color="var(--accent-ma3)" />
            <span style={{ fontWeight: 600 }}>Tempo:</span>
            <input
              type="number"
              className="tempo-input"
              min="30"
              max="300"
              value={bpm}
              onChange={(e) => handleBpmChange(Number(e.target.value))}
              title="Song Tempo in Beats Per Minute (BPM)"
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>BPM</span>

            {/* Interactive Tap Tempo Button */}
            <button
              type="button"
              className={`btn-tap-tempo ${tapFeedback.active ? 'active' : ''}`}
              onClick={handleTapTempo}
              title="Click or tap rhythmically to calculate BPM"
            >
              TAP {tapFeedback.count > 1 ? `(${tapFeedback.count})` : ''}
            </button>
          </div>

          {/* Time Signature */}
          <div className="tempo-item">
            <span style={{ fontWeight: 600 }}>Time Signature:</span>
            <input
              type="number"
              className="tempo-input"
              min="1"
              max="16"
              value={timeSignature.beats}
              onChange={(e) => handleTimeSignatureChange(Number(e.target.value), timeSignature.unit)}
              title="Beats per Measure (Numerator)"
            />
            <span style={{ fontWeight: 700, color: 'var(--text-muted)' }}>/</span>
            <select
              className="tempo-select"
              value={timeSignature.unit}
              onChange={(e) => handleTimeSignatureChange(timeSignature.beats, Number(e.target.value))}
              title="Beat Unit (Denominator)"
            >
              <option value={4}>4 (Quarter)</option>
              <option value={8}>8 (Eighth)</option>
            </select>

            {/* Quick Presets */}
            <div style={{ display: 'flex', gap: '0.25rem', marginLeft: '0.25rem' }}>
              {(['4/4', '3/4', '6/8', '2/4'] as const).map((sig) => {
                const [b, u] = sig.split('/').map(Number);
                const isActive = timeSignature.beats === b && timeSignature.unit === u;
                return (
                  <button
                    key={sig}
                    type="button"
                    className={`btn btn-sm ${isActive ? 'btn-accent' : ''}`}
                    style={{ padding: '0.15rem 0.4rem', fontSize: '0.72rem' }}
                    onClick={() => handleTimeSignatureChange(b, u)}
                  >
                    {sig}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Pre-Roll / Count-In Selector */}
          <div className="tempo-item">
            <span style={{ fontWeight: 600 }}>Count-In:</span>
            <select
              className="tempo-select"
              value={countInMode}
              onChange={(e) => setCountInMode(e.target.value as CountInMode)}
              title="Pre-roll metronome count-in when pressing Play from 00:00.000"
            >
              <option value="off">Off</option>
              <option value="1bar">1 Bar</option>
              <option value="2bars">2 Bars</option>
            </select>
          </div>

          {/* Metronome Toggle & Volume */}
          <div className="tempo-item" style={{ marginLeft: 'auto' }}>
            <button
              type="button"
              className={`btn-metronome ${metronomeEnabled ? 'active' : ''}`}
              onClick={() => setMetronomeEnabled((m) => !m)}
              title="Toggle Metronome Audio Click during Playback (accents beat 1 according to Time Signature)"
            >
              <Bell size={14} color={metronomeEnabled ? '#fbbf24' : 'currentColor'} />
              Metronome: {metronomeEnabled ? 'ON' : 'OFF'}
            </button>

            <div
              style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginLeft: '0.35rem' }}
              title={`Metronome Volume: ${Math.round(metronomeVolume * 100)}%`}
            >
              <Volume2 size={13} color="var(--text-muted)" />
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={metronomeVolume}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setMetronomeVolume(v);
                  metronomeRef.current.setVolume(v);
                }}
                style={{ width: '55px', height: '4px', accentColor: 'var(--accent-ma3)' }}
              />
            </div>

            <button
              type="button"
              className="btn btn-sm"
              style={{ padding: '0.2rem 0.45rem', fontSize: '0.72rem' }}
              onClick={() => {
                metronomeRef.current.playClick(true);
              }}
              title="Preview Metronome Click Sound (Beat 1 Downbeat)"
            >
              Test Click
            </button>
          </div>
        </div>

        {/* Zoom & Pan Navigation Bar + Keyboard Shortcuts Legend */}
        <div className="timeline-nav-bar" aria-label="Timeline Zoom, Pan, and Shortcuts">
          <div className="zoom-controls-group">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => handleZoom(viewport.zoomFactor / 1.5)}
              disabled={viewport.zoomFactor <= 1}
              title="Zoom Out"
            >
              <ZoomOut size={13} />
            </button>
            {([1, 2, 4, 8, 16] as const).map((zf) => (
              <button
                key={zf}
                type="button"
                className={`btn btn-sm ${Math.abs(viewport.zoomFactor - zf) < 0.1 ? 'btn-primary' : ''}`}
                onClick={() => handleZoom(zf)}
              >
                {zf}x
              </button>
            ))}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => handleZoom(viewport.zoomFactor * 1.5)}
              disabled={viewport.zoomFactor >= 256}
              title="Zoom In (Anchored at Playhead)"
            >
              <ZoomIn size={13} />
            </button>

            <span style={{ color: 'var(--border-subtle)', margin: '0 0.15rem' }}>|</span>

            <button
              type="button"
              className="btn btn-sm"
              onClick={() => handlePan(-viewport.visibleDurationSeconds * 0.25)}
              disabled={viewport.startSeconds <= 0}
              title="Pan Left"
            >
              <ChevronLeft size={13} />
              Pan
            </button>
            <input
              type="range"
              aria-label="Timeline horizontal pan position"
              className="pan-slider"
              min={0}
              max={Math.max(0.01, maxPanStart)}
              step={0.05}
              disabled={viewport.zoomFactor <= 1}
              value={Math.min(viewport.startSeconds, maxPanStart)}
              onChange={(e) => {
                const targetStart = Number(e.target.value);
                setViewport((prev) =>
                  panViewport(prev, targetStart - prev.startSeconds, config.songDurationSeconds)
                );
              }}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => handlePan(viewport.visibleDurationSeconds * 0.25)}
              disabled={viewport.startSeconds >= maxPanStart - 0.001}
              title="Pan Right"
            >
              Pan
              <ChevronRight size={13} />
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => handleZoom(1, 0)}
              disabled={viewport.zoomFactor === 1}
              title="Reset Zoom to Full Song (1x)"
            >
              <Maximize2 size={12} />
              Fit
            </button>

            {stems.length > 0 && (
              <button
                type="button"
                className={`btn btn-sm ${multitrackView ? 'btn-accent' : ''}`}
                onClick={() => setMultitrackView((v) => !v)}
                title="Toggle between Multitrack Stems view and Master composite mix"
              >
                <Layers size={12} />
                Lanes ({stems.length}): {multitrackView ? 'ON' : 'OFF'}
              </button>
            )}

            <span className="mono" style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginLeft: '0.25rem' }}>
              Window: {viewport.startSeconds.toFixed(1)}s–
              {(viewport.startSeconds + viewport.visibleDurationSeconds).toFixed(1)}s /{' '}
              {config.songDurationSeconds.toFixed(1)}s ({viewport.zoomFactor}x)
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
            <span className="shortcut-pill">
              <kbd>Space</kbd> Play / Pause
            </span>
            <span className="shortcut-pill">
              <kbd>M</kbd> Drop Marker @ Playhead
            </span>
            <span className="shortcut-pill">
              <kbd>Drag</kbd> / <kbd>←</kbd> <kbd>→</kbd> Move Marker
            </span>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '0.5rem',
            fontSize: '0.75rem',
            color: 'var(--text-secondary)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', flexWrap: 'wrap' }}>
            <span>
              <strong>All Confirmed Categories Exported:</strong>
            </span>
            {(['Structure', 'Hit', 'Effect', 'Note', 'Custom'] as MarkerCategory[]).map((cat) => (
              <span key={cat} className={`cat-badge cat-${cat}`}>
                {cat}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={snapToBeatGrid}
                onChange={(e) => setSnapToBeatGrid(e.target.checked)}
              />
              Snap Dragged Markers to Beat Grid
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showBeatGridOverlay}
                onChange={(e) => setShowBeatGridOverlay(e.target.checked)}
              />
              Show Unconfirmed Beat Grid ({beatGrid.length} grid lines — never auto-exported as cues)
            </label>
          </div>
        </div>
</div></details>
      </section>

      {/* Main Two-Column Workspace */}
      <div className="workspace-grid">
        {/* Left Sidebar: grandMA3 2.5.x & Synchronization Configuration */}


        {/* Right Main Panel: Marker Editor, Sequence & Timecode Preview, Validation & Code */}
        <main className="isolated-panel" aria-label="Marker Editor and grandMA3 Compiler Preview">
          <div className="panel-header">
            <div className="tab-bar" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'markers'}
                className={`tab-btn ${activeTab === 'markers' ? 'active' : ''}`}
                onClick={() => setActiveTab('markers')}
              >
                <Layers size={15} />
                Markers <span className="tab-count">{markers.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'stems'}
                className={`tab-btn ${activeTab === 'stems' ? 'active' : ''}`}
                onClick={() => setActiveTab('stems')}
              >
                <Layers size={15} color="#38bdf8" />
                Mixer <span className="tab-count">{stems.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'candidate-shelf'}
                className={`tab-btn ${activeTab === 'candidate-shelf' ? 'active' : ''}`}
                onClick={() => setActiveTab('candidate-shelf')}
              >
                <Sparkles size={15} color="#f59e0b" />
                Analysis <span className="tab-count">{stagedCandidates.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'sequence-preview'}
                className={`tab-btn ${activeTab === 'sequence-preview' ? 'active' : ''}`}
                onClick={() => setActiveTab('sequence-preview')}
              >
                <Clock size={15} />
                Sequence
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'validation-export'}
                className={`tab-btn ${activeTab === 'validation-export' ? 'active' : ''}`}
                onClick={() => setActiveTab('validation-export')}
              >
                <ShieldCheck size={15} />
                Export
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'beat-grid'}
                className={`tab-btn ${activeTab === 'beat-grid' ? 'active' : ''}`}
                onClick={() => setActiveTab('beat-grid')}
              >
                <Grid size={15} />
                Beat grid
              </button>
            </div>
          </div>

          {/* TAB 1: MARKER & CUE EDITOR */}
          {activeTab === 'markers' && (
            <div>
              {/* Bulk Action Bar (Rendered when markers are selected) */}
              {selectedMarkerIds.size > 0 && (
                <div className="bulk-action-bar" aria-label="Bulk Marker Actions">
                  <div className="bulk-action-group">
                    <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--accent-cyan)' }}>
                      {selectedMarkerIds.size} Selected:
                    </span>

                    <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Fade:</span>
                    {([0, 0.5, 1.0, 2.0] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="bulk-chip"
                        onClick={() => handleBulkFade(s)}
                      >
                        {s}s
                      </button>
                    ))}
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      className="bulk-input"
                      placeholder="Custom"
                      value={bulkCustomFade}
                      onChange={(e) => setBulkCustomFade(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleBulkFade(Number(bulkCustomFade));
                      }}
                    />
                    <button
                      type="button"
                      className="bulk-chip"
                      onClick={() => handleBulkFade(Number(bulkCustomFade))}
                    >
                      Set
                    </button>
                  </div>

                  <div className="bulk-action-group">
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Delay:</span>
                    {([0, 0.2] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="bulk-chip"
                        onClick={() => handleBulkDelay(s)}
                      >
                        {s}s
                      </button>
                    ))}
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      className="bulk-input"
                      placeholder="Custom"
                      value={bulkCustomDelay}
                      onChange={(e) => setBulkCustomDelay(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleBulkDelay(Number(bulkCustomDelay));
                      }}
                    />
                    <button
                      type="button"
                      className="bulk-chip"
                      onClick={() => handleBulkDelay(Number(bulkCustomDelay))}
                    >
                      Set
                    </button>
                  </div>

                  <div className="bulk-action-group">
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Nudge:</span>
                    <button
                      type="button"
                      className="bulk-chip"
                      onClick={() => handleBulkNudge(-5 / config.frameRate)}
                      title="Nudge -5 frames"
                    >
                      -5f
                    </button>
                    <button
                      type="button"
                      className="bulk-chip"
                      onClick={() => handleBulkNudge(-1 / config.frameRate)}
                      title="Nudge -1 frame"
                    >
                      -1f
                    </button>
                    <button
                      type="button"
                      className="bulk-chip"
                      onClick={() => handleBulkNudge(-0.1)}
                      title="Nudge -100ms"
                    >
                      -100ms
                    </button>
                    <button
                      type="button"
                      className="bulk-chip"
                      onClick={() => handleBulkNudge(0.1)}
                      title="Nudge +100ms"
                    >
                      +100ms
                    </button>
                    <button
                      type="button"
                      className="bulk-chip"
                      onClick={() => handleBulkNudge(1 / config.frameRate)}
                      title="Nudge +1 frame"
                    >
                      +1f
                    </button>
                    <button
                      type="button"
                      className="bulk-chip"
                      onClick={() => handleBulkNudge(5 / config.frameRate)}
                      title="Nudge +5 frames"
                    >
                      +5f
                    </button>
                  </div>

                  <div className="bulk-action-group">
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Category:</span>
                    <select
                      className="bulk-input"
                      style={{ width: '85px' }}
                      onChange={(e) => {
                        if (e.target.value) {
                          handleBulkCategory(e.target.value as MarkerCategory);
                          e.target.value = '';
                        }
                      }}
                      defaultValue=""
                    >
                      <option value="" disabled>Change...</option>
                      <option value="Structure">Structure</option>
                      <option value="Hit">Hit</option>
                      <option value="Effect">Effect</option>
                      <option value="Note">Note</option>
                      <option value="Custom">Custom</option>
                    </select>

                    <button
                      type="button"
                      className="bulk-chip"
                      onClick={() => handleBulkExportEnabled(true)}
                      title="Enable export for all selected markers"
                    >
                      Enable
                    </button>
                    <button
                      type="button"
                      className="bulk-chip"
                      onClick={() => handleBulkExportEnabled(false)}
                      title="Disable export for all selected markers"
                    >
                      Disable
                    </button>

                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={handleBulkDelete}
                      title="Delete all selected markers"
                    >
                      <Trash2 size={12} />
                      Delete ({selectedMarkerIds.size})
                    </button>

                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={handleClearMarkerSelection}
                      title="Clear selection"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}

<details className="disclosure marker-tools"><summary>Selection & marker tools</summary>              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '0.75rem',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Select:</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={handleSelectAllMarkers}
                    title="Select all markers"
                  >
                    All ({markers.length})
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={handleInvertMarkerSelection}
                    title="Invert current selection"
                  >
                    Invert
                  </button>
                  {selectedMarkerIds.size > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={handleClearMarkerSelection}
                      title="Deselect all"
                    >
                      Clear
                    </button>
                  )}
                  <select
                    className="tempo-select"
                    style={{ fontSize: '0.72rem', padding: '0.15rem 0.4rem' }}
                    onChange={(e) => {
                      if (e.target.value) {
                        handleSelectByCategory(e.target.value as MarkerCategory);
                        e.target.value = '';
                      }
                    }}
                    defaultValue=""
                    title="Select all markers in category"
                  >
                    <option value="" disabled>By Category...</option>
                    <option value="Structure">Structure</option>
                    <option value="Hit">Hit</option>
                    <option value="Effect">Effect</option>
                    <option value="Note">Note</option>
                    <option value="Custom">Custom</option>
                  </select>
                </div>

                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  {(['Structure', 'Hit', 'Effect', 'Note'] as MarkerCategory[]).map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      className="btn btn-sm"
                      onClick={() => addManualMarkerAtPlayhead(cat)}
                    >
                      <Plus size={13} />+ {cat}
                    </button>
                  ))}
                </div>
              </div>

</details>
              <button type="button" className="detail-toggle" aria-pressed={showMarkerDetails} onClick={() => setShowMarkerDetails((value) => !value)}>{showMarkerDetails ? "Hide technical columns" : "Show technical columns"}</button>
              <div
                tabIndex={0}
                role="region"
                aria-labelledby="marker-editor-table-caption"
                className={`table-wrapper marker-table ${showMarkerDetails ? "" : "marker-table-simple"}`}
              >
                <table className="cue-table">
                  <caption id="marker-editor-table-caption">
                    Chronological Marker and grandMA3 Cue Editor
                  </caption>
                  <thead>
                    <tr>
                      <th style={{ width: '38px', textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={markers.length > 0 && selectedMarkerIds.size === markers.length}
                          onChange={(e) => {
                            if (e.target.checked) handleSelectAllMarkers();
                            else handleClearMarkerSelection();
                          }}
                          title="Select / Deselect all markers"
                        />
                      </th>
                      <th>Cue #</th>
                      <th>Export</th>
                      <th>Marker</th>
                      <th>Category</th>
                      <th>Time (s)</th>
                      <th>Final Relative / Absolute SMPTE</th>
                      <th>Cue Fade / Delay (s)</th>
                      <th>MA3 Event Target</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedMarkers.map((marker) => {
                      const compiled = compiledByMarkerId.get(marker.id);
                      return (
                        <tr
                          key={marker.id}
                          className={`${marker.exportEnabled ? '' : 'row-disabled'} ${selectedMarkerIds.has(marker.id) ? 'row-selected' : ''}`}
                        >
                          <td style={{ textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={selectedMarkerIds.has(marker.id)}
                              onChange={() => toggleMarkerSelection(marker.id)}
                              title={`Select marker ${marker.label}`}
                            />
                          </td>
                          <th scope="row" className="mono">
                            {compiled ? `Cue ${compiled.cueNumber}` : '— (Off)'}
                          </th>
                          <td>
                            <input
                              type="checkbox"
                              checked={marker.exportEnabled}
                              onChange={(e) =>
                                updateMarker(marker.id, {
                                  exportEnabled: e.target.checked,
                                })
                              }
                              title="Explicitly enable or disable export for this marker"
                            />
                          </td>
                          <td>
                            <input
                              type="text"
                              value={marker.label}
                              onChange={(e) =>
                                updateMarker(marker.id, { label: e.target.value })
                              }
                              style={{ minWidth: '170px' }}
                            />
                          </td>
                          <td>
                            <select
                              value={marker.category}
                              onChange={(e) =>
                                updateMarker(marker.id, {
                                  category: e.target.value as MarkerCategory,
                                })
                              }
                              style={{ width: '115px' }}
                            >
                              <option value="Structure">Structure</option>
                              <option value="Hit">Hit</option>
                              <option value="Effect">Effect</option>
                              <option value="Note">Note</option>
                              <option value="Custom">Custom</option>
                            </select>
                          </td>
                          <td>
                            <input
                              type="number"
                              step={0.01}
                              min={0}
                              max={config.songDurationSeconds}
                              className="mono"
                              value={marker.timestampSeconds}
                              onChange={(e) =>
                                updateMarker(marker.id, {
                                  timestampSeconds: clampMarkerTime(
                                    Number(e.target.value || 0),
                                    config.songDurationSeconds
                                  ),
                                })
                              }
                              style={{ width: '92px' }}
                            />
                          </td>
                          <td className="mono">
                            {compiled ? (
                              <div>
                                <div style={{ color: 'var(--accent-cyan)', fontSize: '0.75rem' }}>
                                  Rel: {compiled.relativeTime}
                                </div>
                                <div style={{ color: 'var(--accent-ma3)', fontWeight: 700 }}>
                                  ABS: {compiled.absoluteSmpte}
                                </div>
                              </div>
                            ) : (
                              <span style={{ color: 'var(--text-muted)' }}>Excluded by user</span>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                              <input
                                type="number"
                                step={0.1}
                                min={0}
                                value={marker.fadeInSeconds}
                                onChange={(e) =>
                                  updateMarker(marker.id, {
                                    fadeInSeconds: Math.max(0, Number(e.target.value || 0)),
                                  })
                                }
                                title="Cue Fade In (seconds)"
                                style={{ width: '64px' }}
                              />
                              <span style={{ color: 'var(--text-muted)' }}>/</span>
                              <input
                                type="number"
                                step={0.1}
                                min={0}
                                value={marker.delaySeconds}
                                onChange={(e) =>
                                  updateMarker(marker.id, {
                                    delaySeconds: Math.max(0, Number(e.target.value || 0)),
                                  })
                                }
                                title="Cue Delay (seconds)"
                                style={{ width: '64px' }}
                              />
                            </div>
                          </td>
                          <td className="mono" style={{ fontSize: '0.75rem' }}>
                            {compiled ? (
                              <span>
                                Ev#{compiled.eventIndex}{' '}
                                <strong style={{ color: '#f59e0b' }}>{compiled.token}</strong> → Seq{' '}
                                {config.sequenceId} Cue {compiled.cueNumber}
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: '0.35rem' }}>
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => seekPlayheadTo(marker.timestampSeconds, true)}
                                title="Jump playhead to marker"
                              >
                                <Play size={12} />
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-danger"
                                onClick={() => deleteMarker(marker.id)}
                                title="Delete marker"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB: MULTI-STEM TRACKS & MIXER */}
          {activeTab === 'stems' && (
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '1rem',
                  flexWrap: 'wrap',
                  gap: '0.75rem',
                }}
              >
                <div>
                  <h3
                    style={{
                      fontSize: '1.05rem',
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                    }}
                  >
                    <Layers size={18} color="#38bdf8" />
                    Track mixer
                  </h3>
                  <p
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--text-secondary)',
                      marginTop: '0.2rem',
                    }}
                  >
                    Balance your stems with mute, solo and volume. Review detected sections in Analysis before adding them to the timeline.
                  </p>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <label
                    className="btn btn-sm btn-accent"
                    style={{ cursor: 'pointer' }}
                  >
                    <Plus size={14} />
                    Add More Stems
                    <input
                      type="file"
                      multiple
                      accept="audio/*"
                      onChange={handleStemUpload}
                      style={{ display: 'none' }}
                    />
                  </label>

                  {stems.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={handlePromoteAllStemCandidates}
                        title="Convert all unconfirmed stem transient candidates into confirmed 1:1:1 cues"
                        disabled={isAnalyzingStems || stems.every((s) => s.candidates.length === 0)}
                      >
                        <Sparkles size={14} color="#f59e0b" />
                        Promote All Transients to Cues ({stems.reduce((acc, s) => acc + s.candidates.length, 0)})
                      </button>

                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setActiveTab('candidate-shelf')}
                      >
                        Review in Candidate Shelf ({stagedCandidates.length})
                      </button>

                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setStems([])}
                        title="Remove all loaded stems"
                      >
                        <Trash2 size={14} />
                        Clear Stems
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Informational callout regarding the 1:1:1 invariant */}
              <div
                style={{
                  padding: '0.75rem 1rem',
                  background: 'rgba(56, 189, 248, 0.08)',
                  border: '1px solid rgba(56, 189, 248, 0.25)',
                  borderRadius: '8px',
                  marginBottom: '1rem',
                  fontSize: '0.78rem',
                  color: '#bae6fd',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.65rem',
                }}
              >
                <ShieldCheck size={18} color="#38bdf8" />
                <span>
                  <strong>1:1:1 Core Invariant Guaranteed:</strong> Detected stem transients remain isolated in staging and will never generate grandMA3 cues or timecode events until you explicitly promote them.
                </span>
              </div>

              {/* Stem Tracks List */}
              {stems.length === 0 ? (
                <div
                  style={{
                    padding: '3rem 1.5rem',
                    textAlign: 'center',
                    background: 'var(--bg-panel)',
                    border: '1px dashed var(--border-subtle)',
                    borderRadius: '10px',
                  }}
                >
                  <Layers
                    size={42}
                    color="var(--text-muted)"
                    style={{ margin: '0 auto 1rem', display: 'block' }}
                  />
                  <h4
                    style={{
                      fontSize: '1rem',
                      fontWeight: 600,
                      color: 'var(--text-primary)',
                      marginBottom: '0.5rem',
                    }}
                  >
                    No Multi-Track Stems Loaded Yet
                  </h4>
                  <p
                    style={{
                      fontSize: '0.82rem',
                      color: 'var(--text-secondary)',
                      maxWidth: '560px',
                      margin: '0 auto 1.5rem',
                      lineHeight: 1.5,
                    }}
                  >
                    Load individual audio stems (e.g. <code>Drums.wav</code>, <code>Bass.wav</code>, <code>Vocals.wav</code>, <code>Synths.wav</code>).
                    CueForge will automatically infer their instrument type, isolate kick/snare transients from vocal sibilance, and let you preview and mix them in real-time.
                  </p>
                  <label
                    className="btn btn-accent"
                    style={{ cursor: 'pointer', display: 'inline-flex', padding: '0.65rem 1.25rem' }}
                  >
                    <Plus size={16} />
                    Upload Multi-Stem Files (WAV / MP3 / FLAC)
                    <input
                      type="file"
                      multiple
                      accept="audio/*"
                      onChange={handleStemUpload}
                      style={{ display: 'none' }}
                    />
                  </label>
                </div>
              ) : (
                <div className="stem-mixer-container">
                  {stems.map((stem) => (
                    <div key={stem.id} className="stem-card">
                      <div className="stem-card-header">
                        <div className="stem-identity">
                          <div
                            className="stem-color-pill"
                            style={{ backgroundColor: stem.color }}
                          />
                          <div>
                            <span className="stem-name">{stem.name}</span>
                            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginTop: '0.2rem' }}>
                              <select
                                value={stem.stemType}
                                disabled={isAnalyzingStems}
                                onChange={(e) => handleStemTypeChange(stem.id, e.target.value as StemType)}
                                style={{
                                  fontSize: '0.72rem',
                                  padding: '0.15rem 0.4rem',
                                  borderRadius: '4px',
                                  background: 'var(--bg-input)',
                                  color: stem.color,
                                  border: `1px solid ${stem.color}66`,
                                  fontWeight: 600,
                                }}
                              >
                                <option value="drums">Drums (Hit)</option>
                                <option value="bass">Bass (Hit)</option>
                                <option value="vocals">Vocals (Structure)</option>
                                <option value="other">Other / Synths (Effect)</option>
                                <option value="custom">Custom (Custom)</option>
                              </select>

                              <span
                                style={{
                                  fontSize: '0.72rem',
                                  color: 'var(--text-muted)',
                                }}
                              >
                                {stem.durationSeconds.toFixed(1)}s · {stem.candidates.length} pending · {analysisMode === 'structure' ? 'Used in combined section analysis' : STEM_ANALYSIS_LABELS[stem.stemType]}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="stem-actions-strip">
                          <button
                            type="button"
                            className={`stem-btn-mute ${stem.muted ? 'active' : ''}`}
                            onClick={() => handleToggleStemMute(stem.id)}
                            title={stem.muted ? 'Unmute Stem' : 'Mute Stem'}
                          >
                            M
                          </button>

                          <button
                            type="button"
                            className={`stem-btn-solo ${stem.solo ? 'active' : ''}`}
                            onClick={() => handleToggleStemSolo(stem.id)}
                            title={stem.solo ? 'Unsolo Stem' : 'Solo Stem'}
                          >
                            S
                          </button>

                          <div className="stem-vol-slider" title={`Volume: ${Math.round(stem.volume * 100)}%`}>
                            <span>Vol</span>
                            <input
                              type="range"
                              min="0"
                              max="1"
                              step="0.05"
                              value={stem.volume}
                              onChange={(e) => handleStemVolumeChange(stem.id, parseFloat(e.target.value))}
                            />
                            <span style={{ width: '30px', textAlign: 'right' }}>
                              {Math.round(stem.volume * 100)}%
                            </span>
                          </div>

                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => handlePromoteStemCandidates(stem.id)}
                            disabled={isAnalyzingStems || stem.candidates.length === 0}
                            title={`Promote ${stem.candidates.length} transients directly to confirmed MA3 cues (1:1:1 invariant)`}
                            style={{
                              borderColor: `${stem.color}66`,
                              color: stem.color,
                            }}
                          >
                            <Sparkles size={12} />
                            Promote to Cues ({stem.candidates.length})
                          </button>

                          <button
                            type="button"
                            className="btn btn-sm btn-icon"
                            disabled={isAnalyzingStems}
                            onClick={() => handleRemoveStem(stem.id)}
                            title="Remove Stem"
                            style={{ color: 'var(--accent-red)' }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      {/* Mini Stem Waveform */}
                      <StemCanvasWaveform
                        peaks={stem.waveformPeaks}
                        color={stem.color}
                        playheadFraction={
                          config.songDurationSeconds > 0
                            ? playheadSeconds / config.songDurationSeconds
                            : 0
                        }
                        onSeekFraction={(frac) =>
                          seekPlayheadTo(frac * config.songDurationSeconds, true)
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 1.5: MULTI-BAND TRANSIENT CANDIDATE SHELF */}
          {activeTab === 'candidate-shelf' && (
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '0.85rem',
                  flexWrap: 'wrap',
                  gap: '0.75rem',
                  padding: '0.75rem 1rem',
                  background: 'var(--bg-panel-elevated)',
                  borderRadius: '8px',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', maxWidth: '680px' }}>
                  Structure groups repeated hits and suggests builds, drops and section changes. Accents finds individual attacks. Section times are approximate, based on the current tempo and meter; review before confirming.
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    Sensitivity:
                    <input
                      type="range"
                      min={0.2}
                      max={0.9}
                      step={0.05}
                      value={analysisSensitivity}
                      onChange={(e) => setAnalysisSensitivity(Number(e.target.value))}
                      style={{ width: '80px' }}
                    />
                    <span className="mono">{Math.round(analysisSensitivity * 100)}%</span>
                  </label>
<label className="field-label">Detection mode<select aria-label="Detection mode" value={analysisMode} disabled={isAnalyzingStems} onChange={(e) => {
                    const mode = e.target.value as AnalysisMode; setAnalysisMode(mode);
                    if (stems.length || playbackBlob.current) void handleReanalyzeStems(mode);
                  }}><option value="structure">Structure · sections</option><option value="accents">Accents · individual hits</option></select></label>
<button className="btn btn-sm" disabled={isAnalyzingStems || (stems.length === 0 && !playbackBlob.current)} onClick={() => void handleReanalyzeStems()}>{isAnalyzingStems ? 'Analyzing…' : 'Analyze again'}</button>
                  {analysisMode === 'accents' && <select aria-label="Candidate source" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} style={{ width: '160px' }}><option value="all">All sources</option>{stems.map((stem) => <option key={stem.id} value={stem.id}>{stem.name}</option>)}</select>}
                  <span role="status">{analysisMessage || (analysisMode === 'structure' && stagedCandidates.some((candidate) => candidate.eventKind !== 'section') ? 'These are previous accent results. Analyze again for section suggestions.' : '')}</span>
                  {analysisMode === 'structure' && <small className="analysis-meter">{bpm} BPM · {timeSignature.beats}/{timeSignature.unit} · adjust in Timeline tools</small>}
                  {analysisMode === 'accents' && <><span style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>Band:</span>
                  {(['all', 'low', 'mid', 'high', 'full'] as const).map((b) => (
                    <button
                      key={b}
                      type="button"
                      className={`btn btn-sm ${bandFilter === b ? 'btn-primary' : ''}`}
                      onClick={() => setBandFilter(b)}
                    >
                      {b.toUpperCase()}
                    </button>
                  ))}</>}
                  {stagedCandidates.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => {
                        const toAdd = stagedCandidates
                          .filter((c) => (bandFilter === 'all' || c.band === bandFilter) && (sourceFilter === 'all' || c.sourceStemId === sourceFilter))
                          .map((c) => promoteCandidateToMarker(c));
                        setMarkers((prev) => [...prev, ...toAdd]);
                        removeCandidates(new Set(stagedCandidates.filter((c) => (bandFilter === 'all' || c.band === bandFilter) && (sourceFilter === 'all' || c.sourceStemId === sourceFilter)).map((c) => c.id)));
                        setActiveTab('markers');
                      }}
                      disabled={isAnalyzingStems}
                      title="Confirm all visible candidates into markers"
                    >
                      Confirm All Visible ({stagedCandidates.filter((c) => (bandFilter === 'all' || c.band === bandFilter) && (sourceFilter === 'all' || c.sourceStemId === sourceFilter)).length})
                    </button>
                  )}
                </div>
              </div>

              {stagedCandidates.length === 0 ? (
                <div
                  style={{
                    padding: '2.5rem 1rem',
                    textAlign: 'center',
                    background: 'var(--bg-input)',
                    borderRadius: '8px',
                    border: '1px dashed var(--border-subtle)',
                    color: 'var(--text-secondary)',
                    fontSize: '0.85rem',
                  }}
                >
                  <Sparkles size={28} color="#f59e0b" style={{ margin: '0 auto 0.5rem' }} />
                  <div>{stems.length || playbackBlob.current ? 'No pending suggestions for this analysis.' : 'Add audio or stems to begin.'}</div>
                  <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                    Structure looks for sustained section changes. Use Accents when you need individual hits. Confirmed markers are kept when you analyze again.
                  </div>
                </div>
              ) : (
                <div
                  tabIndex={0}
                  role="region"
                  aria-labelledby="candidates-table-caption"
                  className="table-wrapper"
                >
                  <table className="cue-table">
                    <caption id="candidates-table-caption">
                      Staged Multi-Band Transient Candidates
                    </caption>
                    <thead>
                      <tr>
                        <th>Band</th>
                        <th>Suggested Marker / Cue Label</th>
                        <th>Timestamp (s)</th>
                        <th>Category</th>
                        <th>Signal strength</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stagedCandidates
                        .filter((c) => bandFilter === 'all' || c.band === bandFilter)
                        .map((candidate) => (
                          <tr key={candidate.id}>
                            <th scope="row" className="mono">
                              <span
                                className="cat-badge"
                                style={{
                                  background:
                                    candidate.band === 'low'
                                      ? 'rgba(239, 68, 68, 0.2)'
                                      : candidate.band === 'mid'
                                      ? 'rgba(59, 130, 246, 0.2)'
                                      : 'rgba(168, 85, 247, 0.2)',
                                  color:
                                    candidate.band === 'low'
                                      ? '#fca5a5'
                                      : candidate.band === 'mid'
                                      ? '#93c5fd'
                                      : '#d8b4fe',
                                }}
                              >
                                {candidate.eventKind === 'section' ? 'SECTION' : candidate.band.toUpperCase()}
                              </span>
                            </th>
                            <td style={{ fontWeight: 600 }}>{candidate.suggestedLabel}{candidate.explanation && <div className="candidate-explanation">{candidate.explanation}</div>}</td>
                            <td className="mono">{candidate.timestampSeconds.toFixed(3)}s</td>
                            <td>
                              <span className={`cat-badge cat-${candidate.suggestedCategory}`}>
                                {candidate.suggestedCategory}
                              </span>
                            </td>
                            <td className="mono">{(candidate.energyScore * 100).toFixed(0)}%</td>
                            <td>
                              <div style={{ display: 'flex', gap: '0.35rem' }}>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-primary"
                                  onClick={() => {
                                    const promoted = promoteCandidateToMarker(candidate);
                                    setMarkers((prev) => [...prev, promoted]);
                                    removeCandidates(new Set([candidate.id]));
                                  }}
                                  disabled={isAnalyzingStems}
                                  title="Confirm candidate as marker"
                                >
                                  <CheckCircle2 size={13} />
                                  Confirm (+1 Cue & Event)
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  onClick={() => seekPlayheadTo(candidate.timestampSeconds, true)}
                                  title="Preview playhead at timestamp"
                                >
                                  <Play size={12} />
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-danger"
                                  onClick={() =>
                                    removeCandidates(new Set([candidate.id]))
                                  }
                                  disabled={isAnalyzingStems}
                                  title="Dismiss candidate"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: SEQUENCE & TIMECODE SYNCHRONIZED PREVIEW */}
          {activeTab === 'sequence-preview' && (
            <div>
              <div
                style={{
                  marginBottom: '0.8rem',
                  padding: '0.75rem 1rem',
                  borderRadius: '8px',
                  background: 'var(--bg-panel-elevated)',
                  border: '1px solid var(--border-subtle)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '0.75rem',
                  fontSize: '0.8rem',
                }}
              >
                <div>
                  <strong>Target Sequence:</strong> Sequence {config.sequenceId} ("{config.sequenceName}") —{' '}
                  {compiledShow.cues.length} Placeholder Cues (TrigType = <code>Go</code>)
                </div>
                <div>
                  <strong>Target Timecode Show:</strong> Timecode {config.timecodeId} ("{config.timecodeName}") —{' '}
                  TrackGroup 1 → Track 1 → CmdSubTrack ({compiledShow.events.length} Events)
                </div>
              </div>

              <div
                tabIndex={0}
                role="region"
                aria-labelledby="preview-table-caption"
                className="table-wrapper"
              >
                <table className="cue-table">
                  <caption id="preview-table-caption">
                    Synchronized grandMA3 Sequence Cues and Timecode Events Preview
                  </caption>
                  <thead>
                    <tr>
                      <th>Cue #</th>
                      <th>Cue Name (Marker Label)</th>
                      <th>Category</th>
                      <th>TrigType</th>
                      <th>CueFade / Delay</th>
                      <th>TC Event #</th>
                      <th>Token & Explicit Destination</th>
                      <th>Relative Time</th>
                      <th>Final Absolute SMPTE ({config.frameRate} fps)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compiledShow.cues.map((cue, idx) => {
                      const ev = compiledShow.events[idx];
                      return (
                        <tr key={cue.sourceMarkerId}>
                          <th scope="row" className="mono">
                            Cue {cue.cueNumber}
                          </th>
                          <td style={{ fontWeight: 600 }}>{cue.name}</td>
                          <td>
                            <span className={`cat-badge cat-${cue.category}`}>
                              {cue.category}
                            </span>
                          </td>
                          <td className="mono" style={{ color: '#10b981', fontWeight: 700 }}>
                            {cue.trigType}
                          </td>
                          <td className="mono">
                            Fade: {cue.cueFadeOut !== undefined ? `${cue.cueFadeIn}/${cue.cueFadeOut}s` : `${cue.cueFadeIn}s`} | Delay: {cue.cueDelay}s
                          </td>
                          <td className="mono">Event #{ev.eventIndex}</td>
                          <td className="mono">
                            <span style={{ color: '#f59e0b', fontWeight: 700 }}>{ev.token}</span>{' '}
                            Seq {ev.targetSequenceId} Cue {ev.cueDestinationNumber} ("{ev.cueDestinationName}")
                          </td>
                          <td className="mono" style={{ color: 'var(--accent-cyan)' }}>
                            {ev.timing.formattedRelative} (F#{ev.timing.relativeFrames})
                          </td>
                          <td className="mono" style={{ color: 'var(--accent-ma3)', fontWeight: 700 }}>
                            {ev.timing.formattedAbsoluteSmpte} ({ev.timing.formattedMa3Time})
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 3: EXPORT VALIDATION & MA3 2.5.X MACRO GENERATOR */}
          {activeTab === 'validation-export' && (
            <div>
              <div className="validation-grid">
                {validationReport.checks.map((chk) => (
                  <div
                    key={chk.id}
                    className={`validation-item ${chk.passed ? 'passed' : 'failed'}`}
                  >
                    {chk.passed ? (
                      <CheckCircle2 size={18} color="#10b981" style={{ flexShrink: 0, marginTop: 2 }} />
                    ) : (
                      <AlertTriangle size={18} color="#ef4444" style={{ flexShrink: 0, marginTop: 2 }} />
                    )}
                    <div>
                      <div style={{ fontSize: '0.82rem', fontWeight: 700 }}>{chk.title}</div>
                      <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                        {chk.details}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {exportBundle ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {/* Production Show Export Bundles Card */}
                  <div
                    style={{
                      padding: '1rem 1.25rem',
                      background: 'var(--bg-panel-elevated)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: '8px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.75rem',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '0.75rem',
                      }}
                    >
                      <div>
                        <h3
                          style={{
                            fontSize: '0.98rem',
                            fontWeight: 700,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.45rem',
                          }}
                        >
                          <Archive size={17} color="#fbbf24" />
                          grandMA3 USB & SMPTE LTC Audio Production Packages
                        </h3>
                        <p
                          style={{
                            fontSize: '0.78rem',
                            color: 'var(--text-secondary)',
                            marginTop: '0.2rem',
                          }}
                        >
                          Download the complete ZIP structure ready for USB thumb drives, or synthesize a linear timecode WAV audio track.
                        </p>
                      </div>

                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn btn-accent"
                          disabled={!exportBundle || isExportingZip}
                          onClick={handleExportUsbZip}
                          title="Package Macro XML, Timecode XML, Appearances, and Scripts into gma3_library USB format"
                        >
                          <Archive size={15} />
                          {isExportingZip ? 'Building ZIP...' : 'Download grandMA3 USB ZIP (.zip)'}
                        </button>

                        <button
                          type="button"
                          className="btn"
                          disabled={isGeneratingLtc}
                          onClick={handleDownloadLtcWav}
                          title="Generate SMPTE 12M audio LTC timecode file matching song duration and frame rate"
                        >
                          <Radio size={15} color="#06b6d4" />
                          {isGeneratingLtc ? 'Generating...' : `Download LTC Audio WAV (${config.frameRate} fps)`}
                        </button>

                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            if (exportBundle) {
                              downloadFile(
                                exportBundle.macroXml,
                                `${exportBundle.macroName}_grandMA3_2.5.xml`
                              );
                            }
                          }}
                        >
                          <Download size={14} />
                          Macro XML
                        </button>

                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            if (exportBundle) {
                              downloadFile(
                                exportBundle.timecodeXml,
                                `${config.timecodeName}_Timecode_2.5.xml`
                              );
                            }
                          }}
                        >
                          <FileCode size={14} />
                          Timecode XML
                        </button>
                      </div>
                    </div>
                  </div>
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '0.45rem',
                        flexWrap: 'wrap',
                        gap: '0.5rem',
                      }}
                    >
                      <h3 style={{ fontSize: '0.88rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <Code2 size={16} color="#f59e0b" />
                        grandMA3 2.5.x Macro XML (<code>{exportBundle.macroName}.xml</code> — {exportBundle.macroLines.length} MacroLines)
                      </h3>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => copyToClipboard(exportBundle.macroXml, 'macroXml')}
                        >
                          <Copy size={13} />
                          {copiedType === 'macroXml' ? 'Copied XML!' : 'Copy Macro XML'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() =>
                            copyToClipboard(exportBundle.macroCommandText, 'cmdText')
                          }
                        >
                          <Copy size={13} />
                          {copiedType === 'cmdText' ? 'Copied Commands!' : 'Copy Plain Commands'}
                        </button>
                      </div>
                    </div>
                    <pre className="code-preview">{exportBundle.macroXml}</pre>
                  </div>

                  <div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '0.45rem',
                      }}
                    >
                      <h3 style={{ fontSize: '0.88rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <FileCode size={16} color="#06b6d4" />
                        Direct grandMA3 2.5.x Timecode Pool XML (<code>{config.timecodeName}_Timecode_2.5.xml</code>)
                      </h3>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => copyToClipboard(exportBundle.timecodeXml, 'tcXml')}
                      >
                        <Copy size={13} />
                        {copiedType === 'tcXml' ? 'Copied Timecode XML!' : 'Copy Timecode XML'}
                      </button>
                    </div>
                    <pre className="code-preview">{exportBundle.timecodeXml}</pre>
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    padding: '1rem',
                    borderRadius: '8px',
                    background: 'rgba(239, 68, 68, 0.12)',
                    border: '1px solid rgba(239, 68, 68, 0.4)',
                    color: '#fca5a5',
                    fontSize: '0.85rem',
                  }}
                >
                  <strong>Macro Generation Blocked by Validation Errors:</strong>
                  <ul style={{ marginLeft: '1.25rem', marginTop: '0.4rem' }}>
                    {validationReport.errors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* TAB 4: UNCONFIRMED BEAT GRID REFERENCE */}
          {activeTab === 'beat-grid' && (
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '0.85rem',
                  flexWrap: 'wrap',
                  gap: '0.75rem',
                  padding: '0.75rem 1rem',
                  background: 'var(--bg-panel-elevated)',
                  borderRadius: '8px',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', maxWidth: '680px' }}>
                  <strong style={{ color: 'var(--text-primary)' }}>
                    Mandatory Rule — Beat Grids Are Never Auto-Exported:
                  </strong>{' '}
                  These {beatGrid.length} beat grid points are generated at {bpm} BPM ({timeSignature.beats}/{timeSignature.unit}) for visual alignment only and produce <strong>0 cues</strong> unless you explicitly promote a beat into a confirmed Marker.
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Grid BPM:</span>
                  <input
                    type="number"
                    min={30}
                    max={300}
                    value={bpm}
                    onChange={(e) => handleBpmChange(Number(e.target.value))}
                    style={{ width: '70px' }}
                  />
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Time Sig:</span>
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={timeSignature.beats}
                    onChange={(e) => handleTimeSignatureChange(Number(e.target.value), timeSignature.unit)}
                    style={{ width: '50px' }}
                  />
                  <span>/</span>
                  <select
                    value={timeSignature.unit}
                    onChange={(e) => handleTimeSignatureChange(timeSignature.beats, Number(e.target.value))}
                    style={{ padding: '0.2rem' }}
                  >
                    <option value={4}>4</option>
                    <option value={8}>8</option>
                  </select>
                </div>
              </div>

              <div
                tabIndex={0}
                role="region"
                aria-labelledby="beatgrid-table-caption"
                className="table-wrapper"
              >
                <table className="cue-table">
                  <caption id="beatgrid-table-caption">
                    Unconfirmed Musical Beat Grid Points
                  </caption>
                  <thead>
                    <tr>
                      <th>Bar . Beat</th>
                      <th>Audio Timestamp (s)</th>
                      <th>SMPTE Preview</th>
                      <th>Export Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {beatGrid.slice(0, 64).map((gp) => {
                      const smpte = computeTimecodeTimestamp(
                        gp.timestampSeconds,
                        config.frameRate,
                        config.timecodeOffsetSeconds,
                        config.latencyCompensationMs
                      );
                      return (
                        <tr key={gp.id}>
                          <th scope="row" className="mono">
                            Bar {gp.bar} . {gp.beat}
                          </th>
                          <td className="mono">{gp.timestampSeconds.toFixed(3)}s</td>
                          <td className="mono">{smpte.formattedAbsoluteSmpte}</td>
                          <td>
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                              Not a Marker (Excluded from Cues & Timecode)
                            </span>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => handlePromoteBeatGridPoint(gp)}
                            >
                              <Sparkles size={13} color="#f59e0b" />
                              Confirm as Marker (+1 Cue & +1 Event)
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </main>
        <details className="isolated-panel disclosure show-settings" aria-label="grandMA3 Export and Sync Settings">
<summary>Show settings & export files <span>grandMA3, timecode & advanced options</span></summary><div className="disclosure-content">
          <div className="form-stack">
            <label className="field-label">
              Song / Show Identifier
              <input
                type="text"
                value={config.songTitle}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    songTitle: e.target.value,
                  }))
                }
              />
            </label>

            <div className="form-row-2">
              <label className="field-label">
                MA3 Sequence ID
                <input
                  type="number"
                  min={1}
                  value={config.sequenceId}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      sequenceId: Math.max(1, parseInt(e.target.value || '1', 10)),
                    }))
                  }
                />
              </label>
              <label className="field-label">
                Sequence Name
                <input
                  type="text"
                  value={config.sequenceName}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, sequenceName: e.target.value }))
                  }
                />
              </label>
            </div>

            <div className="form-row-2">
              <label className="field-label">
                MA3 Timecode ID
                <input
                  type="number"
                  min={1}
                  value={config.timecodeId}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      timecodeId: Math.max(1, parseInt(e.target.value || '1', 10)),
                    }))
                  }
                />
              </label>
              <label className="field-label">
                Timecode Show Name
                <input
                  type="text"
                  value={config.timecodeName}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, timecodeName: e.target.value }))
                  }
                />
              </label>
            </div>

            <div className="form-row-2">
              <label className="field-label">
                Target Macro Pool ID
                <input
                  type="number"
                  min={1}
                  value={config.macroId}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      macroId: Math.max(1, parseInt(e.target.value || '1', 10)),
                    }))
                  }
                />
              </label>
              <label className="field-label">
                Frame Rate (SMPTE)
                <select
                  value={config.frameRate}
                  onChange={(e) => {
                    const fps = Number(e.target.value) as TimecodeFrameRate;
                    setConfig((prev) => ({ ...prev, frameRate: fps }));
                    setSmpteOffsetInput(
                      formatSecondsToSmpte(config.timecodeOffsetSeconds, fps)
                    );
                  }}
                >
                  <option value={24}>24 fps (Film)</option>
                  <option value={25}>25 fps (PAL / Europe)</option>
                  <option value={29.97}>29.97 fps (NTSC Drop)</option>
                  <option value={30}>30 fps (SMPTE Non-Drop)</option>
                </select>
              </label>
            </div>

            <label className="field-label">
              Timecode Start Offset (HH:MM:SS:FF)
              <input
                type="text"
                className="mono"
                value={smpteOffsetInput}
                onChange={(e) => {
                  const val = e.target.value;
                  setSmpteOffsetInput(val);
                  const parsedSec = parseSmpteOffsetToSeconds(val, config.frameRate);
                  setConfig((prev) => ({ ...prev, timecodeOffsetSeconds: parsedSec }));
                }}
              />
              <span className="field-hint">
                Offset in seconds: {config.timecodeOffsetSeconds.toFixed(3)}s (No unconfigured offset added)
              </span>
            </label>

            <div className="form-row-2">
              <label className="field-label">
                Latency Comp. (ms)
                <input
                  type="number"
                  step={5}
                  value={config.latencyCompensationMs}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      latencyCompensationMs: Number(e.target.value || 0),
                    }))
                  }
                />
                <span className="field-hint">Global shift (+/- ms)</span>
              </label>

              <label className="field-label">
                Event Fade Override (s)
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  placeholder="Use Cue Fade"
                  value={
                    config.globalEventFadeOverrideSeconds !== undefined
                      ? config.globalEventFadeOverrideSeconds
                      : ''
                  }
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    setConfig((prev) => ({
                      ...prev,
                      globalEventFadeOverrideSeconds:
                        raw === '' ? undefined : Math.max(0, Number(raw)),
                    }));
                  }}
                />
                <span className="field-hint">Optional TC override</span>
              </label>
            </div>

            <label className="field-label">
              Timecode Event Execution Mode
              <select
                value={config.executionMode}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    executionMode: e.target.value as TimecodeExecutionMode,
                  }))
                }
              >
                <option value="Go+">Go+ with Explicit CueDestination (Default)</option>
                <option value="Goto(Status)">Goto(Status) — Advanced Status Tracking</option>
              </select>
              <span className="field-hint">
                Target-specific events ensure the right cue triggers even when scrubbing timeline.
              </span>
            </label>

            <div
              style={{
                padding: '0.65rem',
                borderRadius: '8px',
                background: 'var(--bg-panel-elevated)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
              }}
            >
              <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--accent-ma3)' }}>
                grandMA3 2.5.x Show Integration Extras
              </span>

              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={includeCueAppearances}
                  onChange={(e) => setIncludeCueAppearances(e.target.checked)}
                />
                Generate Color-Coded Cue Appearances
              </label>

              {includeCueAppearances && (
                <label className="field-label" style={{ marginTop: '0.15rem' }}>
                  Base Appearance Pool ID
                  <input
                    type="number"
                    min={1}
                    value={baseAppearancePoolId}
                    onChange={(e) =>
                      setBaseAppearancePoolId(Math.max(1, parseInt(e.target.value || '1', 10)))
                    }
                    style={{ width: '100%' }}
                  />
                  <span className="field-hint">
                    Pool IDs {baseAppearancePoolId}..{baseAppearancePoolId + 4} (Structure, Hit, Effect, Note, Custom)
                  </span>
                </label>
              )}

              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={includeMarkerTrack}
                  onChange={(e) => setIncludeMarkerTrack(e.target.checked)}
                />
                Generate Timecode MarkerTrack Visual Ribbons
              </label>
            </div>

            <div
              style={{
                padding: '0.65rem',
                borderRadius: '8px',
                background: config.allowOverwriteExistingObjects
                  ? 'rgba(245, 158, 11, 0.12)'
                  : 'rgba(16, 185, 129, 0.1)',
                border: `1px solid ${
                  config.allowOverwriteExistingObjects
                    ? 'rgba(245, 158, 11, 0.35)'
                    : 'rgba(16, 185, 129, 0.3)'
                }`,
              }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.5rem',
                  fontSize: '0.78rem',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={config.allowOverwriteExistingObjects}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      allowOverwriteExistingObjects: e.target.checked,
                    }))
                  }
                  style={{ marginTop: '0.2rem' }}
                />
                <span>
                  <strong>Authorize Overwrite of Existing MA3 Objects</strong>
                  <div className="field-hint" style={{ marginTop: '0.2rem' }}>
                    When unchecked (default), the macro checks if Sequence {config.sequenceId} or Timecode {config.timecodeId} exists and stops safely without overwriting.
                  </div>
                </span>
              </label>
            </div>

            <button
              type="button"
              className="btn btn-accent"
              disabled={!exportBundle || isExportingZip}
              onClick={handleExportUsbZip}
              style={{ width: '100%', padding: '0.6rem' }}
              title="Package show files into official grandMA3 USB folder structure (gma3_library/datapools/...)"
            >
              <Archive size={16} />
              {isExportingZip ? 'Building ZIP...' : 'Export grandMA3 USB ZIP (.zip)'}
            </button>

            <button
              type="button"
              className="btn"
              disabled={isGeneratingLtc}
              onClick={handleDownloadLtcWav}
              style={{ width: '100%' }}
              title="Synthesize SMPTE 12M 80-bit biphase mark audio LTC WAV file matching song duration and frame rate"
            >
              <Radio size={15} color="#06b6d4" />
              {isGeneratingLtc ? 'Generating LTC...' : `Generate LTC Audio Track (${config.frameRate} fps .wav)`}
            </button>

            <button
              type="button"
              className="btn btn-primary"
              disabled={!exportBundle}
              onClick={() => {
                if (exportBundle) {
                  downloadFile(
                    exportBundle.macroXml,
                    `${exportBundle.macroName}_grandMA3_2.5.xml`
                  );
                }
              }}
              style={{ width: '100%', padding: '0.6rem' }}
            >
              <Download size={16} />
              Export grandMA3 2.5.x Macro (.xml)
            </button>

            <button
              type="button"
              className="btn"
              disabled={!exportBundle}
              onClick={() => {
                if (exportBundle) {
                  downloadFile(
                    exportBundle.timecodeXml,
                    `${config.timecodeName}_Timecode_2.5.xml`
                  );
                }
              }}
              style={{ width: '100%' }}
            >
              <FileCode size={15} />
              Export Direct Timecode Pool XML (.xml)
            </button>
          </div>
        </div></details>
      </div>
    </div>
  );
}
