import { connect } from '../../connect.js';
import { DeviceError } from '../../errors.js';
import { createLogger } from '../../logger.js';
import { simulatedEsp32 } from '../../drivers/esp32/simulatedTransport.js';
import { ProtocolDeviceBackend } from '../../runtime/protocolBackend.js';
import {
  computeFreshness,
  recordAcknowledged,
  recordCommanded,
  unknownEvidence,
  type EvidenceState,
} from '../../spec/evidence.js';
import type { BackendInvocationContext, DeviceBackend } from '../../runtime/types.js';
import type { Device } from '../../device.js';
import type { Transport } from '../../types.js';
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

/**
 * ESP32 pan-tilt backend.
 *
 * Physical path uses existing firmware `gpio.servo` (50 Hz hobby PWM). That
 * firmware action is COMPILE_TESTED only — this backend does not claim HIL
 * verification for attached servos.
 */
export class Esp32PanTiltBackend implements DeviceBackend {
  readonly kind = 'protocol' as const;
  private readonly device: Device;
  private readonly protocolBackend: ProtocolDeviceBackend;
  private readonly config: ValidatedPanTiltConfig;
  private anglesEvidence: EvidenceState<PanTiltAxisAngles>;
  private armedEvidence: EvidenceState<PanTiltArmedState>;
  private panAngle: number;
  private tiltAngle: number | undefined;
  private readonly listeners = new Set<(event: string, payload: Record<string, unknown>) => void>();
  private closed = false;

  private constructor(
    device: Device,
    protocolBackend: ProtocolDeviceBackend,
    config: ValidatedPanTiltConfig,
  ) {
    this.device = device;
    this.protocolBackend = protocolBackend;
    this.config = config;
    this.panAngle = config.pan.safeAngle;
    this.tiltAngle = config.tilt?.safeAngle;
    this.anglesEvidence = unknownEvidence<PanTiltAxisAngles>(this.config.provenance);
    this.armedEvidence = unknownEvidence<PanTiltArmedState>(this.config.provenance);
    this.armedEvidence = recordAcknowledged(
      this.armedEvidence,
      this.config.autoArm ? 'armed' : 'disarmed',
      null,
      this.config.provenance,
    );
    this.anglesEvidence = recordAcknowledged(
      this.anglesEvidence,
      this.snapshotAngles(),
      null,
      this.config.provenance,
    );

    this.device.on('device.tripped', (payload) => {
      this.armedEvidence = recordAcknowledged(
        this.armedEvidence,
        'tripped',
        null,
        this.config.provenance,
      );
      this.emit('device.tripped', payload);
    });
  }

  static async create(options: Record<string, unknown> = {}): Promise<Esp32PanTiltBackend> {
    const config = validatePanTiltConfig(options);
    if (config.autoArm) {
      createLogger('warn', { module: 'pinout:panTilt' }).warn(
        'autoArm is enabled on pan-tilt backend; this is for demo/testing only and bypasses explicit arming safety.',
      );
    }
    const transport =
      (config.transport as Transport | undefined) ??
      (options.transport as Transport | undefined) ??
      simulatedEsp32();
    const device = (config.device as Device | undefined) ?? (await connect({ transport }));

    // Servo PWM does not use digital safeLevel; ProtocolDeviceBackend still
    // commissions pins for stopAll bookkeeping with hold polarity defaults.
    const outputs = [
      { pin: config.pan.pin, safeLevel: 'hold' as const, polarity: 'active-high' as const },
      ...(config.tilt
        ? [{ pin: config.tilt.pin, safeLevel: 'hold' as const, polarity: 'active-high' as const }]
        : []),
    ];

    const protocolBackend = new ProtocolDeviceBackend(device, {
      outputs,
      requireWatchdog: config.requireWatchdog,
      autoHeartbeat: config.autoHeartbeat,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      watchdogTimeoutMs: config.watchdogTimeoutMs,
      autoArm: config.autoArm,
    });

    if (config.autoArm) {
      await protocolBackend.arm({
        timeoutMs: config.watchdogTimeoutMs,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        requireWatchdog: config.requireWatchdog,
      });
      await driveServoAngles(device, config, {
        pan: config.pan.safeAngle,
        tilt: config.tilt?.safeAngle,
      });
    } else {
      await protocolBackend.initializeOutputs();
    }

    return new Esp32PanTiltBackend(device, protocolBackend, config);
  }

  subscribe(handler: (event: string, payload: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    await this.protocolBackend.close();
  }

  getOperationalState(): Record<string, unknown> {
    return this.buildStatusFromProtocol();
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

  async invoke(
    action: string,
    payload: Record<string, unknown> = {},
    context: BackendInvocationContext = {},
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new DeviceError('DISCONNECTED', 'ESP32 pan-tilt backend is closed.');
    }

    if (action === 'panTilt.status' || action === 'status.read') {
      return this.buildStatusFromProtocol();
    }

    if (action === 'panTilt.arm') {
      const armOptions: {
        timeoutMs?: number;
        heartbeatIntervalMs?: number;
        requireWatchdog?: boolean;
      } = {
        requireWatchdog: this.config.requireWatchdog,
      };
      if (typeof payload.timeoutMs === 'number') {
        armOptions.timeoutMs = payload.timeoutMs;
      } else if (this.config.watchdogTimeoutMs !== undefined) {
        armOptions.timeoutMs = this.config.watchdogTimeoutMs;
      }
      if (this.config.heartbeatIntervalMs !== undefined) {
        armOptions.heartbeatIntervalMs = this.config.heartbeatIntervalMs;
      }

      const armResult = await this.protocolBackend.arm(armOptions);
      this.armedEvidence = recordAcknowledged(
        this.armedEvidence,
        'armed',
        null,
        this.config.provenance,
      );
      return {
        armed: 'armed',
        timeoutMs:
          typeof armResult.timeoutMs === 'number'
            ? armResult.timeoutMs
            : (armOptions.timeoutMs ?? 1000),
      };
    }

    if (action === 'panTilt.disarm') {
      // Drive safe angles while still armed, then disarm (sys.disarm / stopAll).
      const safeAngles = await this.applySafeAnglesOnDevice(context);
      await this.protocolBackend.disarm();
      this.armedEvidence = recordAcknowledged(
        this.armedEvidence,
        'disarmed',
        null,
        this.config.provenance,
      );
      this.emit('safe_state.applied', { angles: safeAngles });
      return { armed: 'disarmed', angles: safeAngles };
    }

    if (action === 'panTilt.setAngles') {
      this.assertArmedForActuation();
      const next = this.resolveSetAnglesPayload(payload);
      return this.commitAnglesOnDevice(next, payload, context);
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
      const result = await this.commitAnglesOnDevice(next, payload, context);
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
    const opState = this.protocolBackend.getOperationalState();
    if (opState.state === 'disarmed') {
      throw new DeviceError(
        'NOT_ARMED',
        'Device is disarmed. Explicit arming (panTilt.arm) is required before actuation.',
      );
    }
    if (opState.state === 'tripped') {
      throw new DeviceError(
        'WATCHDOG_TRIPPED',
        'Device watchdog tripped. Re-arming (panTilt.arm) is required before actuation.',
      );
    }
  }

  private async commitAnglesOnDevice(
    angles: PanTiltAxisAngles,
    payload: Record<string, unknown>,
    context: BackendInvocationContext,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    this.anglesEvidence = recordCommanded(this.anglesEvidence, angles, now, this.config.provenance);

    const validityMs = typeof payload.validityMs === 'number' ? payload.validityMs : undefined;
    await driveServoAngles(this.device, this.config, angles, validityMs, context);

    this.panAngle = angles.pan;
    this.tiltAngle = angles.tilt;
    this.anglesEvidence = recordAcknowledged(
      this.anglesEvidence,
      angles,
      now,
      this.config.provenance,
    );
    this.emit('panTilt.changed', { angles });
    return { angles: this.snapshotAngles() };
  }

  private async applySafeAnglesOnDevice(
    context: BackendInvocationContext,
  ): Promise<PanTiltAxisAngles> {
    const safe = currentAnglesFromConfig(
      this.config,
      this.config.pan.safeAngle,
      this.config.tilt?.safeAngle,
    );
    const now = new Date();
    this.anglesEvidence = recordCommanded(this.anglesEvidence, safe, now, this.config.provenance);
    await driveServoAngles(this.device, this.config, safe, undefined, context);
    this.panAngle = safe.pan;
    this.tiltAngle = safe.tilt;
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

  private buildStatusFromProtocol(): PanTiltStatus {
    const opState = this.protocolBackend.getOperationalState();
    const armedState = (opState.state as PanTiltArmedState) ?? 'unknown';
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
      // Honesty rule: hobby servos without independent feedback do not claim observed position.
      observed: {
        value: null,
        pan: null,
        tilt: null,
        at: null,
        source: 'none',
      },
      freshnessMs: freshAngles.freshnessMs,
      stale: freshAngles.stale,
      provenance: this.config.provenance,
      armed: armedState,
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

async function driveServoAngles(
  device: Device,
  config: ValidatedPanTiltConfig,
  angles: PanTiltAxisAngles,
  validityMs?: number,
  context: BackendInvocationContext = {},
): Promise<void> {
  const invokeOptions = context.signal ? { signal: context.signal } : {};
  const panPayload: Record<string, unknown> = { pin: config.pan.pin, angle: angles.pan };
  if (validityMs !== undefined) {
    panPayload.validityMs = validityMs;
  }
  await device.invoke('gpio.servo', panPayload, invokeOptions);

  if (config.tilt && angles.tilt !== undefined) {
    const tiltPayload: Record<string, unknown> = { pin: config.tilt.pin, angle: angles.tilt };
    if (validityMs !== undefined) {
      tiltPayload.validityMs = validityMs;
    }
    await device.invoke('gpio.servo', tiltPayload, invokeOptions);
  }
}

export async function createEsp32PanTiltBackend(
  options: Record<string, unknown> = {},
): Promise<DeviceBackend> {
  return Esp32PanTiltBackend.create(options);
}
