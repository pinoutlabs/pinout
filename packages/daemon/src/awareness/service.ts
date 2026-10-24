/**
 * AwarenessService — daemon-side orchestration of registry + discovery + graph.
 *
 * Honesty rules:
 * - evidenceLevel defaults to SIMULATED unless a dated hardware record exists
 * - never auto-flash
 * - never auto-enroll (PENDING_ENROLL requires POST /v1/awareness/:id/enroll)
 * - discovery remains read-only
 */
import {
  addDeviceDefinition,
  DeviceGraph,
  PinoutError,
  readDevicesFile,
  resolvePinoutHome,
  ValidationError,
  type DeviceDefinition,
  type Journal,
  type SupportLevel,
  type SupportStatus,
} from '@pinout/core';
import {
  AwarenessRegistry,
  loadMockDevices,
  mockDiscoveryPlugin,
  supportLevelToSupportStatus,
  type AwarenessEvent,
  type AwarenessRecord,
  type AwarenessStalenessConfig,
} from '@pinout/awareness';
import type { DiscoveredCandidate, DiscoveryPlugin } from '@pinout/discovery';
import {
  AwarenessDiscoveryScheduler,
  type AwarenessSchedulerOptions,
  type TransportIntervalConfig,
} from './scheduler.js';

export interface AwarenessServiceOptions {
  home?: string;
  awarenessPath?: string;
  journal?: Journal;
  staleness?: AwarenessStalenessConfig;
  intervals?: Partial<TransportIntervalConfig>;
  network?: AwarenessSchedulerOptions['network'];
  mockDevices?: string;
  listSerialPorts?: AwarenessSchedulerOptions['listSerialPorts'];
  blePlugin?: DiscoveryPlugin;
  log?: (message: string) => void;
  /**
   * Optional lookup for SupportLevel. Default: SIMULATED (honest until an
   * operator-backed dated hardware/records entry is supplied via
   * `hardwareRecordDate` / resolveEvidenceLevel).
   */
  resolveEvidenceLevel?: (record: AwarenessRecord) => SupportLevel;
  hardwareRecordDate?: string | null;
  now?: () => number;
}

export class AwarenessService {
  readonly registry: AwarenessRegistry;
  readonly graph: DeviceGraph;
  private scheduler: AwarenessDiscoveryScheduler | undefined;
  private staleTimer: ReturnType<typeof setInterval> | undefined;
  private readonly home: string;
  private readonly mockPlugin: DiscoveryPlugin | undefined;
  private journal: Journal | undefined;

  constructor(private readonly options: AwarenessServiceOptions = {}) {
    this.home = resolvePinoutHome(options.home);
    this.journal = options.journal;
    this.graph = new DeviceGraph();
    this.registry = new AwarenessRegistry({
      home: this.home,
      ...(options.awarenessPath ? { path: options.awarenessPath } : {}),
      ...(options.staleness ? { staleness: options.staleness } : {}),
      ...(options.now ? { now: options.now } : {}),
      enrolledIds: () => this.readEnrolledIds(),
      resolveEvidenceLevel: options.resolveEvidenceLevel ?? (() => 'SIMULATED'),
      ...(options.hardwareRecordDate !== undefined
        ? { hardwareRecordDate: options.hardwareRecordDate }
        : {}),
      onEvent: (event) => this.journalEvent(event),
    });
    this.registry.subscribe((event) => this.syncGraph(event.record));

    if (options.mockDevices) {
      const specs = loadMockDevices(options.mockDevices);
      this.mockPlugin = mockDiscoveryPlugin(specs);
      this.options.log?.(
        `awareness: loaded ${specs.length} mock device(s) from '${options.mockDevices}' (SIMULATED)`,
      );
    }
  }

  /** Attach the daemon journal after DaemonContext construction. */
  attachJournal(journal: Journal): void {
    this.journal = journal;
  }

  subscribe(handler: (event: AwarenessEvent) => void): () => void {
    return this.registry.subscribe(handler);
  }

  list(): AwarenessRecord[] {
    return this.registry.list();
  }

  get(id: string): AwarenessRecord | undefined {
    return this.registry.get(id);
  }

  async start(): Promise<void> {
    this.registry.load();
    for (const record of this.registry.list()) {
      this.syncGraph(record);
    }

    this.scheduler = new AwarenessDiscoveryScheduler({
      ...(this.options.intervals ? { intervals: this.options.intervals } : {}),
      ...(this.options.network ? { network: this.options.network } : {}),
      ...(this.options.listSerialPorts
        ? { listSerialPorts: this.options.listSerialPorts }
        : {}),
      ...(this.options.blePlugin ? { blePlugin: this.options.blePlugin } : {}),
      // Mock-only mode skips live transports so demos/tests need no radio/USB
      // and do not wait on mDNS timeouts.
      ...(this.mockPlugin
        ? { extraPlugins: [this.mockPlugin], mockOnly: true }
        : {}),
      ...(this.options.log ? { log: this.options.log } : {}),
      onCandidates: (candidates) => {
        this.ingest(candidates, Boolean(this.mockPlugin));
      },
      onError: (plugin, message) => {
        this.options.log?.(`awareness/${plugin}: ${message}`);
      },
    });
    this.scheduler.start();
    // Immediate pass so API consumers see mock/demo devices without waiting.
    await this.scheduler.scanOnce();

    this.staleTimer = setInterval(() => {
      this.registry.tick();
    }, 5_000);
    // Unref so the timer does not keep the process alive alone in tests.
    this.staleTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = undefined;
    await this.scheduler?.stop();
    this.scheduler = undefined;
  }

  ingest(candidates: DiscoveredCandidate[], mock = false): AwarenessRecord[] {
    const out: AwarenessRecord[] = [];
    for (const candidate of candidates) {
      out.push(this.registry.observeCandidate(candidate, { mock }));
    }
    return out;
  }

  /**
   * Operator-approved enrollment. Writes ~/.pinout/devices.json via the
   * existing registration path. Never arms or actuates.
   */
  enroll(
    id: string,
    options: { moduleId?: string; deviceId?: string } = {},
  ): { record: AwarenessRecord; device: DeviceDefinition } {
    const current = this.registry.get(id);
    if (!current) {
      throw notFound(`Awareness device '${id}' not found.`);
    }
    if (current.state !== 'PENDING_ENROLL' && current.state !== 'IDENTIFIED') {
      throw validation(
        `Device '${id}' is in state ${current.state}; enroll requires PENDING_ENROLL.`,
      );
    }
    if (current.mock || current.evidenceLevel === 'SIMULATED') {
      // Still allow enrollment of simulated/mock devices into devices.json —
      // they remain simulated backends. Never claim hardware.
    }

    const moduleId =
      options.moduleId ??
      current.moduleId ??
      current.identity.guessedModuleId ??
      'pinout/esp32';
    if (moduleId.startsWith('unknown/')) {
      throw validation(
        `Device '${id}' has no matching module ('${moduleId}'). Cannot enroll UNKNOWN devices.`,
      );
    }

    const deviceId = options.deviceId ?? stableEnrollId(current);
    const definition = buildDeviceDefinition(current, deviceId, moduleId);
    addDeviceDefinition(definition, { home: this.home });
    const record = this.registry.markEnrolled(id, moduleId);
    this.syncGraph(record);
    this.journal?.append(
      'state.changed',
      { deviceId: record.id },
      {
        event: 'awareness.enrolled',
        moduleId,
        enrolledDeviceId: deviceId,
        evidenceLevel: record.evidenceLevel,
        mock: record.mock === true,
      },
    );
    return { record, device: definition };
  }

  private readEnrolledIds(): Set<string> {
    try {
      const file = readDevicesFile(undefined, this.home);
      return new Set(file.devices.map((d) => d.id));
    } catch {
      return new Set();
    }
  }

  private syncGraph(record: AwarenessRecord): void {
    const support: SupportStatus = supportLevelToSupportStatus(record.evidenceLevel);
    const connected =
      record.state === 'ONLINE' ||
      record.state === 'PENDING_ENROLL' ||
      record.state === 'IDENTIFIED' ||
      record.state === 'SEEN';
    this.graph.upsert({
      id: record.id,
      deviceClass: record.identity.deviceClass ?? 'unknown',
      moduleId: record.moduleId ?? record.identity.guessedModuleId ?? 'unknown/device',
      capabilities: record.capabilities ?? [],
      simulated: record.evidenceLevel !== 'HARDWARE_VERIFIED',
      ...(record.identity.vendor ? { vendor: record.identity.vendor } : {}),
      ...(record.identity.model ? { model: record.identity.model } : {}),
      ...(record.identity.advertisedName ? { label: record.identity.advertisedName } : {}),
      support,
      transport: {
        kind: record.transport,
        ...(record.identity.endpoint ? { endpoint: record.identity.endpoint } : {}),
      },
      tags: ['awareness', record.state.toLowerCase()],
    });
    this.graph.updateHealth(record.id, {
      status: connected ? 'CONNECTED' : 'DISCONNECTED',
      lifecycle: connected ? 'ready' : 'disconnected',
      lastUpdated: record.lastSeen,
      ...(record.health.message ? { message: record.health.message } : {}),
    });
  }

  private journalEvent(event: AwarenessEvent): void {
    this.journal?.append(
      'state.changed',
      { deviceId: event.record.id },
      {
        event: `awareness.${event.type}`,
        state: event.record.state,
        previousState: event.previousState,
        transport: event.record.transport,
        evidenceLevel: event.record.evidenceLevel,
        mock: event.record.mock === true,
      },
    );
  }
}

function stableEnrollId(record: AwarenessRecord): string {
  const base =
    record.moduleId?.replace(/^pinout\//, '') ??
    record.identity.guessedModuleId?.replace(/^pinout\//, '') ??
    'device';
  const suffix = record.id.replace(/^cand_/, '').slice(0, 10);
  return `${base}-${suffix}`;
}

function buildDeviceDefinition(
  record: AwarenessRecord,
  deviceId: string,
  moduleId: string,
): DeviceDefinition {
  const transportType =
    record.transport === 'serial'
      ? ('serial' as const)
      : record.transport === 'ble'
        ? ('simulated-ble-gatt' as const)
        : ('simulated-esp32' as const);

  const backend =
    record.transport === 'serial' && record.identity.endpoint
      ? {
          type: 'protocol' as const,
          transport: {
            type: 'serial' as const,
            path: record.identity.endpoint,
            baud: 115200,
          },
        }
      : {
          type: 'protocol' as const,
          transport: {
            type: transportType === 'serial' ? ('simulated-esp32' as const) : transportType,
          },
        };

  return {
    id: deviceId,
    module: moduleId,
    ...(record.identity.advertisedName ? { label: record.identity.advertisedName } : {}),
    backend,
    identity: {
      firmware: record.identity.firmware ?? 'unknown',
      version: record.identity.version ?? '0.0.0-awareness',
      protocol: 1,
      capabilities: record.capabilities ?? [],
      ...(record.identity.vid ? { vid: record.identity.vid } : {}),
      ...(record.identity.pid ? { pid: record.identity.pid } : {}),
    },
    enrolledAt: new Date().toISOString(),
  };
}

function notFound(message: string): Error {
  return new PinoutError('DEVICE_NOT_FOUND', message);
}

function validation(message: string): Error {
  return new ValidationError(message);
}
