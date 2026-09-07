/**
 * In-process MQTT 3.1.1 broker simulator (no network beyond loopback).
 * Handles CONNECT/CONNACK, SUBSCRIBE/SUBACK, PUBLISH routing (exact topics
 * and `+` single-level wildcards), QoS-1 PUBACK, PINGRESP.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { encodeRemainingLength, tryDecodePacket, type MqttPacket } from './wire.js';

interface Session {
  socket: Socket;
  subscriptions: Map<string, (packet: MqttPacket) => void>;
}

export class MqttBrokerSimulator {
  private server: Server | undefined;
  private readonly sessions = new Set<Session>();
  private readonly retained = new Map<string, Buffer>();
  port = 0;

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    this.port = (server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      for (const session of this.sessions) session.socket.destroy();
    });
    this.server = undefined;
  }

  /** Broker-side publish to all matching subscribers (and retain). */
  publish(topic: string, payload: string | Buffer, qos = 0, retain = false): void {
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    if (retain) this.retained.set(topic, bytes);
    for (const session of this.sessions) {
      for (const filter of session.subscriptions.keys()) {
        if (topicMatchesSim(filter, topic)) {
          session.socket.write(buildPublish(topic, bytes, qos));
        }
      }
    }
  }

  private onConnection(socket: Socket): void {
    let buffer = Buffer.alloc(0);
    const session: Session = { socket, subscriptions: new Map() };

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const decoded = tryDecodePacket(buffer);
        if (!decoded) break;
        buffer = buffer.subarray(decoded.consumed);
        const packet = decoded.packet;
        switch (packet.type) {
          case 'CONNECT': {
            socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
            this.sessions.add(session);
            break;
          }
          case 'SUBSCRIBE': {
            for (const filter of packet.topicFilters ?? []) {
              session.subscriptions.set(filter, () => undefined);
            }
            if (packet.packetId !== undefined) {
              socket.write(
                Buffer.concat([
                  Buffer.from([0x90]),
                  encodeRemainingLength(2 + 1),
                  Buffer.from([packet.packetId >> 8, packet.packetId & 0xff]),
                  Buffer.from([0x00]),
                ]),
              );
            }
            break;
          }
          case 'PUBLISH': {
            if (packet.topic !== undefined && packet.payload !== undefined) {
              if (packet.qos === 1 && packet.packetId !== undefined) {
                socket.write(
                  Buffer.from([0x40, 0x02, (packet.packetId >> 8) & 0xff, packet.packetId & 0xff]),
                );
              }
              for (const other of this.sessions) {
                for (const filter of other.subscriptions.keys()) {
                  if (topicMatchesSim(filter, packet.topic)) {
                    other.socket.write(buildPublish(packet.topic, packet.payload, 0));
                  }
                }
              }
            }
            break;
          }
          case 'PINGREQ': {
            socket.write(Buffer.from([0xd0, 0x00]));
            break;
          }
          case 'DISCONNECT': {
            this.sessions.delete(session);
            socket.end();
            break;
          }
        }
      }
    });
    socket.on('close', () => this.sessions.delete(session));
    socket.on('error', () => this.sessions.delete(session));
  }
}

function buildPublish(topic: string, payload: Buffer, qos: number): Buffer {
  const topicBytes = Buffer.alloc(2 + topic.length);
  topicBytes.writeUInt16BE(topic.length);
  topicBytes.write(topic, 2);
  const body =
    qos === 0
      ? Buffer.concat([topicBytes, payload])
      : Buffer.concat([topicBytes, Buffer.from([0, 1]), payload]);
  const header = (3 << 4) | (qos === 0 ? 0 : 2);
  return Buffer.concat([Buffer.from([header]), encodeRemainingLength(body.length), body]);
}

function topicMatchesSim(filter: string, topic: string): boolean {
  const filterParts = filter.split('/');
  const topicParts = topic.split('/');
  for (let i = 0; i < filterParts.length; i += 1) {
    const part = filterParts[i]!;
    if (part === '#') return true;
    if (i >= topicParts.length) return false;
    if (part === '+') continue;
    if (part !== topicParts[i]) return false;
  }
  return filterParts.length === topicParts.length;
}
