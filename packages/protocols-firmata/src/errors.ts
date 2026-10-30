/**
 * Error classes for the Firmata adapter.
 *
 * Every class carries a stable `code` string so callers can branch without
 * parsing messages. Firmata itself has no device-side error channel for
 * command failures: the protocol answers queries and silently ignores what it
 * cannot do, so most of these errors describe host-side validation or link
 * trouble rather than device-reported faults. The one exception,
 * {@link FirmataDeviceError}, exists for the simulator's diagnostics
 * extension and is never thrown by a real device.
 */

/** Base class for every error this adapter produces. */
export class FirmataError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FirmataError';
    this.code = code;
  }
}

/** A locally rejected argument (pin number, mode, value, or payload field). */
export class FirmataValidationError extends FirmataError {
  constructor(message: string) {
    super('FIRMATA_VALIDATION', message);
    this.name = 'FirmataValidationError';
  }
}

/** The requested operation is legal Firmata but not supported by this link. */
export class FirmataUnsupportedError extends FirmataError {
  constructor(message: string) {
    super('FIRMATA_UNSUPPORTED', message);
    this.name = 'FirmataUnsupportedError';
  }
}

/** The device sent bytes that cannot be a valid Firmata message. */
export class FirmataProtocolError extends FirmataError {
  constructor(message: string) {
    super('FIRMATA_PROTOCOL', message);
    this.name = 'FirmataProtocolError';
  }
}

/** No matching response arrived in time. The link is closed to stay truthful. */
export class FirmataTimeoutError extends FirmataError {
  constructor(message: string) {
    super('FIRMATA_TIMEOUT', message);
    this.name = 'FirmataTimeoutError';
  }
}

/** The client or its transport is closed. */
export class FirmataClosedError extends FirmataError {
  constructor(message = 'The Firmata link is closed.') {
    super('FIRMATA_CLOSED', message);
    this.name = 'FirmataClosedError';
  }
}

/** Too many requests are outstanding; the queue is bounded on purpose. */
export class FirmataQueueFullError extends FirmataError {
  constructor(message: string) {
    super('FIRMATA_QUEUE_FULL', message);
    this.name = 'FirmataQueueFullError';
  }
}

/**
 * A simulator-only diagnostics notice (`F0 00 <code> <message> F7`).
 *
 * Stock StandardFirmata never sends sysex command 0x00; on real hardware that
 * byte belongs to the MIDI extended-ID namespace. Only the bundled simulator
 * uses it, and only when explicitly enabled.
 */
export class FirmataDeviceError extends FirmataError {
  readonly deviceCode: number;
  readonly deviceMessage: string;

  constructor(deviceCode: number, deviceMessage: string) {
    super('FIRMATA_DEVICE_ERROR', `Firmata simulator diagnostic ${deviceCode}: ${deviceMessage}`);
    this.name = 'FirmataDeviceError';
    this.deviceCode = deviceCode;
    this.deviceMessage = deviceMessage;
  }
}
