import WebSocket from 'ws';
import { TransportError } from '../errors.js';
import type { Logger } from '../logger.js';
import { ByteQueue } from './byteQueue.js';
import type { Transport } from '../types.js';

export interface WebSocketReconnectOptions {
  /** Total reconnect attempts before the transport gives up. */
  maxAttempts: number;
  /** Delay before the first attempt; doubles every attempt. */
  baseDelayMs: number;
  /** Upper bound for the computed backoff delay. */
  maxDelayMs?: number;
}

export interface WebSocketTransportOptions {
  url: string;
  /** Optional WebSocket subprotocols. */
  protocols?: string[];
  /** Timeout for establishing a connection in milliseconds (default 5000). */
  timeoutMs?: number;
  /** Receives `reconnecting`/`reconnected` logs. Silent when omitted. */
  logger?: Logger;
  /**
   * When set, the transport reconnects with exponential backoff after an
   * unexpected close. Reconnection never runs after an explicit close().
   */
  reconnect?: WebSocketReconnectOptions;
}

export function webSocketTransport(options: WebSocketTransportOptions): Transport {
  return new NodeWebSocketTransport(options);
}

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  isEnabled: () => false,
};

class NodeWebSocketTransport implements Transport {
  readonly kind = 'websocket';
  private socket: WebSocket | undefined;
  private readonly inbound = new ByteQueue();
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private closed = false;
  /** Bumped on every socket so handlers of superseded sockets are ignored. */
  private generation = 0;

  constructor(private readonly options: WebSocketTransportOptions) {}

  private get logger(): Logger {
    return this.options.logger ?? silentLogger;
  }

  get readable(): AsyncIterable<Uint8Array> {
    return this.inbound;
  }

  async open(): Promise<void> {
    if (this.socket) {
      return;
    }
    this.closed = false;
    const socket = await this.connect();
    this.attach(socket);
  }

  async write(data: Uint8Array): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new TransportError('WebSocket is not open.');
    }

    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        if (error) {
          reject(new TransportError(`WebSocket write failed: ${error.message}`, { cause: error }));
          return;
        }
        resolve();
      };

      const text = this.decodeText(data);
      if (text !== undefined) {
        socket.send(text, done);
      } else {
        socket.send(Buffer.from(data), done);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.inbound.close();
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 2000);
      timer.unref();
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      // ws never throws here: a CONNECTING socket is aborted, a CLOSING or
      // OPEN socket starts (or continues) the close handshake.
      socket.close(1000);
    });
  }

  private connect(): Promise<WebSocket> {
    const socket = new WebSocket(this.options.url, this.options.protocols ?? []);
    // Base guard so a late 'error' event can never crash the process.
    socket.on('error', () => undefined);

    return new Promise<WebSocket>((resolve, reject) => {
      const timeoutMs = this.options.timeoutMs ?? 5000;
      const timer = setTimeout(() => {
        socket.terminate();
        reject(
          new TransportError(`Timed out connecting to ${this.options.url} in ${timeoutMs}ms.`),
        );
      }, timeoutMs);
      timer.unref();

      socket.once('open', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (error: Error) => {
        clearTimeout(timer);
        reject(
          new TransportError(`Failed to connect to ${this.options.url}: ${error.message}`, {
            cause: error,
          }),
        );
      });
    });
  }

  private attach(socket: WebSocket): void {
    const generation = ++this.generation;
    this.socket = socket;

    socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      this.inbound.push(toBytes(data, isBinary));
    });
    socket.on('error', (error: Error) => {
      // The subsequent 'close' event drives reconnection or stream failure.
      this.logger.error(`WebSocket error: ${error.message}`, { transport: 'websocket' });
    });
    socket.on('close', (code: number) => {
      if (generation !== this.generation) {
        return;
      }
      this.socket = undefined;
      if (this.closed) {
        this.inbound.close();
        return;
      }
      void this.reconnect(code);
    });
  }

  private async reconnect(code: number): Promise<void> {
    const reconnect = this.options.reconnect;
    if (!reconnect) {
      this.inbound.close();
      return;
    }

    for (let attempt = 1; attempt <= reconnect.maxAttempts; attempt++) {
      if (this.closed) {
        return;
      }
      const delayMs = Math.min(
        reconnect.baseDelayMs * 2 ** (attempt - 1),
        reconnect.maxDelayMs ?? Number.POSITIVE_INFINITY,
      );
      this.logger.warn('reconnecting', { transport: 'websocket', attempt, delayMs, code });
      await delay(delayMs);
      if (this.closed) {
        return;
      }
      try {
        const socket = await this.connect();
        if (this.closed) {
          socket.close(1000);
          return;
        }
        this.attach(socket);
        this.logger.info('reconnected', { transport: 'websocket', attempt });
        return;
      } catch {
        // Retry until attempts are exhausted; the final failure surfaces below.
      }
    }

    this.inbound.fail(
      new TransportError(
        `WebSocket reconnect to ${this.options.url} failed after ${reconnect.maxAttempts} attempts.`,
      ),
    );
  }

  private decodeText(data: Uint8Array): string | undefined {
    try {
      return this.decoder.decode(data);
    } catch {
      // Not valid UTF-8; send it as a binary frame instead.
      return undefined;
    }
  }
}

function toBytes(data: WebSocket.RawData, isBinary: boolean): Uint8Array {
  if (!isBinary && typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return new Uint8Array(data);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    timer.unref();
  });
}
