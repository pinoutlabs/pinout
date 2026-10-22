export class OahlError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = 'OahlError';
    this.code = code;
    this.statusCode = statusCode;
    if (details !== undefined) {
      this.details = details;
    }
  }

  toJSON(): Record<string, unknown> {
    const json: Record<string, unknown> = {
      error: {
        code: this.code,
        message: this.message,
      },
    };
    if (this.details !== undefined) {
      (json.error as Record<string, unknown>).details = this.details;
    }
    return json;
  }
}

export class OahlDeviceNotFoundError extends OahlError {
  constructor(deviceId: string) {
    super('DEVICE_NOT_FOUND', `Device '${deviceId}' not found in runtime.`, 404, { deviceId });
    this.name = 'OahlDeviceNotFoundError';
  }
}

export class OahlReservationConflictError extends OahlError {
  constructor(deviceId: string, currentOwner?: string) {
    super(
      'RESERVATION_CONFLICT',
      `Device '${deviceId}' is currently reserved${currentOwner ? ` by owner '${currentOwner}'` : ''}.`,
      409,
      { deviceId, currentOwner },
    );
    this.name = 'OahlReservationConflictError';
  }
}

export class OahlReservationExpiredError extends OahlError {
  constructor(reservationId: string) {
    super(
      'RESERVATION_EXPIRED',
      `Reservation '${reservationId}' is not found or has expired.`,
      410,
      { reservationId },
    );
    this.name = 'OahlReservationExpiredError';
  }
}

export class OahlUnauthorizedError extends OahlError {
  constructor(message: string, details?: unknown) {
    super('UNAUTHORIZED', message, 403, details);
    this.name = 'OahlUnauthorizedError';
  }
}

export class OahlValidationError extends OahlError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', message, 400, details);
    this.name = 'OahlValidationError';
  }
}

export class OahlExecutionError extends OahlError {
  constructor(message: string, details?: unknown, statusCode = 422) {
    super('EXECUTION_FAILED', message, statusCode, details);
    this.name = 'OahlExecutionError';
  }
}
