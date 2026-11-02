import { BeatGridPoint } from '../types/cueforge';

export interface TimelineViewport {
  /** Start of visible window in seconds (>= 0) */
  startSeconds: number;
  /** Duration of visible window in seconds (<= songDurationSeconds) */
  visibleDurationSeconds: number;
  /** Zoom factor (1x = full song, up to 256x) */
  zoomFactor: number;
}

/**
 * Computes a clamped timeline viewport given a zoom factor, center anchor time, and total duration.
 */
export function computeZoomedViewport(
  songDurationSeconds: number,
  targetZoomFactor: number,
  anchorSeconds: number
): TimelineViewport {
  const safeTotal = Math.max(
    1,
    Number.isFinite(songDurationSeconds) ? songDurationSeconds : 1
  );
  const safeZoom = Number.isFinite(targetZoomFactor) ? targetZoomFactor : 1;
  const safeAnchor = Number.isFinite(anchorSeconds) ? anchorSeconds : 0;
  const zoomFactor = Math.max(1, Math.min(256, safeZoom));
  const visibleDurationSeconds = safeTotal / zoomFactor;

  if (zoomFactor === 1) {
    return {
      startSeconds: 0,
      visibleDurationSeconds: safeTotal,
      zoomFactor: 1,
    };
  }

  // Keep anchor centered inside the viewport while clamping to [0, safeTotal - visibleDurationSeconds]
  const halfWindow = visibleDurationSeconds / 2;
  const maxStart = Math.max(0, safeTotal - visibleDurationSeconds);
  const startSeconds = Math.max(0, Math.min(maxStart, safeAnchor - halfWindow));

  return {
    startSeconds: Number(startSeconds.toFixed(4)),
    visibleDurationSeconds: Number(visibleDurationSeconds.toFixed(4)),
    zoomFactor: Number(zoomFactor.toFixed(2)),
  };
}

/**
 * Pans an existing viewport by a delta in seconds, clamping to [0, songDurationSeconds].
 */
export function panViewport(
  viewport: TimelineViewport,
  deltaSeconds: number,
  songDurationSeconds: number
): TimelineViewport {
  const safeTotal = Math.max(
    1,
    Number.isFinite(songDurationSeconds) ? songDurationSeconds : 1
  );
  const safeDelta = Number.isFinite(deltaSeconds) ? deltaSeconds : 0;
  const maxStart = Math.max(0, safeTotal - viewport.visibleDurationSeconds);
  const startSeconds = Math.max(
    0,
    Math.min(maxStart, viewport.startSeconds + safeDelta)
  );
  return {
    ...viewport,
    startSeconds: Number(startSeconds.toFixed(4)),
  };
}

/**
 * Converts a timestamp (seconds) to a percentage [0..100] within the active viewport.
 * Returns null if the timestamp lies outside the visible window.
 */
export function timeToViewportPercent(
  timestampSeconds: number,
  viewport: TimelineViewport
): number | null {
  if (!Number.isFinite(timestampSeconds)) {
    return null;
  }
  const endSeconds = viewport.startSeconds + viewport.visibleDurationSeconds;
  const eps = 1e-4;
  if (timestampSeconds < viewport.startSeconds - eps || timestampSeconds > endSeconds + eps) {
    return null;
  }
  const pct =
    ((timestampSeconds - viewport.startSeconds) /
      Math.max(0.0001, viewport.visibleDurationSeconds)) *
    100;
  return Math.max(0, Math.min(100, pct));
}

/**
 * Clamps a candidate marker or playhead timestamp to [0, songDurationSeconds] with millisecond precision.
 * Shared by pointer drag, playhead scrub, and keyboard arrow-key movement.
 */
export function clampMarkerTime(
  candidateSeconds: number,
  songDurationSeconds: number
): number {
  if (!Number.isFinite(candidateSeconds)) {
    return 0;
  }
  const safeDuration = Math.max(
    0,
    Number.isFinite(songDurationSeconds) ? songDurationSeconds : 0
  );
  return Number(Math.max(0, Math.min(safeDuration, candidateSeconds)).toFixed(3));
}

/**
 * Converts a normalized horizontal pointer ratio [0..1] within the timeline container
 * into an audio timestamp in seconds, clamped to [0, songDurationSeconds].
 */
export function viewportRatioToTime(
  ratio: number,
  viewport: TimelineViewport,
  songDurationSeconds: number
): number {
  const safeRatio = Number.isFinite(ratio) ? ratio : 0;
  const clampedRatio = Math.max(0, Math.min(1, safeRatio));
  const rawTime =
    viewport.startSeconds + clampedRatio * viewport.visibleDurationSeconds;
  return clampMarkerTime(rawTime, songDurationSeconds);
}

/**
 * Snaps a candidate timestamp in seconds to the nearest BeatGridPoint if within `maxSnapDistanceSeconds`.
 * Note: BeatGridPoints remain unconfirmed visual alignment references and are never auto-exported.
 */
export function snapTimeToBeatGrid(
  candidateSeconds: number,
  beatGrid: BeatGridPoint[],
  snapEnabled: boolean,
  songDurationSeconds: number,
  maxSnapDistanceSeconds: number = 0.18
): { timestampSeconds: number; snappedBeat: BeatGridPoint | null } {
  const clamped = clampMarkerTime(candidateSeconds, songDurationSeconds);
  if (!snapEnabled || beatGrid.length === 0) {
    return {
      timestampSeconds: clamped,
      snappedBeat: null,
    };
  }

  let closest: BeatGridPoint | null = null;
  let minDiff = Infinity;

  for (const gp of beatGrid) {
    const diff = Math.abs(gp.timestampSeconds - clamped);
    if (diff < minDiff) {
      minDiff = diff;
      closest = gp;
    }
  }

  if (closest && minDiff <= maxSnapDistanceSeconds) {
    return {
      timestampSeconds: clampMarkerTime(closest.timestampSeconds, songDurationSeconds),
      snappedBeat: closest,
    };
  }

  return {
    timestampSeconds: clamped,
    snappedBeat: null,
  };
}

/**
 * Nudges a marker timestamp by `deltaSeconds` (e.g., via Left/Right arrow keys on a focused marker handle),
 * clamping through `clampMarkerTime` so the marker always stays within [0, songDurationSeconds].
 */
export function nudgeMarkerTimestamp(
  currentSeconds: number,
  deltaSeconds: number,
  songDurationSeconds: number
): number {
  const safeCurrent = Number.isFinite(currentSeconds) ? currentSeconds : 0;
  const safeDelta = Number.isFinite(deltaSeconds) ? deltaSeconds : 0;
  return clampMarkerTime(safeCurrent + safeDelta, songDurationSeconds);
}

/**
 * Ensures a target timestamp (such as a nudged marker or jumped playhead) is visible
 * within the active viewport by panning the minimum required distance.
 */
export function ensureTimeVisibleInViewport(
  viewport: TimelineViewport,
  targetSeconds: number,
  songDurationSeconds: number
): TimelineViewport {
  if (!Number.isFinite(targetSeconds) || viewport.zoomFactor <= 1) {
    return viewport;
  }
  const endSeconds = viewport.startSeconds + viewport.visibleDurationSeconds;
  if (targetSeconds < viewport.startSeconds) {
    return panViewport(
      viewport,
      targetSeconds - viewport.startSeconds,
      songDurationSeconds
    );
  }
  if (targetSeconds > endSeconds) {
    return panViewport(
      viewport,
      targetSeconds - endSeconds,
      songDurationSeconds
    );
  }
  return viewport;
}

/**
 * Determines whether a global keyboard shortcut (such as Space or M) should be ignored
 * because focus is inside an interactive form control, editable element, or is a key-repeat event.
 */
export function shouldIgnoreGlobalShortcut(
  target:
    | {
        tagName?: string;
        isContentEditable?: boolean;
        closest?: (selector: string) => unknown;
      }
    | null
    | undefined,
  keyCode?: string,
  isRepeat: boolean = false
): boolean {
  if (isRepeat) return true;
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  if (typeof target.closest === 'function') {
    if (target.closest('input, textarea, select, [contenteditable="true"]')) {
      return true;
    }
    if (keyCode === 'Space' && target.closest('button, a, summary, [role="button"]')) {
      return true;
    }
  }
  // Allow native button/link activation on Space without double-firing transport toggle
  if (keyCode === 'Space' && (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY')) {
    return true;
  }
  return false;
}

