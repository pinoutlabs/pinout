import { describe, expect, it } from 'vitest';
import {
  SUPPORT_LEVELS,
  applyEvidenceRules,
  capSupportLevel,
  compareSupportLevels,
  isDatedHardwareRecord,
  isSupportLevel,
  mapFromCatalogStatus,
  mapFromConformanceLevel,
  mapFromGeneratorLifecycle,
  mapFromManifestStatus,
  mapFromSupportStatus,
  type CatalogStatus,
  type ConformanceLevelInput,
  type GeneratorLifecycle,
  type ManifestStatus,
  type SupportStatusInput,
} from '../src/spec/supportLevel.js';

describe('SupportLevel foundation', () => {
  it('exposes the canonical ladder including UNKNOWN', () => {
    expect(SUPPORT_LEVELS).toEqual(['UNKNOWN', 'SIMULATED', 'COMPILE_TESTED', 'HARDWARE_VERIFIED']);
    expect(isSupportLevel('SIMULATED')).toBe(true);
    expect(isSupportLevel('IMPLEMENTED')).toBe(false);
    expect(compareSupportLevels('SIMULATED', 'COMPILE_TESTED')).toBeLessThan(0);
    expect(capSupportLevel('HARDWARE_VERIFIED', 'COMPILE_TESTED')).toBe('COMPILE_TESTED');
  });

  it('maps manifest statuses without deleting that vocabulary', () => {
    const statuses: ManifestStatus[] = ['CANDIDATE', 'REVIEWED', 'TESTED'];
    expect(statuses.map((status) => mapFromManifestStatus(status))).toEqual([
      'UNKNOWN',
      'SIMULATED',
      'COMPILE_TESTED',
    ]);
  });

  it('maps SupportStatus values honestly', () => {
    const cases: Array<[SupportStatusInput, string]> = [
      ['SIMULATED', 'SIMULATED'],
      ['COMPILE_TESTED', 'COMPILE_TESTED'],
      ['IMPLEMENTED', 'COMPILE_TESTED'],
      ['HARDWARE_VERIFIED', 'COMPILE_TESTED'], // no dated record → demote
      ['PLANNED', 'UNKNOWN'],
      ['EXPERIMENTAL', 'UNKNOWN'],
    ];
    for (const [input, expected] of cases) {
      expect(mapFromSupportStatus(input), input).toBe(expected);
    }
    expect(mapFromSupportStatus('HARDWARE_VERIFIED', { hardwareRecordDate: '2026-10-24' })).toBe(
      'HARDWARE_VERIFIED',
    );
  });

  it('maps all eight catalog statuses', () => {
    const catalog: CatalogStatus[] = [
      'PLANNED',
      'SPEC_ONLY',
      'IMPLEMENTED',
      'COMPILE_TESTED',
      'SIMULATED',
      'INTEGRATION_VERIFIED',
      'HARDWARE_VERIFIED',
      'EXPERIMENTAL',
    ];
    expect(catalog.map((status) => mapFromCatalogStatus(status))).toEqual([
      'UNKNOWN',
      'UNKNOWN',
      'COMPILE_TESTED',
      'COMPILE_TESTED',
      'SIMULATED',
      'COMPILE_TESTED',
      'COMPILE_TESTED', // no dated record
      'UNKNOWN',
    ]);
    expect(mapFromCatalogStatus('HARDWARE_VERIFIED', { hardwareRecordDate: '2026-09-05' })).toBe(
      'HARDWARE_VERIFIED',
    );
  });

  it('maps conformance L0–L5 and requires a dated record for L5', () => {
    const levels: ConformanceLevelInput[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
    expect(levels.map((level) => mapFromConformanceLevel(level))).toEqual([
      'UNKNOWN',
      'UNKNOWN',
      'UNKNOWN',
      'SIMULATED',
      'COMPILE_TESTED',
      'COMPILE_TESTED', // L5 without record
    ]);
    expect(mapFromConformanceLevel('L5', { hardwareRecordDate: '2026-10-01' })).toBe(
      'HARDWARE_VERIFIED',
    );
  });

  it('maps generator lifecycle and never lets generated exceed COMPILE_TESTED without a record', () => {
    const lifecycle: GeneratorLifecycle[] = [
      'GENERATED',
      'CONFORMANCE_PASSED',
      'SIMULATION_TESTED',
      'HUMAN_REVIEWED',
      'HARDWARE_TESTED',
    ];
    expect(lifecycle.map((entry) => mapFromGeneratorLifecycle(entry))).toEqual([
      'UNKNOWN',
      'UNKNOWN',
      'SIMULATED',
      'COMPILE_TESTED',
      'COMPILE_TESTED',
    ]);
    expect(mapFromGeneratorLifecycle('HARDWARE_TESTED', { hardwareRecordDate: '2026-10-24' })).toBe(
      'HARDWARE_VERIFIED',
    );
    expect(applyEvidenceRules('HARDWARE_VERIFIED', { generated: true })).toBe('COMPILE_TESTED');
  });

  it('validates dated hardware record strings', () => {
    expect(isDatedHardwareRecord('2026-10-24')).toBe(true);
    expect(isDatedHardwareRecord('2026-10-24T12:00:00Z')).toBe(true);
    expect(isDatedHardwareRecord('')).toBe(false);
    expect(isDatedHardwareRecord('   ')).toBe(false);
    expect(isDatedHardwareRecord(null)).toBe(false);
    expect(isDatedHardwareRecord('not-a-date')).toBe(false);
  });
});
