import {
  DeviceError,
  recordAcknowledged,
  recordCommanded,
  recordObserved,
  tcpTransport,
  unknownEvidence,
  type DeviceBackend,
  type EvidenceProvenance,
  type EvidenceState,
} from '@pinout/core';
import { MqttBrokerSimulator } from './brokerSimulator.js';
import {
  decodeIngestion,
  encodePublishPayload,
  topicMatches,
  type MqttMapping,
  type PublishRule,
} from './mapping.js';
import { MqttClient } from './mqttClient.js';

export interface MqttBackendOptions {
  mapping: MqttMapping;
  client?: MqttClient;
  simulated?: boolean;
  broker?: MqttBrokerSimulator;
  clientId?: string;
  provenance?: EvidenceProvenance;
}

/**
 * Runtime {@link DeviceBackend} over an MQTT mapping.
 *
 * Each {@link PublishRule} becomes an invoke capability named `rule.capability`.
 * Writes require that explicit publish mapping — topics without a publish entry
 * never become capabilities. Ingest rules update operational state and emit events.
 */
export class MqttBackend implements DeviceBackend {
  readonly kind: 'simulated' | 'protocol';
  private readonly mapping: MqttMapping;
  private readonly provenance: EvidenceProvenance;
  private readonly publishByCapability: Map<string, PublishRule>;
  private readonly listeners = new Set<(event: string, payload: Record<string, unknown>) => void>();
  private readonly ingestFields: Record<string, unknown> = {};
  private readonly commandedByCapability: Record<string, Record<string, unknown>> = {};
  private readonly fieldEvidence = new Map<string, EvidenceState<unknown>>();
  private readonly ready: Promise<void>;
  private readonly ownedBroker: MqttBrokerSimulator | undefined;
  private readonly broker: MqttBrokerSimulator | undefined;
  private client: MqttClient | undefined;
  private closed = false;

  constructor(options: {
    mapping: MqttMapping;
    kind: 'simulated' | 'protocol';
    provenance?: EvidenceProvenance;
    client?: MqttClient;
    broker?: MqttBrokerSimulator;
    ownedBroker?: MqttBrokerSimulator;
    clientId?: string;
  }) {
    this.mapping = options.mapping;
    this.kind = options.kind;
    this.provenance =
      options.provenance ?? (options.kind === 'simulated' ? 'simulated' : 'hardware');
    this.publishByCapability = new Map(
      options.mapping.publishes.map((rule) => [rule.capability, rule]),
    );
    this.client = options.client;
    this.ownedBroker = options.ownedBroker;
    this.broker = options.ownedBroker ?? options.broker;
    this.ready = this.start(options.clientId ?? `pinout-mqtt-${String(Date.now())}`);
  }

  static createSimulated(
    options: Partial<MqttBackendOptions> & { mapping?: MqttMapping } = {},
  ): MqttBackend {
    const mapping = options.mapping ?? defaultMqttBridgeMapping;
    if (options.client) {
      return new MqttBackend({
        mapping,
        kind: 'simulated',
        provenance: options.provenance ?? 'simulated',
        client: options.client,
        ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
      });
    }
    const broker = options.broker ?? new MqttBrokerSimulator();
    return new MqttBackend({
      mapping,
      kind: 'simulated',
      provenance: options.provenance ?? 'simulated',
      broker,
      ...(options.broker ? {} : { ownedBroker: broker }),
      ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
    });
  }

  static async create(options: MqttBackendOptions): Promise<MqttBackend> {
    if (options.client) {
      const backend = new MqttBackend({
        mapping: options.mapping,
        kind: options.simulated === true ? 'simulated' : 'protocol',
        client: options.client,
        ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
        ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
      });
      await backend.ensureReady();
      return backend;
    }
    if (options.simulated === false) {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        'MQTT protocol backend requires a connected client.',
      );
    }
    const backend = MqttBackend.createSimulated(options);
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
      // connect failed
    }
    await this.client?.close().catch(() => undefined);
    await this.ownedBroker?.stop().catch(() => undefined);
  }

  getOperationalState(): Record<string, unknown> {
    const state: Record<string, unknown> = {
      ...this.ingestFields,
      commanded: this.commandedByCapability,
    };
    if (state.value === undefined) {
      for (const payload of Object.values(this.commandedByCapability)) {
        if (payload.value !== undefined) {
          state.value = payload.value;
          break;
        }
      }
    }
    return state;
  }

  getOperationalStateEvidence(): Record<string, EvidenceState<unknown>> {
    return Object.fromEntries(this.fieldEvidence.entries());
  }

  async invoke(
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new DeviceError('DISCONNECTED', 'MQTT backend is closed.');
    }
    await this.ensureReady();
    const client = this.client;
    if (!client) {
      throw new DeviceError('DISCONNECTED', 'MQTT client is not connected.');
    }

    if (action === 'mqtt.status') {
      return this.getOperationalState();
    }

    const rule = this.publishByCapability.get(action);
    if (!rule) {
      throw new DeviceError(
        'UNKNOWN_ACTION',
        `Unknown action '${action}'. Writes require an explicit publish mapping.`,
      );
    }

    const encoded = encodePublishPayload(rule, payload);
    const now = new Date();
    const evidenceKey = action;
    const previous = this.fieldEvidence.get(evidenceKey) ?? unknownEvidence(this.provenance);
    this.fieldEvidence.set(
      evidenceKey,
      recordCommanded(previous, payload.value ?? encoded, now, this.provenance),
    );
    await client.publish(rule.topic, encoded, rule.qos ?? 0);
    this.commandedByCapability[action] = { ...payload };
    const acknowledged = this.fieldEvidence.get(evidenceKey) ?? previous;
    this.fieldEvidence.set(
      evidenceKey,
      recordAcknowledged(acknowledged, payload.value ?? encoded, now, this.provenance),
    );
    this.emit('mqtt.published', { capability: action, topic: rule.topic, payload: encoded });
    return { topic: rule.topic, payload: encoded, ...payload };
  }

  private async start(clientId: string): Promise<void> {
    if (!this.client) {
      if (!this.broker) {
        throw new DeviceError(
          'UNSUPPORTED_CONFIGURATION',
          'MQTT backend requires a connected client or a simulated broker.',
        );
      }
      await this.broker.start();
      this.client = new MqttClient({
        transport: tcpTransport({ host: '127.0.0.1', port: this.broker.port }),
        clientId,
        timeoutMs: 3000,
        keepAliveSeconds: 0,
      });
    }
    const client = this.client;
    if (!client) {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        'MQTT backend requires a connected client or a simulated broker.',
      );
    }
    await client.connect();
    await this.subscribeIngests(client);
  }

  private async subscribeIngests(client: MqttClient): Promise<void> {
    const filters = [...new Set(this.mapping.ingests.map((rule) => rule.topic))];
    for (const filter of filters) {
      await client.subscribe(filter, (topic, body) => {
        this.applyIngestion(topic, body);
      });
    }
  }

  private applyIngestion(topic: string, body: Buffer): void {
    for (const rule of this.mapping.ingests) {
      if (!topicMatches(rule.topic, topic)) continue;
      const mapped = decodeIngestion(rule, body);
      if (rule.as.kind === 'state') {
        this.ingestFields[rule.as.field] = mapped.value;
        const previous = this.fieldEvidence.get(rule.as.field) ?? unknownEvidence(this.provenance);
        this.fieldEvidence.set(
          rule.as.field,
          recordObserved(
            previous,
            mapped.value,
            this.kind === 'simulated' ? 'simulated' : 'sensor',
            new Date(),
            this.provenance,
          ),
        );
      } else {
        this.emit(rule.as.event, { topic, value: mapped.value });
      }
    }
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener(event, payload);
    }
  }
}

export const defaultMqttBridgeMapping: MqttMapping = {
  ingests: [
    {
      topic: 'pinout/cmd/value',
      as: { kind: 'state', field: 'value' },
      codec: 'text',
    },
  ],
  publishes: [
    {
      capability: 'mqtt.setValue',
      topic: 'pinout/cmd/value',
      payload: '{value}',
    },
  ],
};

export function createMqttBackend(options: MqttBackendOptions): Promise<MqttBackend> {
  return MqttBackend.create(options);
}
