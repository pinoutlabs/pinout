import { randomUUID } from 'node:crypto';
import {
  AbortedError,
  DeviceError,
  DisconnectedError,
  TimeoutError,
  TransportError,
} from './errors.js';
import { createLogger, type Logger } from './logger.js';
import { readLines } from './lineReader.js';
import { encodeRequest, maxProtocolLineBytes, parseDeviceInfo, parseLine } from './protocol.js';
import type { ProtocolEvent, ProtocolResponse } from './protocol.js';
import type { DeviceInfo, RequestOptions, Transport } from './types.js';

const textEncoder = new TextEncoder();

interface PendingRequest {
  resolve: (response: ProtocolResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
  signal?: AbortSignal;
}

export type SessionEventListener = (event: ProtocolEvent) => void;

export class Session {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly readyWaiters: Array<(info: DeviceInfo) => void> = [];
  private readonly eventListeners = new Set<SessionEventListener>();
  private readonly logger: Logger;
  private readonly sessionId = randomUUID();
  private nextRequestId = 0;
  private readerTask: Promise<void> | undefined;
  private open = false;
  private closed = false;
  private deviceInfo: DeviceInfo | undefined;

  constructor(
    readonly transport: Transport,
    private readonly timeoutMs: number,
    private readonly connectSignal?: AbortSignal,
    logger?: Logger,
  ) {
    this.logger = (logger ?? createLogger('info')).child({
      sessionId: this.sessionId,
      transport: transport.kind,
    });
  }

  async connect(): Promise<DeviceInfo> {
    if (this.open) {
      throw new TransportError('Session is already connected.');
    }

    await this.transport.open();
    this.open = true;
    this.readerTask = this.readLoop();

    try {
      // Opening a UART commonly resets an ESP32 and produces `ready`, but native
      // USB Serial/JTAG devices can already be running when their port opens.
      // Listen briefly for the boot event, then actively probe with sys.hello.
      try {
        await this.waitForReady(Math.min(this.timeoutMs, 300));
      } catch (error) {
        if (!(error instanceof TimeoutError)) {
          throw error;
        }
      }
      this.deviceInfo = parseDeviceInfo(await this.requestHello());
      this.logger.info('connected', { firmware: this.deviceInfo.firmware });
      return this.deviceInfo;
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  addEventListener(listener: SessionEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async request(
    action: string,
    payload: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    if (!this.open || this.closed) {
      throw new DisconnectedError();
    }

    const signal = options.signal ?? this.connectSignal;
    if (signal?.aborted) {
      throw new AbortedError(`Request '${action}' was aborted before it was sent.`);
    }

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const id = `${this.sessionId}:${this.nextRequestId++}`;
    if (this.logger.isEnabled('debug')) {
      this.logger.debug('request', { requestId: id, action });
    }
    const response = await new Promise<ProtocolResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finishPending(id);
        reject(new TimeoutError(`Timed out waiting for '${action}' (${timeoutMs}ms).`));
      }, timeoutMs);

      const abortHandler = (): void => {
        this.finishPending(id);
        reject(new AbortedError(`Request '${action}' was aborted.`));
      };

      const pending: PendingRequest = { resolve, reject, timer, abortHandler };
      if (signal) {
        pending.signal = signal;
        signal.addEventListener('abort', abortHandler, { once: true });
      }
      this.pending.set(id, pending);

      this.transport
        .write(textEncoder.encode(encodeRequest(id, action, payload)))
        .catch((error: unknown) => {
          this.finishPending(id);
          reject(
            new TransportError(
              error instanceof Error ? error.message : 'Failed to write to transport.',
              { cause: error },
            ),
          );
        });
    });

    if (!response.ok) {
      throw new DeviceError(response.error.code, response.error.message);
    }
    return response.result;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.open = false;

    for (const [id, pending] of this.pending) {
      this.finishPending(id);
      pending.reject(new DisconnectedError('Connection closed before the device responded.'));
    }

    await this.transport.close();
    await this.readerTask?.catch(() => undefined);
  }

  private waitForReady(timeoutMs = this.timeoutMs): Promise<DeviceInfo> {
    if (this.deviceInfo) {
      return Promise.resolve(this.deviceInfo);
    }

    return new Promise<DeviceInfo>((resolve, reject) => {
      const waiter = (info: DeviceInfo): void => {
        clearTimeout(timer);
        this.connectSignal?.removeEventListener('abort', abortHandler);
        resolve(info);
      };
      const timer = setTimeout(() => {
        const index = this.waitersIndex(waiter);
        if (index >= 0) {
          this.readyWaiters.splice(index, 1);
        }
        this.connectSignal?.removeEventListener('abort', abortHandler);
        reject(
          new TimeoutError(
            `Timed out waiting for the device ready event (${timeoutMs}ms). Is firmware running, and is the serial port correct?`,
          ),
        );
      }, timeoutMs);

      const abortHandler = (): void => {
        clearTimeout(timer);
        const index = this.waitersIndex(waiter);
        if (index >= 0) {
          this.readyWaiters.splice(index, 1);
        }
        reject(new AbortedError('Connection was aborted while waiting for ready.'));
      };

      this.readyWaiters.push(waiter);
      if (this.connectSignal?.aborted) {
        abortHandler();
        return;
      }
      this.connectSignal?.addEventListener('abort', abortHandler, { once: true });
    });
  }

  private waitersIndex(waiter: (info: DeviceInfo) => void): number {
    return this.readyWaiters.indexOf(waiter);
  }

  private async requestHello(): Promise<Record<string, unknown>> {
    const deadline = Date.now() + this.timeoutMs;
    let attempts = 0;

    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      const attemptTimeoutMs = Math.min(Math.max(remainingMs, 100), 300);
      attempts += 1;
      try {
        return await this.request(
          'sys.hello',
          {},
          {
            timeoutMs: attemptTimeoutMs,
            ...(this.connectSignal ? { signal: this.connectSignal } : {}),
          },
        );
      } catch (error) {
        if (!(error instanceof TimeoutError)) {
          throw error;
        }
      }
    }

    throw new TimeoutError(
      `Timed out waiting for 'sys.hello' after ${attempts} attempt${attempts === 1 ? '' : 's'} (${this.timeoutMs}ms total).`,
    );
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const line of readLines(this.transport.readable, maxProtocolLineBytes, {
        onOversize: (length) => {
          this.logger.warn('discarded oversized protocol line', {
            length,
            maxProtocolLineBytes,
          });
        },
      })) {
        let message;
        try {
          message = parseLine(line);
        } catch (error) {
          // Boot noise and one malformed serial frame must not tear down a
          // healthy session or reject unrelated in-flight requests.
          this.logger.warn('discarded malformed protocol line', {
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        if (message === null) {
          continue;
        }

        if ('event' in message) {
          this.handleEvent(message);
          continue;
        }

        if ('ok' in message) {
          this.handleResponse(message);
        }
      }
    } catch (error) {
      this.rejectAll(
        error instanceof Error
          ? error
          : new TransportError('Transport readable stream failed.', { cause: error }),
      );
    } finally {
      this.rejectAll(new DisconnectedError('Transport closed.'));
    }
  }

  private handleEvent(event: ProtocolEvent): void {
    if (event.event === 'ready') {
      const info = parseDeviceInfo(event.payload);
      this.deviceInfo = info;
      while (this.readyWaiters.length > 0) {
        this.readyWaiters.shift()?.(info);
      }
    }
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private handleResponse(response: ProtocolResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.finishPending(response.id);
    pending.resolve(response);
  }

  private finishPending(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener('abort', pending.abortHandler);
    }
    this.pending.delete(id);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.finishPending(id);
      pending.reject(error);
    }
  }
}
