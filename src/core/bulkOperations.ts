import { Marker, MarkerCategory } from '../types/cueforge';
import { clampMarkerTime } from './timelineNavigation';

/**
 * Bulk updates the Fade In time (in seconds) for all selected markers.
 */
export function bulkUpdateFadeIn(
  markers: Marker[],
  selectedIds: Set<string>,
  fadeInSeconds: number
): Marker[] {
  const safeFade = Number.isFinite(fadeInSeconds)
    ? Math.max(0, Number(fadeInSeconds.toFixed(3)))
    : 0;
  return markers.map((m) =>
    selectedIds.has(m.id) ? { ...m, fadeInSeconds: safeFade } : m
  );
}

/**
 * Bulk updates the Delay time (in seconds) for all selected markers.
 */
export function bulkUpdateDelay(
  markers: Marker[],
  selectedIds: Set<string>,
  delaySeconds: number
): Marker[] {
  const safeDelay = Number.isFinite(delaySeconds)
    ? Math.max(0, Number(delaySeconds.toFixed(3)))
    : 0;
  return markers.map((m) =>
    selectedIds.has(m.id) ? { ...m, delaySeconds: safeDelay } : m
  );
}

/**
 * Bulk nudges timestamp by a delta (in seconds) for all selected markers,
 * clamping timestamps within [0, maxDurationSeconds].
 */
export function bulkNudgeTime(
  markers: Marker[],
  selectedIds: Set<string>,
  deltaSeconds: number,
  maxDurationSeconds: number
): Marker[] {
  const safeDelta = Number.isFinite(deltaSeconds) ? deltaSeconds : 0;
  return markers.map((m) => {
    if (!selectedIds.has(m.id)) return m;
    const newTime = clampMarkerTime(
      Number((m.timestampSeconds + safeDelta).toFixed(4)),
      maxDurationSeconds
    );
    return { ...m, timestampSeconds: newTime };
  });
}

/**
 * Bulk updates category for all selected markers.
 */
export function bulkUpdateCategory(
  markers: Marker[],
  selectedIds: Set<string>,
  category: MarkerCategory
): Marker[] {
  return markers.map((m) =>
    selectedIds.has(m.id) ? { ...m, category } : m
  );
}

/**
 * Bulk updates exportEnabled flag for all selected markers.
 */
export function bulkUpdateExportEnabled(
  markers: Marker[],
  selectedIds: Set<string>,
  exportEnabled: boolean
): Marker[] {
  return markers.map((m) =>
    selectedIds.has(m.id) ? { ...m, exportEnabled } : m
  );
}

/**
 * Bulk deletes all selected markers.
 */
export function bulkDeleteMarkers(
  markers: Marker[],
  selectedIds: Set<string>
): Marker[] {
  return markers.filter((m) => !selectedIds.has(m.id));
}

/**
 * Returns a Set of marker IDs belonging to the specified category.
 */
export function selectMarkersByCategory(
  markers: Marker[],
  category: MarkerCategory
): Set<string> {
  const ids = new Set<string>();
  for (const m of markers) {
    if (m.category === category) {
      ids.add(m.id);
    }
  }
  return ids;
}
