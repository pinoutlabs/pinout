import { DeviceError } from '../../errors.js';
import { createLogger } from '../../logger.js';
import {
  computeFreshness,
  recordAcknowledged,
  recordCommanded,
  unknownEvidence,
  type EvidenceState,
} from '../../spec/evidence.js';
import type { BackendInvocationContext, DeviceBackend } from '../../runtime/types.js';
import {
  assertAngleInLimits,
  currentAnglesFromConfig,
  validatePanTiltConfig,
  type PanTiltArmedState,
  type PanTiltAxisAngles,
  type PanTiltAxisName,
  type PanTiltStatus,
  type ValidatedPanTiltConfig,
} from './types.js';

export class SimulatedPanTiltBackend implements DeviceBackend {
  readonly kind = 'simulated' as const;
  private readonly config: ValidatedPanTiltConfig;
  private armedState: PanTiltArmedState = 'disarmed';
  private anglesEvidence: EvidenceState<PanTiltAxisAngles>;
  private armedEvidence: EvidenceState<PanTiltArmedState>;
  private panAngle: number;
  private tiltAngle: number | undefined;
  private readonly listeners = new Set<(event: string, payload: Record<string, unknown>) => void>();
  private closed = false;

  constructor(options: Record<string, unknown> = {}) {
    this.config = validatePanTiltConfig(options);
    this.panAngle = this.config.pan.safeAngle;
    this.tiltAngle = this.config.tilt?.safeAngle;
    this.anglesEvidence = unknownEvidence<PanTiltAxisAngles>(this.config.provenance);
    this.armedEvidence = unknownEvidence<PanTiltArmedState>(this.config.provenance);

    if (this.config.autoArm) {
      createLogger('warn', { module: 'pinout:panTilt' }).warn(
        'autoArm is enabled on simulated pan-tilt backend; this is for demo/testing only and bypasses explicit arming safety.',
      );
      this.armedState = 'armed';
      this.armedEvidence = recordAcknowledged(
        this.armedEvidence,
        'armed',
        null,
        this.config.provenance,
      );
    } else {
      this.armedState = 'disarmed';
      this.armedEvidence = recordAcknowledged(
        this.armedEvidence,
        'disarmed',
        null,
        this.config.provenance,
      );
    }

    const initialAngles = this.snapshotAngles();
    this.anglesEvidence = recordAcknowledged(
      this.anglesEvidence,
      initialAngles,
      null,
      this.config.provenance,
    );
  }

  subscribe(handler: (event: string, payload: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
  }

  getOperationalState(): Record<string, unknown> {
    return this.buildStatus();
  }

  getOperationalStateEvidence(): Record<string, EvidenceState<unknown>> {
    const now = Date.now();
    const freshAngles = computeFreshness(
      this.anglesEvidence,
      now,
      this.config.observationMaxAgeMs,
    );
    const freshArmed = computeFreshness(this.armedEvidence, now);
    return {
      angles: freshAngles as EvidenceState<unknown>,
      armed: freshArmed as EvidenceState<unknown>,
    };
  }

  async arm(options: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    const timeoutMs =
      typeof options.timeoutMs === 'number'
        ? options.timeoutMs
        : (this.config.watchdogTimeoutMs ?? 1000);
    this.armedState = 'armed';
    this.armedEvidence = recordAcknowledged(
      this.armedEvidence,
      'armed',
      null,
      this.config.provenance,
    );
    return { armed: 'armed', timeoutMs };
  }

  async disarm(): Promise<Record<string, unknown>> {
    const safeAngles = this.applySafeAngles();
    this.armedState = 'disarmed';
    this.armedEvidence = recordAcknowledged(
      this.armedEvidence,
      'disarmed',
      null,
      this.config.provenance,
    );
    this.emit('safe_state.applied', {
      pan: this.config.pan.safeAngle,
      tilt: this.config.tilt?.safeAngle,
      angles: safeAngles,
    });
    return { armed: 'disarmed', angles: safeAngles };
  }

  async safeState(): Promise<Record<string, unknown>> {
    const angles = this.applySafeAngles();
    this.armedState = 'disarmed';
    this.armedEvidence = recordAcknowledged(
      this.armedEvidence,
      'disarmed',
      null,
      this.config.provenance,
    );
    this.emit('safe_state.applied', { angles });
    return { applied: true, angles };
  }

  injectTrip(reason = 'WATCHDOG_EXPIRED'): void {
    this.applySafeAngles();
    this.armedState = 'tripped';
    this.armedEvidence = recordAcknowledged(
      this.armedEvidence,
      'tripped',
      null,
      this.config.provenance,
    );
    this.emit('device.tripped', {
      reason,
      stoppedPins: [
        this.config.pan.pin,
        ...(this.config.tilt ? [this.config.tilt.pin] : []),
      ],
    });
  }

  async invoke(
    action: string,
    payload: Record<string, unknown> = {},
    _context: BackendInvocationContext = {},
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new DeviceError('DISCONNECTED', 'Simulated pan-tilt backend is closed.');
    }

    if (action === 'panTilt.status' || action === 'status.read') {
      return this.buildStatus();
    }

    if (action === 'panTilt.arm') {
      const timeoutMs =
        typeof payload.timeoutMs === 'number'
          ? payload.timeoutMs
          : (this.config.watchdogTimeoutMs ?? 1000);
      return this.arm({ timeoutMs });
    }

    if (action === 'panTilt.disarm') {
      return this.disarm();
    }

    if (action === 'panTilt.setAngles') {
      this.assertArmedForActuation();
      const next = this.resolveSetAnglesPayload(payload);
      return this.commitAngles(next);
    }

    if (action === 'panTilt.setAngle') {
      this.assertArmedForActuation();
      const axis = this.resolveAxis(payload.axis);
      if (typeof payload.angle !== 'number') {
        throw new DeviceError('INVALID_PAYLOAD', 'panTilt.setAngle requires a numeric angle.');
      }
      const next = { ...this.snapshotAngles() };
      if (axis === 'pan') {
        next.pan = assertAngleInLimits(payload.angle, this.config.pan, 'pan');
      } else {
        if (!this.config.tilt) {
          throw new DeviceError(
            'UNSUPPORTED_CONFIGURATION',
            'Tilt axis is not commissioned on this pan-tilt device.',
          );
        }
        next.tilt = assertAngleInLimits(payload.angle, this.config.tilt, 'tilt');
      }
      const result = this.commitAngles(next);
      return { axis, angle: payload.angle, ...result };
    }

    throw new DeviceError('UNKNOWN_ACTION', `Unknown action '${action}'.`);
  }

  private resolveAxis(value: unknown): PanTiltAxisName {
    if (value === undefined || value === 'pan') {
      return 'pan';
    }
    if (value === 'tilt') {
      return 'tilt';
    }
    throw new DeviceError('INVALID_PAYLOAD', 'axis must be "pan" or "tilt".');
  }

  private resolveSetAnglesPayload(payload: Record<string, unknown>): PanTiltAxisAngles {
    const hasPan = payload.pan !== undefined;
    const hasTilt = payload.tilt !== undefined;
    if (!hasPan && !hasTilt) {
      throw new DeviceError(
        'INVALID_PAYLOAD',
        'panTilt.setAngles requires at least one of pan or tilt.',
      );
    }

    const next = { ...this.snapshotAngles() };
    if (hasPan) {
      next.pan = assertAngleInLimits(payload.pan as number, this.config.pan, 'pan');
    }
    if (hasTilt) {
      if (!this.config.tilt) {
        throw new DeviceError(
          'UNSUPPORTED_CONFIGURATION',
          'Tilt axis is not commissioned on this pan-tilt device.',
        );
      }
      next.tilt = assertAngleInLimits(payload.tilt as number, this.config.tilt, 'tilt');
    }
    return next;
  }

  private assertArmedForActuation(): void {
    if (this.armedState === 'disarmed') {
      throw new DeviceError(
        'NOT_ARMED',
        'Device is disarmed. Explicit arming (panTilt.arm) is required before actuation.',
      );
    }
    if (this.armedState === 'tripped') {
      throw new DeviceError(
        'WATCHDOG_TRIPPED',
        'Device watchdog tripped. Re-arming (panTilt.arm) is required before actuation.',
      );
    }
  }

  private commitAngles(angles: PanTiltAxisAngles): Record<string, unknown> {
    const now = new Date();
    this.panAngle = angles.pan;
    this.tiltAngle = angles.tilt;
    this.anglesEvidence = recordCommanded(this.anglesEvidence, angles, now, this.config.provenance);
    this.anglesEvidence = recordAcknowledged(
      this.anglesEvidence,
      angles,
      now,
      this.config.provenance,
    );
    this.emit('panTilt.changed', { angles });
    return { angles: this.snapshotAngles() };
  }

  private applySafeAngles(): PanTiltAxisAngles {
    const safe = currentAnglesFromConfig(
      this.config,
      this.config.pan.safeAngle,
      this.config.tilt?.safeAngle,
    );
    const now = new Date();
    this.panAngle = safe.pan;
    this.tiltAngle = safe.tilt;
    this.anglesEvidence = recordCommanded(this.anglesEvidence, safe, now, this.config.provenance);
    this.anglesEvidence = recordAcknowledged(
      this.anglesEvidence,
      safe,
      now,
      this.config.provenance,
    );
    this.emit('panTilt.changed', { angles: safe, reason: 'safe_angle' });
    return this.snapshotAngles();
  }

  private snapshotAngles(): PanTiltAxisAngles {
    return currentAnglesFromConfig(this.config, this.panAngle, this.tiltAngle);
  }

  private buildStatus(): PanTiltStatus {
    const now = Date.now();
    const freshAngles = computeFreshness(
      this.anglesEvidence,
      now,
      this.config.observationMaxAgeMs,
    );
    const freshArmed = computeFreshness(this.armedEvidence, now);
    const angles = this.snapshotAngles();
    const commandedValue = freshAngles.commanded.value;
    const acknowledgedValue = freshAngles.acknowledged.value;

    return {
      commanded: {
        value: commandedValue,
        pan: commandedValue?.pan ?? null,
        tilt: commandedValue?.tilt ?? null,
        at: freshAngles.commanded.at,
        source: freshAngles.commanded.source,
      },
      acknowledged: {
        value: acknowledgedValue,
        pan: acknowledgedValue?.pan ?? null,
        tilt: acknowledgedValue?.tilt ?? null,
        at: freshAngles.acknowledged.at,
        source: freshAngles.acknowledged.source,
      },
      observed: {
        value: null,
        pan: null,
        tilt: null,
        at: null,
        source: 'none',
      },
      freshnessMs: freshAngles.freshnessMs,
      stale: freshAngles.stale,
      provenance: freshAngles.provenance,
      armed: this.armedState,
      angles,
      axes: {
        pan: this.config.pan,
        ...(this.config.tilt ? { tilt: this.config.tilt } : {}),
      },
      evidence: {
        angles: freshAngles,
        armed: freshArmed,
      },
    };
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener(event, payload);
    }
  }
}

export function createSimulatedPanTiltBackend(
  options: Record<string, unknown> = {},
): DeviceBackend {
  return new SimulatedPanTiltBackend(options);
}
