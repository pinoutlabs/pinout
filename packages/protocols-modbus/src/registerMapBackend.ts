import {
  DeviceError,
  recordAcknowledged,
  recordCommanded,
  recordObserved,
  unknownEvidence,
  type DeviceBackend,
  type EvidenceProvenance,
  type EvidenceState,
} from '@pinout/core';
import {
  createRegisterMapDevice,
  type RegisterMapDevice,
  type RegisterMapEntry,
} from './registerMap.js';
import { SimulatedModbusServer } from './simulator.js';
import { ModbusTcpClient } from './tcpClient.js';

export interface RegisterMapBackendOptions {
  map: RegisterMapEntry[];
  client?: ModbusTcpClient;
  server?: SimulatedModbusServer;
  simulated?: boolean;
  host?: string;
  port?: number;
  unitId?: number;
  provenance?: EvidenceProvenance;
}

/**
 * DeviceBackend over a Modbus register map.
 *
 * Invoke either:
 * - `modbus.read` with `{ name }` and `modbus.write` with `{ name, value }`
 * - per-entry `modbus.<entryName>.read` / `modbus.<entryName>.write`, matching
 *   the capability ids produced by {@link createRegisterMapDevice}
 *   (`modbus.${entry.name}.${entry.access}`).
 *
 * Writes are refused unless the map entry has `access: 'write'`.
 */
export class RegisterMapDeviceBackend implements DeviceBackend {
  readonly kind: 'simulated' | 'protocol';
  private readonly client: ModbusTcpClient;
  private readonly device: RegisterMapDevice;
  private readonly map: RegisterMapEntry[];
  private readonly provenance: EvidenceProvenance;
  private readonly ownedServer: SimulatedModbusServer | undefined;
  private readonly listeners = new Set<(event: string, payload: Record<string, unknown>) => void>();
  private readonly values: Record<string, number | boolean> = {};
  private readonly evidence = new Map<string, EvidenceState<unknown>>();
  private closed = false;

  constructor(options: {
    client: ModbusTcpClient;
    map: RegisterMapEntry[];
    kind: 'simulated' | 'protocol';
    provenance?: EvidenceProvenance;
    ownedServer?: SimulatedModbusServer;
  }) {
    this.client = options.client;
    this.map = options.map;
    this.device = createRegisterMapDevice({ client: options.client, map: options.map });
    this.kind = options.kind;
    this.provenance =
      options.provenance ?? (options.kind === 'simulated' ? 'simulated' : 'hardware');
    this.ownedServer = options.ownedServer;
  }

  static async create(options: RegisterMapBackendOptions): Promise<RegisterMapDeviceBackend> {
    if (!options.map || options.map.length === 0) {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        'Register map backend requires a non-empty "map".',
      );
    }
    if (options.client) {
      return new RegisterMapDeviceBackend({
        client: options.client,
        map: options.map,
        kind: options.simulated === true ? 'simulated' : 'protocol',
        ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
      });
    }

    const simulated = options.simulated !== false;
    if (!simulated) {
      if (options.host === undefined || options.port === undefined) {
        throw new DeviceError(
          'UNSUPPORTED_CONFIGURATION',
          'Protocol register-map backend requires a client or host/port.',
        );
      }
      const client = new ModbusTcpClient({
        host: options.host,
        port: options.port,
        unitId: options.unitId ?? 1,
        timeoutMs: 3000,
      });
      await client.connect();
      return new RegisterMapDeviceBackend({
        client,
        map: options.map,
        kind: 'protocol',
        provenance: options.provenance ?? 'hardware',
      });
    }

    let server = options.server;
    let createdServer: SimulatedModbusServer | undefined;
    if (!server) {
      createdServer = new SimulatedModbusServer({
        host: options.host ?? '127.0.0.1',
        ...(options.port !== undefined ? { port: options.port } : {}),
      });
      await createdServer.start();
      server = createdServer;
    } else {
      await server.start();
    }

    const client = new ModbusTcpClient({
      host: options.host ?? '127.0.0.1',
      port: server.port,
      unitId: options.unitId ?? 1,
      timeoutMs: 1000,
    });
    await client.connect();
    return new RegisterMapDeviceBackend({
      client,
      map: options.map,
      kind: 'simulated',
      provenance: options.provenance ?? 'simulated',
      ownedServer: createdServer ?? server,
    });
  }

  subscribe(handler: (event: string, payload: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    await this.client.close().catch(() => undefined);
    if (this.ownedServer) {
      await this.ownedServer.close().catch(() => undefined);
    }
  }

  getOperationalState(): Record<string, unknown> {
    return { ...this.values };
  }

  getOperationalStateEvidence(): Record<string, EvidenceState<unknown>> {
    return Object.fromEntries(this.evidence.entries());
  }

  /**
   * Supports `modbus.read` / `modbus.write` and per-entry
   * `modbus.<name>.read` / `modbus.<name>.write`.
   */
  async invoke(
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new DeviceError('DISCONNECTED', 'Modbus register-map backend is closed.');
    }

    if (action === 'modbus.read') {
      const name = requireName(payload.name);
      return this.readEntry(name);
    }
    if (action === 'modbus.write') {
      const name = requireName(payload.name);
      return this.writeEntry(name, payload.value);
    }

    const perEntry = /^modbus\.(.+)\.(read|write)$/.exec(action);
    if (perEntry) {
      const entryName = perEntry[1]!;
      const access = perEntry[2]!;
      this.assertKnownEntry(entryName);
      if (access === 'read') {
        return this.readEntry(entryName);
      }
      return this.writeEntry(entryName, payload.value);
    }

    throw new DeviceError('UNKNOWN_ACTION', `Unknown action '${action}'.`);
  }

  private async readEntry(name: string): Promise<Record<string, unknown>> {
    const value = await this.device.read(name);
    const now = new Date();
    const previous = this.evidence.get(name) ?? unknownEvidence(this.provenance);
    this.evidence.set(
      name,
      recordObserved(
        previous,
        value,
        this.kind === 'simulated' ? 'simulated' : 'sensor',
        now,
        this.provenance,
      ),
    );
    this.values[name] = value;
    return { name, value };
  }

  private async writeEntry(name: string, rawValue: unknown): Promise<Record<string, unknown>> {
    if (rawValue === undefined) {
      throw new DeviceError('VALIDATION_ERROR', 'modbus.write requires a "value" field.');
    }
    if (typeof rawValue !== 'number' && typeof rawValue !== 'boolean') {
      throw new DeviceError('VALIDATION_ERROR', 'modbus.write value must be a number or boolean.');
    }
    const now = new Date();
    const previous = this.evidence.get(name) ?? unknownEvidence(this.provenance);
    this.evidence.set(name, recordCommanded(previous, rawValue, now, this.provenance));
    await this.device.write(name, rawValue);
    this.evidence.set(
      name,
      recordAcknowledged(this.evidence.get(name) ?? previous, rawValue, now, this.provenance),
    );
    this.values[name] = rawValue;
    this.emit('modbus.changed', { name, value: rawValue });
    return { name, value: rawValue };
  }

  private assertKnownEntry(name: string): void {
    if (!this.map.some((entry) => entry.name === name)) {
      throw new DeviceError('UNKNOWN_ACTION', `Register map has no entry '${name}'.`);
    }
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener(event, payload);
    }
  }
}

export function createRegisterMapBackend(
  options: RegisterMapBackendOptions,
): Promise<RegisterMapDeviceBackend> {
  return RegisterMapDeviceBackend.create(options);
}

function requireName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DeviceError('VALIDATION_ERROR', 'Register map invoke requires a string "name".');
  }
  return value;
}
