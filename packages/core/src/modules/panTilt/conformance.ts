import { DeviceError } from '../../errors.js';
import type { DeviceBackend } from '../../runtime/types.js';
import { validatePanTiltConfig, type PanTiltStatus } from './types.js';

export interface PanTiltBackendLike extends DeviceBackend {
  injectTrip?(reason?: string): void;
}

export type PanTiltCheckStatus = 'passed' | 'failed' | 'skipped';

export interface PanTiltConformanceCheck {
  name: string;
  status: PanTiltCheckStatus;
  detail?: string;
}

export interface PanTiltConformanceResult {
  passed: boolean;
  checks: PanTiltConformanceCheck[];
}

export async function runPanTiltConformance(
  factory: (options?: Record<string, unknown>) => Promise<PanTiltBackendLike> | PanTiltBackendLike,
): Promise<PanTiltConformanceResult> {
  const checks: PanTiltConformanceCheck[] = [];

  const recordPass = (name: string, detail?: string) =>
    checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) });
  const recordFail = (name: string, detail?: string) =>
    checks.push({ name, status: 'failed', ...(detail ? { detail } : {}) });
  const recordSkip = (name: string, detail?: string) =>
    checks.push({ name, status: 'skipped', ...(detail ? { detail } : {}) });

  // 1. Safe angle outside limits rejected
  try {
    validatePanTiltConfig(
      { panPin: 13, pan: { pin: 13, minAngle: 20, maxAngle: 160, safeAngle: 10 } },
      false,
    );
    recordFail(
      'safe angle within limits validation',
      'Configuration with safeAngle outside min/max was not rejected.',
    );
  } catch (error) {
    if (
      (error instanceof DeviceError && error.code === 'UNSUPPORTED_CONFIGURATION') ||
      (error instanceof Error && /safeAngle|UNSUPPORTED_CONFIGURATION/i.test(error.message))
    ) {
      recordPass('safe angle within limits validation');
    } else {
      recordFail(
        'safe angle within limits validation',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // 2. Duplicate pan/tilt pins rejected
  try {
    validatePanTiltConfig({ panPin: 13, tiltPin: 13 }, false);
    recordFail('distinct axis pins validation', 'Duplicate pan/tilt pins were not rejected.');
  } catch (error) {
    if (
      (error instanceof DeviceError && error.code === 'UNSUPPORTED_CONFIGURATION') ||
      (error instanceof Error && /distinct|UNSUPPORTED_CONFIGURATION/i.test(error.message))
    ) {
      recordPass('distinct axis pins validation');
    } else {
      recordFail(
        'distinct axis pins validation',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  let backend: PanTiltBackendLike | undefined;
  try {
    backend = await factory({
      pan: { pin: 13, minAngle: 0, maxAngle: 180, safeAngle: 90 },
      tilt: { pin: 14, minAngle: 10, maxAngle: 170, safeAngle: 90 },
      simulated: true,
    });
  } catch (error) {
    recordFail('backend instantiation', error instanceof Error ? error.message : String(error));
    return finalize(checks);
  }

  try {
    const initialStatus = (await backend.invoke('panTilt.status', {})) as PanTiltStatus;
    if (initialStatus.armed === 'disarmed') {
      recordPass('disarmed at start');
    } else {
      recordFail(
        'disarmed at start',
        `Expected initial state 'disarmed', got '${String(initialStatus.armed)}'.`,
      );
    }

    let rejectedWhileDisarmed = false;
    try {
      await backend.invoke('panTilt.setAngles', { pan: 45 });
    } catch (error) {
      if (
        (error instanceof DeviceError && error.code === 'NOT_ARMED') ||
        (error instanceof Error && /NOT_ARMED|disarmed/i.test(error.message))
      ) {
        rejectedWhileDisarmed = true;
      }
    }
    if (rejectedWhileDisarmed) {
      recordPass('actuation rejected before arm');
    } else {
      recordFail(
        'actuation rejected before arm',
        'panTilt.setAngles did not throw NOT_ARMED when disarmed.',
      );
    }

    const armResult = await backend.invoke('panTilt.arm', { timeoutMs: 5000 });
    if (armResult.armed === 'armed') {
      recordPass('explicit arm');
    } else {
      recordFail(
        'explicit arm',
        `Expected { armed: 'armed' }, received ${JSON.stringify(armResult)}.`,
      );
    }

    const setResult = await backend.invoke('panTilt.setAngles', { pan: 30, tilt: 40 });
    const statusAfterSet = (await backend.invoke('panTilt.status', {})) as PanTiltStatus;
    const anglesOk =
      (setResult.angles as { pan?: number; tilt?: number } | undefined)?.pan === 30 &&
      (setResult.angles as { pan?: number; tilt?: number } | undefined)?.tilt === 40 &&
      statusAfterSet.commanded?.pan === 30 &&
      statusAfterSet.acknowledged?.pan === 30 &&
      statusAfterSet.observed?.source === 'none' &&
      statusAfterSet.observed?.pan === null;

    if (anglesOk) {
      recordPass('set angles and honest evidence');
    } else {
      recordFail(
        'set angles and honest evidence',
        `Unexpected result/status: ${JSON.stringify({ setResult, statusAfterSet })}`,
      );
    }

    let rejectedOutOfLimits = false;
    try {
      await backend.invoke('panTilt.setAngle', { axis: 'tilt', angle: 5 });
    } catch (error) {
      if (
        (error instanceof DeviceError && error.code === 'INVALID_PAYLOAD') ||
        (error instanceof Error && /outside commissioned limits|INVALID_PAYLOAD/i.test(error.message))
      ) {
        rejectedOutOfLimits = true;
      }
    }
    if (rejectedOutOfLimits) {
      recordPass('angle limit enforcement');
    } else {
      recordFail('angle limit enforcement', 'Out-of-range tilt angle was not rejected.');
    }

    const disarmResult = await backend.invoke('panTilt.disarm', {});
    const statusAfterDisarm = (await backend.invoke('panTilt.status', {})) as PanTiltStatus;
    let rejectedAfterDisarm = false;
    try {
      await backend.invoke('panTilt.setAngles', { pan: 20 });
    } catch {
      rejectedAfterDisarm = true;
    }

    const safeAnglesApplied =
      disarmResult.armed === 'disarmed' &&
      (disarmResult.angles as { pan?: number; tilt?: number } | undefined)?.pan === 90 &&
      (disarmResult.angles as { pan?: number; tilt?: number } | undefined)?.tilt === 90 &&
      statusAfterDisarm.angles?.pan === 90 &&
      statusAfterDisarm.armed === 'disarmed' &&
      rejectedAfterDisarm;

    if (safeAnglesApplied) {
      recordPass('disarm applies safe angles');
    } else {
      recordFail(
        'disarm applies safe angles',
        `Disarm did not apply safe angles or block actuation: ${JSON.stringify({
          disarmResult,
          statusAfterDisarm,
          rejectedAfterDisarm,
        })}`,
      );
    }

    if (typeof backend.injectTrip === 'function') {
      await backend.invoke('panTilt.arm', { timeoutMs: 1000 });
      backend.injectTrip('TEST_TRIP');
      const trippedStatus = (await backend.invoke('panTilt.status', {})) as PanTiltStatus;
      let rejectedWhileTripped = false;
      try {
        await backend.invoke('panTilt.setAngles', { pan: 50 });
      } catch (error) {
        if (
          (error instanceof DeviceError && error.code === 'WATCHDOG_TRIPPED') ||
          (error instanceof Error && /WATCHDOG_TRIPPED|tripped/i.test(error.message))
        ) {
          rejectedWhileTripped = true;
        }
      }

      const rearmResult = await backend.invoke('panTilt.arm', { timeoutMs: 5000 });
      const rearmSet = await backend.invoke('panTilt.setAngle', { angle: 55 });

      if (
        trippedStatus.armed === 'tripped' &&
        rejectedWhileTripped &&
        rearmResult.armed === 'armed' &&
        (rearmSet.angle as number | undefined) === 55
      ) {
        recordPass('trip recovery and re-arm');
      } else {
        recordFail(
          'trip recovery and re-arm',
          'Trip state did not block actuation or recover on panTilt.arm.',
        );
      }
    } else {
      recordSkip('trip recovery and re-arm', 'Backend does not implement injectTrip() hook.');
    }

    const finalStatus = (await backend.invoke('panTilt.status', {})) as PanTiltStatus;
    if (finalStatus.provenance === 'simulated' || finalStatus.provenance === 'hardware') {
      recordPass('honest provenance declaration');
    } else {
      recordFail(
        'honest provenance declaration',
        `Invalid provenance: '${String(finalStatus.provenance)}'.`,
      );
    }

    if (typeof backend.getOperationalStateEvidence === 'function') {
      const evidenceMap = backend.getOperationalStateEvidence();
      if (
        evidenceMap &&
        typeof evidenceMap === 'object' &&
        'angles' in evidenceMap &&
        'armed' in evidenceMap
      ) {
        recordPass('generic evidence contract getOperationalStateEvidence');
      } else {
        recordFail(
          'generic evidence contract getOperationalStateEvidence',
          'Missing angles or armed evidence keys.',
        );
      }
    } else {
      recordFail(
        'generic evidence contract getOperationalStateEvidence',
        'getOperationalStateEvidence() not implemented.',
      );
    }
  } finally {
    if (backend) {
      await backend.close().catch(() => undefined);
    }
  }

  return finalize(checks);
}

function finalize(checks: PanTiltConformanceCheck[]): PanTiltConformanceResult {
  return {
    passed: checks.every((check) => check.status === 'passed' || check.status === 'skipped'),
    checks,
  };
}
