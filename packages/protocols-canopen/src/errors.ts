/**
 * Structured errors for the CANopen adapter.
 *
 * Codes are stable and machine-checkable; messages never carry the only copy
 * of the diagnostic information (details do). {@link CanopenError} extends
 * core `DeviceError`, so the runtime, journal, and conformance tooling treat
 * these errors exactly like every other device backend in Pinout.
 *
 * Two families of codes exist here:
 *
 * - **Transport / environment**: `PLATFORM_UNSUPPORTED` (not Linux),
 *   `CAN_TOOL_MISSING` (candump/cansend not executable), `BUS_NOT_OPEN`
 *   (SocketCAN interface unavailable, candump died, or a `cansend` failed),
 *   `COMMAND_TIMEOUT` (a one-shot CLI tool exceeded its timeout).
 * - **Protocol**: `FRAME_TIMEOUT` (no matching frame arrived at the bus level),
 *   `SDO_TIMEOUT` (no SDO response after all bounded attempts), `SDO_ABORTED`
 *   (the node answered with an abort code), `NODE_NOT_RESPONDING` (a scan or
 *   status conclusion that a node is absent), `NMT_REJECTED` (this adapter
 *   refused an NMT transition), `WRITE_NOT_ALLOWED` (object write outside the
 *   configured allowlist), `UNSUPPORTED_CONFIGURATION` (a transfer type or
 *   configuration this adapter deliberately does not implement), plus the
 *   repo-wide `VALIDATION_ERROR` for malformed payloads and frames.
 *
 * Tool stderr is captured verbatim in `details.stderr`; it is never parsed for
 * control flow. Nothing here is safety-certified: a CANopen bus is a control
 * network, and writes on it can energize drives and machinery.
 */
import { DeviceError } from '@pinout/core';

export type CanopenErrorCode =
  | 'VALIDATION_ERROR'
  | 'PLATFORM_UNSUPPORTED'
  | 'CAN_TOOL_MISSING'
  | 'BUS_NOT_OPEN'
  | 'FRAME_TIMEOUT'
  | 'SDO_ABORTED'
  | 'SDO_TIMEOUT'
  | 'NODE_NOT_RESPONDING'
  | 'NMT_REJECTED'
  | 'UNSUPPORTED_CONFIGURATION'
  | 'COMMAND_TIMEOUT'
  | 'WRITE_NOT_ALLOWED';

export class CanopenError extends DeviceError {
  constructor(code: CanopenErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
  }
}

export function validationError(message: string, details?: Record<string, unknown>): CanopenError {
  return new CanopenError('VALIDATION_ERROR', message, details);
}

export function platformUnsupportedError(operation: string, platform: string): CanopenError {
  return new CanopenError(
    'PLATFORM_UNSUPPORTED',
    `${operation} requires Linux SocketCAN; host platform is '${platform}'. SocketCAN has no macOS or Windows equivalent — use an external CAN adapter that exposes a serial/TCP transport instead.`,
    { platform, operation },
  );
}

export function toolMissingError(
  tool: string,
  operation: string,
  spawnError?: { code: string; message: string },
): CanopenError {
  return new CanopenError(
    'CAN_TOOL_MISSING',
    `'${tool}' could not be executed${spawnError ? ` (${spawnError.code})` : ''}. Install can-utils and ensure '${tool}' is on PATH.`,
    {
      tool,
      operation,
      ...(spawnError
        ? { spawnErrorCode: spawnError.code, spawnErrorMessage: spawnError.message }
        : {}),
      installHint: 'Debian/Ubuntu: apt install can-utils.',
    },
  );
}

export function busNotOpenError(
  operation: string,
  details: Record<string, unknown> = {},
): CanopenError {
  return new CanopenError('BUS_NOT_OPEN', `CAN bus is not open for '${operation}'.`, {
    operation,
    ...details,
  });
}

export function commandTimeoutError(
  tool: string,
  args: readonly string[],
  timeoutMs: number,
): CanopenError {
  return new CanopenError(
    'COMMAND_TIMEOUT',
    `'${tool}' did not finish within ${timeoutMs}ms and was terminated (SIGTERM, then SIGKILL).`,
    { tool, args: [...args], timeoutMs },
  );
}

export function frameTimeoutError(
  operation: string,
  timeoutMs: number,
  details: Record<string, unknown> = {},
): CanopenError {
  return new CanopenError(
    'FRAME_TIMEOUT',
    `No matching CAN frame arrived within ${timeoutMs}ms while waiting for '${operation}'.`,
    { operation, timeoutMs, ...details },
  );
}

export interface SdoAbortDetails {
  operation: 'upload' | 'download';
  node: number;
  index: number;
  subindex: number;
  abortCode: number;
  abortName: string;
  attempts: number;
}

export function sdoAbortedError(details: SdoAbortDetails): CanopenError {
  return new CanopenError(
    'SDO_ABORTED',
    `SDO ${details.operation} of 0x${details.index.toString(16).toUpperCase()}:${details.subindex} on node ${details.node} was aborted by the node with 0x${details.abortCode.toString(16).toUpperCase().padStart(8, '0')} (${details.abortName}).`,
    { ...details },
  );
}

export interface SdoTimeoutDetails {
  operation: 'upload' | 'download';
  node: number;
  index: number;
  subindex: number;
  attempts: number;
  timeoutMs: number;
  ignoredSdoFrames?: number;
}

export function sdoTimeoutError(details: SdoTimeoutDetails): CanopenError {
  const ignored =
    details.ignoredSdoFrames !== undefined
      ? ` ${details.ignoredSdoFrames} SDO response frame(s) for this node could not be matched and were ignored.`
      : '';
  return new CanopenError(
    'SDO_TIMEOUT',
    `SDO ${details.operation} of 0x${details.index.toString(16).toUpperCase()}:${details.subindex} on node ${details.node} timed out after ${details.attempts} attempt(s) of ${details.timeoutMs}ms.${ignored} The node may be absent, stopped, or not answering SDO.`,
    { ...details },
  );
}

export function nodeNotRespondingError(
  node: number,
  details: Record<string, unknown> = {},
): CanopenError {
  return new CanopenError(
    'NODE_NOT_RESPONDING',
    `CANopen node ${node} did not respond (no SDO answer and no heartbeat observed).`,
    { node, ...details },
  );
}

export function nmtRejectedError(
  command: string,
  reason: string,
  details: Record<string, unknown> = {},
): CanopenError {
  return new CanopenError('NMT_REJECTED', `NMT command '${command}' was rejected: ${reason}`, {
    command,
    reason,
    ...details,
  });
}

export interface WriteNotAllowedDetails {
  node: number;
  index: number;
  subindex: number;
  allowedWrites: unknown[];
}

export function writeNotAllowedError(details: WriteNotAllowedDetails): CanopenError {
  const count = details.allowedWrites.length;
  return new CanopenError(
    'WRITE_NOT_ALLOWED',
    `Object write 0x${details.index.toString(16).toUpperCase()}:${details.subindex} on node ${details.node} is not in the configured write allowlist (${count} entr${count === 1 ? 'y' : 'ies'}). CANopen writes can start motion; the allowlist is empty by default.`,
    { ...details },
  );
}

export function unsupportedConfigurationError(
  message: string,
  details: Record<string, unknown> = {},
): CanopenError {
  return new CanopenError('UNSUPPORTED_CONFIGURATION', message, { ...details });
}
