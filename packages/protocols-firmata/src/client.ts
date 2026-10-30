/**
 * Firmata client (spec v1).
 *
 * Speaks Firmata v2.5 over any Pinout {@link Transport}: handshake, pin
 * capabilities and analog mapping discovery, pin modes, digital I/O, PWM,
 * servos, analog input, sampling interval, and I2C.
 *
 * Truthfulness rules baked into this client:
 * - Firmata has no write acknowledgements. Write methods resolve once the
 *   bytes are handed to the transport; only queries await a device response.
 * - Every query is serialized and bounded. A query that times out closes the
 *   link, so a late response can never be attributed to a later request.
 * - The handshake actively queries the protocol version and firmware instead
 *   of relying on boot messages, which are missed when a link is already up.
 *
 * THIS DRIVES REAL PINS AND BUSES. Nothing here makes wiring safe: the client
 * cannot know what a pin is connected to. Support status: IMPLEMENTED
 * (simulator-tested only), never HARDWARE_VERIFIED.
 */

import type { Transport } from '@pinout/core';
import {
  FirmataClosedError,
  FirmataDeviceError,
  FirmataQueueFullError,
  FirmataTimeoutError,
  FirmataUnsupportedError,
  FirmataValidationError,
} from './errors.js';
import {
  FirmataDecoder,
  FirmataI2cMaxReadBytes,
  FirmataPinMode,
  encodeAnalogMappingQuery,
  encodeAnalogWrite,
  encodeCapabilityQuery,
  encodeDigitalPortWrite,
  encodeFirmwareQuery,
  encodeI2cConfig,
  encodeI2cReadRequest,
  encodeI2cStopReading,
  encodeI2cWriteRequest,
  encodePinStateQuery,
  encodeReportAnalog,
  encodeReportDigitalPort,
  encodeSamplingInterval,
  encodeServoConfig,
  encodeSetDigitalPinValue,
  encodeSetPinMode,
  encodeVersionRequest,
  resolvePinMode,
  type FirmataFirmwareReport,
  type FirmataI2cReplyMessage,
  type FirmataMessage,
  type FirmataPinCapabilities,
  type FirmataPinModeName,
  type FirmataPinStateResponse,
} from './wire.js';

export interface FirmataClientOptions {
  /** Default per-request timeout in milliseconds (default 5000). */
  timeoutMs?: number;
  /** How long the handshake waits for the version response (default 3000). */
  handshakeTimeoutMs?: number;
  /** Maximum queued-and-not-yet-started requests before rejecting (default 64). */
  maxQueueDepth?: number;
  /** Abandon a sysex frame longer than this many payload bytes (default 4096). */
  maxSysexBytes?: number;
  /** Called for device messages that no request is waiting for. */
  onNotice?: (notice: FirmataNotice) => void;
}

/** A stream change pushed by the device after reporting is enabled. */
export type FirmataChange =
  | {
      kind: 'digital';
      port: number;
      /** Port value as received (up to 14 bits; 8 pins are meaningful). */
      value: number;
      /** Only the pins whose level changed since the previous report. */
      pins: Array<{ pin: number; value: number }>;
    }
  | { kind: 'analog'; channel: number; value: number }
  | { kind: 'i2c'; address: number; register: number; data: number[] };

/** A device message that no pending request consumed. */
export type FirmataNotice =
  | { kind: 'string'; text: string }
  | { kind: 'deviceError'; code: number; message: string; error: FirmataDeviceError }
  | { kind: 'sysex'; command: number; payload: number[] }
  | { kind: 'malformed'; reason: string }
  | { kind: 'version'; major: number; minor: number }
  | { kind: 'firmware'; report: FirmataFirmwareReport };

/** Handshake result: protocol version plus whatever firmware answered. */
export interface FirmataInfo {
  protocolMajor: number;
  protocolMinor: number;
  /** e.g. `2.5`. */
  protocolVersion: string;
  firmwareName: string | null;
  firmwareMajor: number | null;
  firmwareMinor: number | null;
  /** e.g. `2.5`, or null when the firmware report never arrived. */
  firmwareVersion: string | null;
}

type MessageOf<K extends FirmataMessage['kind']> = Extract<FirmataMessage, { kind: K }>;

interface Waiter {
  match: (message: FirmataMessage) => boolean;
  resolve: (message: FirmataMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    timer.unref();
  }
}

export class FirmataClient {
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly maxQueueDepth: number;
  private readonly decoder: FirmataDecoder;
  private readonly waiters = new Set<Waiter>();
  private readonly changeHandlers = new Set<(change: FirmataChange) => void>();
  private readonly noticeHandlers = new Set<(notice: FirmataNotice) => void>();
  private readonly lastPortValues = new Map<number, number>();
  private readonly pinModes = new Map<number, number>();
  private readonly portLatch = new Map<number, number>();
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private opened = false;
  private closed = false;
  private openPromise: Promise<FirmataInfo> | null = null;
  private handshakeInfo: FirmataInfo | null = null;
  private capabilityCache: FirmataPinCapabilities[] | null = null;
  private analogMappingCache: Array<number | null> | null = null;
  private i2cConfigured = false;

  constructor(transport: Transport, options: FirmataClientOptions = {}) {
    this.transport = transport;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 3000;
    this.maxQueueDepth = options.maxQueueDepth ?? 64;
    this.decoder = new FirmataDecoder({
      direction: 'device',
      ...(options.maxSysexBytes !== undefined ? { maxSysexBytes: options.maxSysexBytes } : {}),
    });
    const initialNotice = options.onNotice;
    if (initialNotice !== undefined) {
      this.noticeHandlers.add(initialNotice);
    }
  }

  /** True between a successful open() and close(). */
  get isOpen(): boolean {
    return this.opened && !this.closed;
  }

  /** Handshake result, once open() has resolved. */
  get info(): FirmataInfo | null {
    return this.handshakeInfo;
  }

  /**
   * Open the transport and handshake: query the protocol version, then the
   * firmware name and version. Resolves with the handshake result.
   */
  async open(): Promise<FirmataInfo> {
    if (this.openPromise) {
      if (this.closed) {
        throw new FirmataClosedError(
          'The Firmata client is closed; create a new client to reconnect.',
        );
      }
      return this.openPromise;
    }
    this.openPromise = this.performHandshake();
    return this.openPromise;
  }

  /**
   * Close the transport. Any request still waiting for a response is rejected
   * with {@link FirmataClosedError}. Idempotent.
   */
  async close(): Promise<void> {
    await this.closeWithReason('The Firmata link was closed.');
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Query pin capabilities (`CAPABILITY_QUERY`). Cached for later validation. */
  async queryCapabilities(timeoutMs = this.timeoutMs): Promise<FirmataPinCapabilities[]> {
    return this.enqueue(async () => {
      const pins = await this.query(
        (message): message is MessageOf<'capabilityResponse'> =>
          message.kind === 'capabilityResponse',
        () => this.transport.write(encodeCapabilityQuery()),
        'capability response',
        timeoutMs,
      );
      this.capabilityCache = pins.pins;
      return pins.pins;
    });
  }

  /** Query the analog-channel-to-pin mapping (`ANALOG_MAPPING_QUERY`). */
  async queryAnalogMapping(timeoutMs = this.timeoutMs): Promise<Array<number | null>> {
    return this.enqueue(async () => {
      const mapping = await this.query(
        (message): message is MessageOf<'analogMappingResponse'> =>
          message.kind === 'analogMappingResponse',
        () => this.transport.write(encodeAnalogMappingQuery()),
        'analog mapping response',
        timeoutMs,
      );
      this.analogMappingCache = mapping.channels;
      return mapping.channels;
    });
  }

  /** Query one pin's mode and last written state (`PIN_STATE_QUERY`). */
  async queryPinState(pin: number, timeoutMs = this.timeoutMs): Promise<FirmataPinStateResponse> {
    return this.enqueue(async () => {
      const state = await this.query(
        (message): message is MessageOf<'pinStateResponse'> =>
          message.kind === 'pinStateResponse' && message.pin === pin,
        () => this.transport.write(encodePinStateQuery(pin)),
        `pin state for pin ${String(pin)}`,
        timeoutMs,
      );
      this.pinModes.set(pin, state.mode);
      return state;
    });
  }

  /** Query the firmware name and version (`REPORT_FIRMWARE` sysex). */
  async queryFirmware(timeoutMs = this.timeoutMs): Promise<FirmataFirmwareReport> {
    return this.enqueue(async () => {
      const firmware = await this.query(
        (message): message is MessageOf<'firmware'> => message.kind === 'firmware',
        () => this.transport.write(encodeFirmwareQuery()),
        'firmware report',
        timeoutMs,
      );
      return { major: firmware.major, minor: firmware.minor, name: firmware.name };
    });
  }

  // -------------------------------------------------------------------------
  // Pin configuration and writes
  // -------------------------------------------------------------------------

  /** Set a pin's mode (`SET_PIN_MODE`). */
  async setPinMode(pin: number, mode: FirmataPinModeName | number): Promise<void> {
    return this.enqueue(async () => {
      this.assertPinKnown(pin);
      if (typeof mode === 'string') {
        this.assertModeSupported(pin, mode);
      }
      await this.transport.write(encodeSetPinMode(pin, mode));
      this.pinModes.set(pin, resolvePinMode(mode));
    });
  }

  /**
   * Write a digital level.
   *
   * `mode: 'pin'` (default) sends `SET_DIGITAL_PIN_VALUE`, which the device
   * only applies when the pin is in OUTPUT mode. `mode: 'port'` rewrites the
   * whole digital port from a locally tracked latch, for devices or firmware
   * that do not implement the single-pin message.
   */
  async digitalWrite(
    pin: number,
    value: boolean | 0 | 1,
    options: { mode?: 'pin' | 'port' } = {},
  ): Promise<void> {
    return this.enqueue(async () => {
      this.assertPinKnown(pin);
      const level = value ? 1 : 0;
      if ((options.mode ?? 'pin') === 'port') {
        const port = pin >>> 3;
        const bit = 1 << (pin & 7);
        const current = this.portLatch.get(port) ?? 0;
        const next = level === 1 ? current | bit : current & ~bit;
        await this.transport.write(encodeDigitalPortWrite(port, next));
        this.portLatch.set(port, next);
        return;
      }
      await this.transport.write(encodeSetDigitalPinValue(pin, level));
    });
  }

  /**
   * Read one digital pin level.
   *
   * Firmata has no per-pin read request: this forces a fresh port report by
   * disabling and re-enabling reporting for the pin's port, which makes the
   * device send the current port value immediately. The pin must be in
   * `input` or `pullup` mode.
   */
  async digitalRead(pin: number, timeoutMs = this.timeoutMs): Promise<number> {
    return this.enqueue(async () => {
      this.assertPinKnown(pin);
      const port = pin >>> 3;
      const message = await this.query(
        (candidate): candidate is MessageOf<'digital'> =>
          candidate.kind === 'digital' && candidate.port === port,
        async () => {
          await this.transport.write(encodeReportDigitalPort(port, false));
          await this.transport.write(encodeReportDigitalPort(port, true));
        },
        `digital report for port ${String(port)}`,
        timeoutMs,
      );
      return (message.value >> (pin & 7)) & 1;
    });
  }

  /**
   * Read one analog channel value (14-bit on the wire).
   *
   * Enables reporting for the channel, waits for the immediate reading real
   * firmware sends on enable, then disables reporting again.
   */
  async analogRead(channel: number, timeoutMs = this.timeoutMs): Promise<number> {
    return this.enqueue(async () => {
      this.assertAnalogChannelKnown(channel);
      const waiter = this.waitFor(
        (candidate): candidate is MessageOf<'analog'> =>
          candidate.kind === 'analog' && candidate.channel === channel,
        timeoutMs,
        true,
        `analog reading for channel ${String(channel)}`,
      );
      try {
        await this.transport.write(encodeReportAnalog(channel, true));
        return (await waiter.promise).value;
      } finally {
        waiter.cancel();
        await this.transport.write(encodeReportAnalog(channel, false)).catch(() => undefined);
      }
    });
  }

  /** Write a PWM duty value (0–255 at 8-bit resolution) to a pin in PWM mode. */
  async pwmWrite(pin: number, value: number): Promise<void> {
    return this.enqueue(async () => {
      this.assertPinKnown(pin);
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new FirmataValidationError(
          `PWM value must be an integer between 0 and 255, received ${String(value)}.`,
        );
      }
      this.assertModeIs(pin, 'pwm', 'PWM');
      await this.transport.write(encodeAnalogWrite(pin, value));
    });
  }

  /** Write a servo angle in degrees (0–180) to a pin in SERVO mode. */
  async servoWrite(pin: number, angle: number): Promise<void> {
    return this.enqueue(async () => {
      this.assertPinKnown(pin);
      if (!Number.isInteger(angle) || angle < 0 || angle > 180) {
        throw new FirmataValidationError(
          `Servo angle must be an integer between 0 and 180 degrees, received ${String(angle)}.`,
        );
      }
      this.assertModeIs(pin, 'servo', 'SERVO');
      await this.transport.write(encodeAnalogWrite(pin, angle));
    });
  }

  /**
   * Configure a servo's pulse range (`SERVO_CONFIG`, which also attaches the
   * servo and puts the pin in SERVO mode).
   */
  async servoConfig(pin: number, range: { minPulse: number; maxPulse: number }): Promise<void> {
    return this.enqueue(async () => {
      this.assertPinKnown(pin);
      await this.transport.write(encodeServoConfig(pin, range.minPulse, range.maxPulse));
      this.pinModes.set(pin, FirmataPinMode.servo);
    });
  }

  /** Enable or disable analog reporting for a channel (`REPORT_ANALOG`). */
  async reportAnalog(channel: number, enable: boolean): Promise<void> {
    return this.enqueue(async () => {
      await this.transport.write(encodeReportAnalog(channel, enable));
    });
  }

  /** Enable or disable digital reporting for a port (`REPORT_DIGITAL`). */
  async reportDigitalPort(port: number, enable: boolean): Promise<void> {
    return this.enqueue(async () => {
      await this.transport.write(encodeReportDigitalPort(port, enable));
    });
  }

  /** Set the device's sampling interval in milliseconds (1–16383). */
  async setSamplingInterval(intervalMs: number): Promise<void> {
    return this.enqueue(async () => {
      await this.transport.write(encodeSamplingInterval(intervalMs));
    });
  }

  // -------------------------------------------------------------------------
  // I2C
  // -------------------------------------------------------------------------

  /**
   * Enable I2C (`I2C_CONFIG`), which reconfigures the board's I2C pins to
   * `I2C` mode. Safe to call repeatedly; the delay only matters for hardware
   * that needs a pause between register write and read.
   */
  async i2cConfig(options: { delayMs?: number } = {}): Promise<void> {
    return this.enqueue(async () => {
      await this.transport.write(encodeI2cConfig(options.delayMs ?? 0));
      this.i2cConfigured = true;
    });
  }

  /** True after `i2cConfig()` has been issued on this client. */
  get isI2cConfigured(): boolean {
    return this.i2cConfigured;
  }

  /**
   * One-shot I2C read. `count` is capped at 62 bytes because StandardFirmata
   * buffers replies in a 64-byte array that also holds address and register.
   */
  async i2cRead(
    address: number,
    options: { register?: number; count: number },
    timeoutMs = this.timeoutMs,
  ): Promise<FirmataI2cReplyMessage> {
    return this.enqueue(async () => {
      const count = this.assertI2cCount(options.count);
      const message = await this.query(
        (candidate): candidate is MessageOf<'i2cReply'> =>
          candidate.kind === 'i2cReply' && candidate.address === address,
        () =>
          this.transport.write(
            encodeI2cReadRequest({
              address,
              count,
              ...(options.register !== undefined ? { register: options.register } : {}),
            }),
          ),
        `I2C reply from address ${String(address)}`,
        timeoutMs,
      );
      return { address: message.address, register: message.register, data: message.data };
    });
  }

  /**
   * Start periodic I2C reads. Each report arrives as an {@link FirmataChange}
   * of kind `i2c` to subscribers; run the device's loop (simulator:
   * `pumpI2cContinuous()`) for reports to be produced.
   */
  async i2cReadContinuous(
    address: number,
    options: { register?: number; count: number },
  ): Promise<void> {
    return this.enqueue(async () => {
      const count = this.assertI2cCount(options.count);
      await this.transport.write(
        encodeI2cReadRequest({
          address,
          count,
          mode: 'readContinuous',
          ...(options.register !== undefined ? { register: options.register } : {}),
        }),
      );
    });
  }

  /**
   * Stop continuous reads for an address.
   *
   * Device quirk mirrored here and in the simulator: with fewer than two
   * active continuous reads, StandardFirmata stops all of them regardless of
   * the address.
   */
  async i2cStopReading(address: number): Promise<void> {
    return this.enqueue(async () => {
      await this.transport.write(encodeI2cStopReading(address));
    });
  }

  /**
   * I2C write. With `register`, it is written first (register-select); the
   * remaining `data` bytes follow. An empty `data` with a `register` only
   * sets the register pointer, which many devices use for read-backs.
   */
  async i2cWrite(
    address: number,
    options: { register?: number; data?: readonly number[] },
  ): Promise<void> {
    return this.enqueue(async () => {
      const data = options.data ?? [];
      if (data.length === 0 && options.register === undefined) {
        throw new FirmataValidationError('I2C write requires "data" bytes or a "register".');
      }
      await this.transport.write(
        encodeI2cWriteRequest({
          address,
          data,
          ...(options.register !== undefined ? { register: options.register } : {}),
        }),
      );
    });
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  /** Subscribe to digital, analog, and I2C stream changes. */
  subscribe(handler: (change: FirmataChange) => void): () => void {
    this.changeHandlers.add(handler);
    return () => this.changeHandlers.delete(handler);
  }

  /** Subscribe to notices: strings, simulator diagnostics, unknown sysex, malformed frames. */
  onNotice(handler: (notice: FirmataNotice) => void): () => void {
    this.noticeHandlers.add(handler);
    return () => this.noticeHandlers.delete(handler);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async performHandshake(): Promise<FirmataInfo> {
    const versionWaiter = this.waitFor(
      (message): message is MessageOf<'version'> => message.kind === 'version',
      this.handshakeTimeoutMs,
      true,
      'protocol version report',
    );
    try {
      await this.transport.open();
      this.opened = true;
      this.closed = false;
      void this.readLoop();

      // Actively query instead of relying on boot messages: a reconnected link
      // never sees them, and a board that reset on port open may be slow.
      await this.transport.write(encodeVersionRequest());
      const version = await versionWaiter.promise;

      // The firmware report is optional: Firmata-compatible firmwares that do
      // not answer REPORT_FIRMWARE queries still operate; the name is then
      // simply unknown (never guessed).
      const firmwareWaiter = this.waitFor(
        (message): message is MessageOf<'firmware'> => message.kind === 'firmware',
        this.handshakeTimeoutMs,
        false,
        'firmware report',
      );
      const firmwareOutcome = firmwareWaiter.promise.then(
        (report) => report,
        () => null,
      );
      await this.transport.write(encodeFirmwareQuery());
      const firmware = await firmwareOutcome;

      const info: FirmataInfo = {
        protocolMajor: version.major,
        protocolMinor: version.minor,
        protocolVersion: `${String(version.major)}.${String(version.minor)}`,
        firmwareName: firmware ? firmware.name : null,
        firmwareMajor: firmware ? firmware.major : null,
        firmwareMinor: firmware ? firmware.minor : null,
        firmwareVersion: firmware ? `${String(firmware.major)}.${String(firmware.minor)}` : null,
      };
      this.handshakeInfo = info;
      return info;
    } catch (error) {
      versionWaiter.cancel();
      await this.closeWithReason('The Firmata handshake failed; the link was closed.').catch(
        () => undefined,
      );
      throw error;
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new FirmataClosedError('The Firmata link is closed.'));
    }
    if (this.queued >= this.maxQueueDepth) {
      return Promise.reject(
        new FirmataQueueFullError(
          `Firmata request queue is full (${String(this.maxQueueDepth)} pending); the link is backpressured on purpose.`,
        ),
      );
    }
    this.queued += 1;
    const run = this.tail.then(() => {
      this.queued -= 1;
      if (this.closed) {
        throw new FirmataClosedError('The Firmata link is closed.');
      }
      if (!this.opened) {
        throw new FirmataClosedError('The Firmata link is not open; call open() first.');
      }
      return task();
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async query<T extends FirmataMessage>(
    predicate: (message: FirmataMessage) => message is T,
    write: () => Promise<void>,
    description: string,
    timeoutMs: number,
  ): Promise<T> {
    const waiter = this.waitFor(predicate, timeoutMs, true, description);
    try {
      await write();
    } catch (error) {
      waiter.cancel();
      throw error;
    }
    return waiter.promise;
  }

  private waitFor<T extends FirmataMessage>(
    predicate: (message: FirmataMessage) => message is T,
    timeoutMs: number,
    closeOnTimeout: boolean,
    description: string,
  ): { promise: Promise<T>; cancel: () => void } {
    let resolveOuter!: (message: T) => void;
    let rejectOuter!: (error: Error) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;
    });
    const waiter: Waiter = {
      match: predicate,
      resolve: (message) => {
        resolveOuter(message as T);
      },
      reject: rejectOuter,
      timer: undefined,
    };
    const timer = setTimeout(() => {
      this.removeWaiter(waiter);
      if (closeOnTimeout) {
        // A late response must never be attributed to a later request.
        void this.closeWithReason(
          `No Firmata response within ${String(timeoutMs)} ms; the link was closed.`,
        );
      }
      rejectOuter(new FirmataTimeoutError(`No ${description} within ${String(timeoutMs)} ms.`));
    }, timeoutMs);
    unrefTimer(timer);
    waiter.timer = timer;
    this.waiters.add(waiter);
    return { promise, cancel: () => this.removeWaiter(waiter) };
  }

  private removeWaiter(waiter: Waiter): void {
    if (this.waiters.delete(waiter) && waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
    }
  }

  private failWaiters(error: FirmataClosedError): void {
    for (const waiter of [...this.waiters]) {
      this.removeWaiter(waiter);
      waiter.reject(error);
    }
  }

  private async closeWithReason(message: string): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failWaiters(new FirmataClosedError(message));
    await this.transport.close().catch(() => undefined);
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const chunk of this.transport.readable) {
        for (const message of this.decoder.push(chunk)) {
          this.dispatch(message);
        }
      }
    } catch {
      // The transport failed or was closed underneath us; waiters are failed below.
    }
    if (!this.closed) {
      this.closed = true;
      this.failWaiters(
        new FirmataClosedError('The Firmata transport closed before a response arrived.'),
      );
      await this.transport.close().catch(() => undefined);
    }
  }

  private dispatch(message: FirmataMessage): void {
    let consumed = false;
    for (const waiter of [...this.waiters]) {
      if (waiter.match(message)) {
        this.removeWaiter(waiter);
        waiter.resolve(message);
        consumed = true;
        break;
      }
    }
    switch (message.kind) {
      case 'digital':
        this.handleDigital(message);
        return;
      case 'analog':
        this.emitChange({ kind: 'analog', channel: message.channel, value: message.value });
        return;
      case 'i2cReply':
        this.emitChange({
          kind: 'i2c',
          address: message.address,
          register: message.register,
          data: message.data,
        });
        return;
      default:
        if (!consumed) {
          this.noticeFromMessage(message);
        }
    }
  }

  private handleDigital(message: MessageOf<'digital'>): void {
    const previous = this.lastPortValues.get(message.port);
    const pins: Array<{ pin: number; value: number }> = [];
    for (let bit = 0; bit < 8; bit += 1) {
      const value = (message.value >> bit) & 1;
      if (previous === undefined || ((previous >> bit) & 1) !== value) {
        pins.push({ pin: message.port * 8 + bit, value });
      }
    }
    this.lastPortValues.set(message.port, message.value);
    if (pins.length > 0) {
      this.emitChange({ kind: 'digital', port: message.port, value: message.value, pins });
    }
  }

  private noticeFromMessage(message: FirmataMessage): void {
    switch (message.kind) {
      case 'stringData':
        this.emitNotice({ kind: 'string', text: message.text });
        return;
      case 'deviceError':
        this.emitNotice({
          kind: 'deviceError',
          code: message.code,
          message: message.message,
          error: new FirmataDeviceError(message.code, message.message),
        });
        return;
      case 'malformed':
        this.emitNotice({ kind: 'malformed', reason: message.reason });
        return;
      case 'sysex':
        this.emitNotice({ kind: 'sysex', command: message.command, payload: message.payload });
        return;
      case 'version':
        this.emitNotice({ kind: 'version', major: message.major, minor: message.minor });
        return;
      case 'firmware':
        this.emitNotice({
          kind: 'firmware',
          report: { major: message.major, minor: message.minor, name: message.name },
        });
        return;
      default:
        // Structured query responses with no waiter (should not happen while
        // requests are serialized) are dropped rather than guessed at.
        return;
    }
  }

  private emitChange(change: FirmataChange): void {
    for (const handler of [...this.changeHandlers]) {
      try {
        handler(change);
      } catch {
        // A misbehaving subscriber must not kill the read loop.
      }
    }
  }

  private emitNotice(notice: FirmataNotice): void {
    for (const handler of [...this.noticeHandlers]) {
      try {
        handler(notice);
      } catch {
        // A misbehaving notice handler must not kill the read loop.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Local validation (only when the device has told us what it supports)
  // -------------------------------------------------------------------------

  private assertPinKnown(pin: number): void {
    if (!Number.isInteger(pin) || pin < 0 || pin > 0x7f) {
      throw new FirmataValidationError(
        `Pin number must be an integer between 0 and 127, received ${String(pin)}.`,
      );
    }
    if (this.capabilityCache && pin >= this.capabilityCache.length) {
      throw new FirmataUnsupportedError(
        `Pin ${String(pin)} is beyond the ${String(this.capabilityCache.length)} pins reported by this device.`,
      );
    }
  }

  private assertModeSupported(pin: number, mode: FirmataPinModeName): void {
    if (!this.capabilityCache) {
      return;
    }
    const capabilities = this.capabilityCache[pin]?.capabilities ?? [];
    if (!capabilities.some((capability) => capability.mode === FirmataPinMode[mode])) {
      throw new FirmataUnsupportedError(`Pin ${String(pin)} does not report '${mode}' support.`);
    }
  }

  private assertModeIs(pin: number, mode: FirmataPinModeName, label: string): void {
    const known = this.pinModes.get(pin);
    if (known !== undefined && known !== FirmataPinMode[mode]) {
      throw new FirmataUnsupportedError(
        `Pin ${String(pin)} is not in ${label} mode (setPinMode first).`,
      );
    }
    this.assertModeSupported(pin, mode);
  }

  private assertAnalogChannelKnown(channel: number): void {
    if (!this.analogMappingCache) {
      return;
    }
    if (!this.analogMappingCache.includes(channel)) {
      throw new FirmataUnsupportedError(
        `Analog channel ${String(channel)} is not reported by this device.`,
      );
    }
  }

  private assertI2cCount(count: number): number {
    if (!Number.isInteger(count) || count < 1 || count > FirmataI2cMaxReadBytes) {
      throw new FirmataValidationError(
        `I2C read count must be an integer between 1 and ${String(FirmataI2cMaxReadBytes)} bytes, received ${String(count)}.`,
      );
    }
    return count;
  }
}
