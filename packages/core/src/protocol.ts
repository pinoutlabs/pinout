import { ProtocolError } from './errors.js';
import type { DeviceInfo } from './types.js';

export const protocolVersion = 1;
// Maximum protocol frame size in bytes (1024).
// Accommodates comprehensive capability advertisements, features, and batch commands
// while easily fitting within ESP32 SRAM (520 KB) with minimal buffer pressure.
export const maxProtocolLineBytes = 1024;

export interface ProtocolRequest {
  v: number;
  id: string;
  action: string;
  payload: Record<string, unknown>;
}

export interface ProtocolSuccess {
  v: number;
  id: string;
  ok: true;
  result: Record<string, unknown>;
}

export interface ProtocolFailure {
  v: number;
  id: string;
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type ProtocolResponse = ProtocolSuccess | ProtocolFailure;

export interface ProtocolEvent {
  v: number;
  event: string;
  payload: Record<string, unknown>;
}

export type ProtocolMessage = ProtocolRequest | ProtocolResponse | ProtocolEvent;

export function encodeRequest(
  id: string,
  action: string,
  payload: Record<string, unknown> = {},
): string {
  const request: ProtocolRequest = {
    v: protocolVersion,
    id,
    action,
    payload,
  };
  return `${JSON.stringify(request)}\n`;
}

export function encodeResponse(id: string, result: Record<string, unknown> = {}): string {
  const response: ProtocolSuccess = {
    v: protocolVersion,
    id,
    ok: true,
    result,
  };
  return `${JSON.stringify(response)}\n`;
}

export function encodeFailure(id: string, code: string, message: string): string {
  const response: ProtocolFailure = {
    v: protocolVersion,
    id,
    ok: false,
    error: { code, message },
  };
  return `${JSON.stringify(response)}\n`;
}

export function encodeEvent(event: string, payload: Record<string, unknown> = {}): string {
  const message: ProtocolEvent = {
    v: protocolVersion,
    event,
    payload,
  };
  return `${JSON.stringify(message)}\n`;
}

export function parseLine(line: string): ProtocolMessage | null {
  const decoded = decodeLine(line);
  switch (decoded.kind) {
    case 'ignore':
      return null;
    case 'invalidJson':
    case 'invalidMessage':
      throw new ProtocolError(decoded.message);
    case 'message':
      return decoded.value;
  }
}

export type DecodeLineResult =
  | { kind: 'ignore' }
  | { kind: 'invalidJson'; message: string }
  | { kind: 'invalidMessage'; message: string }
  | { kind: 'message'; value: ProtocolMessage };

export function decodeLine(line: string): DecodeLineResult {
  const trimmed = line.replace(/\r$/, '').trim();
  if (!trimmed.startsWith('{')) {
    return { kind: 'ignore' };
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { kind: 'invalidJson', message: `Device sent invalid JSON: ${trimmed}` };
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'invalidMessage', message: 'Device sent a JSON value that is not an object.' };
  }

  const record = value as Record<string, unknown>;
  if (record.v !== protocolVersion) {
    return {
      kind: 'invalidMessage',
      message: `Unsupported protocol version '${String(record.v)}'. This SDK speaks v${protocolVersion}.`,
    };
  }

  if (typeof record.event === 'string') {
    return {
      kind: 'message',
      value: {
        v: protocolVersion,
        event: record.event,
        payload: isPlainObject(record.payload) ? record.payload : {},
      },
    };
  }

  if (typeof record.id !== 'string' || record.id.length === 0) {
    return { kind: 'invalidMessage', message: 'Protocol message is missing a string id.' };
  }

  if (typeof record.action === 'string') {
    return {
      kind: 'message',
      value: {
        v: protocolVersion,
        id: record.id,
        action: record.action,
        payload: isPlainObject(record.payload) ? record.payload : {},
      },
    };
  }

  if (record.ok === true) {
    return {
      kind: 'message',
      value: {
        v: protocolVersion,
        id: record.id,
        ok: true,
        result: isPlainObject(record.result) ? record.result : {},
      },
    };
  }

  if (record.ok === false) {
    const error = record.error;
    if (
      !isPlainObject(error) ||
      typeof error.code !== 'string' ||
      typeof error.message !== 'string'
    ) {
      return {
        kind: 'invalidMessage',
        message: 'Error response is missing error.code and error.message.',
      };
    }
    return {
      kind: 'message',
      value: {
        v: protocolVersion,
        id: record.id,
        ok: false,
        error: { code: error.code, message: error.message },
      },
    };
  }

  return { kind: 'invalidMessage', message: `Unrecognized protocol message: ${trimmed}` };
}

export function parseDeviceInfo(payload: Record<string, unknown>): DeviceInfo {
  const firmware = payload.firmware;
  const version = payload.version;
  const protocol = payload.protocol;
  const capabilities = payload.capabilities;
  const features =
    Array.isArray(payload.features) && payload.features.every((item) => typeof item === 'string')
      ? (payload.features as string[])
      : [];

  if (typeof firmware !== 'string' || firmware.length === 0) {
    throw new ProtocolError('Device identity is missing firmware.');
  }
  if (typeof version !== 'string') {
    throw new ProtocolError('Device identity is missing version.');
  }
  if (protocol !== protocolVersion) {
    throw new ProtocolError(
      `Device protocol '${String(protocol)}' is not supported. Expected ${protocolVersion}.`,
    );
  }
  if (!Array.isArray(capabilities) || !capabilities.every((item) => typeof item === 'string')) {
    throw new ProtocolError('Device identity is missing a capabilities string array.');
  }

  return {
    firmware,
    version,
    protocol,
    capabilities,
    features,
    ...(typeof payload.boardId === 'string' ? { boardId: payload.boardId } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
