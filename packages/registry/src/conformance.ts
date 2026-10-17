/**
 * Machine-readable module conformance report (registry kit).
 *
 * Levels come from `@pinout/module-host` (`CONFORMANCE_LEVELS`): L0 manifest
 * valid, L1 builds, L2 conformance pass, L3 simulation verified, L4 integration
 * verified, L5 hardware verified (dated record required). This module runs the
 * checks that are software-testable (`@pinout/core` `runModuleConformance`
 * plus manifest/entrypoint checks) and accepts *evidence* for L3+ from an
 * optional `evidence/conformance.json` file or explicit options. Nothing is
 * claimed without evidence.
 *
 * Evidence file format (strict):
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "simulationVerified": true,
 *   "integrationVerified": false,
 *   "hardwareRecord": {
 *     "date": "2026-09-08",
 *     "hardware": "ESP32 classic DevKit",
 *     "firmwareVersion": "0.0.1-alpha.1",
 *     "moduleVersion": "1.0.0",
 *     "testSuiteVersion": "0.1.0"
 *   }
 * }
 * ```
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  loadModuleFromDirectory,
  readModuleManifestFromFile,
  runModuleConformance,
  type ConformanceResult,
  type PinoutModuleManifest,
} from '@pinout/core';
import {
  CONFORMANCE_LEVELS,
  LEVEL_NAMES,
  evaluateConformanceLevel,
  type ConformanceEvidence,
  type ConformanceLevel,
} from '@pinout/module-host';
import { RegistryError } from './errors.js';
import { MODULE_MANIFEST_FILENAME } from './content.js';

export interface HardwareVerificationRecord {
  date: string;
  hardware: string;
  firmwareVersion: string;
  moduleVersion: string;
  testSuiteVersion: string;
}

export interface ModuleConformanceOptions {
  simulationVerified?: boolean;
  integrationVerified?: boolean;
  hardwareRecord?: HardwareVerificationRecord;
  /** Override for the evidence file (default `<dir>/evidence/conformance.json`). */
  evidenceFile?: string;
}

export interface ConformanceCheckSummary {
  name: string;
  passed: boolean;
  detail: string | null;
}

export interface ConformanceLane {
  level: ConformanceLevel;
  name: string;
  status: 'passed' | 'failed';
  checks: ConformanceCheckSummary[];
}

export interface ModuleConformanceReport {
  directory: string;
  moduleId: string | null;
  moduleVersion: string | null;
  manifestValid: boolean;
  level: ConformanceLevel | null;
  levelName: string | null;
  /** True when the module reached at least L2 (conformance pass). */
  passed: boolean;
  lanes: ConformanceLane[];
  evidence: {
    source: 'none' | 'options' | 'file';
    file: string | null;
    simulationVerified: boolean;
    integrationVerified: boolean;
    hardwareRecord: HardwareVerificationRecord | null;
  };
}

/** Run the software-testable checks and assemble an L0–L5 report. */
export async function evaluateModuleConformance(
  directory: string,
  options: ModuleConformanceOptions = {},
): Promise<ModuleConformanceReport> {
  const root = resolve(directory);
  if (!existsSync(root)) {
    throw new RegistryError(
      'CONFORMANCE_FAILED',
      `Module directory '${root}' does not exist.`,
    );
  }
  const evidenceFile = options.evidenceFile ?? join(root, 'evidence', 'conformance.json');
  const fileEvidence = readEvidenceFile(evidenceFile);
  const evidenceOptionsProvided =
    options.simulationVerified !== undefined ||
    options.integrationVerified !== undefined ||
    options.hardwareRecord !== undefined;
  const simulationVerified = options.simulationVerified ?? fileEvidence.simulationVerified;
  const integrationVerified = options.integrationVerified ?? fileEvidence.integrationVerified;
  const hardwareRecord = options.hardwareRecord ?? fileEvidence.hardwareRecord;
  const evidenceSource: ModuleConformanceReport['evidence']['source'] = evidenceOptionsProvided
    ? 'options'
    : fileEvidence.present
      ? 'file'
      : 'none';

  const l0Checks: ConformanceCheckSummary[] = [];
  let manifest: PinoutModuleManifest | null = null;
  try {
    manifest = readModuleManifestFromFile(join(root, MODULE_MANIFEST_FILENAME));
    l0Checks.push({
      name: 'manifest',
      passed: true,
      detail: `${manifest.id}@${manifest.version}`,
    });
  } catch (error) {
    l0Checks.push({
      name: 'manifest',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const manifestValid = manifest !== null;

  const l1Checks: ConformanceCheckSummary[] = [];
  let builds = false;
  if (!manifestValid) {
    l1Checks.push({ name: 'builds', passed: false, detail: 'manifest is not valid' });
  } else {
    try {
      const loaded = await loadModuleFromDirectory(root);
      builds = true;
      l1Checks.push({
        name: 'entrypoint',
        passed: true,
        detail: `${manifest?.entrypoint ?? '?'} loads as '${loaded.module.id}@${loaded.module.version}'`,
      });
    } catch (error) {
      l1Checks.push({
        name: 'entrypoint',
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const l2Checks: ConformanceCheckSummary[] = [];
  let conformance: ConformanceResult | null = null;
  try {
    conformance = await runModuleConformance(root);
  } catch (error) {
    l2Checks.push({
      name: 'conformance kit',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (conformance) {
    for (const check of conformance.checks) {
      l2Checks.push({
        name: check.name,
        passed: check.passed,
        detail: check.detail ?? null,
      });
    }
  }
  const conformancePassed = conformance !== null && conformance.passed;

  const lanes: ConformanceLane[] = [
    lane('L0', l0Checks),
    lane('L1', l1Checks),
    lane('L2', l2Checks),
    lane('L3', [
      {
        name: 'evidence: simulation',
        passed: simulationVerified,
        detail: simulationVerified
          ? `source: ${evidenceSource}`
          : 'no simulation evidence provided',
      },
    ]),
    lane('L4', [
      {
        name: 'evidence: integration',
        passed: integrationVerified,
        detail: integrationVerified
          ? `source: ${evidenceSource}`
          : 'no integration (daemon/module-host) evidence provided',
      },
    ]),
    lane('L5', [
      {
        name: 'evidence: hardware record',
        passed: hardwareRecord !== null,
        detail: hardwareRecord
          ? `${hardwareRecord.date} ${hardwareRecord.hardware} (firmware ${hardwareRecord.firmwareVersion}, module ${hardwareRecord.moduleVersion}, suite ${hardwareRecord.testSuiteVersion})`
          : 'no dated hardware test record provided',
      },
    ]),
  ];

  const evidence: ConformanceEvidence = {
    manifestValid,
    builds,
    conformancePassed,
    simulationVerified,
    integrationVerified,
    ...(hardwareRecord !== null ? { hardwareRecord } : {}),
  };
  let level: ConformanceLevel | null = null;
  if (manifestValid) {
    level = evaluateConformanceLevel(evidence);
  }

  return {
    directory: root,
    moduleId: manifest?.id ?? null,
    moduleVersion: manifest?.version ?? null,
    manifestValid,
    level,
    levelName: level === null ? null : LEVEL_NAMES[level],
    passed: level !== null && CONFORMANCE_LEVELS.indexOf(level) >= 2,
    lanes,
    evidence: {
      source: evidenceSource,
      file: fileEvidence.present ? evidenceFile : null,
      simulationVerified,
      integrationVerified,
      hardwareRecord,
    },
  };
}

export function formatModuleConformanceReport(report: ModuleConformanceReport): string {
  const lines = ['Pinout Module Conformance (registry kit)', ''];
  lines.push(
    `MODULE: ${report.moduleId ?? '(unknown)'}@${report.moduleVersion ?? '(unknown)'}  ->  ${
      report.level === null ? 'BELOW L0 (manifest invalid)' : `${report.level} ${report.levelName}`
    }`,
  );
  lines.push('');
  for (const lane of report.lanes) {
    lines.push(`${lane.status === 'passed' ? '✓' : '✗'} ${lane.level} ${lane.name} (${lane.status})`);
    for (const check of lane.checks) {
      lines.push(`    ${check.passed ? '✓' : '✗'} ${check.name}${check.detail ? `: ${check.detail}` : ''}`);
    }
  }
  lines.push('');
  lines.push(report.passed ? 'PASS (>= L2)' : 'FAIL (below L2)');
  return lines.join('\n');
}

interface FileEvidence {
  present: boolean;
  simulationVerified: boolean;
  integrationVerified: boolean;
  hardwareRecord: HardwareVerificationRecord | null;
}

function readEvidenceFile(path: string): FileEvidence {
  const empty: FileEvidence = {
    present: false,
    simulationVerified: false,
    integrationVerified: false,
    hardwareRecord: null,
  };
  if (!existsSync(path)) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new RegistryError(
      'CONFORMANCE_FAILED',
      `Conformance evidence '${path}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RegistryError('CONFORMANCE_FAILED', `Conformance evidence '${path}' must be an object.`);
  }
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (key) => !['schemaVersion', 'simulationVerified', 'integrationVerified', 'hardwareRecord'].includes(key),
  );
  if (unknown.length > 0) {
    throw new RegistryError(
      'CONFORMANCE_FAILED',
      `Conformance evidence '${path}' has unknown field '${unknown[0]}'.`,
    );
  }
  if (record['schemaVersion'] !== 1) {
    throw new RegistryError(
      'CONFORMANCE_FAILED',
      `Conformance evidence '${path}' must have schemaVersion 1.`,
    );
  }
  return {
    present: true,
    simulationVerified: readBoolean(record['simulationVerified'], 'simulationVerified', path),
    integrationVerified: readBoolean(record['integrationVerified'], 'integrationVerified', path),
    hardwareRecord:
      record['hardwareRecord'] === undefined
        ? null
        : validateHardwareVerificationRecord(
            record['hardwareRecord'],
            `Conformance evidence '${path}' hardwareRecord`,
          ),
  };
}

export function validateHardwareVerificationRecord(
  value: unknown,
  label = 'hardware record',
): HardwareVerificationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RegistryError('CONFORMANCE_FAILED', `${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const fields = [
    'date',
    'hardware',
    'firmwareVersion',
    'moduleVersion',
    'testSuiteVersion',
  ] as const;
  const unknown = Object.keys(record).filter(
    (key) => !(fields as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new RegistryError(
      'CONFORMANCE_FAILED',
      `${label} has unknown field '${unknown[0]}'.`,
    );
  }
  for (const field of fields) {
    if (typeof record[field] !== 'string' || (record[field] as string).length === 0) {
      throw new RegistryError(
        'CONFORMANCE_FAILED',
        `${label}.${field} must be a non-empty string.`,
      );
    }
  }
  const date = record['date'] as string;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    throw new RegistryError('CONFORMANCE_FAILED', `${label}.date must be YYYY-MM-DD.`);
  }
  return {
    date,
    hardware: record['hardware'] as string,
    firmwareVersion: record['firmwareVersion'] as string,
    moduleVersion: record['moduleVersion'] as string,
    testSuiteVersion: record['testSuiteVersion'] as string,
  };
}

function readBoolean(value: unknown, label: string, path: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new RegistryError(
      'CONFORMANCE_FAILED',
      `Conformance evidence '${path}' ${label} must be a boolean.`,
    );
  }
  return value;
}

function lane(level: ConformanceLevel, checks: ConformanceCheckSummary[]): ConformanceLane {
  return {
    level,
    name: LEVEL_NAMES[level],
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    checks,
  };
}
