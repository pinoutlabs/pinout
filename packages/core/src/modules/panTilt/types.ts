import { ValidationError, DeviceError } from '../../errors.js';
import { assertGpioPin, assertEsp32WritePin } from '../../drivers/esp32/pins.js';
import type { Transport } from '../../types.js';
import type { Device } from '../../device.js';
import type {
  EvidenceProvenance,
  EvidenceSource,
  EvidenceState,
  EvidenceValue,
} from '../../spec/evidence.js';

export type PanTiltArmedState = 'armed' | 'disarmed' | 'tripped' | 'unknown';
export type PanTiltAxisName = 'pan' | 'tilt';
export type PanTiltObservedSource = Extract<EvidenceSource, 'none' | 'simulated'>;

export interface PanTiltAxisAngles {
  pan: number;
  tilt?: number | undefined;
}

export interface PanTiltAxisLimits {
  pin: number;
  minAngle: number;
  maxAngle: number;
  safeAngle: number;
}

export type PanTiltCommandedState = EvidenceValue<PanTiltAxisAngles> & {
  pan: number | null;
  tilt: number | null;
  [key: string]: unknown;
};

export type PanTiltAcknowledgedState = EvidenceValue<PanTiltAxisAngles> & {
  pan: number | null;
  tilt: number | null;
  [key: string]: unknown;
};

export type PanTiltObservedState = EvidenceValue<PanTiltAxisAngles> & {
  pan: number | null;
  tilt: number | null;
  [key: string]: unknown;
};

export interface PanTiltEvidenceBundle {
  angles: EvidenceState<PanTiltAxisAngles>;
  armed: EvidenceState<PanTiltArmedState>;
  [key: string]: unknown;
}

export interface PanTiltStatus {
  commanded: PanTiltCommandedState;
  acknowledged: PanTiltAcknowledgedState;
  observed: PanTiltObservedState;
  freshnessMs: number | null;
  stale: boolean;
  provenance: EvidenceProvenance;
  armed: PanTiltArmedState;
  angles: PanTiltAxisAngles;
  axes: {
    pan: PanTiltAxisLimits;
    tilt?: PanTiltAxisLimits | undefined;
  };
  evidence: PanTiltEvidenceBundle;
  [key: string]: unknown;
}

export interface PanTiltAxisConfigInput {
  pin?: number | undefined;
  minAngle?: number | undefined;
  maxAngle?: number | undefined;
  safeAngle?: number | undefined;
}

export interface PanTiltConfig {
  pan?: PanTiltAxisConfigInput | undefined;
  tilt?: PanTiltAxisConfigInput | undefined;
  /** Convenience: pan GPIO when `pan` object is omitted. */
  panPin?: number | undefined;
  /** Convenience: optional tilt GPIO when `tilt` object is omitted. */
  tiltPin?: number | undefined;
  requireWatchdog?: boolean | undefined;
  watchdogTimeoutMs?: number | undefined;
  autoArm?: boolean | undefined;
  autoHeartbeat?: boolean | undefined;
  heartbeatIntervalMs?: number | undefined;
  observationMaxAgeMs?: number | undefined;
  provenance?: EvidenceProvenance | undefined;
  simulated?: boolean | undefined;
  transport?: Transport | undefined;
  device?: Device | undefined;
}

export interface ValidatedPanTiltConfig {
  pan: PanTiltAxisLimits;
  tilt?: PanTiltAxisLimits | undefined;
  requireWatchdog: boolean;
  watchdogTimeoutMs?: number | undefined;
  autoArm: boolean;
  autoHeartbeat?: boolean | undefined;
  heartbeatIntervalMs?: number | undefined;
  observationMaxAgeMs: number;
  provenance: EvidenceProvenance;
  simulated: boolean;
  transport?: Transport | undefined;
  device?: Device | undefined;
}

const defaultMinAngle = 0;
const defaultMaxAngle = 180;
const defaultSafeAngle = 90;

function assertFiniteAngle(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number.`);
  }
  return value;
}

function validateAxisConfig(
  rawAxis: PanTiltAxisConfigInput | undefined,
  pinFallback: number | undefined,
  axisName: PanTiltAxisName,
  required: boolean,
): PanTiltAxisLimits | undefined {
  const pinValue = rawAxis?.pin ?? pinFallback;
  if (pinValue === undefined) {
    if (required) {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        `Pan-tilt configuration requires a numeric "${axisName}" pin (or ${axisName}Pin).`,
      );
    }
    return undefined;
  }

  const pin = assertGpioPin(pinValue);
  assertEsp32WritePin(pin);

  const minAngle =
    rawAxis?.minAngle !== undefined
      ? assertFiniteAngle(rawAxis.minAngle, `${axisName}.minAngle`)
      : defaultMinAngle;
  const maxAngle =
    rawAxis?.maxAngle !== undefined
      ? assertFiniteAngle(rawAxis.maxAngle, `${axisName}.maxAngle`)
      : defaultMaxAngle;
  const safeAngle =
    rawAxis?.safeAngle !== undefined
      ? assertFiniteAngle(rawAxis.safeAngle, `${axisName}.safeAngle`)
      : defaultSafeAngle;

  if (minAngle < 0 || maxAngle > 180 || minAngle >= maxAngle) {
    throw new DeviceError(
      'UNSUPPORTED_CONFIGURATION',
      `${axisName} limits must satisfy 0 <= minAngle < maxAngle <= 180.`,
    );
  }
  if (safeAngle < minAngle || safeAngle > maxAngle) {
    throw new DeviceError(
      'UNSUPPORTED_CONFIGURATION',
      `${axisName}.safeAngle must lie within minAngle and maxAngle (disarm → safe angle).`,
    );
  }

  return { pin, minAngle, maxAngle, safeAngle };
}

export function validatePanTiltConfig(
  rawConfig: Record<string, unknown> = {},
  allowEmptyDefaults = true,
): ValidatedPanTiltConfig {
  const isEssentiallyEmpty =
    Object.keys(rawConfig).length === 0 ||
    (Object.keys(rawConfig).length === 1 && rawConfig.simulated !== undefined);

  if (isEssentiallyEmpty && allowEmptyDefaults) {
    return {
      pan: {
        pin: 13,
        minAngle: defaultMinAngle,
        maxAngle: defaultMaxAngle,
        safeAngle: defaultSafeAngle,
      },
      requireWatchdog: true,
      autoArm: false,
      observationMaxAgeMs: 5000,
      simulated: rawConfig.simulated !== false,
      provenance: 'simulated',
      transport: rawConfig.transport as Transport | undefined,
      device: rawConfig.device as Device | undefined,
    };
  }

  const pan = validateAxisConfig(
    rawConfig.pan as PanTiltAxisConfigInput | undefined,
    typeof rawConfig.panPin === 'number' ? rawConfig.panPin : undefined,
    'pan',
    true,
  );
  if (!pan) {
    throw new DeviceError('UNSUPPORTED_CONFIGURATION', 'Pan axis is required.');
  }

  const tilt = validateAxisConfig(
    rawConfig.tilt as PanTiltAxisConfigInput | undefined,
    typeof rawConfig.tiltPin === 'number' ? rawConfig.tiltPin : undefined,
    'tilt',
    false,
  );

  if (tilt && tilt.pin === pan.pin) {
    throw new DeviceError(
      'UNSUPPORTED_CONFIGURATION',
      'Pan and tilt must use distinct GPIO pins.',
    );
  }

  let observationMaxAgeMs = 5000;
  if (rawConfig.observationMaxAgeMs !== undefined) {
    if (
      typeof rawConfig.observationMaxAgeMs !== 'number' ||
      rawConfig.observationMaxAgeMs <= 0 ||
      !Number.isFinite(rawConfig.observationMaxAgeMs)
    ) {
      throw new ValidationError('observationMaxAgeMs must be a positive finite number.');
    }
    observationMaxAgeMs = rawConfig.observationMaxAgeMs;
  }

  const simulated = rawConfig.simulated !== false;
  const provenance: EvidenceProvenance =
    rawConfig.provenance === 'hardware'
      ? 'hardware'
      : ((rawConfig.provenance as EvidenceProvenance | undefined) ?? 'simulated');

  return {
    pan,
    tilt,
    requireWatchdog: rawConfig.requireWatchdog !== false,
    watchdogTimeoutMs:
      typeof rawConfig.watchdogTimeoutMs === 'number' ? rawConfig.watchdogTimeoutMs : undefined,
    autoArm: rawConfig.autoArm === true,
    autoHeartbeat:
      typeof rawConfig.autoHeartbeat === 'boolean' ? rawConfig.autoHeartbeat : undefined,
    heartbeatIntervalMs:
      typeof rawConfig.heartbeatIntervalMs === 'number' ? rawConfig.heartbeatIntervalMs : undefined,
    observationMaxAgeMs,
    provenance,
    simulated,
    transport: rawConfig.transport as Transport | undefined,
    device: rawConfig.device as Device | undefined,
  };
}

export function assertAngleInLimits(
  angle: number,
  limits: PanTiltAxisLimits,
  axisName: PanTiltAxisName,
): number {
  if (!Number.isFinite(angle)) {
    throw new DeviceError('INVALID_PAYLOAD', `${axisName} angle must be a finite number.`);
  }
  if (angle < limits.minAngle || angle > limits.maxAngle) {
    throw new DeviceError(
      'INVALID_PAYLOAD',
      `${axisName} angle ${angle} is outside commissioned limits [${limits.minAngle}, ${limits.maxAngle}].`,
    );
  }
  return angle;
}

export function currentAnglesFromConfig(
  config: ValidatedPanTiltConfig,
  pan: number,
  tilt?: number,
): PanTiltAxisAngles {
  if (config.tilt) {
    return { pan, tilt: tilt ?? config.tilt.safeAngle };
  }
  return { pan };
}
