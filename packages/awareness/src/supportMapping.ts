/**
 * Map core SupportLevel onto DeviceGraph SupportStatus.
 *
 * SupportLevel is the PR0 evidence ladder; SupportStatus remains the broader
 * graph/catalog vocabulary (IMPLEMENTED, PLANNED, EXPERIMENTAL, …).
 */
import type { SupportLevel, SupportStatus } from '@pinout/core';

export function supportLevelToSupportStatus(level: SupportLevel): SupportStatus {
  switch (level) {
    case 'SIMULATED':
      return 'SIMULATED';
    case 'COMPILE_TESTED':
      return 'COMPILE_TESTED';
    case 'HARDWARE_VERIFIED':
      return 'HARDWARE_VERIFIED';
    case 'UNKNOWN':
    default:
      return 'EXPERIMENTAL';
  }
}

/** @deprecated Prefer supportLevelToSupportStatus. */
export const evidenceLevelToSupportStatus = supportLevelToSupportStatus;
