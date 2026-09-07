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
import { ScpiClient, type ScpiIdentity } from './client.js';
import { PowerSupply } from './instruments/powerSupply.js';
import { createScpiPsuSimulator } from './simulator.js';

export interface ScpiPowerSupplyBackendOptions {
  client?: ScpiClient;
  transport?: Transport;
  simulated?: boolean;
  identity?: string;
  channelCount?: number;
  provenance?: EvidenceProvenance;
}

/**
 * Runtime {@link DeviceBackend} wrapping {@link PowerSupply} over a SCPI client.
 *
 * `kind` is `'simulated'` when the in-process PSU simulator owns the transport,
 * and `'protocol'` when the caller supplies an external client or transport.
 */
export class ScpiPowerSupplyBackend implements DeviceBackend {
  readonly kind: 'simulated' | 'protocol';
  private readonly client: ScpiClient;
  private readonly powerSupply: PowerSupply;
  private readonly provenance: EvidenceProvenance;
  private readonly ready: Promise<void>;
  private readonly listeners = new Set<(event: string, payload: Record<string, unknown>) => void>();
  private closed = false;
  private maxChannel = 1;
  private commandedVolts: number | null = null;
  private commandedAmps: number | null = null;
  private outputEnabled = false;
  private identity: ScpiIdentity | null = null;
  private voltageEvidence: EvidenceState<number>;
  private currentEvidence: EvidenceState<number>;
  private outputEvidence: EvidenceState<boolean>;

  constructor(options: {
    client: ScpiClient;
    kind: 'simulated' | 'protocol';
    provenance?: EvidenceProvenance;
  }) {
    this.client = options.client;
    this.kind = options.kind;
    this.provenance =
      options.provenance ?? (options.kind === 'simulated' ? 'simulated' : 'hardware');
    this.powerSupply = new PowerSupply(this.client);
    this.voltageEvidence = unknownEvidence<number>(this.provenance);
    this.currentEvidence = unknownEvidence<number>(this.provenance);
    this.outputEvidence = unknownEvidence<boolean>(this.provenance);
    this.ready = this.client.isOpen ? Promise.resolve() : this.client.open();
  }

  static createSimulated(options: ScpiPowerSupplyBackendOptions = {}): ScpiPowerSupplyBackend {
    const simulator = createScpiPsuSimulator({
      ...(options.identity !== undefined ? { identity: options.identity } : {}),
      ...(options.channelCount !== undefined ? { channelCount: options.channelCount } : {}),
    });
    const client = new ScpiClient(simulator.transport);
    return new ScpiPowerSupplyBackend({
      client,
      kind: 'simulated',
      provenance: options.provenance ?? 'simulated',
    });
  }

  static async create(
    options: ScpiPowerSupplyBackendOptions = {},
  ): Promise<ScpiPowerSupplyBackend> {
    if (options.simulated !== false && !options.client && !options.transport) {
      const backend = ScpiPowerSupplyBackend.createSimulated(options);
      await backend.ensureReady();
      return backend;
    }
    if (options.client) {
      if (!options.client.isOpen) {
        await options.client.open();
      }
      return new ScpiPowerSupplyBackend({
        client: options.client,
        kind: options.simulated === true ? 'simulated' : 'protocol',
        ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
      });
    }
    if (!options.transport) {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        'SCPI protocol backend requires a transport or client.',
      );
    }
    const client = new ScpiClient(options.transport);
    await client.open();
    return new ScpiPowerSupplyBackend({
      client,
      kind: 'protocol',
      provenance: options.provenance ?? 'hardware',
    });
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
      // start failed; still close the client
    }
    await this.client.close().catch(() => undefined);
  }

  getOperationalState(): Record<string, unknown> {
    return {
      identity: this.identity,
      commandedVolts: this.commandedVolts,
      commandedAmps: this.commandedAmps,
      outputEnabled: this.outputEnabled,
      maxChannel: this.maxChannel,
    };
  }

  getOperationalStateEvidence(): Record<string, EvidenceState<unknown>> {
    return {
      voltage: this.voltageEvidence as EvidenceState<unknown>,
      current: this.currentEvidence as EvidenceState<unknown>,
      outputEnabled: this.outputEvidence as EvidenceState<unknown>,
    };
  }

  /**
   * Disable every known output channel. Does not assume GPIO LOW; programmed
   * voltage/current limits are left unchanged.
   */
  async safeState(): Promise<Record<string, unknown>> {
    await this.ensureReady();
    const disabled: number[] = [];
    for (let channel = 1; channel <= this.maxChannel; channel += 1) {
      await this.powerSupply.disableOutput(channel);
      disabled.push(channel);
    }
    const now = new Date();
    this.outputEnabled = false;
    this.outputEvidence = recordCommanded(this.outputEvidence, false, now, this.provenance);
    this.outputEvidence = recordAcknowledged(this.outputEvidence, false, now, this.provenance);
    this.emit('safe_state.applied', { outputsDisabled: disabled });
    return { applied: true, outputsDisabled: disabled };
  }

  async invoke(
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new DeviceError('DISCONNECTED', 'SCPI power supply backend is closed.');
    }
    await this.ensureReady();
    const channel = this.resolveChannel(payload.channel);

    if (action === 'psu.identify') {
      this.identity = await this.client.identify();
      return { ...this.identity };
    }

    if (action === 'psu.setVoltage') {
      const volts = requireFinite(payload.volts, 'volts');
      const now = new Date();
      this.voltageEvidence = recordCommanded(this.voltageEvidence, volts, now, this.provenance);
      await this.powerSupply.setVoltage(channel, volts);
      this.commandedVolts = volts;
      this.voltageEvidence = recordAcknowledged(this.voltageEvidence, volts, now, this.provenance);
      this.emit('psu.changed', { channel, volts });
      return { channel, volts };
    }

    if (action === 'psu.setCurrent') {
      const amps = requireFinite(payload.amps, 'amps');
      const now = new Date();
      this.currentEvidence = recordCommanded(this.currentEvidence, amps, now, this.provenance);
      await this.powerSupply.setCurrent(channel, amps);
      this.commandedAmps = amps;
      this.currentEvidence = recordAcknowledged(this.currentEvidence, amps, now, this.provenance);
      this.emit('psu.changed', { channel, amps });
      return { channel, amps };
    }

    if (action === 'psu.enableOutput') {
      const now = new Date();
      this.outputEvidence = recordCommanded(this.outputEvidence, true, now, this.provenance);
      await this.powerSupply.enableOutput(channel);
      this.outputEnabled = true;
      this.outputEvidence = recordAcknowledged(this.outputEvidence, true, now, this.provenance);
      this.emit('psu.changed', { channel, outputEnabled: true });
      return { channel, outputEnabled: true };
    }

    if (action === 'psu.disableOutput') {
      const now = new Date();
      this.outputEvidence = recordCommanded(this.outputEvidence, false, now, this.provenance);
      await this.powerSupply.disableOutput(channel);
      this.outputEnabled = false;
      this.outputEvidence = recordAcknowledged(this.outputEvidence, false, now, this.provenance);
      this.emit('psu.changed', { channel, outputEnabled: false });
      return { channel, outputEnabled: false };
    }

    if (action === 'psu.readVoltage') {
      const volts = await this.powerSupply.readVoltage(channel);
      const now = new Date();
      this.voltageEvidence = recordObserved(
        this.voltageEvidence,
        volts,
        this.kind === 'simulated' ? 'simulated' : 'sensor',
        now,
        this.provenance,
      );
      return { channel, volts };
    }

    if (action === 'psu.readCurrent') {
      const amps = await this.powerSupply.readCurrent(channel);
      const now = new Date();
      this.currentEvidence = recordObserved(
        this.currentEvidence,
        amps,
        this.kind === 'simulated' ? 'simulated' : 'sensor',
        now,
        this.provenance,
      );
      return { channel, amps };
    }

    if (action === 'psu.status') {
      if (this.identity === null) {
        this.identity = await this.client.identify().catch(() => null);
      }
      let measuredVolts: number | null = null;
      let measuredAmps: number | null = null;
      try {
        measuredVolts = await this.powerSupply.readVoltage(channel);
        measuredAmps = await this.powerSupply.readCurrent(channel);
        const now = new Date();
        this.voltageEvidence = recordObserved(
          this.voltageEvidence,
          measuredVolts,
          this.kind === 'simulated' ? 'simulated' : 'sensor',
          now,
          this.provenance,
        );
        this.currentEvidence = recordObserved(
          this.currentEvidence,
          measuredAmps,
          this.kind === 'simulated' ? 'simulated' : 'sensor',
          now,
          this.provenance,
        );
      } catch {
        // Status still returns commanded values when measurement fails.
      }
      return {
        identity: this.identity,
        channel,
        volts: measuredVolts ?? this.commandedVolts ?? 0,
        amps: measuredAmps ?? this.commandedAmps ?? 0,
        outputEnabled: this.outputEnabled,
        commandedVolts: this.commandedVolts,
        commandedAmps: this.commandedAmps,
      };
    }

    throw new DeviceError('UNKNOWN_ACTION', `Unknown action '${action}'.`);
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  private resolveChannel(raw: unknown): number {
    if (raw === undefined) {
      return 1;
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
      throw new DeviceError(
        'VALIDATION_ERROR',
        `Channel must be an integer >= 1; received ${String(raw)}.`,
      );
    }
    if (raw > this.maxChannel) {
      this.maxChannel = raw;
    }
    return raw;
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener(event, payload);
    }
  }
}

export function createScpiPowerSupplyBackend(
  options: ScpiPowerSupplyBackendOptions = {},
): Promise<ScpiPowerSupplyBackend> {
  return ScpiPowerSupplyBackend.create(options);
}

function requireFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DeviceError('VALIDATION_ERROR', `'${field}' must be a finite number.`);
  }
  return value;
}
