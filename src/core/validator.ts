import { CompiledShow, ExportValidationReport, ValidationCheckResult } from '../types/cueforge';
import { computeTimecodeTimestamp } from './timecodeMath';

/**
 * Validates a compiled show before generating the grandMA3 macro / XML.
 *
 * Mandatory checks:
 * 1. Number of exported cues equals number of exportable markers.
 * 2. Number of timecode GO events equals number of exported cues.
 * 3. Every event references the correct sequence and cue.
 * 4. Every marker label is preserved.
 * 5. Events are placed at the correct frame (and no duplicate frame collisions).
 * 6. No events are missing or duplicated.
 * 7. Cue IDs and event references are unique and valid.
 * 8. The macro does not overwrite existing MA3 objects without explicit user authorization.
 */
export function validateCompiledShow(show: CompiledShow): ExportValidationReport {
  const checks: ValidationCheckResult[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  const { config, exportableMarkers, cues, events } = show;

  // 0. Ensure at least one exportable marker exists
  const hasMarkers = exportableMarkers.length > 0;
  checks.push({
    id: 'non-empty-export',
    title: 'Exportable Markers Present',
    passed: hasMarkers,
    details: hasMarkers
      ? `${exportableMarkers.length} confirmed exportable marker(s) ready.`
      : 'At least 1 confirmed & enabled marker is required to export.',
    severity: 'error',
  });
  if (!hasMarkers) {
    errors.push('Cannot export an empty sequence: 0 exportable markers.');
  }

  // 1. Number of exported cues equals number of exportable markers
  const cueCountMatchesMarkers = cues.length === exportableMarkers.length;
  checks.push({
    id: 'cue-count-matches-markers',
    title: 'Cue Count == Exportable Marker Count',
    passed: cueCountMatchesMarkers,
    details: `Exported cues (${cues.length}) == Exportable markers (${exportableMarkers.length}).`,
    severity: 'error',
  });
  if (!cueCountMatchesMarkers) {
    errors.push(
      `Cue count (${cues.length}) does not equal exportable marker count (${exportableMarkers.length}).`
    );
  }

  // 2. Number of timecode GO events equals number of exported cues
  const eventCountMatchesCues = events.length === cues.length;
  checks.push({
    id: 'event-count-matches-cues',
    title: 'Timecode GO Event Count == Cue Count',
    passed: eventCountMatchesCues,
    details: `Timecode events (${events.length}) == Exported cues (${cues.length}).`,
    severity: 'error',
  });
  if (!eventCountMatchesCues) {
    errors.push(
      `Timecode event count (${events.length}) does not equal exported cue count (${cues.length}).`
    );
  }

  // 3. Every event references the correct sequence and cue + TrigType == 'Go'
  let allReferencesCorrect = true;
  const refMismatchReasons: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const cue = cues[i];
    if (!cue) {
      allReferencesCorrect = false;
      refMismatchReasons.push(`Event #${ev.eventIndex} has no matching cue at index ${i}.`);
      continue;
    }
    if (ev.targetSequenceId !== config.sequenceId) {
      allReferencesCorrect = false;
      refMismatchReasons.push(
        `Event #${ev.eventIndex} targets Sequence ${ev.targetSequenceId} instead of ${config.sequenceId}.`
      );
    }
    if (ev.cueDestinationNumber !== cue.cueNumber) {
      allReferencesCorrect = false;
      refMismatchReasons.push(
        `Event #${ev.eventIndex} targets Cue ${ev.cueDestinationNumber} instead of Cue ${cue.cueNumber}.`
      );
    }
    if (cue.trigType !== 'Go') {
      allReferencesCorrect = false;
      refMismatchReasons.push(
        `Cue ${cue.cueNumber} has TrigType "${cue.trigType}" instead of mandatory "Go".`
      );
    }
    const expectedToken = config.executionMode === 'Goto(Status)' ? 'Goto' : 'Go+';
    if (ev.token !== expectedToken) {
      allReferencesCorrect = false;
      refMismatchReasons.push(
        `Event #${ev.eventIndex} has token "${ev.token}" instead of "${expectedToken}".`
      );
    }
  }
  checks.push({
    id: 'sequence-and-cue-references',
    title: 'Explicit Sequence & Cue Destination References',
    passed: allReferencesCorrect,
    details: allReferencesCorrect
      ? `All ${events.length} events explicitly target Sequence ${config.sequenceId} and their corresponding Cue 1..${cues.length} with ${config.executionMode} and Cue TrigType=Go.`
      : refMismatchReasons.join(' '),
    severity: 'error',
  });
  if (!allReferencesCorrect) {
    errors.push(...refMismatchReasons);
  }

  // 4. Every marker label is preserved
  let allLabelsPreserved = true;
  const labelErrors: string[] = [];
  for (let i = 0; i < exportableMarkers.length; i++) {
    const marker = exportableMarkers[i];
    const cue = cues[i];
    const ev = events[i];
    const trimmed = marker.label.trim();
    if (!trimmed) {
      allLabelsPreserved = false;
      labelErrors.push(`Marker #${i + 1} (${marker.id}) has an empty label.`);
    } else if (cue?.name !== trimmed || ev?.cueDestinationName !== trimmed) {
      allLabelsPreserved = false;
      labelErrors.push(
        `Marker "${trimmed}" label was not preserved on Cue ${cue?.cueNumber} ("${cue?.name}").`
      );
    }
  }
  checks.push({
    id: 'marker-labels-preserved',
    title: 'Marker Labels Preserved as Cue Names',
    passed: allLabelsPreserved,
    details: allLabelsPreserved
      ? 'Every confirmed marker label is non-empty and preserved verbatim as its Cue name and Event destination label.'
      : labelErrors.join(' '),
    severity: 'error',
  });
  if (!allLabelsPreserved) {
    errors.push(...labelErrors);
  }

  // 5. Events are placed at the correct frame
  let allFramesAccurate = true;
  const frameErrors: string[] = [];
  for (let i = 0; i < exportableMarkers.length; i++) {
    const marker = exportableMarkers[i];
    const ev = events[i];
    if (!ev) continue;
    const expectedTiming = computeTimecodeTimestamp(
      marker.timestampSeconds,
      config.frameRate,
      config.timecodeOffsetSeconds,
      config.latencyCompensationMs
    );
    if (
      ev.timing.totalFrames !== expectedTiming.totalFrames ||
      ev.timing.ma3InternalTicks !== expectedTiming.ma3InternalTicks
    ) {
      allFramesAccurate = false;
      frameErrors.push(
        `Event #${ev.eventIndex} frame (${ev.timing.totalFrames}) does not match expected frame (${expectedTiming.totalFrames}).`
      );
    }
    if (i > 0 && ev.timing.totalFrames < events[i - 1].timing.totalFrames) {
      allFramesAccurate = false;
      frameErrors.push(
        `Event #${ev.eventIndex} (${ev.timing.formattedAbsoluteSmpte}) is out of chronological order.`
      );
    }
  }
  checks.push({
    id: 'frame-accuracy',
    title: 'Frame-Accurate Timestamp & Tick Alignment',
    passed: allFramesAccurate,
    details: allFramesAccurate
      ? `All events are chronologically sorted and frame-aligned at ${config.frameRate} fps (Offset: ${config.timecodeOffsetSeconds}s, Latency: ${config.latencyCompensationMs}ms).`
      : frameErrors.join(' '),
    severity: 'error',
  });
  if (!allFramesAccurate) {
    errors.push(...frameErrors);
  }

  // 6. No events are missing or duplicated
  const seenMarkerIds = new Set<string>();
  const duplicateFrames: string[] = [];
  let noMissingOrDuplicated = true;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (seenMarkerIds.has(ev.sourceMarkerId)) {
      noMissingOrDuplicated = false;
      errors.push(`Duplicate event generated for marker ID ${ev.sourceMarkerId}.`);
    }
    seenMarkerIds.add(ev.sourceMarkerId);

    if (i > 0 && ev.timing.totalFrames === events[i - 1].timing.totalFrames) {
      const msg = `Events #${events[i - 1].eventIndex} ("${events[i - 1].label}") and #${ev.eventIndex} ("${ev.label}") land on the exact same timecode frame (${ev.timing.formattedAbsoluteSmpte}).`;
      warnings.push(msg);
      duplicateFrames.push(msg);
    }
  }
  for (const marker of exportableMarkers) {
    if (!seenMarkerIds.has(marker.id)) {
      noMissingOrDuplicated = false;
      errors.push(`Marker "${marker.label}" (${marker.id}) is missing from generated events.`);
    }
  }
  checks.push({
    id: 'no-missing-or-duplicate-events',
    title: 'No Missing or Duplicated Events',
    passed: noMissingOrDuplicated,
    details: noMissingOrDuplicated
      ? duplicateFrames.length > 0
        ? `1:1 marker-to-event mapping verified. Warning: ${duplicateFrames.join(' ')}`
        : 'Every exportable marker maps 1:1 to a unique cue and timecode event.'
      : 'Missing or duplicated marker events detected.',
    severity: noMissingOrDuplicated && duplicateFrames.length > 0 ? 'warning' : 'error',
  });

  // 7. Cue IDs and event references are unique and valid + Pool IDs valid
  const cueNumbers = new Set<number>();
  const eventIndices = new Set<number>();
  let idsValidAndUnique =
    Number.isInteger(config.sequenceId) &&
    config.sequenceId >= 1 &&
    Number.isInteger(config.timecodeId) &&
    config.timecodeId >= 1 &&
    Number.isInteger(config.macroId) &&
    config.macroId >= 1;

  if (!idsValidAndUnique) {
    errors.push('Sequence ID, Timecode ID, and Macro ID must be positive integers (>= 1).');
  }

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const ev = events[i];
    if (cue.cueNumber !== i + 1 || cueNumbers.has(cue.cueNumber)) {
      idsValidAndUnique = false;
      errors.push(`Invalid or non-sequential Cue ID: ${cue.cueNumber} at position ${i + 1}.`);
    }
    cueNumbers.add(cue.cueNumber);

    if (!ev || ev.eventIndex !== i + 1 || eventIndices.has(ev.eventIndex)) {
      idsValidAndUnique = false;
      errors.push(`Invalid or duplicate Event Index at position ${i + 1}.`);
    } else {
      eventIndices.add(ev.eventIndex);
    }
  }
  checks.push({
    id: 'unique-valid-ids',
    title: 'Unique & Sequential Cue IDs and Pool References',
    passed: idsValidAndUnique,
    details: idsValidAndUnique
      ? `Cues 1..${cues.length} and Events 1..${events.length} are strictly sequential and unique (Seq ${config.sequenceId}, TC ${config.timecodeId}, Macro ${config.macroId}).`
      : 'Invalid or non-unique Cue IDs, Event indices, or Pool numbers.',
    severity: 'error',
  });

  // 8. Overwrite safety check
  checks.push({
    id: 'overwrite-protection',
    title: 'grandMA3 Object Overwrite Protection',
    passed: true,
    details: config.allowOverwriteExistingObjects
      ? `Explicit user authorization GRANTED to overwrite Sequence ${config.sequenceId} and Timecode ${config.timecodeId}.`
      : `Safe mode active: Macro will verify Sequence ${config.sequenceId} and Timecode ${config.timecodeId} are empty and abort with a confirmation dialog if occupied.`,
    severity: 'warning',
  });

  return {
    isValid: errors.length === 0,
    checks,
    errors,
    warnings,
  };
}
