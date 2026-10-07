import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { StreamBus, StreamFrame } from '@pinout/core';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function bearerMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const actual = Buffer.from(provided, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** Binary messages contain uint32-BE metadata length, UTF-8 JSON, then raw bytes. */
export function encodeStreamFrame(frame: StreamFrame): Buffer | string {
  if (!(frame.data instanceof Uint8Array)) return JSON.stringify(frame);
  const { data, ...metadata } = frame;
  const header = Buffer.from(JSON.stringify({ ...metadata, encoding: 'binary' }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, data]);
}

/** Attach an authenticated, read-only WebSocket data plane to the HTTP server. */
export function attachStreamSockets(
  server: Server,
  streams: StreamBus,
  token?: string,
): () => void {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
  });
  const subscriptions = new Map<WebSocket, () => void>();
  const reject = (socket: Duplex, status: string): void => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const match = /^\/v1\/streams\/([^/]+)\/frames$/.exec(url.pathname);
      if (!match) return reject(socket, '404 Not Found');
      if (
        token &&
        !bearerMatches((request.headers.authorization ?? '').replace(/^Bearer\s+/i, ''), token)
      ) {
        return reject(socket, '401 Unauthorized');
      }
      const streamId = decodeURIComponent(match[1]!);
      if (!streams.get(streamId)) return reject(socket, '404 Not Found');
      sockets.handleUpgrade(request, socket, head, (ws) => {
        // Only one queued frame plus one send may be retained per connection.
        const subscription = streams.subscribe(streamId, { bufferSize: 1, policy: 'latest-only' });
        const cleanup = (): void => {
          subscription.close();
          subscriptions.delete(ws);
        };
        subscriptions.set(ws, cleanup);
        ws.on('close', cleanup);
        ws.on('error', cleanup);
        ws.on('message', () => ws.close(1008, 'This stream is read-only.'));
        void (async () => {
          try {
            for await (const frame of subscription) {
              if (ws.readyState !== WebSocket.OPEN) break;
              if (frame.data instanceof Uint8Array && frame.data.byteLength > MAX_FRAME_BYTES) {
                ws.close(1009, 'Frame exceeds 8 MiB.');
                break;
              }
              const payload = encodeStreamFrame(frame);
              if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) {
                ws.close(1009, 'Frame exceeds 8 MiB.');
                break;
              }
              await new Promise<void>((resolve, rejectSend) => {
                const timer = setTimeout(() => {
                  ws.terminate();
                  rejectSend(new Error('Stream consumer stalled.'));
                }, 5000);
                timer.unref();
                ws.send(payload, { binary: Buffer.isBuffer(payload) }, (error) => {
                  clearTimeout(timer);
                  if (error) rejectSend(error);
                  else resolve();
                });
              });
            }
            if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Stream ended.');
          } catch {
            ws.terminate();
          } finally {
            cleanup();
          }
        })();
      });
    } catch {
      reject(socket, '400 Bad Request');
    }
  });
  return () => {
    // Release subscribers synchronously; socket close events may arrive after
    // the HTTP server's close callback, especially on Windows.
    for (const cleanup of subscriptions.values()) cleanup();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  };
}
