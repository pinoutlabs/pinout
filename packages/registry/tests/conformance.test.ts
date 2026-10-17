import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateModuleConformance,
  formatModuleConformanceReport,
  validateHardwareVerificationRecord,
  type HardwareVerificationRecord,
} from '../src/conformance.js';
import { RegistryError } from '../src/errors.js';
import { writeManifest, writeRunnableModule } from './helpers.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pinout-registry-conformance-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HARDWARE_RECORD: HardwareVerificationRecord = {
  date: '2026-09-08',
  hardware: 'ESP32 classic DevKit',
  firmwareVersion: '0.0.1-alpha.1',
  moduleVersion: '0.1.0',
  testSuiteVersion: '0.1.0',
};

function writeEvidence(directory: string, evidence: unknown): void {
  mkdirSync(join(directory, 'evidence'), { recursive: true });
  writeFileSync(
    join(directory, 'evidence/conformance.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
    'utf8',
  );
}

describe('evaluateModuleConformance — software-testable levels', () => {
  it('runnable module reaches L2 with no evidence claims', async () => {
    const moduleDir = join(dir, 'runnable');
    writeRunnableModule(moduleDir);
    const report = await evaluateModuleConformance(moduleDir);

    expect(report.moduleId).toBe('test/thermo');
    expect(report.moduleVersion).toBe('0.1.0');
    expect(report.manifestValid).toBe(true);
    expect(report.level).toBe('L2');
    expect(report.levelName).toBe('CONFORMANCE_PASS');
    expect(report.passed).toBe(true);
    expect(report.evidence.source).toBe('none');
    expect(report.evidence.file).toBeNull();
    expect(report.evidence.hardwareRecord).toBeNull();

    const lanes = Object.fromEntries(report.lanes.map((lane) => [lane.level, lane.status]));
    expect(lanes).toEqual({
      L0: 'passed',
      L1: 'passed',
      L2: 'passed',
      L3: 'failed',
      L4: 'failed',
      L5: 'failed',
    });
  });

  it('stays at L0 when the entrypoint does not match the manifest', async () => {
    const moduleDir = join(dir, 'stub');
    writeManifest(moduleDir);
    writeFileSync(join(moduleDir, 'index.js'), 'export default {};\n', 'utf8');
    const report = await evaluateModuleConformance(moduleDir);

    expect(report.manifestValid).toBe(true);
    expect(report.level).toBe('L0');
    expect(report.passed).toBe(false);
    expect(report.lanes[1]?.status).toBe('failed');
  });

  it('stays at L0 when the entrypoint file is missing', async () => {
    const moduleDir = join(dir, 'no-entrypoint');
    writeManifest(moduleDir);
    const report = await evaluateModuleConformance(moduleDir);

    expect(report.manifestValid).toBe(true);
    expect(report.level).toBe('L0');
    expect(report.passed).toBe(false);
    expect(report.lanes[0]?.status).toBe('passed');
  });

  it('returns level null when the manifest is invalid', async () => {
    const moduleDir = join(dir, 'invalid-manifest');
    writeManifest(moduleDir, { id: 'Not Valid' });
    const report = await evaluateModuleConformance(moduleDir);

    expect(report.manifestValid).toBe(false);
    expect(report.moduleId).toBeNull();
    expect(report.level).toBeNull();
    expect(report.levelName).toBeNull();
    expect(report.passed).toBe(false);
    expect(report.lanes[0]?.checks[0]?.passed).toBe(false);
  });
});

describe('evaluateModuleConformance — evidence files', () => {
  it('reads simulation evidence (L3) from evidence/conformance.json', async () => {
    const moduleDir = join(dir, 'simulated');
    writeRunnableModule(moduleDir);
    writeEvidence(moduleDir, { schemaVersion: 1, simulationVerified: true });
    const report = await evaluateModuleConformance(moduleDir);

    expect(report.level).toBe('L3');
    expect(report.levelName).toBe('SIMULATION_VERIFIED');
    expect(report.evidence.source).toBe('file');
    expect(report.evidence.file).toBe(join(moduleDir, 'evidence/conformance.json'));
    expect(report.evidence.simulationVerified).toBe(true);
  });

  it('reads integration evidence (L4) and a hardware record (L5)', async () => {
    const moduleDir = join(dir, 'integrated');
    writeRunnableModule(moduleDir);
    writeEvidence(moduleDir, {
      schemaVersion: 1,
      simulationVerified: true,
      integrationVerified: true,
    });
    expect((await evaluateModuleConformance(moduleDir)).level).toBe('L4');

    writeEvidence(moduleDir, {
      schemaVersion: 1,
      simulationVerified: true,
      integrationVerified: true,
      hardwareRecord: HARDWARE_RECORD,
    });
    const report = await evaluateModuleConformance(moduleDir);
    expect(report.level).toBe('L5');
    expect(report.levelName).toBe('HARDWARE_VERIFIED');
    expect(report.evidence.hardwareRecord).toEqual(HARDWARE_RECORD);
  });

  it('merges options with the evidence file and reports the source', async () => {
    const moduleDir = join(dir, 'merged');
    writeRunnableModule(moduleDir);
    writeEvidence(moduleDir, { schemaVersion: 1, simulationVerified: true });
    const report = await evaluateModuleConformance(moduleDir, { integrationVerified: true });

    expect(report.evidence.source).toBe('options');
    expect(report.level).toBe('L4');
  });

  it('accepts a hardware record through options (L5)', async () => {
    const moduleDir = join(dir, 'options');
    writeRunnableModule(moduleDir);
    const report = await evaluateModuleConformance(moduleDir, {
      simulationVerified: true,
      integrationVerified: true,
      hardwareRecord: HARDWARE_RECORD,
    });

    expect(report.level).toBe('L5');
    expect(report.evidence.source).toBe('options');
  });

  it('supports an explicit evidence file path', async () => {
    const moduleDir = join(dir, 'custom-evidence');
    writeRunnableModule(moduleDir);
    const evidencePath = join(dir, 'custom.json');
    writeFileSync(
      evidencePath,
      `${JSON.stringify({ schemaVersion: 1, simulationVerified: true })}\n`,
      'utf8',
    );
    const report = await evaluateModuleConformance(moduleDir, { evidenceFile: evidencePath });

    expect(report.level).toBe('L3');
    expect(report.evidence.file).toBe(evidencePath);
  });

  it('rejects malformed evidence files', async () => {
    const moduleDir = join(dir, 'broken-evidence');
    writeRunnableModule(moduleDir);

    mkdirSync(join(moduleDir, 'evidence'), { recursive: true });
    const evidencePath = join(moduleDir, 'evidence/conformance.json');
    for (const raw of [
      '{oops',
      '"text"',
      '[]',
      '{"schemaVersion":2}',
      '{"schemaVersion":1,"unknown":true}',
      '{"schemaVersion":1,"simulationVerified":"yes"}',
      '{"schemaVersion":1,"hardwareRecord":{}}',
    ]) {
      writeFileSync(evidencePath, raw, 'utf8');
      await expect(evaluateModuleConformance(moduleDir)).rejects.toMatchObject({
        code: 'CONFORMANCE_FAILED',
      });
    }
  });

  it('throws CONFORMANCE_FAILED for missing directories', async () => {
    await expect(evaluateModuleConformance(join(dir, 'nope'))).rejects.toMatchObject({
      code: 'CONFORMANCE_FAILED',
    });
  });
});

describe('validateHardwareVerificationRecord', () => {
  it('accepts a well-formed record and rejects malformed ones', () => {
    expect(validateHardwareVerificationRecord(HARDWARE_RECORD)).toEqual(HARDWARE_RECORD);

    for (const invalid of [
      null,
      [],
      { ...HARDWARE_RECORD, extra: true },
      { ...HARDWARE_RECORD, date: '2026-9-8' },
      { ...HARDWARE_RECORD, date: 'not-a-date' },
      { ...HARDWARE_RECORD, hardware: '' },
      { ...HARDWARE_RECORD, firmwareVersion: 7 },
      { ...HARDWARE_RECORD, moduleVersion: undefined },
    ]) {
      let thrown: unknown = null;
      try {
        validateHardwareVerificationRecord(invalid);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RegistryError);
      expect((thrown as RegistryError).code).toBe('CONFORMANCE_FAILED');
    }
  });
});

describe('formatModuleConformanceReport', () => {
  it('renders levels, checks, and the L2 verdict', async () => {
    const moduleDir = join(dir, 'runnable');
    writeRunnableModule(moduleDir);
    const report = await evaluateModuleConformance(moduleDir);
    const text = formatModuleConformanceReport(report);

    expect(text).toContain('L2 CONFORMANCE_PASS');
    expect(text).toContain('L5 HARDWARE_VERIFIED');
    expect(text).toContain('PASS (>= L2)');
    expect(text).toContain('test/thermo@0.1.0');
  });

  it('renders a failing verdict below L2', async () => {
    const moduleDir = join(dir, 'no-entrypoint');
    writeManifest(moduleDir);
    const report = await evaluateModuleConformance(moduleDir);
    const text = formatModuleConformanceReport(report);

    expect(text).toContain('L0 MANIFEST_VALID');
    expect(text).toContain('FAIL (below L2)');
  });
});
