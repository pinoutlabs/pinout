import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';
import { TransportError } from '../src/errors.js';
import type { LogContext, LogLevel, Logger } from '../src/logger.js';
import { webSocketTransport } from '../src/transports/webSocketTransport.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class CapturingLogger implements Logger {
  readonly entries: Array<{ level: LogLevel; message: string; context?: LogContext }> = [];

  debug(message: string, context?: LogContext): void {
    this.entries.push(
      context === undefined ? { level: 'debug', message } : { level: 'debug', message, context },
    );
  }

  info(message: string, context?: LogContext): void {
    this.entries.push(
      context === undefined ? { level: 'info', message } : { level: 'info', message, context },
    );
  }

  warn(message: string, context?: LogContext): void {
    this.entries.push(
      context === undefined ? { level: 'warn', message } : { level: 'warn', message, context },
    );
  }

  error(message: string, context?: LogContext): void {
    this.entries.push(
      context === undefined ? { level: 'error', message } : { level: 'error', message, context },
    );
  }

  child(): Logger {
    return this;
  }

  isEnabled(): boolean {
    return true;
  }
}

interface EchoServer {
  port: number;
  kill(): void;
  close(): Promise<void>;
}

async function listen(server: http.Server, preferredPort?: number): Promise<number> {
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      return await new Promise<number>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
          reject(error);
        };
        server.once('error', onError);
        const done = () => {
          resolve((server.address() as AddressInfo).port);
        };
        if (preferredPort === undefined) {
          server.listen(0, '127.0.0.1', done);
        } else {
          server.listen(preferredPort, '127.0.0.1', done);
        }
      });
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Could not bind echo server to port ${preferredPort}.`);
}

async function startEchoServer(preferredPort?: number): Promise<EchoServer> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const sockets = new Set<WebSocket>();
  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (data, isBinary) => {
      socket.send(data, { binary: isBinary });
    });
  });

  const port = await listen(server, preferredPort);

  return {
    port,
    kill() {
      for (const socket of sockets) {
        socket.terminate();
      }
      wss.close();
      server.close();
    },
    close() {
      for (const socket of sockets) {
        socket.terminate();
      }
      wss.close();
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    timer.unref();
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 2000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for a WebSocket message.'));
    }, timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function startReading(transport: ReturnType<typeof webSocketTransport>): () => Promise<Uint8Array> {
  const iterator = transport.readable[Symbol.asyncIterator]();
  return async () => {
    const result = await withTimeout(iterator.next());
    if (result.done) {
      throw new Error('Readable stream ended unexpectedly.');
    }
    return result.value;
  };
}

async function writeUntilAccepted(
  transport: ReturnType<typeof webSocketTransport>,
  data: Uint8Array,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await transport.write(data);
      return;
    } catch {
      await sleep(20);
    }
  }
  throw new Error('Transport never accepted a write.');
}

describe('webSocketTransport', () => {
  it('round-trips text and binary messages against an echo server', async () => {
    const echo = await startEchoServer();
    const transport = webSocketTransport({
      url: `ws://127.0.0.1:${echo.port}`,
      timeoutMs: 2000,
      reconnect: { maxAttempts: 3, baseDelayMs: 20 },
    });
    await transport.open();
    const readNext = startReading(transport);

    try {
      await transport.write(encoder.encode('hello'));
      expect(decoder.decode(await readNext())).toBe('hello');

      const binary = new Uint8Array([0xff, 0x00, 0xfe, 0x01]);
      await transport.write(binary);
      expect(Array.from(await readNext())).toEqual([0xff, 0x00, 0xfe, 0x01]);
    } finally {
      await transport.close();
      await echo.close();
    }
  });

  it('explicit close ends the stream without reconnecting', async () => {
    const echo = await startEchoServer();
    const logger = new CapturingLogger();
    const transport = webSocketTransport({
      url: `ws://127.0.0.1:${echo.port}`,
      timeoutMs: 2000,
      logger,
      reconnect: { maxAttempts: 5, baseDelayMs: 20 },
    });
    await transport.open();
    await transport.write(encoder.encode('bye'));
    await transport.close();

    await expect(transport.write(encoder.encode('after-close'))).rejects.toBeInstanceOf(
      TransportError,
    );
    expect(logger.entries.map((entry) => entry.message)).not.toContain('reconnecting');
    await echo.close();
  });

  it('reconnects after the server dies and delivers messages afterwards', async () => {
    const echo = await startEchoServer();
    const logger = new CapturingLogger();
    const transport = webSocketTransport({
      url: `ws://127.0.0.1:${echo.port}`,
      timeoutMs: 1000,
      logger,
      reconnect: { maxAttempts: 30, baseDelayMs: 20, maxDelayMs: 60 },
    });
    await transport.open();
    const readNext = startReading(transport);

    echo.kill();
    await sleep(150);
    const restarted = await startEchoServer(echo.port);

    try {
      await writeUntilAccepted(transport, encoder.encode('after-restart'));
      expect(decoder.decode(await readNext())).toBe('after-restart');

      const messages = logger.entries.map((entry) => entry.message);
      expect(messages).toContain('reconnecting');
      expect(messages).toContain('reconnected');
    } finally {
      await transport.close();
      await restarted.close();
    }
  });

  it('fails the stream after exhausting reconnect attempts', async () => {
    const echo = await startEchoServer();
    const logger = new CapturingLogger();
    const transport = webSocketTransport({
      url: `ws://127.0.0.1:${echo.port}`,
      timeoutMs: 1000,
      logger,
      reconnect: { maxAttempts: 2, baseDelayMs: 20 },
    });
    await transport.open();
    const readNext = startReading(transport);

    echo.kill();
    await expect(readNext()).rejects.toBeInstanceOf(TransportError);
    expect(
      logger.entries.filter((entry) => entry.message === 'reconnecting').length,
    ).toBeGreaterThanOrEqual(2);
    await transport.close();
  });
});
