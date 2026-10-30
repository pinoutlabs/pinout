/**
 * RTDE (Real-Time Data Exchange, port 30004) codec, protocol version 2.
 *
 * Wire format: every frame is a 3-byte header (`uint16` big-endian total frame
 * size INCLUDING the header, then a 1-byte command) followed by the command
 * payload. This module implements the read-only subset used by the adapter:
 *
 * - `V` request / `v` reply: protocol version negotiation.
 * - `O` request / reply: output recipe setup (`[recipe_id u8][type names]`).
 * - `S` / `P` request / reply: start and pause the data stream.
 * - `U` data packages: `[recipe_id u8][values, big-endian]` (protocol ≥ 2).
 *
 * NOT implemented (by design): input recipes (`I`), custom URScript over RTDE,
 * and any write path. This adapter never writes robot state over RTDE.
 *
 * Numeric encoding facts: all multi-byte values are BIG-endian; `DOUBLE` is
 * IEEE-754 binary64; vector types are packed without padding.
 */
import { UrRtdeError } from './errors.js';

/** RTDE command bytes (ASCII letters as seen on the wire). */
export const RtdeCommand = {
  /** 'V' — request protocol version. */
  PROTOCOL_VERSION: 0x56,
  /** 'v' — protocol version reply. */
  PROTOCOL_VERSION_REPLY: 0x76,
  /** 'O' — setup output recipe. */
  SETUP_OUTPUTS: 0x4f,
  /** 'I' — setup input recipe. Not used: this adapter is read-only. */
  SETUP_INPUTS: 0x49,
  /** 'S' — start data streaming. */
  START: 0x53,
  /** 'P' — pause data streaming. */
  PAUSE: 0x50,
  /** 'U' — data package (server → client). */
  DATA_PACKAGE: 0x55,
} as const;

export const RTDE_HEADER_SIZE = 3;

/**
 * Protocol version requested by this adapter. Version 2 is required for the
 * `[recipe_id u8]` prefix on data packages. A newer version (3) exists for
 * later Polyscope/controller releases; this adapter deliberately caps its
 * request at 2 rather than starting at a higher version and decrementing.
 */
export const RTDE_REQUESTED_PROTOCOL_VERSION = 2;

/** Outputs subscribed by default: base pose telemetry + controller modes. */
export const RTDE_DEFAULT_OUTPUTS = [
  'timestamp',
  'actual_q',
  'actual_TCP_pose',
  'robot_mode',
  'safety_mode',
] as const;

export type RtdeValueType =
  | 'BOOL'
  | 'UINT8'
  | 'INT32'
  | 'UINT32'
  | 'UINT64'
  | 'DOUBLE'
  | 'VECTOR3D'
  | 'VECTOR6D'
  | 'VECTOR6INT32'
  | 'VECTOR6UINT32';

/** Payload size in bytes for each RTDE value type. */
export const RTDE_VALUE_SIZES: Record<RtdeValueType, number> = {
  BOOL: 1,
  UINT8: 1,
  INT32: 4,
  UINT32: 4,
  UINT64: 8,
  DOUBLE: 8,
  VECTOR3D: 24,
  VECTOR6D: 48,
  VECTOR6INT32: 24,
  VECTOR6UINT32: 24,
};

/**
 * Decoded RTDE value. `UINT64` values above `Number.MAX_SAFE_INTEGER` lose
 * precision — the adapter's default outputs do not use them.
 */
export type RtdeValue = number | boolean | number[];

export function isRtdeValueType(value: string): value is RtdeValueType {
  return Object.hasOwn(RTDE_VALUE_SIZES, value);
}

export interface RtdeFrame {
  command: number;
  payload: Uint8Array;
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

export function encodeRtdeFrame(
  command: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const size = RTDE_HEADER_SIZE + payload.length;
  if (size > 0xffff) {
    throw new UrRtdeError(
      'UR_RTDE_PROTOCOL_ERROR',
      `RTDE frame of ${size} bytes exceeds the uint16 header size.`,
    );
  }
  const frame = new Uint8Array(size);
  frame[0] = (size >> 8) & 0xff;
  frame[1] = size & 0xff;
  frame[2] = command & 0xff;
  frame.set(payload, RTDE_HEADER_SIZE);
  return frame;
}

export function decodeRtdeFrame(frame: Uint8Array): RtdeFrame {
  if (frame.length < RTDE_HEADER_SIZE) {
    throw new UrRtdeError('UR_RTDE_PROTOCOL_ERROR', 'RTDE frame shorter than its 3-byte header.');
  }
  const size = (frame[0]! << 8) | frame[1]!;
  if (size < RTDE_HEADER_SIZE) {
    throw new UrRtdeError('UR_RTDE_PROTOCOL_ERROR', `RTDE frame declares invalid size ${size}.`);
  }
  if (frame.length < size) {
    throw new UrRtdeError(
      'UR_RTDE_PROTOCOL_ERROR',
      `RTDE frame declares ${size} bytes but only ${frame.length} are available.`,
    );
  }
  return { command: frame[2]!, payload: frame.subarray(RTDE_HEADER_SIZE, size) };
}

/** Extract one complete RTDE frame from the head of `buffer`; `undefined` when more bytes are needed. */
export function tryDecodeRtdeFrame(
  buffer: Uint8Array,
): { frame: RtdeFrame; consumed: number } | undefined {
  if (buffer.length < RTDE_HEADER_SIZE) return undefined;
  const size = (buffer[0]! << 8) | buffer[1]!;
  if (size < RTDE_HEADER_SIZE) {
    throw new UrRtdeError('UR_RTDE_PROTOCOL_ERROR', `RTDE frame declares invalid size ${size}.`);
  }
  if (buffer.length < size) return undefined;
  return { frame: decodeRtdeFrame(buffer.subarray(0, size)), consumed: size };
}

// ---------------------------------------------------------------------------
// Protocol version (V / v)
// ---------------------------------------------------------------------------

export function encodeProtocolVersionRequest(
  version: number = RTDE_REQUESTED_PROTOCOL_VERSION,
): Uint8Array {
  const payload = new Uint8Array(2);
  payload[0] = (version >> 8) & 0xff;
  payload[1] = version & 0xff;
  return encodeRtdeFrame(RtdeCommand.PROTOCOL_VERSION, payload);
}

export interface RtdeProtocolVersionInfo {
  /** Negotiated protocol version (the lower of the requested and supported versions). */
  protocolVersion: number;
  /**
   * The three trailing uint32 values of the `v` reply, exposed as the RTDE
   * library version trio. Their exact semantics (library vs. controller
   * version) are not verified here; consumers must not depend on them beyond
   * diagnostics.
   */
  libraryVersionMajor: number;
  libraryVersionMinor: number;
  libraryVersionPatch: number;
}

export function decodeProtocolVersionReply(payload: Uint8Array): RtdeProtocolVersionInfo {
  if (payload.length < 16) {
    throw new UrRtdeError(
      'UR_RTDE_PROTOCOL_ERROR',
      `Protocol version reply must be 16 bytes (4 uint32); received ${payload.length}.`,
    );
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    protocolVersion: view.getUint32(0),
    libraryVersionMajor: view.getUint32(4),
    libraryVersionMinor: view.getUint32(8),
    libraryVersionPatch: view.getUint32(12),
  };
}

// ---------------------------------------------------------------------------
// Output recipe (O)
// ---------------------------------------------------------------------------

export function encodeSetupOutputsRequest(
  frequencyHz: number,
  outputNames: readonly string[],
): Uint8Array {
  if (typeof frequencyHz !== 'number' || !Number.isFinite(frequencyHz) || frequencyHz <= 0) {
    throw new UrRtdeError(
      'UR_RTDE_INVALID_FREQUENCY',
      `RTDE output frequency must be a positive number of Hz; received ${String(frequencyHz)}.`,
    );
  }
  if (outputNames.length === 0) {
    throw new UrRtdeError('UR_RTDE_INVALID_OUTPUTS', 'At least one RTDE output name is required.');
  }
  for (const name of outputNames) {
    if (name.length === 0 || name.includes(',') || name.includes('\n')) {
      throw new UrRtdeError(
        'UR_RTDE_INVALID_OUTPUTS',
        `Invalid RTDE output name '${name}': names are comma-joined and may not be empty.`,
      );
    }
  }
  const nameBytes = new TextEncoder().encode(outputNames.join(','));
  const payload = new Uint8Array(8 + nameBytes.length);
  new DataView(payload.buffer).setFloat64(0, frequencyHz, false);
  payload.set(nameBytes, 8);
  return encodeRtdeFrame(RtdeCommand.SETUP_OUTPUTS, payload);
}

export type RtdeSetupOutputType = RtdeValueType | 'NOT_FOUND';

export interface RtdeSetupOutputsReply {
  /** Recipe identifier assigned by the controller; echoed on every data package. */
  recipeId: number;
  /** One entry per requested output, in request order; `'NOT_FOUND'` for unknown names. */
  types: RtdeSetupOutputType[];
}

export function decodeSetupOutputsReply(payload: Uint8Array): RtdeSetupOutputsReply {
  if (payload.length < 1) {
    throw new UrRtdeError('UR_RTDE_PROTOCOL_ERROR', 'Setup-outputs reply is empty.');
  }
  const recipeId = payload[0]!;
  const text = new TextDecoder().decode(payload.subarray(1));
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const types = parts.map((part): RtdeSetupOutputType => {
    if (part === 'NOT_FOUND') return 'NOT_FOUND';
    if (isRtdeValueType(part)) return part;
    throw new UrRtdeError(
      'UR_RTDE_PROTOCOL_ERROR',
      `Setup-outputs reply contains unknown type name '${part}'.`,
    );
  });
  return { recipeId, types };
}

// ---------------------------------------------------------------------------
// Start / pause (S / P)
// ---------------------------------------------------------------------------

export function encodeStartRequest(): Uint8Array {
  return encodeRtdeFrame(RtdeCommand.START);
}

export function encodePauseRequest(): Uint8Array {
  return encodeRtdeFrame(RtdeCommand.PAUSE);
}

/** `S`/`P` replies carry a single boolean byte. */
export function decodeBooleanReply(payload: Uint8Array): boolean {
  if (payload.length < 1) {
    throw new UrRtdeError('UR_RTDE_PROTOCOL_ERROR', 'Boolean reply is empty.');
  }
  return payload[0] !== 0;
}

// ---------------------------------------------------------------------------
// Data packages (U)
// ---------------------------------------------------------------------------

export interface RtdeDataPackage {
  recipeId: number;
  /** Values in recipe order, matching the types from the setup reply. */
  values: RtdeValue[];
}

/**
 * Decode a protocol-2 data package payload: `[recipe_id u8][values be]`.
 * The caller supplies the type list from the setup-outputs reply.
 */
export function decodeDataPackage(
  payload: Uint8Array,
  types: readonly RtdeValueType[],
): RtdeDataPackage {
  if (payload.length < 1) {
    throw new UrRtdeError('UR_RTDE_PROTOCOL_ERROR', 'Data package is empty.');
  }
  const recipeId = payload[0]!;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const values: RtdeValue[] = [];
  let offset = 1;
  for (const type of types) {
    const size = RTDE_VALUE_SIZES[type];
    if (offset + size > payload.length) {
      throw new UrRtdeError(
        'UR_RTDE_PROTOCOL_ERROR',
        `Data package truncated while reading ${type} (${payload.length - offset} bytes left, ${size} needed).`,
      );
    }
    switch (type) {
      case 'BOOL':
        values.push(payload[offset] !== 0);
        offset += 1;
        break;
      case 'UINT8':
        values.push(payload[offset]!);
        offset += 1;
        break;
      case 'INT32':
        values.push(view.getInt32(offset));
        offset += 4;
        break;
      case 'UINT32':
        values.push(view.getUint32(offset));
        offset += 4;
        break;
      case 'UINT64': {
        const high = view.getUint32(offset);
        const low = view.getUint32(offset + 4);
        values.push(high * 0x1_0000_0000 + low);
        offset += 8;
        break;
      }
      case 'DOUBLE':
        values.push(view.getFloat64(offset));
        offset += 8;
        break;
      case 'VECTOR3D':
      case 'VECTOR6D': {
        const count = type === 'VECTOR3D' ? 3 : 6;
        const vector: number[] = [];
        for (let index = 0; index < count; index += 1) {
          vector.push(view.getFloat64(offset + index * 8));
        }
        values.push(vector);
        offset += count * 8;
        break;
      }
      case 'VECTOR6INT32':
      case 'VECTOR6UINT32': {
        const vector: number[] = [];
        for (let index = 0; index < 6; index += 1) {
          vector.push(
            type === 'VECTOR6INT32'
              ? view.getInt32(offset + index * 4)
              : view.getUint32(offset + index * 4),
          );
        }
        values.push(vector);
        offset += 24;
        break;
      }
    }
  }
  return { recipeId, values };
}
