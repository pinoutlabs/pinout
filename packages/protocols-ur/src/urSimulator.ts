/**
 * Deterministic in-process Universal Robots simulator.
 *
 * One {@link UrSimulatorController} models the controller state
 * (power / safety / program state + a simulated TCP pose) and three
 * `Transport` classes speak the real wire protocols against it:
 *
 * - {@link UrDashboardSimulatorTransport} — dashboard server line protocol
 *   (conventionally port 29999), including the connect greeting.
 * - {@link UrRtdeSimulatorTransport} — RTDE protocol-2 handshake and data
 *   packages (conventionally port 30004). Read-only: input recipes are not
 *   simulated.
 * - {@link UrScriptSimulatorTransport} — URScript sink that executes the
 *   small command subset this adapter emits.
 *
 * HONESTY: this is not a kinematic, dynamic, or safety simulation. `movel`
 * and `movej` update a stored TCP pose; joint telemetry is not derived from
 * it. `sleep()` is recorded but not waited. Protective stops, safety-rated
 * behavior, and real-time performance do not exist here. The simulated
 * greeting text and simulated failure wordings are not part of the verified
 * protocol contract.
 */
import type { Transport } from '@pinout/core';
import {
  encodeRtdeFrame,
  RtdeCommand,
  RTDE_VALUE_SIZES,
  type RtdeValue,
  type RtdeValueType,
} from './rtde.js';

export interface UrSimulatorOptions {
  /** Simulated Polyscope version reported by `PolyscopeVersion`. Default '5.11.0'. */
  polyscopeVersion?: string;
  /** Simulated build number in the `PolyscopeVersion` reply. Default '108057'. */
  polyscopeBuild?: string;
  /** Simulated model reported by `get robot model`. Default 'UR5e'. */
  robotModel?: string;
  /** Simulated serial reported by `get serial number`. Default '2020550000'. */
  serialNumber?: string;
  /** Simulated execution delay per motion command in ms. Default 0. */
  motionDelayMs?: number;
  /** Simulated joint positions in radians, 6 values. Default all zeros. */
  initialJointPositions?: number[];
  /** Simulated initial TCP pose `[x, y, z, rx, ry, rz]` (m + rad). Default all zeros. */
  initialTcpPose?: number[];
  /**
   * Reject URScript motion until a dashboard program is PLAYING. Default
   * false — real client interfaces execute raw URScript immediately.
   */
  requireProgramRunning?: boolean;
}

export interface UrSimulatedStop {
  kind: 'stopl' | 'stopj';
  acceleration: number;
  at: number;
}

/** RTDE outputs the simulated controller knows how to produce. Unlisted names are NOT_FOUND. */
export const UR_SIMULATED_RTDE_OUTPUT_TYPES: Record<string, RtdeValueType> = {
  timestamp: 'DOUBLE',
  actual_q: 'VECTOR6D',
  actual_qd: 'VECTOR6D',
  actual_current: 'VECTOR6D',
  actual_TCP_pose: 'VECTOR6D',
  actual_TCP_speed: 'VECTOR6D',
  actual_TCP_force: 'VECTOR6D',
  joint_temperatures: 'VECTOR6D',
  robot_mode: 'INT32',
  safety_mode: 'INT32',
  speed_scaling: 'DOUBLE',
  target_speed_fraction: 'DOUBLE',
  actual_digital_input_bits: 'UINT64',
  actual_digital_output_bits: 'UINT64',
};

const ZERO6: number[] = [0, 0, 0, 0, 0, 0];

export class UrSimulatorController {
  readonly robotModel: string;
  readonly serialNumber: string;
  readonly polyscopeVersion: string;
  readonly polyscopeBuild: string;
  readonly scriptLog: string[] = [];
  readonly scriptErrors: string[] = [];
  readonly motionLog: number[][] = [];

  lastStop: UrSimulatedStop | undefined;

  private robotMode = 3; // POWER_OFF (RTDE robot-mode values)
  private safetyModeNumber = 1; // NORMAL
  private state: 'STOPPED' | 'PLAYING' | 'PAUSED' = 'STOPPED';
  private loadedProgram: string | undefined;
  private tcpPose: number[];
  private joints: number[];
  private readonly motionDelayMs: number;
  private readonly requireProgramRunning: boolean;

  constructor(options: UrSimulatorOptions = {}) {
    this.robotModel = options.robotModel ?? 'UR5e';
    this.serialNumber = options.serialNumber ?? '2020550000';
    this.polyscopeVersion = options.polyscopeVersion ?? '5.11.0';
    this.polyscopeBuild = options.polyscopeBuild ?? '108057';
    this.motionDelayMs = options.motionDelayMs ?? 0;
    this.requireProgramRunning = options.requireProgramRunning ?? false;
    this.joints = normalizeVector(options.initialJointPositions ?? ZERO6, 'initialJointPositions');
    this.tcpPose = normalizeVector(options.initialTcpPose ?? ZERO6, 'initialTcpPose');
  }

  get robotModeNumber(): number {
    return this.robotMode;
  }

  get robotModeName(): string {
    return (
      {
        [-1]: 'NO_CONTROLLER',
        0: 'DISCONNECTED',
        1: 'CONFIRM_SAFETY',
        2: 'BOOTING',
        3: 'POWER_OFF',
        4: 'POWER_ON',
        5: 'IDLE',
        6: 'BACKDRIVE',
        7: 'RUNNING',
        8: 'UPDATING_FIRMWARE',
      }[this.robotMode] ?? 'UNKNOWN'
    );
  }

  get safetyModeNumberValue(): number {
    return this.safetyModeNumber;
  }

  /**
   * Test/simulation hook: force the reported safety mode (RTDE safety-mode
   * value, 1 = NORMAL). Never driven by network input.
   */
  setSimulatedSafetyMode(mode: number): void {
    this.safetyModeNumber = mode;
  }

  /**
   * Test/simulation hook: force the reported robot mode (RTDE robot-mode
   * value, 3 = POWER_OFF). Never driven by network input.
   */
  setSimulatedRobotMode(mode: number): void {
    this.robotMode = mode;
  }

  get safetyModeName(): string {
    return (
      {
        1: 'NORMAL',
        2: 'REDUCED',
        3: 'PROTECTIVE_STOP',
        4: 'RECOVERY',
        5: 'SAFEGUARD_STOP',
        6: 'SYSTEM_EMERGENCY_STOP',
        7: 'ROBOT_EMERGENCY_STOP',
        8: 'VIOLATION',
        9: 'FAULT',
        10: 'VALIDATE_JOINT_ID',
        11: 'UNDEFINED_SAFETY_MODE',
      }[this.safetyModeNumber] ?? 'UNKNOWN'
    );
  }

  get programState(): 'STOPPED' | 'PLAYING' | 'PAUSED' {
    return this.state;
  }

  get programName(): string | undefined {
    return this.loadedProgram;
  }

  get isProgramRunning(): boolean {
    return this.state === 'PLAYING';
  }

  get tcp(): number[] {
    return [...this.tcpPose];
  }

  get jointPositions(): number[] {
    return [...this.joints];
  }

  /** Apply one dashboard command and return the reply line (without terminator). */
  dashboardCommand(command: string): string {
    const text = command.trim();

    if (text === 'play') {
      if (this.robotMode === 3) return 'Could not play program: robot is not powered on.';
      if (!this.loadedProgram) return 'Could not play program: no program loaded.';
      this.state = 'PLAYING';
      this.robotMode = 7; // RUNNING
      return 'Starting program';
    }
    if (text === 'stop') {
      this.state = 'STOPPED';
      if (this.robotMode === 7) this.robotMode = 5; // IDLE
      return 'Stopped';
    }
    if (text === 'pause') {
      if (this.state !== 'PLAYING') return 'Could not pause program: program is not running.';
      this.state = 'PAUSED';
      return 'Pausing program';
    }
    if (text === 'power on') {
      if (this.robotMode !== 3) return 'Robot is already powered on';
      this.robotMode = 5; // IDLE
      return 'Powering on';
    }
    if (text === 'power off') {
      if (this.robotMode === 3) return 'Robot is already powered off';
      this.robotMode = 3;
      this.state = 'STOPPED';
      this.loadedProgram = undefined;
      return 'Powering off';
    }
    if (text === 'brake release') {
      if (this.robotMode === 3 || this.robotMode === 0 || this.robotMode === 2) {
        return 'Could not release brakes: robot is not powered on.';
      }
      return 'Brake releasing';
    }
    if (text === 'robotmode') return `Robotmode: ${this.robotModeName}`;
    if (text === 'safetymode') return `Safetymode: ${this.safetyModeName}`;
    if (text === 'safetystatus') return `Safetystatus: ${this.safetyModeName}`;
    if (text === 'running') return `Program running: ${this.isProgramRunning ? 'true' : 'false'}`;
    if (text === 'programState') {
      return this.loadedProgram ? `${this.state} ${this.loadedProgram}` : this.state;
    }
    if (text === 'get robot model') return this.robotModel;
    if (text === 'get serial number') return this.serialNumber;
    if (text === 'PolyscopeVersion') {
      return `URSoftware ${this.polyscopeVersion} (${this.polyscopeBuild})`;
    }
    if (text.startsWith('load ')) {
      const program = text.slice(5).trim();
      if (program.length === 0) return 'Could not load program: missing path.';
      this.loadedProgram = program;
      return `Loading program: ${program}`;
    }
    return `Unknown command: ${text}`;
  }

  /** Execute one URScript line. Unsupported lines are recorded as errors. */
  async applyScriptLine(line: string): Promise<void> {
    const text = line.trim();
    if (text.length === 0) return;
    this.scriptLog.push(text);

    const move = /^(movel|movej)\s*\(\s*p\[([^\]]+)\]\s*(?:,.*)?\)$/i.exec(text);
    if (move) {
      const kind = move[1]!.toLowerCase();
      const pose = parsePoseList(move[2]!);
      if (!pose) {
        this.scriptErrors.push(`invalid pose in '${text}'`);
        return;
      }
      if (this.robotMode === 3) {
        this.scriptErrors.push(`${kind} rejected: robot is powered off`);
        return;
      }
      if (this.requireProgramRunning && this.state !== 'PLAYING') {
        this.scriptErrors.push(`${kind} rejected: no program is playing`);
        return;
      }
      if (this.motionDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.motionDelayMs));
      }
      this.tcpPose = pose;
      this.motionLog.push([...pose]);
      this.lastStop = undefined;
      return;
    }

    const stopl = /^stopl\s*\(\s*([-\d.eE+]+)\s*\)$/i.exec(text);
    if (stopl) {
      const acceleration = Number.parseFloat(stopl[1]!);
      if (!Number.isFinite(acceleration) || acceleration <= 0) {
        this.scriptErrors.push(`invalid stopl acceleration in '${text}'`);
        return;
      }
      this.lastStop = { kind: 'stopl', acceleration, at: Date.now() };
      return;
    }

    const stopj = /^stopj\s*\(\s*([-\d.eE+]+)\s*\)$/i.exec(text);
    if (stopj) {
      const acceleration = Number.parseFloat(stopj[1]!);
      if (!Number.isFinite(acceleration) || acceleration <= 0) {
        this.scriptErrors.push(`invalid stopj acceleration in '${text}'`);
        return;
      }
      this.lastStop = { kind: 'stopj', acceleration, at: Date.now() };
      return;
    }

    const sleep = /^sleep\s*\(\s*([-\d.eE+]+)\s*\)$/i.exec(text);
    if (sleep) {
      // Recorded only: the simulator never actually waits. Documented limitation.
      return;
    }

    this.scriptErrors.push(`unsupported script line: '${text}'`);
  }

  /** Current value for an RTDE output name, or `undefined` when unsupported. */
  rtdeValue(name: string, epochMs: number): RtdeValue | undefined {
    switch (name) {
      case 'timestamp':
        return (Date.now() - epochMs) / 1000;
      case 'actual_q':
        return [...this.joints];
      case 'actual_qd':
      case 'actual_current':
      case 'actual_TCP_speed':
      case 'actual_TCP_force':
      case 'joint_temperatures':
        return [...ZERO6];
      case 'actual_TCP_pose':
        return [...this.tcpPose];
      case 'robot_mode':
        return this.robotMode;
      case 'safety_mode':
        return this.safetyModeNumber;
      case 'speed_scaling':
        return 1;
      case 'target_speed_fraction':
        return 1;
      case 'actual_digital_input_bits':
      case 'actual_digital_output_bits':
        return 0;
      default:
        return undefined;
    }
  }
}

export function createUrSimulatorController(
  options: UrSimulatorOptions = {},
): UrSimulatorController {
  return new UrSimulatorController(options);
}

// ---------------------------------------------------------------------------
// Dashboard server transport
// ---------------------------------------------------------------------------

export interface UrDashboardSimulatorOptions {
  controller?: UrSimulatorController;
  /** Greeting line sent on every open. Default 'Universal Robots Dashboard Server'. */
  welcomeMessage?: string;
}

export class UrDashboardSimulatorTransport implements Transport {
  readonly kind = 'ur-dashboard-simulator';
  private readonly controller: UrSimulatorController;
  private readonly welcomeMessage: string;
  private readonly listeners = new Set<(chunk: Uint8Array) => void>();
  private readonly backlog: Uint8Array[] = [];
  private inputBuffer = '';
  private closedState = false;

  constructor(options: UrDashboardSimulatorOptions = {}) {
    this.controller = options.controller ?? new UrSimulatorController();
    this.welcomeMessage = options.welcomeMessage ?? 'Universal Robots Dashboard Server';
  }

  /** Public probe used by clients to detect an externally closed transport. */
  get closed(): boolean {
    return this.closedState;
  }

  get readable(): AsyncIterable<Uint8Array> {
    return createReadable(this.listeners, () => this.closedState, this.backlog);
  }

  async open(): Promise<void> {
    this.closedState = false;
    this.respond(this.welcomeMessage);
  }

  async close(): Promise<void> {
    this.closedState = true;
    this.emit(new Uint8Array(0));
  }

  async write(data: Uint8Array): Promise<void> {
    this.inputBuffer += new TextDecoder().decode(data);
    for (;;) {
      const newline = this.inputBuffer.indexOf('\n');
      if (newline === -1) break;
      const line = this.inputBuffer.slice(0, newline);
      this.inputBuffer = this.inputBuffer.slice(newline + 1);
      const command = line.replace(/\r/g, '').trim();
      if (command.length === 0) continue;
      this.respond(this.controller.dashboardCommand(command));
    }
  }

  private respond(text: string): void {
    this.emit(new TextEncoder().encode(`${text}\n`));
  }

  private emit(chunk: Uint8Array): void {
    if (this.listeners.size === 0) {
      this.backlog.push(chunk);
      if (this.backlog.length > 64) this.backlog.shift();
      return;
    }
    for (const listener of this.listeners) listener(chunk);
  }
}

// ---------------------------------------------------------------------------
// RTDE server transport
// ---------------------------------------------------------------------------

export interface UrRtdeSimulatorOptions {
  controller?: UrSimulatorController;
  /** Protocol version the simulated controller supports. Default 2. */
  protocolVersion?: number;
  /** Simulated RTDE library version trio reported by the `v` reply. Default [1, 0, 0]. */
  libraryVersion?: [number, number, number];
  /**
   * Emit data packages after `S`. Default true. When false, `S` is still
   * accepted but no packages are emitted — useful for testing read timeouts.
   */
  streaming?: boolean;
}

interface SimulatedRecipeOutput {
  name: string;
  type: RtdeValueType;
}

interface SimulatedRecipe {
  id: number;
  frequencyHz: number;
  /** Resolved data-package outputs, in request order; NOT_FOUND entries are excluded. */
  outputs: SimulatedRecipeOutput[];
  /** Type names exactly as reported in the setup reply, including NOT_FOUND. */
  typeNames: string[];
}

export class UrRtdeSimulatorTransport implements Transport {
  readonly kind = 'ur-rtde-simulator';
  private readonly controller: UrSimulatorController;
  private readonly protocolVersion: number;
  private readonly libraryVersion: [number, number, number];
  private readonly streaming: boolean;
  private readonly listeners = new Set<(chunk: Uint8Array) => void>();
  private readonly backlog: Uint8Array[] = [];

  private pending = new Uint8Array(0);
  private recipe: SimulatedRecipe | undefined;
  private nextRecipeId = 0;
  private streamTimer: ReturnType<typeof setInterval> | undefined;
  private epochMs = 0;
  private closedState = false;

  constructor(options: UrRtdeSimulatorOptions = {}) {
    this.controller = options.controller ?? new UrSimulatorController();
    this.protocolVersion = options.protocolVersion ?? 2;
    this.libraryVersion = options.libraryVersion ?? [1, 0, 0];
    this.streaming = options.streaming !== false;
  }

  /** Public probe used by clients to detect an externally closed transport. */
  get closed(): boolean {
    return this.closedState;
  }

  get readable(): AsyncIterable<Uint8Array> {
    return createReadable(this.listeners, () => this.closedState, this.backlog);
  }

  async open(): Promise<void> {
    this.closedState = false;
    this.epochMs = Date.now();
  }

  async close(): Promise<void> {
    this.stopStreaming();
    this.closedState = true;
    this.emit(new Uint8Array(0));
  }

  async write(data: Uint8Array): Promise<void> {
    this.append(data);
    for (;;) {
      if (this.pending.length < 3) break;
      const size = (this.pending[0]! << 8) | this.pending[1]!;
      if (size < 3) {
        this.pending = new Uint8Array(0);
        break;
      }
      if (this.pending.length < size) break;
      const frame = this.pending.subarray(0, size);
      this.pending = this.pending.subarray(size);
      const command = frame[2]!;
      const payload = frame.subarray(3);
      this.handleFrame(command, payload);
    }
  }

  /** Emit one data package for the current recipe. Exposed for deterministic tests. */
  emitSample(): void {
    const recipe = this.recipe;
    if (!recipe || this.closedState) return;
    const chunks: number[] = [recipe.id];
    for (const output of recipe.outputs) {
      const value = this.controller.rtdeValue(output.name, this.epochMs) ?? zeroValue(output.type);
      const encoded = encodeTypedValue(output.type, value);
      if (encoded.length !== RTDE_VALUE_SIZES[output.type]) {
        throw new Error(
          `UR RTDE simulator bug: encoded ${encoded.length} bytes for ${output.type}, expected ${RTDE_VALUE_SIZES[output.type]}.`,
        );
      }
      chunks.push(...encoded);
    }
    this.emit(encodeRtdeFrame(RtdeCommand.DATA_PACKAGE, Uint8Array.from(chunks)));
  }

  // -------------------------------------------------------------------------

  private handleFrame(command: number, payload: Uint8Array): void {
    switch (command) {
      case RtdeCommand.PROTOCOL_VERSION: {
        const requested = payload.length >= 2 ? (payload[0]! << 8) | payload[1]! : 0;
        const negotiated = Math.min(requested, this.protocolVersion);
        const reply = new Uint8Array(16);
        const view = new DataView(reply.buffer);
        view.setUint32(0, negotiated);
        view.setUint32(4, this.libraryVersion[0]);
        view.setUint32(8, this.libraryVersion[1]);
        view.setUint32(12, this.libraryVersion[2]);
        this.emit(encodeRtdeFrame(RtdeCommand.PROTOCOL_VERSION_REPLY, reply));
        return;
      }
      case RtdeCommand.SETUP_OUTPUTS: {
        const response = this.setupOutputs(payload);
        this.emit(encodeRtdeFrame(RtdeCommand.SETUP_OUTPUTS, response));
        return;
      }
      case RtdeCommand.START: {
        const accepted = this.recipe !== undefined;
        this.emit(encodeRtdeFrame(RtdeCommand.START, Uint8Array.from([accepted ? 1 : 0])));
        if (accepted && this.streaming) {
          this.emitSample();
          this.startStreaming();
        }
        return;
      }
      case RtdeCommand.PAUSE: {
        this.stopStreaming();
        this.emit(encodeRtdeFrame(RtdeCommand.PAUSE, Uint8Array.from([1])));
        return;
      }
      default:
        // Unknown commands are ignored; a real controller would error.
        return;
    }
  }

  private setupOutputs(payload: Uint8Array): Uint8Array {
    const frequencyHz =
      payload.length >= 8
        ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getFloat64(0, false)
        : 0;
    const names = new TextDecoder()
      .decode(payload.subarray(8))
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const outputs: SimulatedRecipeOutput[] = [];
    const typeNames: string[] = [];
    for (const name of names) {
      const type = UR_SIMULATED_RTDE_OUTPUT_TYPES[name];
      if (type === undefined) {
        typeNames.push('NOT_FOUND');
      } else {
        outputs.push({ name, type });
        typeNames.push(type);
      }
    }
    const recipeId = this.nextRecipeId;
    this.nextRecipeId += 1;
    this.recipe = { id: recipeId, frequencyHz, outputs, typeNames };
    const encoded = new TextEncoder().encode(typeNames.join(','));
    const response = new Uint8Array(1 + encoded.length);
    response[0] = recipeId;
    response.set(encoded, 1);
    return response;
  }

  private startStreaming(): void {
    this.stopStreaming();
    const recipe = this.recipe;
    if (!recipe || !this.streaming) return;
    const intervalMs = Math.max(1, Math.round(1000 / recipe.frequencyHz));
    this.streamTimer = setInterval(() => this.emitSample(), intervalMs);
    (this.streamTimer as { unref?: () => void }).unref?.();
  }

  private stopStreaming(): void {
    if (this.streamTimer !== undefined) {
      clearInterval(this.streamTimer);
      this.streamTimer = undefined;
    }
  }

  private append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const merged = new Uint8Array(this.pending.length + chunk.length);
    merged.set(this.pending, 0);
    merged.set(chunk, this.pending.length);
    this.pending = merged;
  }

  private emit(chunk: Uint8Array): void {
    if (this.listeners.size === 0) {
      this.backlog.push(chunk);
      if (this.backlog.length > 64) this.backlog.shift();
      return;
    }
    for (const listener of this.listeners) listener(chunk);
  }
}

// ---------------------------------------------------------------------------
// URScript sink transport
// ---------------------------------------------------------------------------

export interface UrScriptSimulatorOptions {
  controller?: UrSimulatorController;
}

/**
 * URScript sink. Real client interfaces acknowledge nothing here, so this
 * transport produces no data; inspect the controller's `scriptLog`,
 * `scriptErrors`, and `motionLog` in tests.
 */
export class UrScriptSimulatorTransport implements Transport {
  readonly kind = 'ur-script-simulator';
  private readonly controller: UrSimulatorController;
  private readonly listeners = new Set<(chunk: Uint8Array) => void>();
  private readonly backlog: Uint8Array[] = [];
  private inputBuffer = '';
  private closedState = false;

  constructor(options: UrScriptSimulatorOptions = {}) {
    this.controller = options.controller ?? new UrSimulatorController();
  }

  /** Public probe used by clients to detect an externally closed transport. */
  get closed(): boolean {
    return this.closedState;
  }

  get readable(): AsyncIterable<Uint8Array> {
    return createReadable(this.listeners, () => this.closedState, this.backlog);
  }

  async open(): Promise<void> {
    this.closedState = false;
  }

  async close(): Promise<void> {
    this.closedState = true;
    this.emit(new Uint8Array(0));
  }

  async write(data: Uint8Array): Promise<void> {
    this.inputBuffer += new TextDecoder().decode(data);
    for (;;) {
      const newline = this.inputBuffer.indexOf('\n');
      if (newline === -1) break;
      const line = this.inputBuffer.slice(0, newline);
      this.inputBuffer = this.inputBuffer.slice(newline + 1);
      await this.controller.applyScriptLine(line);
    }
  }

  private emit(chunk: Uint8Array): void {
    for (const listener of this.listeners) listener(chunk);
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

export interface UrSimulatorBundle {
  controller: UrSimulatorController;
  dashboard: UrDashboardSimulatorTransport;
  rtde: UrRtdeSimulatorTransport;
  script: UrScriptSimulatorTransport;
}

/**
 * Create one controller shared by all three simulated transports. The
 * transport options are passed through where they exist (`welcomeMessage`,
 * `protocolVersion`, `libraryVersion`, `streaming`).
 */
export function createUrSimulator(
  options: UrSimulatorOptions = {},
  transportOptions: {
    welcomeMessage?: string;
    protocolVersion?: number;
    libraryVersion?: [number, number, number];
    streaming?: boolean;
  } = {},
): UrSimulatorBundle {
  const controller = new UrSimulatorController(options);
  return {
    controller,
    dashboard: new UrDashboardSimulatorTransport({
      controller,
      ...(transportOptions.welcomeMessage !== undefined
        ? { welcomeMessage: transportOptions.welcomeMessage }
        : {}),
    }),
    rtde: new UrRtdeSimulatorTransport({
      controller,
      ...(transportOptions.protocolVersion !== undefined
        ? { protocolVersion: transportOptions.protocolVersion }
        : {}),
      ...(transportOptions.libraryVersion !== undefined
        ? { libraryVersion: transportOptions.libraryVersion }
        : {}),
      ...(transportOptions.streaming !== undefined
        ? { streaming: transportOptions.streaming }
        : {}),
    }),
    script: new UrScriptSimulatorTransport({ controller }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createReadable(
  listeners: Set<(chunk: Uint8Array) => void>,
  isClosed: () => boolean,
  backlog: Uint8Array[] = [],
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const queue = backlog.splice(0, backlog.length);
      let notify: (() => void) | undefined;
      const listener = (chunk: Uint8Array): void => {
        queue.push(chunk);
        notify?.();
      };
      listeners.add(listener);
      try {
        while (!isClosed()) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            continue;
          }
          yield queue.shift()!;
        }
      } finally {
        listeners.delete(listener);
      }
    },
  };
}

function normalizeVector(values: number[], field: string): number[] {
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`UR simulator '${field}' must be 6 finite numbers; received ${values.length}.`);
  }
  return [...values];
}

function parsePoseList(text: string): number[] | undefined {
  const parts = text.split(',').map((part) => Number.parseFloat(part.trim()));
  if (parts.length !== 6 || parts.some((value) => !Number.isFinite(value))) return undefined;
  return parts;
}

function zeroValue(type: RtdeValueType): RtdeValue {
  switch (type) {
    case 'BOOL':
      return false;
    case 'UINT8':
    case 'INT32':
    case 'UINT32':
    case 'UINT64':
    case 'DOUBLE':
      return 0;
    case 'VECTOR3D':
      return [0, 0, 0];
    case 'VECTOR6D':
    case 'VECTOR6INT32':
    case 'VECTOR6UINT32':
      return [...ZERO6];
  }
}

/** Encode an RTDE value as exactly `RTDE_VALUE_SIZES[type]` big-endian bytes. */
function encodeTypedValue(type: RtdeValueType, value: RtdeValue): number[] {
  const bytes: number[] = [];
  const pushU32 = (input: number): void => {
    const unsigned = input >>> 0;
    bytes.push(
      (unsigned >>> 24) & 0xff,
      (unsigned >>> 16) & 0xff,
      (unsigned >>> 8) & 0xff,
      unsigned & 0xff,
    );
  };
  const pushDouble = (input: number): void => {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, input, false);
    bytes.push(...new Uint8Array(buffer));
  };
  const vector = Array.isArray(value) ? value : [];
  switch (type) {
    case 'BOOL':
      bytes.push(value ? 1 : 0);
      break;
    case 'UINT8':
      bytes.push(Number(value) & 0xff);
      break;
    case 'INT32':
    case 'UINT32':
      pushU32(Number(value));
      break;
    case 'UINT64':
      pushU32(0);
      pushU32(Number(value));
      break;
    case 'DOUBLE':
      pushDouble(Number(value));
      break;
    case 'VECTOR3D':
      for (let index = 0; index < 3; index += 1) pushDouble(vector[index] ?? 0);
      break;
    case 'VECTOR6D':
      for (let index = 0; index < 6; index += 1) pushDouble(vector[index] ?? 0);
      break;
    case 'VECTOR6INT32':
    case 'VECTOR6UINT32':
      for (let index = 0; index < 6; index += 1) pushU32(vector[index] ?? 0);
      break;
  }
  return bytes;
}
