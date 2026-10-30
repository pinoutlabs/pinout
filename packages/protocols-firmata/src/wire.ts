/**
 * Firmata v2.5 wire codec.
 *
 * Implements the byte-level protocol shared by Firmata hosts and devices, as
 * implemented by the Arduino Firmata library (`FirmataMarshaller.cpp`,
 * `FirmataParser.cpp`, `FirmataConstants.h`) and its reference sketch
 * StandardFirmata. Every layout in this file was checked against those
 * sources; no physical board was attached while this adapter was written.
 * Support status: IMPLEMENTED (simulator-tested only), never
 * HARDWARE_VERIFIED.
 *
 * Encoding rules worth knowing before touching this file:
 * - Sysex messages are `0xF0 <command> <data...> 0xF7`. Firmata is
 *   inconsistent about payload packing: CAPABILITY_RESPONSE,
 *   ANALOG_MAPPING_RESPONSE, PIN_STATE_RESPONSE and I2C_REPLY carry raw 7-bit
 *   bytes, while REPORT_FIRMWARE names and STRING_DATA pack each character
 *   into a low 7-bit byte plus a high 1-bit byte (`encodeByteStream` /
 *   `decodeByteStream` in the C++ library). Encoders here therefore emit
 *   finished wire bytes and the decoders unpack only the messages that are
 *   packed on the wire.
 * - Messages that combine two bytes into a 14-bit value (analog values,
 *   digital ports, I2C register/count/data, servo pulses, sampling interval)
 *   use low-7-bits first, then the high bits. {@link encodePair} builds that.
 * - Firmata devices never acknowledge writes. Only queries have responses.
 */

import { FirmataProtocolError, FirmataValidationError } from './errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Non-sysex command bytes and multi-byte status bytes (Firmata v2.5). */
export const FirmataWire = {
  /** Digital port status/data byte: `0x90 | port`. */
  digitalPort: 0x90,
  /** Analog channel status/data byte: `0xE0 | analogChannel`. */
  analog: 0xe0,
  /** Host -> device: enable/disable analog reporting for a channel. */
  reportAnalog: 0xc0,
  /** Host -> device: enable/disable digital reporting for a port. */
  reportDigital: 0xd0,
  /** Host -> device: set a pin's mode. */
  setPinMode: 0xf4,
  /** Host -> device: set a single digital pin's value (OUTPUT mode only). */
  setDigitalPinValue: 0xf5,
  /** Both directions: report protocol version. Two data bytes when sent by a device. */
  reportVersion: 0xf9,
  /** Both directions: reset to power-on state. Single byte, no data. */
  systemReset: 0xff,
  /** Sysex frame start. */
  startSysex: 0xf0,
  /** Sysex frame end. */
  endSysex: 0xf7,
} as const;

/** Sysex command bytes (the byte right after `0xF0`). */
export const FirmataSysex = {
  extendedAnalog: 0x6f,
  pinStateQuery: 0x6d,
  pinStateResponse: 0x6e,
  capabilityQuery: 0x6b,
  capabilityResponse: 0x6c,
  analogMappingQuery: 0x69,
  analogMappingResponse: 0x6a,
  servoConfig: 0x70,
  stringData: 0x71,
  i2cRequest: 0x76,
  i2cReply: 0x77,
  i2cConfig: 0x78,
  reportFirmware: 0x79,
  samplingInterval: 0x7a,
} as const;

/**
 * Sysex command 0x00 used by the bundled simulator for diagnostics.
 *
 * Stock StandardFirmata never sends this; on real hardware 0x00 begins the
 * MIDI extended-ID namespace. Probing firmware will never produce it, so the
 * decoder treats it as a simulator diagnostic. Documented conflict: a real
 * device emitting MIDI extended-ID messages would be misread as a device
 * error. Only enable it on simulators.
 */
export const FirmataSimulatorDiagnosticsSysex = 0x00;

/** Firmata pin mode values (FirmataConstants + StandardFirmata). */
export const FirmataPinMode = {
  input: 0x00,
  output: 0x01,
  analog: 0x02,
  pwm: 0x03,
  servo: 0x04,
  i2c: 0x06,
  pullup: 0x0b,
} as const;

export type FirmataPinModeName = keyof typeof FirmataPinMode;

/** I2C control-byte modes: the low 5 bits of the control byte in I2C_REQUEST. */
export const FirmataI2cMode = {
  write: 0x00,
  read: 0x08,
  readContinuous: 0x10,
  stopReading: 0x18,
} as const;

export type FirmataI2cModeName = keyof typeof FirmataI2cMode;

/** Control-byte bit selecting 10-bit addressing. StandardFirmata refuses these. */
export const FirmataI2cTenBitAddress = 0x20;
/** Control-byte bit that asks for a repeated start instead of a stop. */
export const FirmataI2cRestartTx = 0x40;

/**
 * Largest I2C read StandardFirmata can answer.
 *
 * `i2cRxData[64]` holds the slave address, the register, and the reply data,
 * so a request larger than 62 bytes would overflow device memory.
 */
export const FirmataI2cMaxReadBytes = 62;

/** Default sampling interval used by StandardFirmata (ms). */
export const FirmataDefaultSamplingIntervalMs = 19;

/** Largest 14-bit value representable by two 7-bit wire bytes. */
export const FirmataMax14Bit = 0x3fff;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function requireInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new FirmataValidationError(
      `${label} must be an integer between ${min} and ${max}, received ${String(value)}.`,
    );
  }
  return value;
}

function requireByte(value: number, label: string): number {
  return requireInteger(value, 0, 0xff, label);
}

/** Resolve a pin-mode name or raw value to its wire value. */
export function resolvePinMode(mode: FirmataPinModeName | number): number {
  if (typeof mode === 'number') {
    return requireInteger(mode, 0, 0x7f, 'Pin mode');
  }
  return FirmataPinMode[mode];
}

/** Map a wire pin-mode value back to its name, or `null` when unknown. */
export function pinModeName(value: number): FirmataPinModeName | null {
  for (const name of Object.keys(FirmataPinMode) as FirmataPinModeName[]) {
    if (FirmataPinMode[name] === value) {
      return name;
    }
  }
  return null;
}

/** Split a 14-bit value into low-7-bits then high-7-bits wire bytes. */
export function encodePair(value: number): [number, number] {
  const bounded = requireInteger(value, 0, FirmataMax14Bit, 'Pair value');
  return [bounded & 0x7f, (bounded >> 7) & 0x7f];
}

function readPair(bytes: readonly number[], index: number, label: string): number {
  const low = bytes[index];
  const high = bytes[index + 1];
  if (low === undefined || high === undefined) {
    throw new FirmataProtocolError(`${label} is missing its second 7-bit byte.`);
  }
  return (low & 0x7f) | ((high & 0x7f) << 7);
}

// ---------------------------------------------------------------------------
// Encoders (host -> device)
// ---------------------------------------------------------------------------

/**
 * Build a sysex frame: `0xF0 <command> <payload...> 0xF7`.
 *
 * Payload bytes are finished wire bytes and must already be 7-bit; this
 * mirrors `firmata.js`, and the C++ marshaller's pair-expanding `sendSysex`
 * is expressed by passing {@link encodePair} results explicitly.
 */
export function encodeSysex(command: number, payload: readonly number[] = []): Uint8Array {
  const commandByte = requireInteger(command, 0, 0x7f, 'Sysex command');
  const frame = new Uint8Array(payload.length + 3);
  frame[0] = FirmataWire.startSysex;
  frame[1] = commandByte;
  for (let index = 0; index < payload.length; index += 1) {
    frame[index + 2] = requireInteger(payload[index]!, 0, 0x7f, `Sysex payload byte ${index}`);
  }
  frame[frame.length - 1] = FirmataWire.endSysex;
  return frame;
}

/** Query the protocol version (`0xF9`). The device answers with two data bytes. */
export function encodeVersionRequest(): Uint8Array {
  return new Uint8Array([FirmataWire.reportVersion]);
}

/** System reset (`0xFF`). Resets the device to power-on configuration. */
export function encodeSystemReset(): Uint8Array {
  return new Uint8Array([FirmataWire.systemReset]);
}

/** Query firmware name and version (`REPORT_FIRMWARE` sysex). */
export function encodeFirmwareQuery(): Uint8Array {
  return encodeSysex(FirmataSysex.reportFirmware);
}

/** Query pin capabilities (`CAPABILITY_QUERY`). */
export function encodeCapabilityQuery(): Uint8Array {
  return encodeSysex(FirmataSysex.capabilityQuery);
}

/** Query the analog-channel-to-pin mapping (`ANALOG_MAPPING_QUERY`). */
export function encodeAnalogMappingQuery(): Uint8Array {
  return encodeSysex(FirmataSysex.analogMappingQuery);
}

/** Query one pin's mode and last written state (`PIN_STATE_QUERY`). */
export function encodePinStateQuery(pin: number): Uint8Array {
  return encodeSysex(FirmataSysex.pinStateQuery, [requireInteger(pin, 0, 0x7f, 'Pin number')]);
}

/** Set a pin's mode (`SET_PIN_MODE`). */
export function encodeSetPinMode(pin: number, mode: FirmataPinModeName | number): Uint8Array {
  return new Uint8Array([
    FirmataWire.setPinMode,
    requireInteger(pin, 0, 0x7f, 'Pin number'),
    resolvePinMode(mode),
  ]);
}

/**
 * Set one digital pin's value (`SET_DIGITAL_PIN_VALUE`).
 *
 * StandardFirmata only applies this when the pin is already in OUTPUT mode.
 */
export function encodeSetDigitalPinValue(pin: number, value: boolean | 0 | 1): Uint8Array {
  return new Uint8Array([
    FirmataWire.setDigitalPinValue,
    requireInteger(pin, 0, 0x7f, 'Pin number'),
    value ? 1 : 0,
  ]);
}

/** Write all pins of a digital port at once (`DIGITAL_MESSAGE`). */
export function encodeDigitalPortWrite(port: number, portValue: number): Uint8Array {
  const [low, high] = encodePair(requireInteger(portValue, 0, FirmataMax14Bit, 'Port value'));
  return new Uint8Array([
    FirmataWire.digitalPort | requireInteger(port, 0, 0x0f, 'Port'),
    low,
    high,
  ]);
}

/** Enable or disable analog reporting for an analog channel (`REPORT_ANALOG`). */
export function encodeReportAnalog(channel: number, enable: boolean): Uint8Array {
  return new Uint8Array([
    FirmataWire.reportAnalog | requireInteger(channel, 0, 0x0f, 'Analog channel'),
    enable ? 1 : 0,
  ]);
}

/** Enable or disable digital reporting for a port (`REPORT_DIGITAL`). */
export function encodeReportDigitalPort(port: number, enable: boolean): Uint8Array {
  return new Uint8Array([
    FirmataWire.reportDigital | requireInteger(port, 0, 0x0f, 'Port'),
    enable ? 1 : 0,
  ]);
}

/**
 * Write an analog-style value to a pin (`ANALOG_MESSAGE` or `EXTENDED_ANALOG`).
 *
 * Used for PWM duty (`0–255` at 8-bit resolution), servo angles, and any
 * value beyond the 14-bit/`0–15` limits of the plain analog message. The
 * device decides what the value means from the pin's current mode, and
 * StandardFirmata silently ignores the write for pins not in PWM or SERVO
 * mode.
 */
export function encodeAnalogWrite(pin: number, value: number): Uint8Array {
  const pinNumber = requireInteger(pin, 0, 0x7f, 'Pin number');
  const analogValue = requireInteger(value, 0, 0x1fffff, 'Analog value');
  if (pinNumber <= 0x0f && analogValue <= FirmataMax14Bit) {
    const [low, high] = encodePair(analogValue);
    return new Uint8Array([FirmataWire.analog | pinNumber, low, high]);
  }
  const chunks = [analogValue & 0x7f, (analogValue >> 7) & 0x7f];
  if (analogValue > FirmataMax14Bit) {
    chunks.push((analogValue >> 14) & 0x7f);
  }
  return encodeSysex(FirmataSysex.extendedAnalog, [pinNumber, ...chunks]);
}

/** Configure a servo's pulse range (`SERVO_CONFIG`, also attaches the pin). */
export function encodeServoConfig(pin: number, minPulse: number, maxPulse: number): Uint8Array {
  return encodeSysex(FirmataSysex.servoConfig, [
    requireInteger(pin, 0, 0x7f, 'Pin number'),
    ...encodePair(requireInteger(minPulse, 0, FirmataMax14Bit, 'Minimum pulse')),
    ...encodePair(requireInteger(maxPulse, 0, FirmataMax14Bit, 'Maximum pulse')),
  ]);
}

/**
 * Set the sampling interval (`SAMPLING_INTERVAL`), in milliseconds.
 *
 * StandardFirmata reads only two payload bytes and clamps values below 1 ms
 * up to 1 ms, so this adapter accepts 1–16383.
 */
export function encodeSamplingInterval(intervalMs: number): Uint8Array {
  return encodeSysex(FirmataSysex.samplingInterval, [
    ...encodePair(requireInteger(intervalMs, 1, FirmataMax14Bit, 'Sampling interval')),
  ]);
}

/**
 * Enable I2C and optionally set a read delay (`I2C_CONFIG`).
 *
 * Enabling I2C reconfigures the board's I2C pins to `I2C` mode. On an Uno
 * those are A4/A5 (Firmata pins 18/19).
 */
export function encodeI2cConfig(delayMs = 0): Uint8Array {
  return encodeSysex(FirmataSysex.i2cConfig, [
    ...encodePair(requireInteger(delayMs, 0, FirmataMax14Bit, 'I2C read delay')),
  ]);
}

function i2cControl(mode: FirmataI2cModeName, stopTx: boolean): number {
  return FirmataI2cMode[mode] | (stopTx ? 0 : FirmataI2cRestartTx);
}

function requireI2cAddress(address: number): number {
  // Firmata carries the address raw; 10-bit addresses are refused by
  // StandardFirmata, so only the 7-bit space is legal here.
  return requireInteger(address, 0, 0x7f, 'I2C address');
}

export interface FirmataI2cReadOptions {
  /** 7-bit I2C address (0–127). */
  address: number;
  /** Register selector written before the read; omit for a bare request. */
  register?: number;
  /** Bytes to read (1–16383 on the wire; see {@link FirmataI2cMaxReadBytes}). */
  count: number;
  /** `read` (default) is one-shot; `readContinuous` enables periodic reports. */
  mode?: 'read' | 'readContinuous';
  /** `false` requests a repeated start instead of a stop. Default `true`. */
  stopTx?: boolean;
}

/** Build an `I2C_REQUEST` frame for a one-shot or continuous read. */
export function encodeI2cReadRequest(options: FirmataI2cReadOptions): Uint8Array {
  const address = requireI2cAddress(options.address);
  const count = requireInteger(options.count, 1, FirmataMax14Bit, 'I2C read count');
  const mode = options.mode ?? 'read';
  const payload = [address, i2cControl(mode, options.stopTx ?? true)];
  if (options.register !== undefined) {
    payload.push(
      ...encodePair(requireInteger(options.register, 0, FirmataMax14Bit, 'I2C register')),
    );
  }
  payload.push(...encodePair(count));
  return encodeSysex(FirmataSysex.i2cRequest, payload);
}

export interface FirmataI2cWriteOptions {
  /** 7-bit I2C address (0–127). */
  address: number;
  /** Register selector; when present it is the first byte written. */
  register?: number;
  /** Bytes to write. May be empty when `register` is present (pointer set). */
  data: readonly number[];
  /** `false` requests a repeated start instead of a stop. Default `true`. */
  stopTx?: boolean;
}

/** Build an `I2C_REQUEST` frame for a write. */
export function encodeI2cWriteRequest(options: FirmataI2cWriteOptions): Uint8Array {
  const address = requireI2cAddress(options.address);
  const data = options.data.map((byte, index) => requireByte(byte, `I2C data byte ${index}`));
  const payload = [address, i2cControl('write', options.stopTx ?? true)];
  if (options.register !== undefined) {
    payload.push(
      ...encodePair(requireInteger(options.register, 0, FirmataMax14Bit, 'I2C register')),
    );
  }
  for (const byte of data) {
    payload.push(...encodePair(byte));
  }
  return encodeSysex(FirmataSysex.i2cRequest, payload);
}

/**
 * Build an `I2C_REQUEST` frame that stops continuous reads.
 *
 * StandardFirmata needs the address byte; with fewer than two active queries
 * it stops every continuous read regardless of the address (device quirk
 * mirrored by the bundled simulator).
 */
export function encodeI2cStopReading(address: number): Uint8Array {
  return encodeSysex(FirmataSysex.i2cRequest, [
    requireI2cAddress(address),
    FirmataI2cMode.stopReading,
  ]);
}

// ---------------------------------------------------------------------------
// Decoders (device -> host)
// ---------------------------------------------------------------------------

export interface FirmataPinCapability {
  /** Raw Firmata pin mode value. */
  mode: number;
  /** Resolution bits reported for the mode (e.g. 8 for PWM, 10 for analog). */
  resolution: number;
}

export interface FirmataPinCapabilities {
  pin: number;
  capabilities: FirmataPinCapability[];
}

export interface FirmataPinStateResponse {
  pin: number;
  /** Raw Firmata pin mode value. */
  mode: number;
  /** Aggregated pin state chunks: 1–3 raw 7-bit bytes, LSB first. */
  state: number;
}

export interface FirmataFirmwareReport {
  major: number;
  minor: number;
  name: string;
}

export interface FirmataI2cReplyMessage {
  address: number;
  register: number;
  data: number[];
}

/**
 * Unpack C++ `encodeByteStream` data: two 7-bit wire bytes per 8-bit value.
 *
 * A trailing odd byte carries no complete value and is ignored, which is what
 * `FirmataParser::decodeByteStream` does too.
 */
export function decodePackedBytes(bytes: readonly number[]): number[] {
  const decoded: number[] = [];
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    decoded.push((bytes[index]! & 0x7f) | ((bytes[index + 1]! & 0x7f) << 7));
  }
  return decoded;
}

/** Decode a STRING_DATA payload, dropping the NUL padding real firmware emits. */
export function decodeStringData(bytes: readonly number[]): string {
  const decoded = decodePackedBytes(bytes);
  return new TextDecoder().decode(Uint8Array.from(decoded)).replace(/\0/g, '');
}

/** Parse a CAPABILITY_RESPONSE payload (without the command byte). */
export function parseCapabilityResponse(bytes: readonly number[]): FirmataPinCapabilities[] {
  const pins: FirmataPinCapabilities[] = [];
  let capabilities: FirmataPinCapability[] = [];
  let index = 0;
  while (index < bytes.length) {
    const mode = bytes[index]!;
    if (mode === 0x7f) {
      pins.push({ pin: pins.length, capabilities });
      capabilities = [];
      index += 1;
      continue;
    }
    const resolution = bytes[index + 1];
    if (resolution === undefined || resolution === 0x7f) {
      throw new FirmataProtocolError(
        'CAPABILITY_RESPONSE contains a mode without a resolution byte.',
      );
    }
    capabilities.push({ mode, resolution: resolution & 0x7f });
    index += 2;
  }
  if (pins.length === 0) {
    throw new FirmataProtocolError('CAPABILITY_RESPONSE contained no pins.');
  }
  return pins;
}

/**
 * Parse an ANALOG_MAPPING_RESPONSE payload: one entry per pin, either the
 * analog channel or `null` for pins without analog input.
 */
export function parseAnalogMappingResponse(bytes: readonly number[]): Array<number | null> {
  if (bytes.length === 0) {
    throw new FirmataProtocolError('ANALOG_MAPPING_RESPONSE contained no pins.');
  }
  return bytes.map((byte) => (byte === 0x7f ? null : byte & 0x7f));
}

/** Parse a PIN_STATE_RESPONSE payload (pin, mode, then 1–3 state bytes). */
export function parsePinStateResponse(bytes: readonly number[]): FirmataPinStateResponse {
  const pin = bytes[0];
  const mode = bytes[1];
  if (pin === undefined || mode === undefined) {
    throw new FirmataProtocolError('PIN_STATE_RESPONSE is missing its pin or mode byte.');
  }
  const chunks = bytes.slice(2);
  if (chunks.length > 3) {
    throw new FirmataProtocolError(
      `PIN_STATE_RESPONSE carries ${chunks.length} state bytes; at most 3 are defined.`,
    );
  }
  let state = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    state |= (chunks[index]! & 0x7f) << (7 * index);
  }
  return { pin: pin & 0x7f, mode: mode & 0x7f, state };
}

/**
 * Parse a REPORT_FIRMWARE payload (major, minor, packed name chars).
 *
 * Firmware older than Firmata 3.0.0 answers a bare query with an empty
 * message; that decodes to version 0.0 with an empty name, exactly as the
 * C++ parser reports it.
 */
export function parseFirmwareReport(bytes: readonly number[]): FirmataFirmwareReport {
  if (bytes.length < 2) {
    return { major: 0, minor: 0, name: '' };
  }
  return {
    major: bytes[0]! & 0x7f,
    minor: bytes[1]! & 0x7f,
    name: decodeStringData(bytes.slice(2)),
  };
}

/** Parse an I2C_REPLY payload: address pair, register pair, then data pairs. */
export function parseI2cReply(bytes: readonly number[]): FirmataI2cReplyMessage {
  if (bytes.length < 4) {
    throw new FirmataProtocolError('I2C_REPLY is missing its address or register pair.');
  }
  const dataBytes = bytes.slice(4);
  if (dataBytes.length % 2 !== 0) {
    throw new FirmataProtocolError('I2C_REPLY data must arrive in 7-bit pairs.');
  }
  return {
    address: readPair(bytes, 0, 'I2C_REPLY address'),
    register: readPair(bytes, 2, 'I2C_REPLY register'),
    data: decodePackedBytes(dataBytes),
  };
}

// ---------------------------------------------------------------------------
// Streaming decoder
// ---------------------------------------------------------------------------

export type FirmataMessage =
  | { kind: 'version'; major: number; minor: number }
  | { kind: 'firmware'; major: number; minor: number; name: string }
  | { kind: 'capabilityResponse'; pins: FirmataPinCapabilities[] }
  | { kind: 'analogMappingResponse'; channels: Array<number | null> }
  | { kind: 'pinStateResponse'; pin: number; mode: number; state: number }
  | { kind: 'digital'; port: number; value: number; pins: number[] }
  | { kind: 'analog'; channel: number; value: number }
  | { kind: 'i2cReply'; address: number; register: number; data: number[] }
  | { kind: 'stringData'; text: string }
  | { kind: 'sysex'; command: number; payload: number[] }
  | { kind: 'deviceError'; code: number; message: string }
  | { kind: 'malformed'; reason: string }
  | { kind: 'versionRequest' }
  | { kind: 'systemReset' };

export interface FirmataDecoderOptions {
  /**
   * Which side of the link is being decoded.
   *
   * `device` (default) expects device responses: `0xF9` carries two version
   * bytes and `0xFF` is skipped as a MIDI real-time byte. `host` decodes the
   * same byte stream as sent by a host: `0xF9` is a version request and
   * `0xFF` is a system reset. Only queries and resets differ; sysex and
   * data messages decode identically.
   */
  direction?: 'device' | 'host';
  /** Abandon a sysex frame longer than this many payload bytes (default 4096). */
  maxSysexBytes?: number;
}

/**
 * Incremental Firmata message decoder.
 *
 * Feed it arbitrary chunks; it returns every complete message and tolerates
 * byte-level noise, split frames, and mid-frame junk:
 * - MIDI real-time bytes (0xF8–0xFE, and 0xFF on the device side) are skipped.
 * - A `0xF0` inside a sysex frame restarts the frame, mirroring firmata.js.
 * - Data bytes that arrive with no status byte in effect are ignored.
 * - Oversized or structurally invalid sysex frames produce
 *   `{ kind: 'malformed' }` instead of throwing.
 */
export class FirmataDecoder {
  private readonly direction: 'device' | 'host';
  private readonly maxSysexBytes: number;
  private sysex: number[] | null = null;
  private sysexOverflow = false;
  private pendingStatus: number | null = null;
  private pendingLength = 0;
  private pendingData: number[] = [];

  constructor(options: FirmataDecoderOptions = {}) {
    this.direction = options.direction ?? 'device';
    this.maxSysexBytes = options.maxSysexBytes ?? 4096;
  }

  /** Decode a chunk of bytes into every complete message it contains. */
  push(chunk: Uint8Array): FirmataMessage[] {
    const messages: FirmataMessage[] = [];
    for (const byte of chunk) {
      this.pushByte(byte, messages);
    }
    return messages;
  }

  // -------------------------------------------------------------------------

  private pushByte(byte: number, messages: FirmataMessage[]): void {
    if (this.direction === 'host' && byte === FirmataWire.systemReset) {
      this.pendingStatus = null;
      this.pendingLength = 0;
      this.pendingData = [];
      this.sysex = null;
      this.sysexOverflow = false;
      messages.push({ kind: 'systemReset' });
      return;
    }
    if (byte >= 0xf8) {
      return;
    }
    if (this.sysex !== null) {
      this.pushSysexByte(byte, messages);
      return;
    }
    if (byte === FirmataWire.startSysex) {
      this.sysex = [];
      this.sysexOverflow = false;
      this.pendingStatus = null;
      this.pendingLength = 0;
      this.pendingData = [];
      return;
    }
    if (byte & 0x80) {
      this.beginStatus(byte, messages);
      return;
    }
    this.pushDataByte(byte, messages);
  }

  private pushSysexByte(byte: number, messages: FirmataMessage[]): void {
    if (byte === FirmataWire.startSysex) {
      this.sysex = [];
      this.sysexOverflow = false;
      return;
    }
    if (byte === FirmataWire.endSysex) {
      const payload = this.sysex ?? [];
      this.sysex = null;
      if (this.sysexOverflow) {
        this.sysexOverflow = false;
        messages.push({ kind: 'malformed', reason: 'sysex-overflow' });
        return;
      }
      if (payload.length === 0) {
        messages.push({ kind: 'malformed', reason: 'empty-sysex' });
        return;
      }
      this.decodeSysex(payload, messages);
      return;
    }
    if (byte & 0x80) {
      // A status byte inside a sysex frame means framing broke; abandon the
      // frame and process the status byte normally.
      this.sysex = null;
      this.sysexOverflow = false;
      messages.push({ kind: 'malformed', reason: 'sysex-interrupted' });
      this.beginStatus(byte, messages);
      return;
    }
    const sysex = this.sysex;
    if (this.sysexOverflow || sysex === null) {
      return;
    }
    sysex.push(byte);
    if (sysex.length > this.maxSysexBytes) {
      this.sysex = [];
      this.sysexOverflow = true;
    }
  }

  private beginStatus(byte: number, messages: FirmataMessage[]): void {
    this.pendingStatus = null;
    this.pendingLength = 0;
    this.pendingData = [];
    if (byte === FirmataWire.startSysex) {
      this.sysex = [];
      this.sysexOverflow = false;
      return;
    }
    if (byte === FirmataWire.endSysex) {
      return;
    }
    const high = byte & 0xf0;
    if (high === FirmataWire.digitalPort || high === FirmataWire.analog) {
      this.pendingStatus = byte;
      this.pendingLength = 2;
      return;
    }
    if (byte === FirmataWire.reportVersion) {
      if (this.direction === 'host') {
        messages.push({ kind: 'versionRequest' });
        return;
      }
      this.pendingStatus = byte;
      this.pendingLength = 2;
    }
    // Anything else is not a message this adapter asks for; ignore it.
  }

  private pushDataByte(byte: number, messages: FirmataMessage[]): void {
    if (this.pendingStatus === null) {
      return;
    }
    this.pendingData.push(byte);
    if (this.pendingData.length < this.pendingLength) {
      return;
    }
    const status = this.pendingStatus;
    const data = this.pendingData;
    this.pendingStatus = null;
    this.pendingLength = 0;
    this.pendingData = [];
    if (status === FirmataWire.reportVersion) {
      messages.push({ kind: 'version', major: data[0]! & 0x7f, minor: data[1]! & 0x7f });
      return;
    }
    if ((status & 0xf0) === FirmataWire.digitalPort) {
      const port = status & 0x0f;
      const value = (data[0]! & 0x7f) | ((data[1]! & 0x7f) << 7);
      const pins: number[] = [];
      for (let bit = 0; bit < 8; bit += 1) {
        pins.push((value >> bit) & 1);
      }
      messages.push({ kind: 'digital', port, value, pins });
      return;
    }
    if ((status & 0xf0) === FirmataWire.analog) {
      messages.push({
        kind: 'analog',
        channel: status & 0x0f,
        value: (data[0]! & 0x7f) | ((data[1]! & 0x7f) << 7),
      });
    }
  }

  private decodeSysex(payload: readonly number[], messages: FirmataMessage[]): void {
    const command = payload[0]!;
    const data = payload.slice(1);
    try {
      switch (command) {
        case FirmataSysex.reportFirmware:
          messages.push({ kind: 'firmware', ...parseFirmwareReport(data) });
          return;
        case FirmataSysex.stringData:
          messages.push({ kind: 'stringData', text: decodeStringData(data) });
          return;
        case FirmataSysex.capabilityResponse:
          messages.push({ kind: 'capabilityResponse', pins: parseCapabilityResponse(data) });
          return;
        case FirmataSysex.analogMappingResponse:
          messages.push({
            kind: 'analogMappingResponse',
            channels: parseAnalogMappingResponse(data),
          });
          return;
        case FirmataSysex.pinStateResponse:
          messages.push({ kind: 'pinStateResponse', ...parsePinStateResponse(data) });
          return;
        case FirmataSysex.i2cReply:
          messages.push({ kind: 'i2cReply', ...parseI2cReply(data) });
          return;
        case FirmataSimulatorDiagnosticsSysex:
          messages.push({
            kind: 'deviceError',
            code: data[0] ?? 0,
            message: decodeStringData(data.slice(1)),
          });
          return;
        default:
          messages.push({ kind: 'sysex', command, payload: data });
      }
    } catch (error) {
      messages.push({
        kind: 'malformed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
