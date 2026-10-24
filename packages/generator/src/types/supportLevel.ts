/**
 * Re-export canonical SupportLevel from `@pinout/core` (PR0).
 * Generator connectors always pass `generated: true` so evidence never exceeds
 * COMPILE_TESTED without a dated hardware/records entry.
 */
import type { SupportLevel } from '@pinout/core';

export {
  SUPPORT_LEVELS,
  applyEvidenceRules,
  capSupportLevel,
  compareSupportLevels,
  isSupportLevel,
  mapFromGeneratorLifecycle,
  mapFromSupportStatus,
  type GeneratorLifecycle,
  type SupportLevel,
  type SupportLevelOptions,
} from '@pinout/core';

/**
 * Evidence levels `generateConnector` may return after applying
 * `mapFromGeneratorLifecycle` + `applyEvidenceRules({ generated: true })`.
 * Never HARDWARE_VERIFIED without a dated hardware record (and generation
 * does not produce one).
 */
export type GeneratorEvidenceLevel = Extract<
  SupportLevel,
  'UNKNOWN' | 'SIMULATED' | 'COMPILE_TESTED'
>;
