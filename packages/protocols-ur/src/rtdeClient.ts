/**
 * RTDE read-only client (protocol version 2, port 30004 by convention).
 *
 * Handshake: `V` (request protocol version) → `v` (reply), `O` (output recipe)
 * → reply with recipe id + type names, `S` (start) → boolean reply. The client
 * then consumes `U` data packages.
 *
 * This client is READ-ONLY: it never writes robot state, never sends input
 * recipes, and never injects URScript. Values follow the unit conventions of
 * the corresponding RTDE outputs (e.g. `actual_q` in radians,
 * `actual_TCP_pose` in meters + axis-angle radians).
 *
 * If the transport dies, pending readers fail with `UR_RTDE_CONNECTION_LOST`;
 * callers at the Pinout boundary translate that into
 * `DeviceError('DISCONNECTED')`.
 */
import type { Transport } from '@pinout/core';
import { UrRtdeError } from './errors.js';
import {
  decodeBooleanReply,
  decodeDataPackage,
  decodeProtocolVersionReply,
  decodeSetupOutputsReply,
  encodePauseRequest,
  encodeProtocolVersionRequest,
  encodeSetupOutputsRequest,
  encodeStartRequest,
  RTDE_DEFAULT_OUTPUTS,
  RTDE_REQUESTED_PROTOCOL_VERSION,
  RtdeCommand,
  tryDecodeRtdeFrame,
  type RtdeFrame,
  type RtdeProtocolVersionInfo,
  type RtdeValue,
  type RtdeValueType,
} from './rtde.js';

export interface UrRtdeDiagnostic {
  code: string;
  message: string;
  at: number;
}

export interface UrRtdeClientOptions {
  transport: Transport;
  /** Data-package frequency in Hz. Default 125. */
  frequencyHz?: number;
  /** Output names; defaults to {@link RTDE_DEFAULT_OUTPUTS}. */
  outputs?: readonly string[];
  /** Protocol version to request. Default 2; versions below 2 are rejected. */
  requestProtocolVersion?: number;
  /** Handshake request/reply timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Default `readSample()` timeout in ms. Default 1000. */
  sampleTimeoutMs?: number;
  /** Bound on buffered, unread samples. Default 16; the oldest is dropped on overflow. */
  sampleBacklog?: number;
  onDiagnostic?: (diagnostic: UrRtdeDiagnostic) => void;
}

export interface UrRtdeSample {
  /** Local receive time, ms since epoch. */
  at: number;
  /** Value of the `timestamp` output in controller seconds, when subscribed. */
  controllerTimestamp: number | undefined;
  recipeId: number;
  /** Values keyed by output name, in the configured order. */
  values: Record<string, RtdeValue>;
  /** Type names reported by the controller for each output. */
  types: Record<string, RtdeValueType>;
}

interface FrameWaiter {
  command: number;
  resolve: (frame: RtdeFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface SampleWaiter {
  resolve: (sample: UrRtdeSample) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class UrRtdeClient {
  private readonly transport: Transport;
  private readonly frequencyHz: number;
  private readonly outputs: readonly string[];
  private readonly requestProtocolVersion: number;
  private readonly timeoutMs: number;
  private readonly sampleTimeoutMs: number;
  private readonly sampleBacklog: number;
  private readonly onDiagnostic: ((diagnostic: UrRtdeDiagnostic) => void) | undefined;

  private started = false;
  private closed = false;
  private handshakeComplete = false;
  private pending = new Uint8Array(0);
  private frameQueue: RtdeFrame[] = [];
  private readonly frameWaiters: FrameWaiter[] = [];
  private readonly sampleWaiters: SampleWaiter[] = [];
  private samples: UrRtdeSample[] = [];

  private protocolInfo: RtdeProtocolVersionInfo | undefined;
  private recipeId = 0;
  private types: RtdeValueType[] = [];

  constructor(options: UrRtdeClientOptions) {
    this.transport = options.transport;
    this.frequencyHz = options.frequencyHz ?? 125;
    this.outputs = options.outputs ?? RTDE_DEFAULT_OUTPUTS;
    this.requestProtocolVersion = options.requestProtocolVersion ?? RTDE_REQUESTED_PROTOCOL_VERSION;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.sampleTimeoutMs = options.sampleTimeoutMs ?? 1000;
    this.sampleBacklog = Math.max(1, options.sampleBacklog ?? 16);
    this.onDiagnostic = options.onDiagnostic;
  }

  /** Negotiated protocol version, available after `start()`. */
  get negotiatedProtocolVersion(): number | undefined {
    return this.protocolInfo?.protocolVersion;
  }

  /** Recipe id assigned by the controller, available after `start()`. */
  get outputRecipeId(): number | undefined {
    return this.handshakeComplete ? this.recipeId : undefined;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.transport.open();
    void this.consume();

    try {
      await this.negotiateProtocolVersion();
      await this.setupOutputs();
      await this.startStreaming();
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  /** Most recently received sample, without consuming it. */
  latest(): UrRtdeSample | undefined {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1] : undefined;
  }

  /**
   * Drop buffered, unread samples and return how many were discarded. Useful
   * before `readSample()` when only a fresh observation is meaningful.
   */
  discardBufferedSamples(): number {
    const count = this.samples.length;
    this.samples = [];
    return count;
  }

  /** True once this client — or a transport exposing a `closed` flag — is closed. */
  get connectionClosed(): boolean {
    return this.isConnectionClosed();
  }

  /**
   * Wait for (and consume) the next data package. Fails with
   * `UR_RTDE_CONNECTION_LOST` if the transport died or was closed — buffered
   * samples older than a lost connection are not returned.
   *
   * Closure is detected synchronously for transports that expose a `closed`
   * flag (the bundled simulators do); for other transports the read loop
   * notices the loss as soon as the transport's readable ends.
   */
  readSample(timeoutMs: number = this.sampleTimeoutMs): Promise<UrRtdeSample> {
    if (this.isConnectionClosed()) {
      return Promise.reject(
        new UrRtdeError('UR_RTDE_CONNECTION_LOST', 'RTDE connection is closed.'),
      );
    }
    const buffered = this.samples.shift();
    if (buffered) return Promise.resolve(buffered);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new UrRtdeError(
        'UR_RTDE_INVALID_TIMEOUT',
        `Sample timeout must be a positive number of milliseconds; received ${String(timeoutMs)}.`,
      );
    }
    return new Promise<UrRtdeSample>((resolve, reject) => {
      const waiter: SampleWaiter = { resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        const index = this.sampleWaiters.indexOf(waiter);
        if (index >= 0) this.sampleWaiters.splice(index, 1);
        reject(
          new UrRtdeError(
            'UR_RTDE_TIMEOUT',
            `No RTDE data package within ${timeoutMs}ms. Streaming may have stopped; the connection is left open.`,
          ),
        );
      }, timeoutMs);
      (waiter.timer as { unref?: () => void }).unref?.();
      this.sampleWaiters.push(waiter);
    });
  }

  /** Send `P` (pause streaming) and await the boolean reply. */
  async pause(): Promise<boolean> {
    this.assertUsable('pause');
    await this.transport.write(encodePauseRequest());
    const frame = await this.awaitFrame(RtdeCommand.PAUSE, this.timeoutMs);
    return decodeBooleanReply(frame.payload);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectWaiters(new UrRtdeError('UR_RTDE_CONNECTION_LOST', 'RTDE client was closed.'));
    if (this.handshakeComplete) {
      // Best effort: ask the controller to stop streaming before disconnecting.
      await this.transport.write(encodePauseRequest()).catch(() => undefined);
    }
    await this.transport.close().catch(() => undefined);
  }

  // -------------------------------------------------------------------------

  private async negotiateProtocolVersion(): Promise<void> {
    await this.transport.write(encodeProtocolVersionRequest(this.requestProtocolVersion));
    const frame = await this.awaitFrame(RtdeCommand.PROTOCOL_VERSION_REPLY, this.timeoutMs);
    const info = decodeProtocolVersionReply(frame.payload);
    if (info.protocolVersion < 2) {
      throw new UrRtdeError(
        'UR_RTDE_PROTOCOL_UNSUPPORTED',
        `Controller negotiated RTDE protocol version ${info.protocolVersion}; version 2 or newer is required.`,
      );
    }
    this.protocolInfo = info;
  }

  private async setupOutputs(): Promise<void> {
    await this.transport.write(encodeSetupOutputsRequest(this.frequencyHz, this.outputs));
    const frame = await this.awaitFrame(RtdeCommand.SETUP_OUTPUTS, this.timeoutMs);
    const reply = decodeSetupOutputsReply(frame.payload);
    const unknown: string[] = [];
    const types: RtdeValueType[] = [];
    reply.types.forEach((type, index) => {
      if (type === 'NOT_FOUND') {
        unknown.push(this.outputs[index] ?? `#${index}`);
      } else {
        types.push(type);
      }
    });
    if (unknown.length > 0) {
      throw new UrRtdeError(
        'UR_RTDE_UNKNOWN_OUTPUTS',
        `Controller rejected ${unknown.length} RTDE output(s): ${unknown.join(', ')}.`,
      );
    }
    this.recipeId = reply.recipeId;
    this.types = types;
    this.handshakeComplete = true;
  }

  private async startStreaming(): Promise<void> {
    await this.transport.write(encodeStartRequest());
    const frame = await this.awaitFrame(RtdeCommand.START, this.timeoutMs);
    if (!decodeBooleanReply(frame.payload)) {
      throw new UrRtdeError(
        'UR_RTDE_START_REJECTED',
        'Controller refused to start RTDE streaming.',
      );
    }
  }

  private assertUsable(operation: string): void {
    if (this.isConnectionClosed()) {
      throw new UrRtdeError(
        'UR_RTDE_CONNECTION_LOST',
        `RTDE client is closed; cannot ${operation}.`,
      );
    }
    if (!this.handshakeComplete) {
      throw new UrRtdeError(
        'UR_RTDE_NOT_STARTED',
        `RTDE handshake did not complete; call start() before ${operation}().`,
      );
    }
  }

  /**
   * Synchronously reports a known-closed connection: either this client was
   * closed, or the transport exposes a `closed` flag that is set.
   */
  private isConnectionClosed(): boolean {
    if (this.closed) return true;
    const probe = this.transport as Transport & { readonly closed?: unknown };
    return probe.closed === true;
  }

  private awaitFrame(command: number, timeoutMs: number): Promise<RtdeFrame> {
    const existingIndex = this.frameQueue.findIndex((frame) => frame.command === command);
    if (existingIndex >= 0) {
      const [frame] = this.frameQueue.splice(existingIndex, 1);
      return Promise.resolve(frame!);
    }
    if (this.isConnectionClosed()) {
      return Promise.reject(
        new UrRtdeError(
          'UR_RTDE_CONNECTION_LOST',
          'RTDE connection closed while awaiting a reply.',
        ),
      );
    }
    return new Promise<RtdeFrame>((resolve, reject) => {
      const waiter: FrameWaiter = { command, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        const index = this.frameWaiters.indexOf(waiter);
        if (index >= 0) this.frameWaiters.splice(index, 1);
        reject(
          new UrRtdeError(
            'UR_RTDE_TIMEOUT',
            `No RTDE reply (command 0x${command.toString(16).padStart(2, '0')}) within ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      (waiter.timer as { unref?: () => void }).unref?.();
      this.frameWaiters.push(waiter);
    });
  }

  private async consume(): Promise<void> {
    try {
      for await (const chunk of this.transport.readable) {
        this.appendChunk(chunk);
        for (;;) {
          let decoded: { frame: RtdeFrame; consumed: number } | undefined;
          try {
            decoded = tryDecodeRtdeFrame(this.pending);
          } catch (error) {
            this.diagnostic(
              'UR_RTDE_PROTOCOL_ERROR',
              `Dropping RTDE connection after a framing error: ${error instanceof Error ? error.message : String(error)}`,
            );
            await this.close().catch(() => undefined);
            return;
          }
          if (!decoded) break;
          this.pending = this.pending.subarray(decoded.consumed);
          this.handleFrame(decoded.frame);
        }
      }
    } catch {
      // The error is surfaced through the connection-lost path below.
    } finally {
      if (!this.closed) {
        this.closed = true;
        this.rejectWaiters(
          new UrRtdeError(
            'UR_RTDE_CONNECTION_LOST',
            'RTDE transport ended; the connection is lost.',
          ),
        );
      }
    }
  }

  private appendChunk(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    if (this.pending.length === 0) {
      this.pending = chunk.slice();
      return;
    }
    const merged = new Uint8Array(this.pending.length + chunk.length);
    merged.set(this.pending, 0);
    merged.set(chunk, this.pending.length);
    this.pending = merged;
  }

  private handleFrame(frame: RtdeFrame): void {
    if (frame.command === RtdeCommand.DATA_PACKAGE) {
      this.handleDataPackage(frame.payload);
      return;
    }
    const waiterIndex = this.frameWaiters.findIndex((waiter) => waiter.command === frame.command);
    if (waiterIndex >= 0) {
      const [waiter] = this.frameWaiters.splice(waiterIndex, 1);
      if (waiter?.timer !== undefined) clearTimeout(waiter.timer);
      waiter?.resolve(frame);
      return;
    }
    this.frameQueue.push(frame);
    if (this.frameQueue.length > 32) {
      this.frameQueue.shift();
      this.diagnostic(
        'UR_RTDE_UNEXPECTED_FRAME',
        'More than 32 unclaimed RTDE reply frames; the oldest was dropped.',
      );
    }
  }

  private handleDataPackage(payload: Uint8Array): void {
    let decoded;
    try {
      decoded = decodeDataPackage(payload, this.types);
    } catch (error) {
      this.diagnostic(
        'UR_RTDE_PROTOCOL_ERROR',
        `Undecodable data package: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (decoded.recipeId !== this.recipeId) {
      this.diagnostic(
        'UR_RTDE_UNEXPECTED_RECIPE',
        `Data package for recipe ${decoded.recipeId}, expected ${this.recipeId}; dropped.`,
      );
      return;
    }
    if (decoded.values.length !== this.outputs.length) {
      this.diagnostic(
        'UR_RTDE_VALUE_COUNT_MISMATCH',
        `Data package carries ${decoded.values.length} values, expected ${this.outputs.length}; dropped.`,
      );
      return;
    }

    const values: Record<string, RtdeValue> = {};
    const types: Record<string, RtdeValueType> = {};
    for (const [index, name] of this.outputs.entries()) {
      values[name] = decoded.values[index]!;
      types[name] = this.types[index]!;
    }
    const timestamp = values.timestamp;
    const sample: UrRtdeSample = {
      at: Date.now(),
      controllerTimestamp: typeof timestamp === 'number' ? timestamp : undefined,
      recipeId: decoded.recipeId,
      values,
      types,
    };

    const waiter = this.sampleWaiters.shift();
    if (waiter) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve(sample);
      return;
    }
    this.samples.push(sample);
    while (this.samples.length > this.sampleBacklog) {
      this.samples.shift();
      this.diagnostic(
        'UR_RTDE_SAMPLE_BACKLOG_OVERFLOW',
        'Unread RTDE sample backlog exceeded its bound; the oldest sample was dropped.',
      );
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.frameWaiters.splice(0, this.frameWaiters.length)) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    for (const waiter of this.sampleWaiters.splice(0, this.sampleWaiters.length)) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private diagnostic(code: string, message: string): void {
    this.onDiagnostic?.({ code, message, at: Date.now() });
  }
}

export function createUrRtdeClient(options: UrRtdeClientOptions): UrRtdeClient {
  return new UrRtdeClient(options);
}
