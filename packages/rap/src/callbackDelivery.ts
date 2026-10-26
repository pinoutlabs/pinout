import type { RapCallbackMessage } from './types.js';

export interface CallbackDeliveryOptions {
  fetch?: typeof globalThis.fetch;
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeliveryResult {
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

/**
 * POST RAP callbacks with exponential backoff. Does not retry HTTP 4xx.
 * Returns exhausted=true when maxAttempts is reached without success.
 */
export class CallbackDelivery {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: CallbackDeliveryOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 50;
    this.sleepFn =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get attemptLimit(): number {
    return this.maxAttempts;
  }

  async deliver(callbackUrl: string, message: RapCallbackMessage): Promise<DeliveryResult> {
    let lastStatus: number | undefined;
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchFn(callbackUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(message),
        });
        lastStatus = response.status;
        if (response.status >= 200 && response.status < 300) {
          return { ok: true, attempts: attempt, status: response.status };
        }
        if (response.status >= 400 && response.status < 500) {
          return {
            ok: false,
            attempts: attempt,
            status: response.status,
            error: `callback rejected with HTTP ${response.status}`,
          };
        }
        lastError = `callback HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < this.maxAttempts) {
        await this.sleepFn(this.baseDelayMs * 2 ** (attempt - 1));
      }
    }
    return {
      ok: false,
      attempts: this.maxAttempts,
      ...(lastStatus !== undefined ? { status: lastStatus } : {}),
      ...(lastError !== undefined ? { error: lastError } : {}),
    };
  }
}

export function toolResultMessage(input: {
  groupId: string;
  id: string;
  callId?: string | null;
  text: string;
}): RapCallbackMessage {
  return {
    type: 'tool_result',
    group_id: input.groupId,
    id: input.id,
    ...(input.callId !== undefined && input.callId !== null ? { call_id: input.callId } : {}),
    text: input.text,
  };
}

export function progressViewUpdate(input: {
  groupId: string;
  operationId: string;
  fraction: number;
  message?: string;
}): RapCallbackMessage {
  return {
    type: 'view_update',
    group_id: input.groupId,
    view: 'pinout.operation_progress',
    content: {
      operationId: input.operationId,
      fraction: input.fraction,
      ...(input.message !== undefined ? { message: input.message } : {}),
    },
  };
}
