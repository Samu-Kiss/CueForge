import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildGrandMa3UsbZip } from '../zipExporter';
import { createDefaultDemoShow } from '../audioAnalysis';
import { compileShow } from '../compiler';
import { ExportConfiguration } from '../../types/cueforge';

const baseConfig: ExportConfiguration = {
  songTitle: 'Solaris Show',
  ma3Version: '2.5.x',
  sequenceId: 101,
  sequenceName: 'Solaris_Seq',
  timecodeId: 101,
  timecodeName: 'Solaris_TC',
  macroId: 101,
  frameRate: 30,
  timecodeOffsetSeconds: 3600,
  latencyCompensationMs: 0,
  executionMode: 'Go+',
  allowOverwriteExistingObjects: false,
  songDurationSeconds: 120,
};

describe('grandMA3 USB Zip Exporter', () => {
  it('generates a zip file containing the official grandMA3 directory structure', async () => {
    const demo = createDefaultDemoShow();
    const compiled = compileShow(demo.markers, baseConfig);

    const zipBlob = await buildGrandMa3UsbZip(compiled, baseConfig, {
      includeCueAppearances: true,
      includeMarkerTrack: true,
    });

    expect(zipBlob.type).toBe('application/zip');
    expect(zipBlob.size).toBeGreaterThan(500);

    // Read back zip contents with JSZip
    const zip = await JSZip.loadAsync(zipBlob);
    const files = Object.keys(zip.files);

    // Verify grandMA3 directory paths
    expect(files.some((f) => f.startsWith('gma3_library/datapools/macros/'))).toBe(true);
    expect(files.some((f) => f.startsWith('gma3_library/datapools/timecodes/'))).toBe(true);
    expect(files.some((f) => f.startsWith('gma3_library/datapools/appearances/'))).toBe(true);
    expect(files.some((f) => f.startsWith('scripts/'))).toBe(true);
    expect(files).toContain('README_MA3_USB_IMPORT.txt');

    const readme = await zip.file('README_MA3_USB_IMPORT.txt')?.async('string');
    expect(readme).toContain('SelectDrive 2');
    expect(readme).toContain('Import Macro');
    expect(readme).toContain('Strict 1:1:1 Invariant Guaranteed');
  });
});
