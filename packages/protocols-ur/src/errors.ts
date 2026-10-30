/**
 * Universal Robots adapter error types (spec v1).
 *
 * Protocol-level failures are reported with stable codes so callers never have
 * to parse English prose. Backends translate connection loss into
 * `DeviceError('DISCONNECTED')` at the Pinout boundary.
 */

export class UrError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'UrError';
    this.code = code;
  }
}

/** Dashboard-server (port 29999) failures. */
export class UrDashboardError extends UrError {
  /** Raw dashboard reply, when one was received. */
  readonly response: string | undefined;

  constructor(code: string, message: string, response?: string) {
    super(code, message);
    this.name = 'UrDashboardError';
    this.response = response;
  }
}

/** RTDE (port 30004) codec and session failures. */
export class UrRtdeError extends UrError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'UrRtdeError';
  }
}

/** URScript builder / client failures. */
export class UrScriptError extends UrError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'UrScriptError';
  }
}
