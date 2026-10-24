/**
 * Canonical evidence / support level (PR0 foundation).
 *
 * Existing vocabularies (catalog statuses, SupportStatus, module manifest
 * status, conformance L0–L5, generator lifecycle) stay as-is. This module is
 * the mapping layer so agents and tooling can speak one honest ladder:
 *
 *   UNKNOWN → SIMULATED → COMPILE_TESTED → HARDWARE_VERIFIED
 *
 * HARDWARE_VERIFIED requires a dated `hardware/records/` entry. Generated or
 * auto-built artifacts never exceed COMPILE_TESTED without that record.
 * Pinout has not run on real hardware in this repository.
 */

/** Canonical evidence ladder shared across packages. */
export type SupportLevel = 'UNKNOWN' | 'SIMULATED' | 'COMPILE_TESTED' | 'HARDWARE_VERIFIED';

/** Module-manifest `status` values (see `module/manifest.ts`). */
export type ManifestStatus = 'CANDIDATE' | 'REVIEWED' | 'TESTED';

/**
 * Spec `SupportStatus` values (see `spec/types.ts`). Kept as a string union
 * here so this mapping layer does not create a circular import with types.ts.
 */
export type SupportStatusInput =
  'IMPLEMENTED' | 'HARDWARE_VERIFIED' | 'SIMULATED' | 'COMPILE_TESTED' | 'PLANNED' | 'EXPERIMENTAL';

/** The eight statuses published in `hardware/catalog.json`. */
export type CatalogStatus =
  | 'PLANNED'
  | 'SPEC_ONLY'
  | 'IMPLEMENTED'
  | 'COMPILE_TESTED'
  | 'SIMULATED'
  | 'INTEGRATION_VERIFIED'
  | 'HARDWARE_VERIFIED'
  | 'EXPERIMENTAL';

/** Module-host conformance levels (L0–L5). */
export type ConformanceLevelInput = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

/** Generator candidate lifecycle (see `@pinout/generator` provenance). */
export type GeneratorLifecycle =
  'GENERATED' | 'CONFORMANCE_PASSED' | 'SIMULATION_TESTED' | 'HUMAN_REVIEWED' | 'HARDWARE_TESTED';

export const SUPPORT_LEVELS: readonly SupportLevel[] = [
  'UNKNOWN',
  'SIMULATED',
  'COMPILE_TESTED',
  'HARDWARE_VERIFIED',
] as const;

const supportLevelRank: Record<SupportLevel, number> = {
  UNKNOWN: 0,
  SIMULATED: 1,
  COMPILE_TESTED: 2,
  HARDWARE_VERIFIED: 3,
};

/** True when `value` is a canonical SupportLevel string. */
export function isSupportLevel(value: unknown): value is SupportLevel {
  return typeof value === 'string' && (SUPPORT_LEVELS as readonly string[]).includes(value);
}

/** Compare two levels; negative if `left` is weaker than `right`. */
export function compareSupportLevels(left: SupportLevel, right: SupportLevel): number {
  return supportLevelRank[left] - supportLevelRank[right];
}

/**
 * Cap a level so it never exceeds `max`. Used to enforce the generated-artifact
 * rule and missing hardware-record demotions.
 */
export function capSupportLevel(level: SupportLevel, max: SupportLevel): SupportLevel {
  return compareSupportLevels(level, max) > 0 ? max : level;
}

/**
 * ISO date (YYYY-MM-DD) or full ISO timestamp from a `hardware/records/` entry.
 * Rejects empty / whitespace-only strings.
 */
export function isDatedHardwareRecord(recordDate: string | undefined | null): boolean {
  if (recordDate === undefined || recordDate === null) return false;
  const trimmed = recordDate.trim();
  if (trimmed.length === 0) return false;
  // Accept YYYY-MM-DD or fuller ISO-8601; require a parseable date prefix.
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (!match) return false;
  const parsed = Date.parse(match[1]!);
  return !Number.isNaN(parsed);
}

export interface SupportLevelOptions {
  /**
   * When true, the subject is generator/auto-built output and must not claim
   * HARDWARE_VERIFIED without a dated hardware record (and even then the
   * caller must supply that record via `hardwareRecordDate`).
   */
  generated?: boolean;
  /** Dated hardware record (`hardware/records/…`); required for L5 / HARDWARE_*. */
  hardwareRecordDate?: string | null;
}

/**
 * Enforce: generated/auto-built things never exceed COMPILE_TESTED without a
 * dated hardware/records entry. Also demotes HARDWARE_VERIFIED claims that
 * lack a dated record.
 */
export function applyEvidenceRules(
  level: SupportLevel,
  options: SupportLevelOptions = {},
): SupportLevel {
  const hasRecord = isDatedHardwareRecord(options.hardwareRecordDate);
  let resolved = level;
  if (resolved === 'HARDWARE_VERIFIED' && !hasRecord) {
    resolved = 'COMPILE_TESTED';
  }
  if (options.generated && !hasRecord) {
    resolved = capSupportLevel(resolved, 'COMPILE_TESTED');
  }
  return resolved;
}

/** Map module-manifest status → SupportLevel. */
export function mapFromManifestStatus(
  status: ManifestStatus,
  options: SupportLevelOptions = {},
): SupportLevel {
  const mapped: SupportLevel =
    status === 'CANDIDATE' ? 'UNKNOWN' : status === 'REVIEWED' ? 'SIMULATED' : 'COMPILE_TESTED';
  return applyEvidenceRules(mapped, options);
}

/** Map spec SupportStatus → SupportLevel. */
export function mapFromSupportStatus(
  status: SupportStatusInput,
  options: SupportLevelOptions = {},
): SupportLevel {
  let mapped: SupportLevel;
  switch (status) {
    case 'SIMULATED':
      mapped = 'SIMULATED';
      break;
    case 'COMPILE_TESTED':
    case 'IMPLEMENTED':
      mapped = 'COMPILE_TESTED';
      break;
    case 'HARDWARE_VERIFIED':
      mapped = 'HARDWARE_VERIFIED';
      break;
    case 'PLANNED':
    case 'EXPERIMENTAL':
    default:
      mapped = 'UNKNOWN';
      break;
  }
  return applyEvidenceRules(mapped, options);
}

/** Map a `hardware/catalog.json` status → SupportLevel. */
export function mapFromCatalogStatus(
  status: CatalogStatus,
  options: SupportLevelOptions = {},
): SupportLevel {
  let mapped: SupportLevel;
  switch (status) {
    case 'SIMULATED':
      mapped = 'SIMULATED';
      break;
    case 'COMPILE_TESTED':
    case 'IMPLEMENTED':
    case 'INTEGRATION_VERIFIED':
      mapped = 'COMPILE_TESTED';
      break;
    case 'HARDWARE_VERIFIED':
      mapped = 'HARDWARE_VERIFIED';
      break;
    case 'PLANNED':
    case 'SPEC_ONLY':
    case 'EXPERIMENTAL':
    default:
      mapped = 'UNKNOWN';
      break;
  }
  return applyEvidenceRules(mapped, options);
}

/**
 * Map conformance L0–L5 → SupportLevel.
 * L5 maps to HARDWARE_VERIFIED only when a dated hardware record is supplied;
 * otherwise it demotes to COMPILE_TESTED.
 */
export function mapFromConformanceLevel(
  level: ConformanceLevelInput,
  options: SupportLevelOptions = {},
): SupportLevel {
  let mapped: SupportLevel;
  switch (level) {
    case 'L0':
    case 'L1':
    case 'L2':
      mapped = 'UNKNOWN';
      break;
    case 'L3':
      mapped = 'SIMULATED';
      break;
    case 'L4':
      mapped = 'COMPILE_TESTED';
      break;
    case 'L5':
      mapped = 'HARDWARE_VERIFIED';
      break;
    default:
      mapped = 'UNKNOWN';
      break;
  }
  return applyEvidenceRules(mapped, options);
}

/**
 * Map generator lifecycle → SupportLevel.
 * HARDWARE_TESTED requires a dated record; generated artifacts are capped at
 * COMPILE_TESTED without one.
 */
export function mapFromGeneratorLifecycle(
  lifecycle: GeneratorLifecycle,
  options: SupportLevelOptions = {},
): SupportLevel {
  let mapped: SupportLevel;
  switch (lifecycle) {
    case 'GENERATED':
    case 'CONFORMANCE_PASSED':
      mapped = 'UNKNOWN';
      break;
    case 'SIMULATION_TESTED':
      mapped = 'SIMULATED';
      break;
    case 'HUMAN_REVIEWED':
      mapped = 'COMPILE_TESTED';
      break;
    case 'HARDWARE_TESTED':
      mapped = 'HARDWARE_VERIFIED';
      break;
    default:
      mapped = 'UNKNOWN';
      break;
  }
  // Generator output is always treated as generated unless the caller opts out.
  const generated = options.generated !== false;
  return applyEvidenceRules(mapped, { ...options, generated });
}
