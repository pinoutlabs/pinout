/**
 * URScript client — sends raw URScript over any Pinout `Transport`.
 *
 * WHERE TO CONNECT: raw URScript must be sent to a client interface that
 * accepts script (the primary client interface, port 30001 by convention).
 * The real-time interface (30003) is read-only. The secondary interface
 * (30002) mirrors the robot's output stream on modern firmware; whether it
 * also accepts script is firmware/version dependent and is NOT assumed here —
 * this client accepts whatever `Transport` the embedder provides and makes no
 * port assumptions.
 *
 * SAFETY: URScript sent to a client interface executes IMMEDIATELY; it is not
 * governed by the dashboard `play`/`pause`/`stop` state, is not inspected,
 * sandboxed, or validated by this client, and can command arbitrary motion
 * (including setting payloads, digital outputs, and disabling safeguards that
 * are not exposed as URScript). Only send vetted scripts. Use
 * `buildMoveLCommand`/`buildMoveJCommand` helpers (or your own vetted
 * generator) rather than string concatenation of untrusted input.
 *
 * Client interfaces do not acknowledge script execution. Confirmation of
 * motion must come from RTDE telemetry or dashboard state, never from the
 * absence of an error here.
 */
import type { Transport } from '@pinout/core';
import { UrScriptError } from './errors.js';

export interface UrScriptDiagnostic {
  code: string;
  message: string;
  at: number;
}

export interface UrScriptClientOptions {
  transport: Transport;
  onDiagnostic?: (diagnostic: UrScriptDiagnostic) => void;
}

export class UrScriptClient {
  private readonly transport: Transport;
  private started = false;
  private closed = false;
  private bytesSent = 0;

  constructor(options: UrScriptClientOptions) {
    this.transport = options.transport;
  }

  /** Total bytes of URScript written since construction. */
  get bytesWritten(): number {
    return this.bytesSent;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.transport.open();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.transport.close().catch(() => undefined);
  }

  /**
   * Send one or more URScript lines. A trailing newline is appended when the
   * script does not end with one.
   */
  async sendScript(script: string | readonly string[]): Promise<void> {
    const text = Array.isArray(script) ? script.join('\n') : (script as string);
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new UrScriptError('UR_SCRIPT_EMPTY', 'URScript payload must be a non-empty string.');
    }
    if (this.closed) {
      throw new UrScriptError('UR_SCRIPT_CLOSED', 'URScript transport is closed.');
    }
    if (!this.started) {
      await this.start();
    }
    const payload = text.endsWith('\n') ? text : `${text}\n`;
    const bytes = new TextEncoder().encode(payload);
    await this.transport.write(bytes);
    this.bytesSent += bytes.length;
  }

  /** Send a single URScript line. */
  sendLine(line: string): Promise<void> {
    return this.sendScript(line);
  }
}

export function createUrScriptClient(options: UrScriptClientOptions): UrScriptClient {
  return new UrScriptClient(options);
}
