import {
  connect,
  createGpioState,
  handleBridgeAction,
  simulatedEsp32,
  type Device,
  type Transport,
} from '@pinout/core';

type GpioState = ReturnType<typeof createGpioState>;
import {
  assertAdcPin,
  assertPwmPin,
  assertUsableGpio,
  getProfile,
  type BoardProfile,
} from './profiles.js';
import type { DeviceJournalEntry, DeviceMode, DeviceSnapshot, ProfileId } from '../types.js';

const protocolVersion = 1;
const maxProtocolLineBytes = 1024;

/**
 * Shared SIMULATED board used by both arms.
 *
 * ESP32 uses the repo simulatedEsp32 transport so Arm B can drive real Pinout
 * connect() / MCP-shaped tools against the same GPIO state the checker reads.
 * Pico and Uno use a protocol-compatible bench transport with board pin maps.
 * Every result from this harness is labelled SIMULATED unless --device real
 * is implemented and actually run against hardware.
 */
export class BenchDevice {
  readonly profile: BoardProfile;
  readonly mode: DeviceMode;
  readonly journal: DeviceJournalEntry[] = [];
  private readonly startedAt = Date.now();
  private esp32Transport: ReturnType<typeof simulatedEsp32> | undefined;
  private genericTransport: GenericBoardTransport | undefined;
  private pinoutDevice: Device | undefined;
  private closed = false;
  private lastMaps: MapSnapshot;

  constructor(profileId: ProfileId, mode: DeviceMode = 'simulated') {
    if (mode === 'real') {
      throw new Error(
        'BenchDevice real mode is reserved for a future hardware hook and has not been run.',
      );
    }
    this.mode = mode;
    this.profile = getProfile(profileId);
    if (profileId === 'esp32') {
      this.esp32Transport = simulatedEsp32({ autoArm: false });
      this.seedAnalog(this.esp32Transport.state);
    } else {
      this.genericTransport = new GenericBoardTransport(this.profile, (entry) => {
        this.journal.push(entry);
      }, this.startedAt);
      this.seedAnalog(this.genericTransport.state);
    }
    this.lastMaps = snapshotMaps(this.state);
  }

  get transport(): Transport {
    if (this.esp32Transport) return this.esp32Transport;
    if (this.genericTransport) return this.genericTransport;
    throw new Error('Bench device transport is not initialized.');
  }

  get state(): GpioState {
    if (this.esp32Transport) return this.esp32Transport.state;
    if (this.genericTransport) return this.genericTransport.state;
    throw new Error('Bench device state is not initialized.');
  }

  /** Open a Pinout Device bound to this simulator (Arm B). */
  async openPinoutDevice(): Promise<Device> {
    if (this.pinoutDevice) return this.pinoutDevice;
    this.pinoutDevice = await connect({ transport: this.transport, timeoutMs: 5000 });
    this.syncJournal('pinout.connect');
    return this.pinoutDevice;
  }

  /** Apply a raw bridge action (Arm A serial / flash path). */
  applyAction(action: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
    let result: Record<string, unknown>;
    if (this.esp32Transport) {
      result = handleBridgeAction(action, payload, this.state, {
        emitEvent: () => undefined,
      });
    } else if (this.genericTransport) {
      result = this.genericTransport.applyAction(action, payload);
    } else {
      throw new Error('No backend for applyAction.');
    }
    this.syncJournal(action, payload);
    return result;
  }

  /** Diff GPIO maps into the journal after Pinout/serial side effects. */
  syncJournal(action = 'external', payload: Record<string, unknown> = {}): void {
    const after = snapshotMaps(this.state);
    for (const [pin, value] of after.levels) {
      if (this.lastMaps.levels.get(pin) !== value) {
        this.journal.push({
          atMs: Date.now() - this.startedAt,
          kind: 'gpio.level',
          pin,
          value,
          detail: { action, payload },
        });
      }
    }
    for (const [pin, angle] of after.servos) {
      if (this.lastMaps.servos.get(pin) !== angle) {
        this.journal.push({
          atMs: Date.now() - this.startedAt,
          kind: 'gpio.servo',
          pin,
          value: angle,
          detail: { action, payload },
        });
      }
    }
    if (this.lastMaps.deviceState !== after.deviceState) {
      this.journal.push({
        atMs: Date.now() - this.startedAt,
        kind: 'device.state',
        value: after.deviceState,
        detail: { action, payload },
      });
    }
    if (action === 'gpio.analogRead' && typeof payload.pin === 'number') {
      this.journal.push({
        atMs: Date.now() - this.startedAt,
        kind: 'gpio.analogRead',
        pin: payload.pin,
        value: after.analog.get(payload.pin) ?? this.state.analogLevels.get(payload.pin),
        detail: { action, payload },
      });
    }
    this.lastMaps = after;
  }

  snapshot(): DeviceSnapshot {
    this.syncJournal('snapshot');
    const levels: Record<string, boolean> = {};
    for (const [pin, value] of this.state.levels.entries()) levels[String(pin)] = value;
    const servos: Record<string, number> = {};
    for (const [pin, angle] of this.state.servos.entries()) servos[String(pin)] = angle;
    const analogLevels: Record<string, number> = {};
    for (const [pin, value] of this.state.analogLevels.entries()) {
      analogLevels[String(pin)] = value;
    }
    return {
      profileId: this.profile.id,
      mode: this.mode,
      levels,
      servos,
      analogLevels,
      deviceState: this.state.deviceState,
      journal: [...this.journal],
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pinoutDevice?.close().catch(() => undefined);
    this.pinoutDevice = undefined;
    await this.transport.close().catch(() => undefined);
  }

  private seedAnalog(state: GpioState): void {
    state.analogLevels.set(this.profile.adcPin, this.profile.seededAnalogValue);
  }
}

interface MapSnapshot {
  levels: Map<number, boolean>;
  servos: Map<number, number>;
  analog: Map<number, number>;
  deviceState: string;
}

function snapshotMaps(state: GpioState): MapSnapshot {
  return {
    levels: new Map(state.levels),
    servos: new Map(state.servos),
    analog: new Map(state.analogLevels),
    deviceState: state.deviceState,
  };
}

type JournalSink = (entry: DeviceJournalEntry) => void;

/** Minimal async byte source for the generic transport readable side. */
class ByteSource implements AsyncIterable<Uint8Array> {
  private readonly chunks: Uint8Array[] = [];
  private readonly waiters: Array<(chunk: IteratorResult<Uint8Array>) => void> = [];
  private closed = false;

  push(chunk: Uint8Array): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: chunk, done: false });
      return;
    }
    this.chunks.push(chunk);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: (): Promise<IteratorResult<Uint8Array>> => {
        if (this.chunks.length > 0) {
          return Promise.resolve({ value: this.chunks.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

/**
 * Protocol-compatible SIMULATED transport for Pico / Uno profiles.
 * Speaks JSON-line bridge framing so Arm A datasheets stay realistic.
 */
class GenericBoardTransport implements Transport {
  readonly kind = 'simulated-bench-board';
  readonly state: GpioState;
  private readonly inbound = new ByteSource();
  private readonly decoder = new TextDecoder();
  private writeBuffer = '';
  private started = false;

  constructor(
    private readonly profile: BoardProfile,
    private readonly sink: JournalSink,
    private readonly startedAt: number,
  ) {
    this.state = createGpioState();
  }

  get readable(): AsyncIterable<Uint8Array> {
    return this.inbound;
  }

  async open(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.emitRaw(encodeEvent('ready', this.helloInfo()));
  }

  async close(): Promise<void> {
    this.inbound.close();
  }

  async write(data: Uint8Array): Promise<void> {
    this.writeBuffer += this.decoder.decode(data, { stream: true });
    let newlineAt = this.writeBuffer.indexOf('\n');
    while (newlineAt >= 0) {
      const line = this.writeBuffer.slice(0, newlineAt);
      this.writeBuffer = this.writeBuffer.slice(newlineAt + 1);
      this.handleLine(line);
      newlineAt = this.writeBuffer.indexOf('\n');
    }
  }

  applyAction(action: string, payload: Record<string, unknown>): Record<string, unknown> {
    return this.dispatch(action, payload);
  }

  private handleLine(line: string): void {
    if (new TextEncoder().encode(line).length >= maxProtocolLineBytes) {
      this.emitRaw(encodeFailure('invalid', 'INVALID_MESSAGE', 'Request line is too long.'));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emitRaw(encodeFailure('invalid', 'INVALID_JSON', 'Request is not valid JSON.'));
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.emitRaw(encodeFailure('invalid', 'INVALID_MESSAGE', 'Request must be an object.'));
      return;
    }
    const message = parsed as { id?: unknown; action?: unknown; payload?: unknown };
    if (typeof message.id !== 'string' || typeof message.action !== 'string') {
      this.emitRaw(
        encodeFailure('invalid', 'INVALID_MESSAGE', 'Request must include string id and action.'),
      );
      return;
    }
    const payload =
      message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload)
        ? (message.payload as Record<string, unknown>)
        : {};
    try {
      const result = this.dispatch(message.action, payload);
      this.emitRaw(encodeResponse(message.id, result));
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'DEVICE_ERROR';
      const errMessage = error instanceof Error ? error.message : String(error);
      this.emitRaw(encodeFailure(message.id, code, errMessage));
    }
  }

  private dispatch(action: string, payload: Record<string, unknown>): Record<string, unknown> {
    switch (action) {
      case 'sys.hello':
        return this.helloInfo();
      case 'sys.ping':
        return { pong: true };
      case 'sys.info':
        return { uptimeMs: Date.now() - this.startedAt, freeHeap: 100_000 };
      case 'sys.arm':
        this.state.deviceState = 'armed';
        this.state.watchdog.deadlineMs = Date.now() + this.state.watchdog.timeoutMs;
        this.sink({
          atMs: Date.now() - this.startedAt,
          kind: 'device.state',
          value: 'armed',
        });
        return { state: 'armed' };
      case 'sys.disarm':
        this.state.deviceState = 'disarmed';
        this.sink({
          atMs: Date.now() - this.startedAt,
          kind: 'device.state',
          value: 'disarmed',
        });
        return { state: 'disarmed' };
      case 'watchdog.configure': {
        const timeoutMs = Number(payload.timeoutMs ?? 1000);
        this.state.watchdog.timeoutMs = timeoutMs;
        return { timeoutMs };
      }
      case 'watchdog.kick':
        if (this.state.deviceState === 'armed') {
          this.state.watchdog.deadlineMs = Date.now() + this.state.watchdog.timeoutMs;
        }
        return { kicked: true };
      case 'gpio.write': {
        this.assertArmed();
        const pin = requireNumber(payload.pin, 'pin');
        assertUsableGpio(this.profile, pin);
        if (this.profile.id !== 'uno' && [34, 35, 36, 39].includes(pin)) {
          throw Object.assign(new Error(`GPIO ${pin} is input-only.`), { code: 'INVALID_PIN' });
        }
        const value = Boolean(payload.value);
        this.state.levels.set(pin, value);
        this.state.modes.set(pin, 'output');
        this.sink({
          atMs: Date.now() - this.startedAt,
          kind: 'gpio.level',
          pin,
          value,
        });
        return { pin, value };
      }
      case 'gpio.read': {
        const pin = requireNumber(payload.pin, 'pin');
        assertUsableGpio(this.profile, pin);
        return { pin, value: this.state.levels.get(pin) ?? false };
      }
      case 'gpio.mode': {
        const pin = requireNumber(payload.pin, 'pin');
        assertUsableGpio(this.profile, pin);
        const mode = String(payload.mode ?? 'output') as 'input' | 'output' | 'pullup' | 'pulldown';
        this.state.modes.set(pin, mode);
        return { pin, mode };
      }
      case 'gpio.servo': {
        this.assertArmed();
        const pin = requireNumber(payload.pin, 'pin');
        assertPwmPin(this.profile, pin);
        const angle = requireNumber(payload.angle, 'angle');
        if (angle < 0 || angle > 180) {
          throw Object.assign(new Error('Servo angle must be 0-180.'), {
            code: 'INVALID_PAYLOAD',
          });
        }
        this.state.servos.set(pin, angle);
        this.state.modes.set(pin, 'output');
        this.sink({
          atMs: Date.now() - this.startedAt,
          kind: 'gpio.servo',
          pin,
          value: angle,
        });
        return { pin, angle };
      }
      case 'gpio.analogRead': {
        const pin = requireNumber(payload.pin, 'pin');
        assertAdcPin(this.profile, pin);
        const value = this.state.analogLevels.get(pin) ?? 0;
        this.sink({
          atMs: Date.now() - this.startedAt,
          kind: 'gpio.analogRead',
          pin,
          value,
        });
        return { pin, value };
      }
      case 'gpio.stopAll': {
        const stopped = [...this.state.levels.keys()];
        this.state.levels.clear();
        this.state.servos.clear();
        return { stoppedPins: stopped };
      }
      default:
        throw Object.assign(new Error(`Unknown action '${action}'.`), { code: 'UNKNOWN_ACTION' });
    }
  }

  private helloInfo(): Record<string, unknown> {
    return {
      boardId: this.profile.boardId,
      firmware: `${this.profile.id}-bench-bridge`,
      version: '0.1.0-bench',
      protocol: protocolVersion,
      capabilities: [
        'sys.hello',
        'sys.ping',
        'sys.info',
        'sys.arm',
        'sys.disarm',
        'watchdog.configure',
        'watchdog.kick',
        'gpio.mode',
        'gpio.write',
        'gpio.read',
        'gpio.servo',
        'gpio.analogRead',
        'gpio.stopAll',
      ],
      features: ['watchdog', 'arming'],
      simulated: true,
      evidence: 'SIMULATED',
    };
  }

  private assertArmed(): void {
    if (this.state.deviceState !== 'armed') {
      throw Object.assign(new Error('Device is disarmed.'), { code: 'NOT_ARMED' });
    }
  }

  private emitRaw(line: string): void {
    this.inbound.push(new TextEncoder().encode(`${line}\n`));
  }
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw Object.assign(new Error(`${name} must be a number.`), { code: 'INVALID_PAYLOAD' });
  }
  return value;
}

function encodeResponse(id: string, result: Record<string, unknown>): string {
  return JSON.stringify({ v: protocolVersion, id, ok: true, result });
}

function encodeFailure(id: string, code: string, message: string): string {
  return JSON.stringify({ v: protocolVersion, id, ok: false, error: { code, message } });
}

function encodeEvent(event: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ v: protocolVersion, event, payload });
}
