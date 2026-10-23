/**
 * Commissioned MQTT lamp / smart-plug backend for local Wi-Fi homes.
 *
 * Maps semantic lamp capabilities (arm / disarm / on / off / set / status) onto
 * declarative Tasmota/Shelly-style MQTT topics via {@link buildMqttLampMapping}.
 * Verified against the in-process {@link MqttBrokerSimulator} only — not against
 * production Mosquitto/EMQX unless separately recorded.
 */
import {
  DeviceError,
  ValidationError,
  computeFreshness,
  recordAcknowledged,
  recordCommanded,
  recordObserved,
  tcpTransport,
  unknownEvidence,
  type EvidenceProvenance,
  type EvidenceSource,
  type EvidenceState,
  type DeviceBackend,
  type LampArmedState,
  type LampPolarity,
  type LampSafeLevel,
  type LampStatus,
  type LampBackendLike,
} from '@pinout/core';
import { MqttBrokerSimulator } from './brokerSimulator.js';
import {
  encodePublishPayload,
  topicMatches,
  type MqttMapping,
  type PublishRule,
} from './mapping.js';
import { MqttClient } from './mqttClient.js';
import {
  buildMqttLampMapping,
  parseMqttLampPayload,
  resolveMqttLampTopics,
  type MqttLampPreset,
  type MqttLampTopicTemplates,
  type ResolvedMqttLampTopics,
} from './lampTopics.js';

export interface BackendInvocationContext {
  signal?: AbortSignal;
  reportProgress?: (fraction: number | null, message?: string) => void;
}

export interface MqttLampConfig extends Partial<MqttLampTopicTemplates> {
  polarity?: LampPolarity | undefined;
  safeLevel?: LampSafeLevel | undefined;
  /** When true, state-topic ingest populates observed evidence. Default true. */
  enableStateReadback?: boolean | undefined;
  maxOnMs?: number | undefined;
  observationMaxAgeMs?: number | undefined;
  requireFreshObservation?: boolean | undefined;
  requireWatchdog?: boolean | undefined;
  watchdogTimeoutMs?: number | undefined;
  autoArm?: boolean | undefined;
  provenance?: EvidenceProvenance | undefined;
  simulated?: boolean | undefined;
  client?: MqttClient | undefined;
  broker?: MqttBrokerSimulator | undefined;
  clientId?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  username?: string | undefined;
  password?: string | undefined;
  mapping?: MqttMapping | undefined;
}

export interface ValidatedMqttLampConfig {
  topics: ResolvedMqttLampTopics;
  mapping: MqttMapping;
  powerRule: PublishRule;
  polarity: LampPolarity;
  safeLevel: LampSafeLevel;
  enableStateReadback: boolean;
  maxOnMs?: number | undefined;
  observationMaxAgeMs: number;
  requireFreshObservation: boolean;
  requireWatchdog: boolean;
  watchdogTimeoutMs?: number | undefined;
  autoArm: boolean;
  provenance: EvidenceProvenance;
  simulated: boolean;
  client?: MqttClient | undefined;
  broker?: MqttBrokerSimulator | undefined;
  clientId: string;
  host: string;
  port: number;
  username?: string | undefined;
  password?: string | undefined;
}

export function validateMqttLampConfig(
  rawConfig: Record<string, unknown> = {},
  allowEmptyDefaults = true,
): ValidatedMqttLampConfig {
  const isEssentiallyEmpty =
    Object.keys(rawConfig).length === 0 ||
    (Object.keys(rawConfig).length === 1 && rawConfig.simulated !== undefined);

  if (isEssentiallyEmpty && allowEmptyDefaults) {
    const topics = resolveMqttLampTopics({ deviceId: 'lamp1', preset: 'tasmota' });
    const mapping = buildMqttLampMapping(topics);
    const powerRule = mapping.publishes.find((rule) => rule.capability === 'lamp.power');
    if (!powerRule) {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        'MQTT lamp mapping is missing the lamp.power publish rule.',
      );
    }
    return {
      topics,
      mapping,
      powerRule,
      polarity: 'active-high',
      safeLevel: 'low',
      enableStateReadback: true,
      observationMaxAgeMs: 5000,
      requireFreshObservation: false,
      requireWatchdog: true,
      autoArm: false,
      provenance: 'simulated',
      simulated: true,
      clientId: 'pinout-mqtt-lamp',
      host: '127.0.0.1',
      port: 1883,
    };
  }

  let topics: ResolvedMqttLampTopics;
  try {
    topics = resolveMqttLampTopics(rawConfig as Partial<MqttLampTopicTemplates>);
  } catch (error) {
    throw new DeviceError(
      'UNSUPPORTED_CONFIGURATION',
      error instanceof Error ? error.message : String(error),
    );
  }

  if (rawConfig.polarity !== 'active-high' && rawConfig.polarity !== 'active-low') {
    throw new DeviceError(
      'UNSUPPORTED_CONFIGURATION',
      'Lamp configuration requires "polarity" set to "active-high" or "active-low".',
    );
  }
  const polarity = rawConfig.polarity as LampPolarity;

  let safeLevel: LampSafeLevel;
  if (rawConfig.safeLevel === undefined) {
    safeLevel = polarity === 'active-low' ? 'high' : 'low';
  } else {
    const rawSafeLevel = rawConfig.safeLevel as string;
    if (
      rawSafeLevel !== 'low' &&
      rawSafeLevel !== 'high' &&
      rawSafeLevel !== 'high-z' &&
      rawSafeLevel !== 'hold'
    ) {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        `Unsupported safeLevel '${rawSafeLevel}'. Must be 'low', 'high', 'high-z', or 'hold'.`,
      );
    }
    safeLevel = rawSafeLevel as LampSafeLevel;

    if (polarity === 'active-high' && safeLevel === 'high') {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        'Active-high lamp configuration cannot specify safeLevel "high" because safe state would energize the lamp.',
      );
    }
    if (polarity === 'active-low' && safeLevel === 'low') {
      throw new DeviceError(
        'UNSUPPORTED_CONFIGURATION',
        'Active-low lamp configuration cannot specify safeLevel "low" because safe state would energize the lamp.',
      );
    }
  }

  let maxOnMs: number | undefined;
  if (rawConfig.maxOnMs !== undefined) {
    if (
      typeof rawConfig.maxOnMs !== 'number' ||
      rawConfig.maxOnMs <= 0 ||
      !Number.isFinite(rawConfig.maxOnMs)
    ) {
      throw new ValidationError('maxOnMs must be a positive finite number.');
    }
    maxOnMs = rawConfig.maxOnMs;
  }

  let observationMaxAgeMs = 5000;
  if (rawConfig.observationMaxAgeMs !== undefined) {
    if (
      typeof rawConfig.observationMaxAgeMs !== 'number' ||
      rawConfig.observationMaxAgeMs <= 0 ||
      !Number.isFinite(rawConfig.observationMaxAgeMs)
    ) {
      throw new ValidationError('observationMaxAgeMs must be a positive finite number.');
    }
    observationMaxAgeMs = rawConfig.observationMaxAgeMs;
  }

  const mapping =
    rawConfig.mapping && typeof rawConfig.mapping === 'object'
      ? (rawConfig.mapping as MqttMapping)
      : buildMqttLampMapping(topics);
  const powerRule = mapping.publishes.find((rule) => rule.capability === 'lamp.power');
  if (!powerRule) {
    throw new DeviceError(
      'UNSUPPORTED_CONFIGURATION',
      'MQTT lamp mapping must include a publish rule with capability "lamp.power".',
    );
  }

  const simulated = rawConfig.simulated !== false;
  const provenance: EvidenceProvenance =
    rawConfig.provenance === 'hardware'
      ? 'hardware'
      : ((rawConfig.provenance as EvidenceProvenance | undefined) ?? 'simulated');

  return {
    topics,
    mapping,
    powerRule,
    polarity,
    safeLevel,
    enableStateReadback: rawConfig.enableStateReadback !== false,
    maxOnMs,
    observationMaxAgeMs,
    requireFreshObservation: rawConfig.requireFreshObservation === true,
    requireWatchdog: rawConfig.requireWatchdog !== false,
    watchdogTimeoutMs:
      typeof rawConfig.watchdogTimeoutMs === 'number' ? rawConfig.watchdogTimeoutMs : undefined,
    autoArm: rawConfig.autoArm === true,
    provenance,
    simulated,
    client: rawConfig.client as MqttClient | undefined,
    broker: rawConfig.broker as MqttBrokerSimulator | undefined,
    clientId:
      typeof rawConfig.clientId === 'string' && rawConfig.clientId.length > 0
        ? rawConfig.clientId
        : `pinout-mqtt-lamp-${topics.deviceId}`,
    host: typeof rawConfig.host === 'string' ? rawConfig.host : '127.0.0.1',
    port: typeof rawConfig.port === 'number' ? rawConfig.port : 1883,
    username: typeof rawConfig.username === 'string' ? rawConfig.username : undefined,
    password: typeof rawConfig.password === 'string' ? rawConfig.password : undefined,
  };
}

export class MqttLampBackend implements DeviceBackend, LampBackendLike {
  readonly kind: 'simulated' | 'protocol';
  private client: MqttClient | undefined;
  private readonly ownedBroker: MqttBrokerSimulator | undefined;
  private readonly broker: MqttBrokerSimulator | undefined;
  private readonly config: ValidatedMqttLampConfig;
  private armedState: LampArmedState = 'disarmed';
  private onEvidence: EvidenceState<boolean>;
  private armedEvidence: EvidenceState<LampArmedState>;
  private simulatedReadbackLevel: boolean | undefined = undefined;
  private maxOnTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(event: string, payload: Record<string, unknown>) => void>();
  private closed = false;
  private readonly ready: Promise<void>;

  constructor(options: {
    config: ValidatedMqttLampConfig;
    kind: 'simulated' | 'protocol';
    client?: MqttClient;
    broker?: MqttBrokerSimulator;
    ownedBroker?: MqttBrokerSimulator;
  }) {
    this.config = options.config;
    this.kind = options.kind;
    this.client = options.client;
    this.ownedBroker = options.ownedBroker;
    this.broker = options.ownedBroker ?? options.broker;
    this.onEvidence = unknownEvidence<boolean>(this.config.provenance);
    this.armedEvidence = unknownEvidence<LampArmedState>(this.config.provenance);

    if (this.config.autoArm) {
      this.armedState = 'armed';
      this.armedEvidence = recordAcknowledged(
        this.armedEvidence,
        'armed',
        null,
        this.config.provenance,
      );
    } else {
      this.armedState = 'disarmed';
      this.armedEvidence = recordAcknowledged(
        this.armedEvidence,
        'disarmed',
        null,
        this.config.provenance,
      );
    }

    this.ready = this.start();
  }

  /** Sync factory: owns an in-process broker; first invoke awaits connect. */
  static createSimulated(options: MqttLampConfig = {}): MqttLampBackend {
    const config = validateMqttLampConfig({ ...options, simulated: true } as Record<
      string,
      unknown
    >);
    if (options.client) {
      return new MqttLampBackend({
        config,
        kind: 'simulated',
        client: options.client,
        ...(options.broker ? { broker: options.broker } : {}),
      });
    }
    const broker = options.broker ?? new MqttBrokerSimulator();
    return new MqttLampBackend({
      config,
      kind: 'simulated',
      broker,
      ...(options.broker ? {} : { ownedBroker: broker }),
    });
  }

  static async create(options: MqttLampConfig = {}): Promise<MqttLampBackend> {
    const config = validateMqttLampConfig(options as Record<string, unknown>);

    if (config.client) {
      await config.client.connect().catch(() => undefined);
      const backend = new MqttLampBackend({
        config,
        kind: config.simulated ? 'simulated' : 'protocol',
        client: config.client,
        ...(config.broker ? { broker: config.broker } : {}),
      });
      await backend.ensureReady();
      return backend;
    }

    if (config.simulated || options.simulated !== false) {
      const backend = MqttLampBackend.createSimulated(options);
      await backend.ensureReady();
      return backend;
    }

    const client = new MqttClient({
      transport: tcpTransport({ host: config.host, port: config.port }),
      clientId: config.clientId,
      timeoutMs: 5000,
      keepAliveSeconds: 30,
      ...(config.username !== undefined ? { username: config.username } : {}),
      ...(config.password !== undefined ? { password: config.password } : {}),
    });
    await client.connect();
    const backend = new MqttLampBackend({
      config,
      kind: 'protocol',
      client,
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
    this.clearMaxOnTimer();
    this.listeners.clear();
    try {
      await this.ready;
    } catch {
      // connect/subscribe failed
    }
    await this.client?.close().catch(() => undefined);
    if (this.ownedBroker) {
      await this.ownedBroker.stop().catch(() => undefined);
    }
  }

  getOperationalState(): Record<string, unknown> {
    return this.buildStatus();
  }

  getOperationalStateEvidence(): Record<string, EvidenceState<unknown>> {
    const now = Date.now();
    const freshOn = computeFreshness(this.onEvidence, now, this.config.observationMaxAgeMs);
    const freshArmed = computeFreshness(this.armedEvidence, now);
    return {
      on: freshOn as EvidenceState<unknown>,
      armed: freshArmed as EvidenceState<unknown>,
    };
  }

  /** Resolved topic templates (command/state/payloads) for diagnostics and docs. */
  getTopicTemplates(): ResolvedMqttLampTopics {
    return this.config.topics;
  }

  getMapping(): MqttMapping {
    return this.config.mapping;
  }

  getPreset(): MqttLampPreset {
    return this.config.topics.preset;
  }

  async arm(
    options: { timeoutMs?: number; requireWatchdog?: boolean; ignoreWatchdog?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const enforceWatchdog = options.requireWatchdog ?? this.config.requireWatchdog;
    if (enforceWatchdog && !options.ignoreWatchdog) {
      throw new DeviceError(
        'WATCHDOG_NOT_SUPPORTED',
        'MQTT lamp/plug adapter does not provide a device-local hardware watchdog. Set requireWatchdog: false to explicitly acknowledge host-loss limitation on a home LAN broker.',
      );
    }

    const timeoutMs =
      typeof options.timeoutMs === 'number'
        ? options.timeoutMs
        : (this.config.watchdogTimeoutMs ?? 1000);
    this.armedState = 'armed';
    this.armedEvidence = recordAcknowledged(
      this.armedEvidence,
      'armed',
      null,
      this.config.provenance,
    );
    return { armed: 'armed', timeoutMs };
  }

  async disarm(): Promise<Record<string, unknown>> {
    this.clearMaxOnTimer();
    this.armedState = 'disarmed';
    this.armedEvidence = recordAcknowledged(
      this.armedEvidence,
      'disarmed',
      null,
      this.config.provenance,
    );

    await this.publishPower(false).catch(() => undefined);

    if (this.config.enableStateReadback) {
      this.applyObserved(false, new Date());
    }

    this.emit('safe_state.applied', {
      topic: this.config.topics.commandTopic,
      safeLevel: this.config.safeLevel,
    });
    return { armed: 'disarmed' };
  }

  async safeState(): Promise<Record<string, unknown>> {
    this.clearMaxOnTimer();
    this.armedState = 'disarmed';
    this.armedEvidence = recordAcknowledged(
      this.armedEvidence,
      'disarmed',
      null,
      this.config.provenance,
    );

    await this.publishPower(false).catch(() => undefined);

    this.emit('safe_state.applied', {
      topic: this.config.topics.commandTopic,
      safeLevel: this.config.safeLevel,
    });
    return {
      applied: true,
      topic: this.config.topics.commandTopic,
      safeLevel: this.config.safeLevel,
    };
  }

  injectTrip(reason = 'WATCHDOG_EXPIRED'): void {
    this.clearMaxOnTimer();
    this.armedState = 'tripped';
    this.armedEvidence = recordAcknowledged(
      this.armedEvidence,
      'tripped',
      null,
      this.config.provenance,
    );
    this.emit('device.tripped', { reason, stoppedTopics: [this.config.topics.commandTopic] });
  }

  setSimulatedReadbackLevel(level: boolean): void {
    this.simulatedReadbackLevel = level;
    if (this.broker) {
      const payload = level ? this.config.topics.onPayload : this.config.topics.offPayload;
      this.broker.publish(this.config.topics.stateTopic, payload, 0, true);
    }
    this.applyObserved(level, new Date());
  }

  async invoke(
    action: string,
    payload: Record<string, unknown> = {},
    _context: BackendInvocationContext = {},
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new DeviceError('DISCONNECTED', 'MQTT lamp backend is closed.');
    }
    await this.ensureReady();
    if (!this.client) {
      throw new DeviceError('DISCONNECTED', 'MQTT client is not connected.');
    }

    if (action === 'lamp.status' || action === 'status.read') {
      return this.readStatus();
    }

    if (action === 'lamp.arm') {
      const timeoutMs =
        typeof payload.timeoutMs === 'number'
          ? payload.timeoutMs
          : (this.config.watchdogTimeoutMs ?? 1000);
      const ignoreWatchdog = payload.requireWatchdog === false || !this.config.requireWatchdog;
      return this.arm({ timeoutMs, ignoreWatchdog });
    }

    if (action === 'lamp.disarm') {
      return this.disarm();
    }

    if (action === 'lamp.on' || action === 'lamp.off' || action === 'lamp.set') {
      let targetOn: boolean;
      if (action === 'lamp.on') {
        targetOn = true;
      } else if (action === 'lamp.off') {
        targetOn = false;
      } else {
        targetOn = Boolean(payload.on);
      }

      if (this.armedState === 'disarmed') {
        throw new DeviceError(
          'NOT_ARMED',
          'Device is disarmed. Explicit arming (lamp.arm) is required before actuation.',
        );
      }
      if (this.armedState === 'tripped') {
        throw new DeviceError(
          'WATCHDOG_TRIPPED',
          'Device watchdog tripped. Re-arming (lamp.arm) is required before actuation.',
        );
      }

      const now = new Date();
      this.onEvidence = recordCommanded(this.onEvidence, targetOn, now, this.config.provenance);

      await this.publishPower(targetOn);

      this.onEvidence = recordAcknowledged(this.onEvidence, targetOn, now, this.config.provenance);

      if (this.config.enableStateReadback) {
        this.echoSimulatedState(targetOn);
        if (this.simulatedReadbackLevel !== undefined) {
          this.applyObserved(this.simulatedReadbackLevel, now);
        } else if (this.broker) {
          // Simulated device echo: apply observed immediately (broker publish is for
          // other subscribers / retained state); do not wait on loopback delivery.
          this.applyObserved(targetOn, now);
        }
      }

      if (targetOn && this.config.maxOnMs) {
        this.startMaxOnTimer(this.config.maxOnMs);
      } else {
        this.clearMaxOnTimer();
      }

      this.emit('lamp.changed', { on: targetOn });
      return { on: targetOn };
    }

    throw new DeviceError('UNKNOWN_ACTION', `Unknown action '${action}'.`);
  }

  private async readStatus(): Promise<LampStatus> {
    if (this.config.enableStateReadback && this.simulatedReadbackLevel !== undefined) {
      this.applyObserved(this.simulatedReadbackLevel, new Date());
    }
    return this.buildStatus();
  }

  private buildStatus(): LampStatus {
    const now = Date.now();
    const freshOn = computeFreshness(this.onEvidence, now, this.config.observationMaxAgeMs);
    const freshArmed = computeFreshness(this.armedEvidence, now);

    const observedSource: EvidenceSource = this.config.enableStateReadback
      ? freshOn.observed.source
      : 'none';

    return {
      commanded: {
        value: freshOn.commanded.value,
        on: freshOn.commanded.value,
        at: freshOn.commanded.at,
        source: freshOn.commanded.source,
      },
      acknowledged: {
        value: freshOn.acknowledged.value,
        on: freshOn.acknowledged.value,
        at: freshOn.acknowledged.at,
        source: freshOn.acknowledged.source,
      },
      observed: {
        value: this.config.enableStateReadback ? freshOn.observed.value : null,
        on: this.config.enableStateReadback ? freshOn.observed.value : null,
        at: this.config.enableStateReadback ? freshOn.observed.at : null,
        source: this.config.enableStateReadback ? observedSource : 'none',
      },
      freshnessMs: this.config.enableStateReadback ? freshOn.freshnessMs : null,
      stale: this.config.enableStateReadback ? freshOn.stale : false,
      provenance: freshOn.provenance,
      armed: this.armedState,
      evidence: {
        on: freshOn,
        armed: freshArmed,
      },
      topics: {
        commandTopic: this.config.topics.commandTopic,
        stateTopic: this.config.topics.stateTopic,
        preset: this.config.topics.preset,
        deviceId: this.config.topics.deviceId,
      },
    };
  }

  private async publishPower(targetOn: boolean): Promise<void> {
    const client = this.client;
    if (!client) {
      throw new DeviceError('DISCONNECTED', 'MQTT client is not connected.');
    }
    const energized = this.config.polarity === 'active-low' ? !targetOn : targetOn;
    const value = energized ? this.config.topics.onPayload : this.config.topics.offPayload;
    const encoded = encodePublishPayload(this.config.powerRule, { value });
    await client.publish(
      this.config.powerRule.topic,
      encoded,
      this.config.powerRule.qos ?? this.config.topics.qos,
    );
  }

  /**
   * In simulated mode, echo command → state on the broker so state-topic
   * subscribers (including this backend) observe a device-like response.
   */
  private echoSimulatedState(targetOn: boolean): void {
    if (!this.broker || this.simulatedReadbackLevel !== undefined) return;
    // Echo logical POWER state (Tasmota-style): ON/OFF matches lamp.on intent,
    // independent of active-low command encoding on the command topic.
    const payload = targetOn ? this.config.topics.onPayload : this.config.topics.offPayload;
    this.broker.publish(this.config.topics.stateTopic, payload, 0, true);
  }

  private applyObserved(on: boolean, at: Date): void {
    this.onEvidence = recordObserved(
      this.onEvidence,
      on,
      this.config.provenance === 'hardware' ? 'sensor' : 'simulated',
      at,
      this.config.provenance,
      this.config.observationMaxAgeMs,
    );
  }

  private async start(): Promise<void> {
    if (!this.client) {
      if (!this.broker) {
        throw new DeviceError(
          'UNSUPPORTED_CONFIGURATION',
          'MQTT lamp backend requires a connected client or a simulated broker.',
        );
      }
      await this.broker.start();
      this.client = new MqttClient({
        transport: tcpTransport({ host: '127.0.0.1', port: this.broker.port }),
        clientId: this.config.clientId,
        timeoutMs: 3000,
        keepAliveSeconds: 0,
      });
    }
    const client = this.client;
    if (!client) {
      throw new DeviceError('DISCONNECTED', 'MQTT client is not connected.');
    }
    await client.connect();
    await this.subscribeStateTopic(client);
  }

  private async subscribeStateTopic(client: MqttClient): Promise<void> {
    if (!this.config.enableStateReadback) return;
    const stateTopic = this.config.topics.stateTopic;
    await client.subscribe(stateTopic, (topic, body) => {
      if (!topicMatches(stateTopic, topic)) return;
      const parsed = parseMqttLampPayload(
        body.toString('utf8'),
        this.config.topics.onPayload,
        this.config.topics.offPayload,
      );
      if (parsed === undefined) return;
      if (this.simulatedReadbackLevel !== undefined) {
        this.applyObserved(this.simulatedReadbackLevel, new Date());
        return;
      }
      this.applyObserved(parsed, new Date());
      this.emit('lamp.state', { topic, on: parsed });
    });
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  private startMaxOnTimer(maxOnMs: number): void {
    this.clearMaxOnTimer();
    this.maxOnTimer = setTimeout(async () => {
      try {
        await this.publishPower(false).catch(() => undefined);
        const now = new Date();
        this.onEvidence = recordCommanded(this.onEvidence, false, now, this.config.provenance);
        this.onEvidence = recordAcknowledged(this.onEvidence, false, now, this.config.provenance);
        if (this.config.enableStateReadback) {
          this.echoSimulatedState(false);
          this.applyObserved(false, now);
        }
        this.emit('lamp.changed', { on: false, reason: 'max_on_exceeded' });
      } catch {
        // silent safe handling
      }
    }, maxOnMs);
  }

  private clearMaxOnTimer(): void {
    if (this.maxOnTimer) {
      clearTimeout(this.maxOnTimer);
      this.maxOnTimer = undefined;
    }
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener(event, payload);
    }
  }
}

export function createMqttLampBackend(options: MqttLampConfig = {}): Promise<MqttLampBackend> {
  return MqttLampBackend.create(options);
}
