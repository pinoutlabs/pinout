import {
  DeviceError,
  recordAcknowledged,
  recordCommanded,
  recordObserved,
  unknownEvidence,
  type DeviceBackend,
  type EvidenceProvenance,
  type EvidenceState,
  type Transport,
} from '@pinout/core';
import { GrblClient, type GrblMachineStatus } from './grblClient.js';
import { GrblSimulatorTransport, type GrblSimulatorOptions } from './grblSimulator.js';

export interface GrblBackendOptions extends GrblSimulatorOptions {
  client?: GrblClient;
  transport?: Transport;
  simulated?: boolean;
  provenance?: EvidenceProvenance;
}

const SAFE_STATE_NOTE =
  'Feed hold and soft reset do not replace a hardware e-stop, limit switches, or other mechanical safeguards. This backend never claims mechanical safety.';

/**
 * Runtime {@link DeviceBackend} over {@link GrblClient}.
 *
 * Motion capabilities are PHYSICAL. `safeState` issues feed hold then soft
 * reset — it does not claim the machine is mechanically safe.
 */
export class GrblBackend implements DeviceBackend {
  readonly kind: 'simulated' | 'protocol';
  private readonly client: GrblClient;
  private readonly provenance: EvidenceProvenance;
  private readonly ready: Promise<void>;
  private readonly listeners = new Set<(event: string, payload: Record<string, unknown>) => void>();
  private closed = false;
  private lastStatus: GrblMachineStatus | null = null;
  private positionEvidence: EvidenceState<Record<string, number>>;
  private stateEvidence: EvidenceState<string>;

  constructor(options: {
    client: GrblClient;
    kind: 'simulated' | 'protocol';
    provenance?: EvidenceProvenance;
  }) {
    this.client = options.client;
    this.kind = options.kind;
    this.provenance =
      options.provenance ?? (options.kind === 'simulated' ? 'simulated' : 'hardware');
    this.positionEvidence = unknownEvidence<Record<string, number>>(this.provenance);
    this.stateEvidence = unknownEvidence<string>(this.provenance);
    this.ready = this.client.start();
  }

  static createSimulated(options: GrblBackendOptions = {}): GrblBackend {
    const transport = new GrblSimulatorTransport({
      ...(options.version !== undefined ? { version: options.version } : {}),
      ...(options.motionDelayMs !== undefined ? { motionDelayMs: options.motionDelayMs } : {}),
      ...(options.travel !== undefined ? { travel: options.travel } : {}),
    });
    const client = new GrblClient(transport);
    return new GrblBackend({
      client,
      kind: 'simulated',
      provenance: options.provenance ?? 'simulated',
    });
  }

  static async create(options: GrblBackendOptions = {}): Promise<GrblBackend> {
    if (options.simulated !== false && !options.client && !options.transport) {
      const backend = GrblBackend.createSimulated(options);
      await backend.ensureReady();
      return backend;
    }
    if (options.client) {
      const backend = new GrblBackend({
        client: options.client,
        kind: options.simulated === true ? 'simulated' : 'protocol',
        ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
      });
      await backend.ensureReady();
      return backend;
    }
    if (!options.transport) {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        'GRBL protocol backend requires a transport or client.',
      );
    }
    const client = new GrblClient(options.transport);
    const backend = new GrblBackend({
      client,
      kind: options.transport instanceof GrblSimulatorTransport ? 'simulated' : 'protocol',
      ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
    });
    await backend.ensureReady();
    return backend;
  }

  subscribe(handler: (event: string, payload: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    try {
      await this.ready;
    } catch {
      // start failed
    }
    await this.client.close().catch(() => undefined);
  }

  getOperationalState(): Record<string, unknown> {
    return {
      status: this.lastStatus,
      note: SAFE_STATE_NOTE,
    };
  }

  getOperationalStateEvidence(): Record<string, EvidenceState<unknown>> {
    return {
      state: this.stateEvidence as EvidenceState<unknown>,
      position: this.positionEvidence as EvidenceState<unknown>,
    };
  }

  /**
   * Feed hold, then soft reset if available.
   *
   * THIS DOES NOT CLAIM MECHANICAL SAFETY. Independent hardware e-stops and
   * limit switches are always required around real machinery.
   */
  async safeState(): Promise<Record<string, unknown>> {
    await this.ensureReady();
    await this.client.feedHold();
    if (typeof this.client.softReset === 'function') {
      await this.client.softReset();
    }
    this.emit('safe_state.applied', { actions: ['hold', 'reset'], note: SAFE_STATE_NOTE });
    return {
      applied: true,
      actions: ['hold', 'reset'],
      note: SAFE_STATE_NOTE,
    };
  }

  async invoke(
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new DeviceError('DISCONNECTED', 'GRBL backend is closed.');
    }
    await this.ensureReady();

    if (action === 'grbl.status') {
      const status = await this.client.status();
      this.recordStatus(status, true);
      return statusToPayload(status);
    }

    if (action === 'grbl.home') {
      const now = new Date();
      this.stateEvidence = recordCommanded(this.stateEvidence, 'Home', now, this.provenance);
      await this.client.home();
      this.stateEvidence = recordAcknowledged(this.stateEvidence, 'Idle', now, this.provenance);
      const status = await this.client.status().catch(() => null);
      if (status) this.recordStatus(status, false);
      this.emit('grbl.changed', { action: 'home' });
      return { homed: true, ...(status ? statusToPayload(status) : {}) };
    }

    if (action === 'grbl.rapidMove') {
      const position = axisPayload(payload);
      const now = new Date();
      this.positionEvidence = recordCommanded(
        this.positionEvidence,
        position,
        now,
        this.provenance,
      );
      await this.client.rapidMove(position);
      this.positionEvidence = recordAcknowledged(
        this.positionEvidence,
        position,
        now,
        this.provenance,
      );
      this.emit('grbl.changed', { action: 'rapidMove', ...position });
      return { moved: true, ...position };
    }

    if (action === 'grbl.linearMove') {
      const position = axisPayload(payload);
      const feedRate = requirePositive(payload.feedRate, 'feedRate');
      const now = new Date();
      this.positionEvidence = recordCommanded(
        this.positionEvidence,
        position,
        now,
        this.provenance,
      );
      await this.client.feedMove(position, feedRate);
      this.positionEvidence = recordAcknowledged(
        this.positionEvidence,
        position,
        now,
        this.provenance,
      );
      this.emit('grbl.changed', { action: 'linearMove', ...position, feedRate });
      return { moved: true, ...position, feedRate };
    }

    if (action === 'grbl.hold') {
      const now = new Date();
      this.stateEvidence = recordCommanded(this.stateEvidence, 'Hold', now, this.provenance);
      await this.client.feedHold();
      this.stateEvidence = recordAcknowledged(this.stateEvidence, 'Hold', now, this.provenance);
      this.emit('grbl.changed', { action: 'hold' });
      return { held: true, note: SAFE_STATE_NOTE };
    }

    if (action === 'grbl.reset') {
      const now = new Date();
      this.stateEvidence = recordCommanded(this.stateEvidence, 'reset', now, this.provenance);
      await this.client.softReset();
      this.stateEvidence = recordAcknowledged(this.stateEvidence, 'reset', now, this.provenance);
      this.emit('grbl.changed', { action: 'reset' });
      return { reset: true, note: SAFE_STATE_NOTE };
    }

    throw new DeviceError('UNKNOWN_ACTION', `Unknown action '${action}'.`);
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  private recordStatus(status: GrblMachineStatus, observed: boolean): void {
    this.lastStatus = status;
    if (!observed) return;
    const now = new Date();
    const source = this.kind === 'simulated' ? 'simulated' : 'sensor';
    this.stateEvidence = recordObserved(
      this.stateEvidence,
      status.state,
      source,
      now,
      this.provenance,
    );
    if (status.wpos) {
      this.positionEvidence = recordObserved(
        this.positionEvidence,
        status.wpos,
        source,
        now,
        this.provenance,
      );
    }
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener(event, payload);
    }
  }
}

export function createGrblBackend(options: GrblBackendOptions = {}): Promise<GrblBackend> {
  return GrblBackend.create(options);
}

function axisPayload(payload: Record<string, unknown>): { x?: number; y?: number; z?: number } {
  const position: { x?: number; y?: number; z?: number } = {};
  for (const axis of ['x', 'y', 'z'] as const) {
    const value = payload[axis];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new DeviceError(
        'VALIDATION_ERROR',
        `Axis ${axis} must be a finite number of millimeters.`,
      );
    }
    position[axis] = value;
  }
  if (position.x === undefined && position.y === undefined && position.z === undefined) {
    throw new DeviceError(
      'VALIDATION_ERROR',
      'At least one axis (x/y/z) in millimeters is required.',
    );
  }
  return position;
}

function requirePositive(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new DeviceError('VALIDATION_ERROR', `'${field}' must be a positive finite number.`);
  }
  return value;
}

function statusToPayload(status: GrblMachineStatus): Record<string, unknown> {
  return {
    state: status.state,
    raw: status.raw,
    ...(status.wpos !== undefined ? { wpos: status.wpos } : {}),
    ...(status.mpos !== undefined ? { mpos: status.mpos } : {}),
  };
}
