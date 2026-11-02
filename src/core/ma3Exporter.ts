import { CompiledShow } from '../types/cueforge';
import { MA3_TICKS_PER_SECOND, computeTimecodeTimestamp } from './timecodeMath';
import { validateCompiledShow } from './validator';

export interface Ma3MacroLine {
  index: number;
  command: string;
  wait: 'Follow' | 'Go' | string;
  note?: string;
}

export interface Ma3ExportBundle {
  macroName: string;
  macroLines: Ma3MacroLine[];
  macroXml: string;
  macroCommandText: string;
  timecodeXml: string;
}

/**
 * Escapes strings for XML attribute / text usage.
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Escapes double quotes and backslashes for grandMA3 command line string literals.
 */
export function escapeMa3CommandString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Escapes single quotes and backslashes for inline Lua strings inside a grandMA3 `Lua "..."` call.
 */
export function escapeLuaSingleQuotedString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"');
}

/**
 * Generates the complete grandMA3 2.5.x Macro XML, command script, and Timecode XML.
 * Throws an error if `validateCompiledShow(show)` fails.
 */
export function generateMa3ExportBundle(show: CompiledShow): Ma3ExportBundle {
  const validation = validateCompiledShow(show);
  if (!validation.isValid) {
    throw new Error(
      `Export validation failed: ${validation.errors.join(' | ')}`
    );
  }

  const { config, cues, events } = show;
  const seqId = config.sequenceId;
  const tcId = config.timecodeId;
  const seqName = escapeMa3CommandString(config.sequenceName.trim() || config.songTitle.trim() || `Sequence ${seqId}`);
  const tcName = escapeMa3CommandString(config.timecodeName.trim() || config.songTitle.trim() || `Timecode ${tcId}`);
  const storeFlag = config.allowOverwriteExistingObjects ? '/Overwrite' : '/NoConfirm';

  const macroLines: Ma3MacroLine[] = [];
  const pushLine = (command: string, note?: string, wait: string = 'Follow') => {
    macroLines.push({
      index: macroLines.length + 1,
      command,
      wait,
      note,
    });
  };

  // 1. Overwrite protection / programmer cleanup
  if (!config.allowOverwriteExistingObjects) {
    const safeGuardLua = [
      `local dp = DataPool()`,
      `if dp.sequences[${seqId}] or dp.timecodes[${tcId}] then`,
      `  Confirm('CueForge Safety Stop', 'Sequence ${seqId} or Timecode ${tcId} already exists. Enable Overwrite in CueForge or choose unused Pool IDs.')`,
      `  Cmd('Off Macro ${config.macroId}')`,
      `  return`,
      `end`,
    ].join(' ');
    pushLine(
      `Lua "${safeGuardLua}"`,
      'Abort macro safely if Sequence or Timecode pool object already exists (Overwrite not authorized)',
      '0.05'
    );
  } else {
    pushLine(
      `Delete Sequence ${seqId} /NoConfirm`,
      `Authorized overwrite: clear existing Sequence ${seqId}`
    );
    pushLine(
      `Delete Timecode ${tcId} /NoConfirm`,
      `Authorized overwrite: clear existing Timecode ${tcId}`
    );
  }

  // Clear programmer so cues contain NO programmed lighting values (placeholders only)
  pushLine('ClearAll', 'Ensure programmer is empty so cues contain no lighting values');

  // 2. Create Sequence
  pushLine(
    `Store Sequence ${seqId} "${seqName}" ${storeFlag}`,
    `Create Sequence ${seqId} ("${config.sequenceName}")`
  );

  // 3. Create sequentially numbered Cues (1..N) with GO trigger, label, fade, and delay
  for (const cue of cues) {
    const escapedCueName = escapeMa3CommandString(cue.name);
    pushLine(
      `Store Sequence ${seqId} Cue ${cue.cueNumber} "${escapedCueName}" /NoConfirm`,
      `Cue ${cue.cueNumber} -> Marker "${cue.name}" (${cue.category})`
    );
    pushLine(
      `Set Sequence ${seqId} Cue ${cue.cueNumber} Property "TrigType" "Go"`,
      `Configure Cue ${cue.cueNumber} Trigger Type strictly as Go (not Follow or Time)`
    );

    const fadeCmdValue =
      cue.cueFadeOut !== undefined
        ? `${cue.cueFadeIn}/${cue.cueFadeOut}`
        : `${cue.cueFadeIn}`;
    pushLine(
      `Sequence ${seqId} Cue ${cue.cueNumber} CueFade ${fadeCmdValue} CueDelay ${cue.cueDelay}`,
      `Preserve Cue ${cue.cueNumber} timing (Fade: ${fadeCmdValue}s, Delay: ${cue.cueDelay}s)`
    );
  }

  // 4. Create Timecode Show and configure frame rate & duration
  const lastEventAbsSeconds =
    events.length > 0
      ? events[events.length - 1].timing.absoluteSeconds
      : config.songDurationSeconds;
  const totalShowDurationSeconds = Math.max(
    config.timecodeOffsetSeconds + config.songDurationSeconds,
    lastEventAbsSeconds + 5
  );
  const totalDurationTicks = Math.round(totalShowDurationSeconds * MA3_TICKS_PER_SECOND);

  const frameRateUnitMap: Record<number, string> = {
    24: '24 fps',
    25: '25 fps',
    29.97: '29.97 fps',
    30: '30 fps',
  };
  const frameReadout = frameRateUnitMap[config.frameRate] || '30 fps';

  pushLine(
    `Store Timecode ${tcId} "${tcName}" ${storeFlag}`,
    `Create Timecode Show ${tcId} ("${config.timecodeName}")`
  );
  pushLine(
    `Set Timecode ${tcId} Property "FrameReadout" "${frameReadout}"`,
    `Configure Timecode ${tcId} frame rate to ${frameReadout}`
  );

  // 5. Initialize TrackGroup 1, Sequence Track, TimeRange, and CmdSubTrack in grandMA3 2.5.x
  const playbackAndRecordMode =
    config.executionMode === 'Goto(Status)' ? 'Goto (Status)' : 'Go+ ( Events)';
  const initTrackLua = [
    `local dp = DataPool()`,
    `local seq = dp.sequences[${seqId}]`,
    `local tc = dp.timecodes[${tcId}]`,
    `tc:Set('duration', ${totalDurationTicks})`,
    `local tg = tc[1] or tc:Acquire()`,
    `tg:Set('name', '${escapeLuaSingleQuotedString(config.sequenceName)}')`,
    `local trk = tg[2] or tg:Acquire()`,
    `trk:Set('name', '${escapeLuaSingleQuotedString(config.sequenceName)}')`,
    `trk:Set('target', seq)`,
    `local tr = trk[1] or trk:Acquire()`,
    `local sub = tr[1] or tr:Acquire('CmdSubTrack')`,
  ].join('; ');

  pushLine(
    `Lua "${initTrackLua}"`,
    `Assign Sequence ${seqId} to Timecode ${tcId} Track and initialize CmdSubTrack (${playbackAndRecordMode})`,
    '0.05'
  );

  // 6. Create 1 Timecode Event per Cue with explicit CueDestination and GO action
  for (const ev of events) {
    const escapedEventName = escapeLuaSingleQuotedString(ev.label);
    const eventLuaParts = [
      `local dp = DataPool()`,
      `local seq = dp.sequences[${seqId}]`,
      `local tc = dp.timecodes[${tcId}]`,
      `local tg = tc[1]`,
      `local trk = tg[2] or tg[1]`,
      `local tr = trk[1]`,
      `local sub = tr[1]`,
      `local ev = sub:Acquire()`,
      `ev:Set('name', '${escapedEventName}')`,
      `ev:Set('time', ${ev.timing.ma3InternalTicks})`,
      `ev:Set('token', '${ev.token}')`,
      `ev:Set('cuedestination', seq[${ev.cueDestinationNumber + 1}] and seq[${ev.cueDestinationNumber + 1}][1] or GetObject('Sequence ${seqId} Cue ${ev.cueDestinationNumber} Part 0'))`,
    ];
    if (ev.fadeOverrideSeconds !== undefined) {
      eventLuaParts.push(`pcall(function() ev:Set('cuefade', ${ev.fadeOverrideSeconds}) end)`);
    }

    pushLine(
      `Lua "${eventLuaParts.join('; ')}"`,
      `Event #${ev.eventIndex} @ ${ev.timing.formattedAbsoluteSmpte} (${ev.timing.formattedRelative}) -> ${ev.token} Sequence ${seqId} Cue ${ev.cueDestinationNumber} ("${ev.cueDestinationName}")`
    );
  }

  // 7. Build grandMA3 2.5.x Macro XML
  const macroName = `CF_${config.songTitle.replace(/[^a-zA-Z0-9_-]/g, '_') || 'Show'}_Build`;
  const xmlMacroLines = macroLines
    .map(
      (line) =>
        `        <MacroLine Name="${escapeXml(line.note || `Step ${line.index}`)}" Command="${escapeXml(line.command)}" Wait="${escapeXml(line.wait)}" Execute="Yes" Enabled="Yes" />`
    )
    .join('\n');

  const macroXml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<GMA3 DataVersion="2.5.0.0">`,
    `    <!-- Generated by CueForge for grandMA3 2.5.x -->`,
    `    <!-- Invariant: ${cues.length} Markers = ${cues.length} Cues = ${events.length} Timecode Events -->`,
    `    <Macro Name="${escapeXml(macroName)}" Index="${config.macroId}">`,
    xmlMacroLines,
    `    </Macro>`,
    `</GMA3>`,
  ].join('\n');

  // 8. Build plain-text Command Script reference
  const macroCommandText = macroLines
    .map((l) => `# [${l.index}] ${l.note ?? ''}\n${l.command}`)
    .join('\n\n');

  // 9. Build Direct grandMA3 2.5.x Timecode Show XML
  const durationTiming = computeTimecodeTimestamp(
    totalShowDurationSeconds,
    config.frameRate,
    0,
    0
  );
  const xmlCmdEvents = events
    .map((ev) => {
      const fadeAttr =
        ev.fadeOverrideSeconds !== undefined
          ? ` CueFade="${ev.fadeOverrideSeconds}"`
          : '';
      return [
        `                        <CmdEvent Name="${escapeXml(ev.token)}" Time="${ev.timing.formattedMa3Time}" CueDestination="${escapeXml(ev.cueDestinationName)}" CueDestinationIndex="${ev.cueDestinationNumber}" ExecuteCommand="Yes"${fadeAttr}>`,
        `                            <RealtimeCmd Type="Key" Source="Original" IsRealtime="1" Status="On" Object="ShowData.DataPools.Default.Sequences.${escapeXml(config.sequenceName)}" Token="${escapeXml(ev.token)}" />`,
        `                        </CmdEvent>`,
      ].join('\n');
    })
    .join('\n');

  const timecodeXml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<GMA3 DataVersion="2.5.0.0">`,
    `    <!-- Generated by CueForge for grandMA3 2.5.x -->`,
    `    <Timecode Name="${escapeXml(config.timecodeName)}" Duration="${durationTiming.formattedMa3Time}" FrameReadout="${escapeXml(frameReadout)}" TCSlot="0" AutoStop="No" SwitchOff="Keep Playbacks">`,
    `        <TrackGroup Name="${escapeXml(config.sequenceName)}" Play="" Rec="">`,
    `            <MarkerTrack Name="Marker" />`,
    `            <Track Name="${escapeXml(config.sequenceName)}" Target="ShowData.DataPools.Default.Sequences.${escapeXml(config.sequenceName)}" Play="" Rec="">`,
    `                <TimeRange Duration="To End" Play="" Rec="">`,
    `                    <CmdSubTrack>`,
    xmlCmdEvents,
    `                    </CmdSubTrack>`,
    `                </TimeRange>`,
    `            </Track>`,
    `        </TrackGroup>`,
    `    </Timecode>`,
    `</GMA3>`,
  ].join('\n');

  return {
    macroName,
    macroLines,
    macroXml,
    macroCommandText,
    timecodeXml,
  };
}
