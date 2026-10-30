/**
 * Universal Robots runtime backend over dashboard + RTDE + URScript.
 *
 * MOTION IS A PHYSICAL SIDE EFFECT. This backend enforces the explicit limits
 * in {@link UrSafetyLimits} (tool speed / acceleration, blend radius, joint
 * speed / acceleration, script size) before anything is sent, performs
 * optional preflight reads of robot mode and safety mode, and never resumes
 * motion automatically: after a stop, restarting requires an explicit
 * `ur.play_program` or `ur.move_to_pose`.
 *
 * It does NOT make a robot safe. On-robot safety configuration (safety limits,
 * protective stops, emergency stop, functional safety inputs) remains
 * authoritative. This adapter adds no safety-rated functions and no workspace
 * bounds — it has no robot model or frame tree; those belong to deployment
 * policies.
 *
 * Units (stated, never guessed): poses in METERS + axis-angle RADIANS; tool
 * speed in m/s (linear) or rad/s (joint); tool acceleration in m/s² (linear)
 * or rad/s² (joint); blend radius in meters.
 *
 * Support status: IMPLEMENTED — behavior-tested against the in-process
 * simulator only. Never HARDWARE_VERIFIED; no physical robot was commanded.
 */
import {
  DeviceError,
  recordAcknowledged,
  recordCommanded,
  recordObserved,
  TimeoutError,
  unknownEvidence,
  type BackendInvocationContext,
  type DeviceBackend,
  type DeviceStateEvidence,
  type EvidenceProvenance,
  type EvidenceState,
  type Transport,
} from '@pinout/core';
import {
  createUrDashboardClient,
  UrDashboardClient,
  type UrDashboardClientOptions,
  type UrProgramState,
  type UrRobotMode,
  type UrSafetyMode,
} from './dashboardClient.js';
import { UrDashboardError, UrRtdeError, UrScriptError } from './errors.js';
import {
  createUrRtdeClient,
  UrRtdeClient,
  type UrRtdeClientOptions,
  type UrRtdeSample,
} from './rtdeClient.js';
import { createUrScriptClient, UrScriptClient } from './urScriptClient.js';
import {
  UrSimulatorController,
  UrDashboardSimulatorTransport,
  UrRtdeSimulatorTransport,
  UrScriptSimulatorTransport,
  type UrSimulatorOptions,
} from './urSimulator.js';
import {
  buildMoveJCommand,
  buildMoveLCommand,
  buildStopLCommand,
  type UrPose,
} from './urscript.js';

export interface UrSafetyLimits {
  /** Maximum tool speed accepted for linear moves, m/s. Default 0.25. */
  maxSpeedMps: number;
  /** Maximum tool acceleration accepted for linear moves, m/s². Default 1.2. */
  maxAccelerationMps2: number;
  /** Maximum blend radius accepted, meters. Default 0.05. */
  maxBlendRadiusM: number;
  /** Maximum speed accepted for joint moves, rad/s. Default 0.5. */
  maxJointSpeedRadPerS: number;
  /** Maximum acceleration accepted for joint moves, rad/s². Default 2. */
  maxJointAccelerationRadPerS2: number;
  /** Deceleration sent to `stopl` on stop, m/s². Default 5. */
  stopAccelerationMps2: number;
  /** Maximum accepted `ur.execute_script` payload size in bytes. Default 65536. */
  maxScriptBytes: number;
}

export const UR_DEFAULT_SAFETY_LIMITS: UrSafetyLimits = {
  maxSpeedMps: 0.25,
  maxAccelerationMps2: 1.2,
  maxBlendRadiusM: 0.05,
  maxJointSpeedRadPerS: 0.5,
  maxJointAccelerationRadPerS2: 2,
  stopAccelerationMps2: 5,
  maxScriptBytes: 65_536,
};

export const UR_SAFE_STATE_NOTE =
  'UR stop requests are software commands sent to the dashboard and script interfaces. They do not replace a hardware emergency stop or safety-rated protective stop, and this adapter cannot confirm that the robot physically halted.';

const SAFETY_STOP_MODES: readonly UrSafetyMode[] = [
  'PROTECTIVE_STOP',
  'SAFEGUARD_STOP',
  'SYSTEM_EMERGENCY_STOP',
  'ROBOT_EMERGENCY_STOP',
  'FAULT',
  'VIOLATION',
];

const NOT_READY_ROBOT_MODES: readonly UrRobotMode[] = [
  'POWER_OFF',
  'BOOTING',
  'DISCONNECTED',
  'NO_CONTROLLER',
];

export interface UrBackendOptions extends UrSimulatorOptions {
  simulated?: boolean;
  kind?: 'simulated' | 'protocol';
  provenance?: EvidenceProvenance;
  dashboard?: UrDashboardClient;
  rtde?: UrRtdeClient;
  script?: UrScriptClient;
  dashboardTransport?: Transport;
  rtdeTransport?: Transport;
  scriptTransport?: Transport;
  dashboardClientOptions?: Omit<UrDashboardClientOptions, 'transport'>;
  rtdeClientOptions?: Omit<UrRtdeClientOptions, 'transport'>;
  /** Overrides for {@link UR_DEFAULT_SAFETY_LIMITS}. */
  limits?: Partial<UrSafetyLimits>;
  /**
   * Call dashboard `play` after `ur.execute_script`. Default FALSE: raw
   * URScript executes immediately without `play`, and `play` would start the
   * loaded program — which may be a different program entirely.
   */
  playAfterScript?: boolean;
  /** Preflight robot-mode/safety-mode reads before motion and play. Default true. */
  preflightChecks?: boolean;
}

interface UrBackendDependencies {
  kind: 'simulated' | 'protocol';
  dashboard?: UrDashboardClient;
  rtde?: UrRtdeClient;
  script?: UrScriptClient;
  provenance?: EvidenceProvenance;
  limits?: Partial<UrSafetyLimits>;
  playAfterScript?: boolean;
  preflightChecks?: boolean;
}

interface LastStatus {
  robotMode: UrRobotMode;
  safetyMode: UrSafetyMode;
  safetyStatus: string;
  state: UrProgramState;
  programName: string | undefined;
  running: boolean;
  at: number;
}

export class UrBackend implements DeviceBackend {
  readonly kind: 'simulated' | 'protocol';

  private readonly dashboard: UrDashboardClient | undefined;
  private readonly rtde: UrRtdeClient | undefined;
  private readonly script: UrScriptClient | undefined;
  private readonly provenance: EvidenceProvenance;
  private readonly limits: UrSafetyLimits;
  private readonly playAfterScript: boolean;
  private readonly preflightChecks: boolean;

  private readonly listeners = new Set<(event: string, payload: Record<string, unknown>) => void>();
  private readonly ready: Promise<void>;
  private closed = false;

  private lastStatus: LastStatus | undefined;
  private lastSample: UrRtdeSample | undefined;
  private stateEvidence: EvidenceState<string>;
  private positionEvidence: EvidenceState<number[]>;

  constructor(dependencies: UrBackendDependencies) {
    this.kind = dependencies.kind;
    this.dashboard = dependencies.dashboard;
    this.rtde = dependencies.rtde;
    this.script = dependencies.script;
    this.provenance =
      dependencies.provenance ?? (this.kind === 'simulated' ? 'simulated' : 'hardware');
    this.limits = { ...UR_DEFAULT_SAFETY_LIMITS, ...(dependencies.limits ?? {}) };
    this.playAfterScript = dependencies.playAfterScript ?? false;
    this.preflightChecks = dependencies.preflightChecks ?? true;
    this.stateEvidence = unknownEvidence<string>(this.provenance);
    this.positionEvidence = unknownEvidence<number[]>(this.provenance);
    this.ready = this.startAll();
  }

  static createSimulated(options: UrBackendOptions = {}): UrBackend {
    const controller = new UrSimulatorController(options);
    const dashboard = new UrDashboardClient({
      transport: new UrDashboardSimulatorTransport({ controller }),
      ...(options.dashboardClientOptions ?? {}),
    });
    const rtde = new UrRtdeClient({
      transport: new UrRtdeSimulatorTransport({ controller }),
      ...(options.rtdeClientOptions ?? {}),
    });
    const script = new UrScriptClient({
      transport: new UrScriptSimulatorTransport({ controller }),
    });
    return new UrBackend({
      kind: 'simulated',
      dashboard,
      rtde,
      script,
      ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
      ...(options.limits !== undefined ? { limits: options.limits } : {}),
      ...(options.playAfterScript !== undefined
        ? { playAfterScript: options.playAfterScript }
        : {}),
      ...(options.preflightChecks !== undefined
        ? { preflightChecks: options.preflightChecks }
        : {}),
    });
  }

  static async create(options: UrBackendOptions = {}): Promise<UrBackend> {
    const hasClient =
      options.dashboard !== undefined || options.rtde !== undefined || options.script !== undefined;
    const hasTransport =
      options.dashboardTransport !== undefined ||
      options.rtdeTransport !== undefined ||
      options.scriptTransport !== undefined;
    if (options.simulated !== false && !hasClient && !hasTransport) {
      const backend = UrBackend.createSimulated(options);
      await backend.ensureReady();
      return backend;
    }

    const dashboard =
      options.dashboard ??
      (options.dashboardTransport
        ? createUrDashboardClient({
            transport: options.dashboardTransport,
            ...(options.dashboardClientOptions ?? {}),
          })
        : undefined);
    const rtde =
      options.rtde ??
      (options.rtdeTransport
        ? createUrRtdeClient({
            transport: options.rtdeTransport,
            ...(options.rtdeClientOptions ?? {}),
          })
        : undefined);
    const script =
      options.script ??
      (options.scriptTransport
        ? createUrScriptClient({ transport: options.scriptTransport })
        : undefined);

    if (!dashboard && !rtde && !script) {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        'UR protocol backend requires at least one of: dashboard/RTDE/script clients or transports.',
      );
    }
    const backend = new UrBackend({
      kind: options.simulated === true ? 'simulated' : 'protocol',
      ...(dashboard !== undefined ? { dashboard } : {}),
      ...(rtde !== undefined ? { rtde } : {}),
      ...(script !== undefined ? { script } : {}),
      ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
      ...(options.limits !== undefined ? { limits: options.limits } : {}),
      ...(options.playAfterScript !== undefined
        ? { playAfterScript: options.playAfterScript }
        : {}),
      ...(options.preflightChecks !== undefined
        ? { preflightChecks: options.preflightChecks }
        : {}),
    });
    await backend.ensureReady();
    return backend;
  }

  async ensureReady(): Promise<void> {
    await this.ready;
  }

  subscribe(handler: (event: string, payload: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    await this.ready.catch(() => undefined);
    await Promise.all([
      this.dashboard?.close().catch(() => undefined),
      this.rtde?.close().catch(() => undefined),
      this.script?.close().catch(() => undefined),
    ]);
  }

  getOperationalState(): Record<string, unknown> {
    return {
      ...(this.lastStatus
        ? {
            robotMode: this.lastStatus.robotMode,
            safetyMode: this.lastStatus.safetyMode,
            programState: this.lastStatus.state,
            programName: this.lastStatus.programName,
            running: this.lastStatus.running,
            lastStatusAt: this.lastStatus.at,
          }
        : {}),
      ...(this.lastSample
        ? { lastTelemetryAt: this.lastSample.at, tcpPose: this.lastSample.values.actual_TCP_pose }
        : {}),
      note: UR_SAFE_STATE_NOTE,
    };
  }

  getOperationalStateEvidence(): DeviceStateEvidence {
    return {
      state: this.stateEvidence as EvidenceState<unknown>,
      position: this.positionEvidence as EvidenceState<unknown>,
    };
  }

  /** Stop the program and decelerate any scripted motion. Never resumes. */
  async safeState(): Promise<Record<string, unknown>> {
    const result = await this.stopMotion();
    return { ...result, note: UR_SAFE_STATE_NOTE };
  }

  async invoke(
    action: string,
    payload: Record<string, unknown> = {},
    _context?: BackendInvocationContext,
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new DeviceError('DISCONNECTED', 'UR backend is closed.');
    }
    await this.ensureReady();
    const emit = (event: string, eventPayload: Record<string, unknown>): void => {
      for (const listener of this.listeners) listener(event, eventPayload);
    };

    switch (action) {
      case 'ur.status': {
        const status = await this.readStatus(payload.includeIdentity === true);
        return { ...status, note: UR_SAFE_STATE_NOTE };
      }
      case 'ur.telemetry': {
        const timeoutMs = optionalPositiveNumber(payload.timeoutMs) ?? undefined;
        const sample = await this.readTelemetry(timeoutMs);
        return {
          at: sample.at,
          controllerTimestamp: sample.controllerTimestamp,
          recipeId: sample.recipeId,
          values: sample.values,
          units: {
            timestamp: 'seconds',
            actual_q: 'radians',
            actual_TCP_pose: 'meters + radians (axis-angle)',
            robot_mode: 'RTDE robot-mode value',
            safety_mode: 'RTDE safety-mode value',
          },
        };
      }
      case 'ur.power_on': {
        const dashboard = this.requireDashboard('power on');
        const reply = await this.wrapDashboard(() => dashboard.powerOn());
        this.stateEvidence = recordAcknowledged(
          recordCommanded(this.stateEvidence, 'power on', undefined, this.provenance),
          reply,
          undefined,
          this.provenance,
        );
        emit('ur.changed', { action: 'power_on' });
        return { poweredOn: true, reply };
      }
      case 'ur.power_off': {
        const dashboard = this.requireDashboard('power off');
        const reply = await this.wrapDashboard(() => dashboard.powerOff());
        this.stateEvidence = recordAcknowledged(
          recordCommanded(this.stateEvidence, 'power off', undefined, this.provenance),
          reply,
          undefined,
          this.provenance,
        );
        emit('ur.changed', { action: 'power_off' });
        return {
          poweredOff: true,
          reply,
          warning:
            'Powering off releases motor control; an arm holding a pose may sag or fall under gravity. Support or park the arm first.',
        };
      }
      case 'ur.brake_release': {
        const dashboard = this.requireDashboard('brake release');
        const reply = await this.wrapDashboard(() => dashboard.brakeRelease());
        emit('ur.changed', { action: 'brake_release' });
        return {
          brakesReleased: true,
          reply,
          warning: 'Brakes released: the arm can be moved by hand and may fall under gravity.',
        };
      }
      case 'ur.move_to_pose': {
        return this.moveToPose(payload, emit);
      }
      case 'ur.stop': {
        const result = await this.stopMotion();
        emit('ur.changed', { action: 'stop' });
        return result;
      }
      case 'ur.load_program': {
        const dashboard = this.requireDashboard('load a program');
        const path = requireNonEmptyString(payload.path, 'path');
        const reply = await this.wrapDashboard(() => dashboard.loadProgram(path));
        this.stateEvidence = recordAcknowledged(
          recordCommanded(this.stateEvidence, `load ${path}`, undefined, this.provenance),
          reply,
          undefined,
          this.provenance,
        );
        emit('ur.changed', { action: 'load_program', path });
        return { loaded: true, program: path, reply };
      }
      case 'ur.play_program': {
        const dashboard = this.requireDashboard('play a program');
        await this.preflightRobotReady();
        const reply = await this.wrapDashboard(() => dashboard.play());
        this.stateEvidence = recordAcknowledged(
          recordCommanded(this.stateEvidence, 'play', undefined, this.provenance),
          reply,
          undefined,
          this.provenance,
        );
        emit('ur.changed', { action: 'play_program' });
        return {
          playing: true,
          reply,
          warning:
            'The loaded program is not inspected before play; it may command arbitrary motion.',
        };
      }
      case 'ur.pause_program': {
        const dashboard = this.requireDashboard('pause a program');
        const reply = await this.wrapDashboard(() => dashboard.pause());
        emit('ur.changed', { action: 'pause_program' });
        return { paused: true, reply, note: 'Paused programs do not resume automatically.' };
      }
      case 'ur.execute_script': {
        return this.executeScript(payload, emit);
      }
      default:
        throw new DeviceError('UNKNOWN_ACTION', `Unknown action '${action}'.`);
    }
  }

  // -------------------------------------------------------------------------

  private async startAll(): Promise<void> {
    const started: Array<{ close: () => Promise<void> }> = [];
    try {
      if (this.dashboard) {
        await this.dashboard.start();
        started.push(this.dashboard);
      }
      if (this.rtde) {
        await this.rtde.start();
        started.push(this.rtde);
      }
      if (this.script) {
        await this.script.start();
        started.push(this.script);
      }
    } catch (error) {
      await Promise.all(started.map((client) => client.close().catch(() => undefined)));
      throw error;
    }
  }

  private requireDashboard(operation: string): UrDashboardClient {
    if (!this.dashboard) {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        `Cannot ${operation}: no dashboard client is configured.`,
      );
    }
    return this.dashboard;
  }

  private async readStatus(includeIdentity: boolean): Promise<Record<string, unknown>> {
    const dashboard = this.requireDashboard('read status');
    const robotMode = await this.wrapDashboard(() => dashboard.robotMode());
    const safetyMode = await this.wrapDashboard(() => dashboard.safetyMode());
    const safetyStatus = await this.wrapDashboard(() => dashboard.safetyStatus());
    const program = await this.wrapDashboard(() => dashboard.programState());
    const running = await this.wrapDashboard(() => dashboard.running());

    this.lastStatus = {
      robotMode: robotMode.mode,
      safetyMode: safetyMode.mode,
      safetyStatus: safetyStatus.status,
      state: program.state,
      programName: program.programName,
      running,
      at: Date.now(),
    };
    this.stateEvidence = recordObserved(
      this.stateEvidence,
      `${robotMode.mode}/${safetyMode.mode}/${program.state}`,
      this.kind === 'simulated' ? 'simulated' : 'sensor',
      this.lastStatus.at,
      this.provenance,
    );

    const telemetry = this.rtde?.latest();
    if (telemetry) {
      this.lastSample = telemetry;
      const tcp = telemetry.values.actual_TCP_pose;
      if (Array.isArray(tcp)) {
        this.positionEvidence = recordObserved(
          this.positionEvidence,
          tcp,
          this.kind === 'simulated' ? 'simulated' : 'sensor',
          telemetry.at,
          this.provenance,
        );
      }
    }

    return {
      robotMode: robotMode.mode,
      robotModeRaw: robotMode.raw,
      safetyMode: safetyMode.mode,
      safetyModeRaw: safetyMode.raw,
      safetyStatus: safetyStatus.status,
      program: { state: program.state, name: program.programName },
      programName: program.programName,
      running,
      ...(includeIdentity
        ? {
            model: await this.wrapDashboard(() => dashboard.robotModel()),
            serial: await this.wrapDashboard(() => dashboard.serialNumber()),
          }
        : {}),
      ...(telemetry ? { telemetry: { at: telemetry.at, values: telemetry.values } } : {}),
    };
  }

  private async readTelemetry(timeoutMs?: number): Promise<UrRtdeSample> {
    if (!this.rtde) {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        'Cannot read telemetry: no RTDE client is configured.',
      );
    }
    try {
      // Telemetry prefers a fresh observation: buffered samples that predate
      // this call are discarded, then the next data package is awaited.
      this.rtde.discardBufferedSamples();
      const sample =
        timeoutMs === undefined
          ? await this.rtde.readSample()
          : await this.rtde.readSample(timeoutMs);
      this.lastSample = sample;
      const tcp = sample.values.actual_TCP_pose;
      if (Array.isArray(tcp)) {
        this.positionEvidence = recordObserved(
          this.positionEvidence,
          tcp,
          this.kind === 'simulated' ? 'simulated' : 'sensor',
          sample.at,
          this.provenance,
        );
      }
      return sample;
    } catch (error) {
      if (error instanceof UrRtdeError && error.code === 'UR_RTDE_TIMEOUT') {
        throw new TimeoutError(error.message);
      }
      throw this.wrapDisconnected('RTDE', error);
    }
  }

  private async preflightRobotReady(): Promise<void> {
    if (!this.preflightChecks) return;
    const dashboard = this.dashboard;
    if (!dashboard) return;
    const mode = await this.wrapDashboard(() => dashboard.robotMode());
    if (NOT_READY_ROBOT_MODES.includes(mode.mode)) {
      throw new DeviceError(
        'UR_ROBOT_NOT_READY',
        `Robot is not ready for motion: robot mode is ${mode.mode}. Power on and release brakes first.`,
        { robotMode: mode.mode },
      );
    }
    const safety = await this.wrapDashboard(() => dashboard.safetyMode());
    if (SAFETY_STOP_MODES.includes(safety.mode)) {
      throw new DeviceError(
        'UR_SAFETY_STOP_ACTIVE',
        `Robot reports safety mode ${safety.mode}; motion commands will not be sent.`,
        { safetyMode: safety.mode },
      );
    }
  }

  private async moveToPose(
    payload: Record<string, unknown>,
    emit: (event: string, eventPayload: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> {
    const script = this.script;
    if (!script) {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        'Cannot move: no URScript client is configured.',
      );
    }
    const pose = requirePose(payload.pose);
    const joint = payload.movement === 'joint';
    if (
      payload.movement !== undefined &&
      payload.movement !== 'joint' &&
      payload.movement !== 'linear'
    ) {
      throw new DeviceError(
        'VALIDATION_ERROR',
        "payload.movement must be 'linear' or 'joint' when provided.",
      );
    }

    const speed = optionalPositiveNumber(payload.speed);
    const acceleration = optionalPositiveNumber(payload.acceleration);
    const blendRadius = optionalNonNegativeNumber(payload.blendRadius);

    const maxSpeed = joint ? this.limits.maxJointSpeedRadPerS : this.limits.maxSpeedMps;
    const maxAcceleration = joint
      ? this.limits.maxJointAccelerationRadPerS2
      : this.limits.maxAccelerationMps2;
    const unit = joint ? 'rad/s' : 'm/s';
    const accelerationUnit = joint ? 'rad/s²' : 'm/s²';

    if (speed !== undefined && speed > maxSpeed) {
      throw limitError('speed', speed, maxSpeed, unit);
    }
    if (acceleration !== undefined && acceleration > maxAcceleration) {
      throw limitError('acceleration', acceleration, maxAcceleration, accelerationUnit);
    }
    if (blendRadius !== undefined && blendRadius > this.limits.maxBlendRadiusM) {
      throw limitError('blendRadius', blendRadius, this.limits.maxBlendRadiusM, 'm');
    }

    await this.preflightRobotReady();

    const command = joint
      ? buildMoveJCommand(pose, {
          ...(speed !== undefined ? { speed } : {}),
          ...(acceleration !== undefined ? { acceleration } : {}),
          ...(blendRadius !== undefined ? { blendRadius } : {}),
        })
      : buildMoveLCommand(pose, {
          ...(speed !== undefined ? { speed } : {}),
          ...(acceleration !== undefined ? { acceleration } : {}),
          ...(blendRadius !== undefined ? { blendRadius } : {}),
        });

    try {
      await script.sendLine(command);
    } catch (error) {
      if (error instanceof UrScriptError && error.code === 'UR_SCRIPT_CLOSED') {
        throw new DeviceError('DISCONNECTED', 'URScript transport is closed.');
      }
      throw error;
    }

    let playReply: string | undefined;
    if (this.playAfterScript && this.dashboard) {
      playReply = await this.wrapDashboard(() => this.dashboard!.play());
    }

    const at = Date.now();
    this.positionEvidence = recordCommanded(
      this.positionEvidence,
      [...poseToArray(pose)],
      at,
      this.provenance,
    );
    emit('ur.changed', { action: 'move_to_pose', pose, movement: joint ? 'joint' : 'linear' });

    return {
      commanded: true,
      movement: joint ? 'joint' : 'linear',
      pose,
      units: { position: 'meters', rotation: 'radians (axis-angle)' },
      script: command,
      ...(speed !== undefined ? { speed, speedUnit: unit } : {}),
      ...(acceleration !== undefined ? { acceleration, accelerationUnit } : {}),
      ...(blendRadius !== undefined ? { blendRadius } : {}),
      playRequested: this.playAfterScript,
      ...(playReply !== undefined ? { playReply } : {}),
      note: 'Motion is commanded via raw URScript, which executes immediately. Completion is not acknowledged by the script interface; confirm motion via ur.telemetry.',
    };
  }

  private async executeScript(
    payload: Record<string, unknown>,
    emit: (event: string, eventPayload: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> {
    const script = this.script;
    if (!script) {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        'Cannot execute a script: no URScript client is configured.',
      );
    }
    const text = requireNonEmptyString(payload.script, 'script');
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > this.limits.maxScriptBytes) {
      throw new DeviceError(
        'VALIDATION_ERROR',
        `Script payload of ${bytes} bytes exceeds the configured maximum of ${this.limits.maxScriptBytes} bytes.`,
        { bytes, maxScriptBytes: this.limits.maxScriptBytes },
      );
    }
    try {
      await script.sendScript(text);
    } catch (error) {
      if (error instanceof UrScriptError && error.code === 'UR_SCRIPT_CLOSED') {
        throw new DeviceError('DISCONNECTED', 'URScript transport is closed.');
      }
      throw error;
    }

    let playReply: string | undefined;
    if (this.playAfterScript && this.dashboard) {
      playReply = await this.wrapDashboard(() => this.dashboard!.play());
    }
    emit('ur.changed', { action: 'execute_script', bytes });
    return {
      sent: true,
      bytes,
      playRequested: this.playAfterScript,
      ...(playReply !== undefined ? { playReply } : {}),
      note: 'Raw URScript executes immediately on the controller and is not acknowledged; it is not inspected or sandboxed by this adapter.',
    };
  }

  private async stopMotion(): Promise<Record<string, unknown>> {
    let programStop: 'confirmed' | 'failed' | 'unavailable' = 'unavailable';
    let programStopError: string | undefined;
    let scriptStop: 'sent' | 'failed' | 'unavailable' = 'unavailable';
    let scriptStopError: string | undefined;

    if (this.dashboard) {
      try {
        await this.dashboard.stop();
        programStop = 'confirmed';
      } catch (error) {
        programStop = 'failed';
        programStopError = error instanceof Error ? error.message : String(error);
      }
    }
    if (this.script) {
      try {
        await this.script.sendLine(buildStopLCommand(this.limits.stopAccelerationMps2));
        scriptStop = 'sent';
      } catch (error) {
        scriptStop = 'failed';
        scriptStopError = error instanceof Error ? error.message : String(error);
      }
    }

    if (programStop !== 'confirmed' && scriptStop !== 'sent') {
      throw new DeviceError(
        'UR_STOP_UNCONFIRMED',
        'No stop channel could be used: the dashboard stop and the scripted stopl both failed. Physical state is unconfirmed.',
        {
          programStop,
          scriptStop,
          ...(programStopError !== undefined ? { programStopError } : {}),
          ...(scriptStopError !== undefined ? { scriptStopError } : {}),
        },
      );
    }

    const stopConfirmed = programStop === 'confirmed';
    this.stateEvidence = recordAcknowledged(
      this.stateEvidence,
      stopConfirmed ? 'stopped' : 'stop-requested',
      Date.now(),
      this.provenance,
    );
    return {
      stopRequested: true,
      stopConfirmed,
      programStop,
      scriptStop,
      ...(programStopError !== undefined ? { programStopError } : {}),
      ...(scriptStopError !== undefined ? { scriptStopError } : {}),
      note: UR_SAFE_STATE_NOTE,
    };
  }

  private async wrapDashboard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (
        error instanceof UrDashboardError &&
        (error.code === 'UR_DASHBOARD_TIMEOUT' || error.code === 'UR_DASHBOARD_CLOSED')
      ) {
        throw new DeviceError('DISCONNECTED', `UR dashboard connection lost: ${error.message}`);
      }
      throw error;
    }
  }

  private wrapDisconnected(channel: string, error: unknown): unknown {
    if (error instanceof UrRtdeError && error.code === 'UR_RTDE_CONNECTION_LOST') {
      return new DeviceError('DISCONNECTED', `UR ${channel} connection lost: ${error.message}`);
    }
    return error;
  }
}

export function createUrBackend(options: UrBackendOptions = {}): Promise<UrBackend> {
  return UrBackend.create(options);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function limitError(field: string, value: number, limit: number, unit: string): DeviceError {
  return new DeviceError(
    'VALIDATION_ERROR',
    `'${field}' of ${value} ${unit} exceeds the configured limit of ${limit} ${unit}.`,
    { field, value, limit, unit },
  );
}

function requirePose(value: unknown): UrPose {
  if (typeof value !== 'object' || value === null) {
    throw new DeviceError(
      'VALIDATION_ERROR',
      "A 'pose' object with x, y, z (meters) and rx, ry, rz (radians, axis-angle) is required.",
    );
  }
  const record = value as Record<string, unknown>;
  const pose: Partial<UrPose> = {};
  for (const key of ['x', 'y', 'z', 'rx', 'ry', 'rz'] as const) {
    const component = record[key];
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw new DeviceError(
        'VALIDATION_ERROR',
        `Pose component '${key}' must be a finite number (meters for x/y/z, radians for rx/ry/rz).`,
      );
    }
    pose[key] = component;
  }
  return pose as UrPose;
}

function poseToArray(pose: UrPose): number[] {
  return [pose.x, pose.y, pose.z, pose.rx, pose.ry, pose.rz];
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DeviceError('VALIDATION_ERROR', `'${field}' must be a non-empty string.`);
  }
  return value;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new DeviceError(
      'VALIDATION_ERROR',
      `Expected a positive finite number; received ${String(value)}.`,
    );
  }
  return value;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DeviceError(
      'VALIDATION_ERROR',
      `Expected a non-negative finite number; received ${String(value)}.`,
    );
  }
  return value;
}
