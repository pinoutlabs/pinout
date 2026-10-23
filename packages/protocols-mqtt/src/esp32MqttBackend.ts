/**
 * Host-side DeviceBackend for the ESP32 Wi-Fi/MQTT bridge.
 *
 * Simulated mode owns an in-process broker plus {@link Esp32MqttDeviceSimulator}
 * (firmware stand-in). Protocol mode requires a connected {@link MqttClient}
 * pointed at a LAN broker — physical boards are never auto-flashed.
 *
 * Evidence status: SIMULATED for the in-process path. Firmware source is
 * COMPILE_TESTED only after a PlatformIO build; never HARDWARE_VERIFIED here.
 */
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
import { createEsp32MqttMapping, defaultEsp32MqttDeviceId } from './esp32MqttMapping.js';
import { Esp32MqttDeviceSimulator } from './esp32MqttDeviceSimulator.js';
import {
  decodeIngestion,
  encodePublishPayload,
  esp32MqttTopicPrefix,
  topicMatches,
  type MqttMapping,
  type PublishRule,
} from './mapping.js';
import { MqttClient } from './mqttClient.js';

export interface Esp32MqttBackendOptions {
  deviceId?: string;
  mapping?: MqttMapping;
  client?: MqttClient;
  simulated?: boolean;
  broker?: MqttBrokerSimulator;
  clientId?: string;
  provenance?: EvidenceProvenance;
  /** Demo/tests only: device simulator starts armed. Default false. */
  autoArm?: boolean;
  /** Max wait for gpio/armed echoes from the device peer. */
  readTimeoutMs?: number;
}

export class Esp32MqttBackend implements DeviceBackend {
  readonly kind: 'simulated' | 'protocol';
  readonly deviceId: string;
  private readonly mapping: MqttMapping;
  private readonly provenance: EvidenceProvenance;
  private readonly publishByCapability: Map<string, PublishRule>;
  private readonly listeners = new Set<(event: string, payload: Record<string, unknown>) => void>();
  /** Boot contract matches firmware: disarmed until sys.arm. */
  private readonly ingestFields: Record<string, unknown> = { armed: 'disarmed' };
  private readonly gpioLevels: Record<string, number> = {};
  private readonly commandedByCapability: Record<string, Record<string, unknown>> = {};
  private readonly fieldEvidence = new Map<string, EvidenceState<unknown>>();
  private readonly readTimeoutMs: number;
  private readonly ready: Promise<void>;
  private ownedBroker: MqttBrokerSimulator | undefined;
  private ownedDevice: Esp32MqttDeviceSimulator | undefined;
  private readonly externalBroker: MqttBrokerSimulator | undefined;
  private client: MqttClient | undefined;
  private closed = false;

  private constructor(options: {
    mapping: MqttMapping;
    deviceId: string;
    kind: 'simulated' | 'protocol';
    provenance?: EvidenceProvenance;
    client?: MqttClient;
    broker?: MqttBrokerSimulator;
    ownedBroker?: MqttBrokerSimulator;
    ownedDevice?: Esp32MqttDeviceSimulator;
    clientId?: string;
    readTimeoutMs?: number;
  }) {
    this.mapping = options.mapping;
    this.deviceId = options.deviceId;
    this.kind = options.kind;
    this.provenance =
      options.provenance ?? (options.kind === 'simulated' ? 'simulated' : 'hardware');
    this.publishByCapability = new Map(
      options.mapping.publishes.map((rule) => [rule.capability, rule]),
    );
    this.client = options.client;
    this.ownedBroker = options.ownedBroker;
    this.ownedDevice = options.ownedDevice;
    this.externalBroker = options.broker;
    this.readTimeoutMs = options.readTimeoutMs ?? 500;
    this.ready = this.start(options.clientId ?? `pinout-esp32-mqtt-${this.deviceId}`);
  }

  /**
   * Sync factory for tests that already have a client. Prefer {@link create}
   * when the in-process device simulator should be started automatically.
   */
  static createSimulated(
    options: Partial<Esp32MqttBackendOptions> & { client: MqttClient },
  ): Esp32MqttBackend {
    const deviceId = options.deviceId ?? defaultEsp32MqttDeviceId;
    const mapping = options.mapping ?? createEsp32MqttMapping({ deviceId });
    return new Esp32MqttBackend({
      mapping,
      deviceId,
      kind: 'simulated',
      provenance: options.provenance ?? 'simulated',
      client: options.client,
      ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
      ...(options.readTimeoutMs !== undefined ? { readTimeoutMs: options.readTimeoutMs } : {}),
    });
  }

  static async create(options: Esp32MqttBackendOptions = {}): Promise<Esp32MqttBackend> {
    const deviceId = options.deviceId ?? defaultEsp32MqttDeviceId;
    const mapping = options.mapping ?? createEsp32MqttMapping({ deviceId });

    if (options.client) {
      const backend = new Esp32MqttBackend({
        mapping,
        deviceId,
        kind: options.simulated === true ? 'simulated' : 'protocol',
        client: options.client,
        ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
        ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
        ...(options.readTimeoutMs !== undefined ? { readTimeoutMs: options.readTimeoutMs } : {}),
      });
      await backend.ensureReady();
      return backend;
    }

    if (options.simulated === false) {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        'ESP32 MQTT protocol backend requires a connected MqttClient to a LAN broker.',
      );
    }

    const broker = options.broker ?? new MqttBrokerSimulator();
    const ownedBroker = options.broker ? undefined : broker;
    await broker.start();

    // Host subscribes first so it does not miss the device simulator's boot state.
    const backend = new Esp32MqttBackend({
      mapping,
      deviceId,
      kind: 'simulated',
      provenance: options.provenance ?? 'simulated',
      broker,
      ...(ownedBroker ? { ownedBroker } : {}),
      ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
      ...(options.readTimeoutMs !== undefined ? { readTimeoutMs: options.readTimeoutMs } : {}),
    });
    await backend.ensureReady();

    const deviceSim = await Esp32MqttDeviceSimulator.create({
      broker,
      deviceId,
      ...(options.autoArm !== undefined ? { autoArm: options.autoArm } : {}),
    });
    backend.attachDevice(deviceSim);
    return backend;
  }

  private attachDevice(device: Esp32MqttDeviceSimulator): void {
    this.ownedDevice = device;
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
    await this.ownedDevice?.close().catch(() => undefined);
    await this.ownedBroker?.stop().catch(() => undefined);
  }

  getOperationalState(): Record<string, unknown> {
    return {
      ...this.ingestFields,
      gpio: { ...this.gpioLevels },
      deviceId: this.deviceId,
      topicPrefix: esp32MqttTopicPrefix(this.deviceId),
      evidenceStatus: this.kind === 'simulated' ? 'SIMULATED' : 'IMPLEMENTED',
      commanded: this.commandedByCapability,
    };
  }

  getOperationalStateEvidence(): Record<string, EvidenceState<unknown>> {
    return Object.fromEntries(this.fieldEvidence.entries());
  }

  async invoke(
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new DeviceError('DISCONNECTED', 'ESP32 MQTT backend is closed.');
    }
    await this.ensureReady();
    const client = this.client;
    if (!client) {
      throw new DeviceError('DISCONNECTED', 'MQTT client is not connected.');
    }

    if (action === 'mqtt.status' || action === 'sys.info') {
      return this.getOperationalState();
    }

    const rule = this.publishByCapability.get(action);
    if (!rule) {
      throw new DeviceError(
        'UNKNOWN_ACTION',
        `Unknown action '${action}'. Writes require an explicit publish mapping.`,
      );
    }

    if (action === 'gpio.write' || action === 'gpio.toggle') {
      if (this.ingestFields.armed !== 'armed') {
        throw new DeviceError(
          'NOT_ARMED',
          'Device is disarmed; call sys.arm before GPIO actuation.',
        );
      }
    }

    if (action === 'gpio.read') {
      return this.invokeGpioRead(client, rule, payload);
    }

    const encoded = encodePublishPayload(rule, payload);
    const now = new Date();
    const evidenceKey = action;
    const previous = this.fieldEvidence.get(evidenceKey) ?? unknownEvidence(this.provenance);
    this.fieldEvidence.set(
      evidenceKey,
      recordCommanded(previous, payload.value ?? encoded, now, this.provenance),
    );

    const pin =
      typeof payload.pin === 'number' && (action === 'gpio.write' || action === 'gpio.toggle')
        ? payload.pin
        : undefined;
    const gpioWaiter =
      pin !== undefined ? this.waitForGpioOrError(pin, this.readTimeoutMs) : undefined;
    const armedWaiter =
      action === 'sys.arm' || action === 'sys.disarm'
        ? this.waitForArmed(action === 'sys.arm' ? 'armed' : 'disarmed', this.readTimeoutMs)
        : undefined;

    await client.publish(rule.topic, encoded, rule.qos ?? 0);
    this.commandedByCapability[action] = { ...payload };

    if (gpioWaiter) {
      const outcome = await gpioWaiter;
      if (outcome.kind === 'error') {
        throw new DeviceError(outcome.code, outcome.message);
      }
    }
    if (armedWaiter) {
      await armedWaiter;
    }

    const acknowledged = this.fieldEvidence.get(evidenceKey) ?? previous;
    this.fieldEvidence.set(
      evidenceKey,
      recordAcknowledged(acknowledged, payload.value ?? encoded, now, this.provenance),
    );
    this.emit('mqtt.published', { capability: action, topic: rule.topic, payload: encoded });
    return { topic: rule.topic, payload: encoded, ...payload, ...this.sliceGpioState(payload) };
  }

  private async invokeGpioRead(
    client: MqttClient,
    rule: PublishRule,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const pin = payload.pin;
    if (typeof pin !== 'number') {
      throw new DeviceError('INVALID_ARGUMENT', 'gpio.read requires numeric pin.');
    }
    const encoded = encodePublishPayload(rule, payload);
    const gpioWaiter = this.waitForGpioOrError(pin, this.readTimeoutMs);
    await client.publish(rule.topic, encoded, rule.qos ?? 0);
    const outcome = await gpioWaiter;
    if (outcome.kind === 'error') {
      throw new DeviceError(outcome.code, outcome.message);
    }
    if (outcome.kind === 'timeout') {
      throw new DeviceError('TIMEOUT', `No gpio state received for pin ${pin}.`);
    }
    return { pin, value: outcome.value === 1, level: outcome.value };
  }

  private sliceGpioState(payload: Record<string, unknown>): Record<string, unknown> {
    if (typeof payload.pin !== 'number') return {};
    const level = this.gpioLevels[String(payload.pin)];
    if (level === undefined) return {};
    return { level, value: level === 1 };
  }

  private async start(clientId: string): Promise<void> {
    if (!this.client) {
      const broker = this.ownedBroker ?? this.externalBroker;
      if (!broker) {
        throw new DeviceError(
          'UNSUPPORTED_CONFIGURATION',
          'ESP32 MQTT backend requires a connected client or a simulated broker.',
        );
      }
      await broker.start();
      this.client = new MqttClient({
        transport: tcpTransport({ host: '127.0.0.1', port: broker.port }),
        clientId,
        timeoutMs: 3000,
        keepAliveSeconds: 0,
      });
    }
    const client = this.client;
    if (!client) {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        'ESP32 MQTT backend requires a connected client or a simulated broker.',
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
      } else if (rule.as.event === 'gpio.state') {
        const pin = pinFromGpioStateTopic(topic);
        if (pin !== undefined && typeof mapped.value === 'number') {
          this.gpioLevels[String(pin)] = mapped.value;
          const key = `gpio.${pin}`;
          const previous = this.fieldEvidence.get(key) ?? unknownEvidence(this.provenance);
          this.fieldEvidence.set(
            key,
            recordObserved(
              previous,
              mapped.value,
              this.kind === 'simulated' ? 'simulated' : 'sensor',
              new Date(),
              this.provenance,
            ),
          );
          this.emit('gpio.state', { topic, pin, value: mapped.value });
        }
      } else {
        this.emit(rule.as.event, { topic, value: mapped.value });
      }
    }
  }

  private waitForGpioOrError(
    pin: number,
    timeoutMs: number,
  ): Promise<
    | { kind: 'gpio'; value: number }
    | { kind: 'error'; code: string; message: string }
    | { kind: 'timeout' }
  > {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (
        result:
          | { kind: 'gpio'; value: number }
          | { kind: 'error'; code: string; message: string }
          | { kind: 'timeout' },
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onEvent = (event: string, payload: Record<string, unknown>) => {
        if (event === 'gpio.state' && payload.pin === pin && typeof payload.value === 'number') {
          finish({ kind: 'gpio', value: payload.value });
          return;
        }
        if (event === 'mqtt.error') {
          const value = payload.value;
          if (value !== null && typeof value === 'object') {
            const record = value as Record<string, unknown>;
            finish({
              kind: 'error',
              code: typeof record.code === 'string' ? record.code : 'DEVICE_ERROR',
              message:
                typeof record.message === 'string'
                  ? record.message
                  : 'ESP32 MQTT device reported an error.',
            });
          }
        }
      };
      const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(onEvent);
      };
      this.listeners.add(onEvent);
    });
  }

  private waitForArmed(expected: string, timeoutMs: number): Promise<void> {
    if (this.ingestFields.armed === expected) return Promise.resolve();
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const timer = setInterval(() => {
        if (this.ingestFields.armed === expected || Date.now() >= deadline) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
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

function pinFromGpioStateTopic(topic: string): number | undefined {
  const parts = topic.split('/');
  const pinText = parts[parts.length - 1];
  if (pinText === undefined) return undefined;
  const pin = Number(pinText);
  return Number.isInteger(pin) ? pin : undefined;
}

export function createEsp32MqttBackend(
  options: Esp32MqttBackendOptions = {},
): Promise<Esp32MqttBackend> {
  return Esp32MqttBackend.create(options);
}
