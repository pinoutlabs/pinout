import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  AwarenessClient,
  AwarenessEvent,
  AwarenessRecord,
  AwarenessState,
  AwarenessTransport,
} from '@pinout/awareness';
import { SUPPORT_LEVELS, type SupportLevel } from '@pinout/core';
import {
  awarenessConnectorGuidance,
  filterAwarenessRecords,
  generatedConnectorGuidance,
  honestyNote,
  isConnectorInstallEvent,
  isNewDeviceEventType,
  normalizeEvidenceLevel,
  normalizeGeneratedConnector,
  withNormalizedEvidence,
  type GeneratedConnectorRecord,
  type NearbyDevicesFilter,
} from './awarenessContracts.js';
import { success } from './createRuntimeServer.js';

export const nearbyDevicesToolName = 'pinout__nearby_devices';
export const awarenessEventsToolName = 'pinout__awareness_events';
export const describeNearbyToolName = 'pinout__describe_nearby';
export const requestEnrollToolName = 'pinout__request_enroll';
export const generateConnectorToolName = 'pinout__generate_connector';
export const connectorStatusToolName = 'pinout__connector_status';
export const listConnectorsToolName = 'pinout__list_connectors';

export const awarenessToolNames = new Set([
  nearbyDevicesToolName,
  awarenessEventsToolName,
  describeNearbyToolName,
  requestEnrollToolName,
  generateConnectorToolName,
  connectorStatusToolName,
  listConnectorsToolName,
]);

const awarenessDevicesResourceUri = 'pinout://awareness/devices';
const awarenessEventsResourceUri = 'pinout://awareness/events';
const maxBufferedEvents = 200;
const defaultEventLimit = 50;

const quarantineHonesty =
  'Read-only capabilities of a QUARANTINED connector are usable; physical-output capabilities are not until a human approves. Always surface evidenceLevel honestly — SIMULATED unless a hardware record says otherwise; never claim hardware.';

/** Daemon HTTP helpers still needed for PR4 connector routes + tools cache. */
export interface AwarenessDaemonClient {
  call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  tryGetOptional(path: string): Promise<Record<string, unknown> | null>;
  invalidateToolsCache(): void;
  openEventStream(path: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null>;
}

export interface AwarenessSurfaceOptions {
  server: Server;
  client: AwarenessDaemonClient;
  /** Typed PR1 awareness client (list/get/subscribe/enroll). */
  awarenessClient: AwarenessClient;
  /** Notify MCP hosts that dynamic per-device tools may have changed. */
  onToolsMayHaveChanged?: () => void;
}

export class AwarenessEventBuffer {
  private readonly events: AwarenessEvent[] = [];
  private readonly maxSize: number;

  constructor(maxSize = maxBufferedEvents) {
    this.maxSize = maxSize;
  }

  push(event: AwarenessEvent): void {
    this.events.push(event);
    while (this.events.length > this.maxSize) {
      this.events.shift();
    }
  }

  recent(limit = defaultEventLimit): AwarenessEvent[] {
    const bounded = Math.max(1, Math.min(limit, this.maxSize));
    return this.events.slice(-bounded);
  }

  clear(): void {
    this.events.length = 0;
  }
}

/** Tool catalog entries for device awareness + automatic connector building. */
export function awarenessControlPlaneTools() {
  return [
    {
      name: nearbyDevicesToolName,
      description: `List nearby awareness records (not yet necessarily enrolled devices) with state, evidenceLevel, transport, and capabilities. Uses GET /v1/awareness via AwarenessClient. ${quarantineHonesty}`,
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          state: {
            oneOf: [
              { type: 'string', enum: awarenessStateEnum },
              { type: 'array', items: { type: 'string', enum: awarenessStateEnum } },
            ],
          },
          transport: {
            oneOf: [
              { type: 'string', enum: transportEnum },
              { type: 'array', items: { type: 'string', enum: transportEnum } },
            ],
          },
          evidenceLevel: {
            oneOf: [
              { type: 'string', enum: [...evidenceEnum] },
              { type: 'array', items: { type: 'string', enum: [...evidenceEnum] } },
            ],
          },
          moduleId: { type: 'string' },
          hasConnector: { type: 'boolean' },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        title: 'List nearby awareness devices',
      },
    },
    {
      name: awarenessEventsToolName,
      description: `Return a bounded buffer of recent awareness change events (seen, identified, state_changed, online, offline) fed by AwarenessClient.subscribe. ${quarantineHonesty}`,
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: maxBufferedEvents,
            default: defaultEventLimit,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        title: 'Recent awareness events',
      },
    },
    {
      name: describeNearbyToolName,
      description: `Describe one nearby awareness record by id (AwarenessClient.get), including evidenceLevel and connector status. ${quarantineHonesty}`,
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', minLength: 1 } },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        title: 'Describe nearby awareness device',
      },
    },
    {
      name: requestEnrollToolName,
      description: `Request enrollment via AwarenessClient.enroll. Registers the device in devices.json when the daemon accepts — does NOT approve physical-output capabilities. Human connector approve/install remains required for actuation. ${quarantineHonesty}`,
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', minLength: 1 },
          moduleId: { type: 'string', minLength: 1 },
          deviceId: { type: 'string', minLength: 1 },
        },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        title: 'Request awareness enrollment (physical-output still human-gated)',
      },
    },
    {
      name: generateConnectorToolName,
      description: `Ask the daemon to generate a connector candidate from an awareness record (PR4). Generated connectors start QUARANTINED/CANDIDATE — read-only may be usable; physical-output requires human approve+install. ${quarantineHonesty}`,
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['awarenessId'],
        properties: { awarenessId: { type: 'string', minLength: 1 } },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        title: 'Generate connector candidate',
      },
    },
    {
      name: connectorStatusToolName,
      description: `Read generated connector status, capabilities, safety flags, report, and evidenceLevel. ${quarantineHonesty}`,
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', minLength: 1 } },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        title: 'Connector status',
      },
    },
    {
      name: listConnectorsToolName,
      description: `List generated connector candidates and installed connectors with status and evidenceLevel. ${quarantineHonesty}`,
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          status: {
            oneOf: [
              { type: 'string', enum: generatedConnectorStatusEnum },
              { type: 'array', items: { type: 'string', enum: generatedConnectorStatusEnum } },
            ],
          },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        title: 'List connectors',
      },
    },
  ];
}

export function attachAwarenessSurface(options: AwarenessSurfaceOptions): {
  buffer: AwarenessEventBuffer;
  handleToolCall: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ReturnType<typeof success> | null>;
  start: () => void;
  stop: () => void;
} {
  const { server, client, awarenessClient } = options;
  const buffer = new AwarenessEventBuffer();
  const subscribedResources = new Set<string>();
  let stopWatchers: (() => void) | undefined;
  let started = false;

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const devices = await listAwarenessSafe(awarenessClient);
    return {
      resources: [
        {
          uri: awarenessDevicesResourceUri,
          name: 'Nearby awareness devices',
          description: 'Snapshot of GET /v1/awareness devices with honest evidenceLevel.',
          mimeType: 'application/json',
        },
        {
          uri: awarenessEventsResourceUri,
          name: 'Recent awareness events',
          description: 'Bounded recent awareness events from AwarenessClient.subscribe.',
          mimeType: 'application/json',
        },
        ...devices.map((device) => ({
          uri: awarenessDeviceUri(device.id),
          name: `Awareness ${device.id}`,
          description: `Nearby device ${device.id} (${device.state}, ${device.evidenceLevel})`,
          mimeType: 'application/json',
        })),
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri === awarenessDevicesResourceUri) {
      const devices = await listAwarenessSafe(awarenessClient);
      return resourceJson(uri, {
        devices: devices.map(annotateAwareness),
        honesty:
          'evidenceLevel is SupportLevel; defaults to SIMULATED; never claim hardware without HARDWARE_VERIFIED.',
      });
    }
    if (uri === awarenessEventsResourceUri) {
      return resourceJson(uri, { events: buffer.recent(defaultEventLimit) });
    }
    const deviceId = parseAwarenessDeviceUri(uri);
    if (deviceId) {
      const record = withNormalizedEvidence(await awarenessClient.get(deviceId));
      return resourceJson(uri, annotateAwareness(record));
    }
    throw structured('NOT_FOUND', `Unknown resource '${uri}'.`);
  });

  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subscribedResources.add(request.params.uri);
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscribedResources.delete(request.params.uri);
    return {};
  });

  const handleToolCall = async (name: string, args: Record<string, unknown>) => {
    switch (name) {
      case nearbyDevicesToolName: {
        const devices = await listAwarenessSafe(awarenessClient);
        const filtered = filterAwarenessRecords(devices, parseNearbyFilter(args));
        return success({
          devices: filtered.map(annotateAwareness),
          count: filtered.length,
          honesty:
            'evidenceLevel is SupportLevel (SIMULATED unless COMPILE_TESTED/HARDWARE_VERIFIED). Never claim hardware from SIMULATED/UNKNOWN.',
        });
      }
      case awarenessEventsToolName: {
        const limit =
          typeof args.limit === 'number' && Number.isFinite(args.limit)
            ? Math.trunc(args.limit)
            : defaultEventLimit;
        return success({
          events: buffer.recent(limit),
          bound: maxBufferedEvents,
        });
      }
      case describeNearbyToolName: {
        const id = requiredString(args, 'id');
        const record = withNormalizedEvidence(await awarenessClient.get(id));
        return success(annotateAwareness(record));
      }
      case requestEnrollToolName: {
        const id = requiredString(args, 'id');
        const enrollBody: { moduleId?: string; deviceId?: string } = {};
        if (typeof args.moduleId === 'string' && args.moduleId.length > 0) {
          enrollBody.moduleId = args.moduleId;
        }
        if (typeof args.deviceId === 'string' && args.deviceId.length > 0) {
          enrollBody.deviceId = args.deviceId;
        }
        const result = await awarenessClient.enroll(id, enrollBody);
        const approvalHandle = `enroll:${id}:${result.record.state}`;
        return success({
          pendingPhysicalOutputApproval: true,
          enrolled: result.enrolled,
          awarenessId: id,
          approvalHandle,
          record: annotateAwareness(withNormalizedEvidence(result.record)),
          ...(result.device ? { device: result.device } : {}),
          humanStepRequired: true,
          instructions: [
            'Enrollment was requested through AwarenessClient.enroll — this registers presence only.',
            'Physical-output capabilities are NOT approved by this tool.',
            'A human must still approve/install any generated connector before actuation.',
            `Follow-up handle: '${approvalHandle}'.`,
            quarantineHonesty,
          ],
        });
      }
      case generateConnectorToolName: {
        const awarenessId = requiredString(args, 'awarenessId');
        const payload = await client.call('POST', '/v1/connectors/generate', { awarenessId });
        const connector = normalizeGeneratedConnector(payload.connector ?? payload);
        if (connector.status === 'INSTALLED') {
          client.invalidateToolsCache();
          options.onToolsMayHaveChanged?.();
        }
        return success(annotateGeneratedConnector(connector));
      }
      case connectorStatusToolName: {
        const id = requiredString(args, 'id');
        const payload = await client.call('GET', `/v1/connectors/${segment(id)}`);
        const connector = normalizeGeneratedConnector(payload.connector ?? payload);
        if (connector.status === 'INSTALLED') {
          client.invalidateToolsCache();
        }
        return success(annotateGeneratedConnector(connector));
      }
      case listConnectorsToolName: {
        const payload = await client.call('GET', '/v1/connectors');
        const rawList = Array.isArray(payload.connectors) ? payload.connectors : [];
        let connectors = rawList.map((entry) => normalizeGeneratedConnector(entry));
        const statusFilter = parseStatusFilter(args.status);
        if (statusFilter) {
          connectors = connectors.filter((entry) => statusFilter.has(entry.status));
        }
        return success({
          connectors: connectors.map(annotateGeneratedConnector),
          count: connectors.length,
          honesty: quarantineHonesty,
        });
      }
      default:
        return null;
    }
  };

  const start = () => {
    if (started) return;
    started = true;
    const unsubAwareness = awarenessClient.subscribe((event) => {
      buffer.push(event);
      void notifyForAwarenessEvent(server, subscribedResources, event, options);
    });
    const stopBus = startConnectorBusWatcher({
      client,
      onInstall: () => {
        client.invalidateToolsCache();
        options.onToolsMayHaveChanged?.();
        void server.sendToolListChanged().catch(() => undefined);
      },
    });
    stopWatchers = () => {
      unsubAwareness();
      stopBus();
    };
  };

  const stop = () => {
    stopWatchers?.();
    stopWatchers = undefined;
    started = false;
  };

  return { buffer, handleToolCall, start, stop };
}

function startConnectorBusWatcher(options: {
  client: AwarenessDaemonClient;
  onInstall: () => void;
}): () => void {
  const controller = new AbortController();
  void pumpSse('/v1/events', options.client, controller.signal, async (raw) => {
    const kind =
      typeof raw.kind === 'string'
        ? raw.kind
        : typeof raw.type === 'string'
          ? raw.type
          : typeof raw.event === 'string'
            ? raw.event
            : '';
    if (!kind || kind === 'hello') return;
    if (isConnectorInstallEvent(kind, raw)) options.onInstall();
  });
  return () => controller.abort();
}

async function pumpSse(
  path: string,
  client: AwarenessDaemonClient,
  signal: AbortSignal,
  onData: (payload: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const stream = await client.openEventStream(path, signal);
      if (!stream) {
        await sleep(2000, signal);
        continue;
      }
      await readSseStream(stream, signal, onData);
    } catch {
      if (signal.aborted) return;
      await sleep(2000, signal);
    }
  }
}

async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onData: (payload: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancelReader, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const dataLine = chunk
          .split('\n')
          .map((line) => line.trimEnd())
          .find((line) => line.startsWith('data:'));
        if (dataLine) {
          const jsonText = dataLine.slice('data:'.length).trim();
          if (jsonText) {
            try {
              await onData(JSON.parse(jsonText) as Record<string, unknown>);
            } catch {
              // ignore malformed SSE payloads
            }
          }
        }
        split = buffer.indexOf('\n\n');
      }
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

async function notifyForAwarenessEvent(
  server: Server,
  subscribedResources: Set<string>,
  event: AwarenessEvent,
  options: AwarenessSurfaceOptions,
): Promise<void> {
  const type = String(event.type);
  if (isNewDeviceEventType(type)) {
    try {
      await server.sendResourceListChanged();
    } catch {
      // Client may not support resources yet.
    }
    if (subscribedResources.has(awarenessDevicesResourceUri)) {
      try {
        await server.sendResourceUpdated({ uri: awarenessDevicesResourceUri });
      } catch {
        // ignore
      }
    }
    const awarenessId = event.record.id;
    if (subscribedResources.has(awarenessDeviceUri(awarenessId))) {
      try {
        await server.sendResourceUpdated({ uri: awarenessDeviceUri(awarenessId) });
      } catch {
        // ignore
      }
    }
    try {
      await server.sendToolListChanged();
    } catch {
      // ignore
    }
  }

  if (event.record.connector?.status === 'installed') {
    options.client.invalidateToolsCache();
    options.onToolsMayHaveChanged?.();
    try {
      await server.sendToolListChanged();
    } catch {
      // ignore
    }
  }

  if (subscribedResources.has(awarenessEventsResourceUri)) {
    try {
      await server.sendResourceUpdated({ uri: awarenessEventsResourceUri });
    } catch {
      // ignore
    }
  }
}

async function listAwarenessSafe(awarenessClient: AwarenessClient): Promise<AwarenessRecord[]> {
  try {
    const devices = await awarenessClient.list();
    return devices.map(withNormalizedEvidence);
  } catch {
    return [];
  }
}

function annotateAwareness(record: AwarenessRecord): Record<string, unknown> {
  const evidenceLevel = normalizeEvidenceLevel(record.evidenceLevel);
  return {
    ...record,
    evidenceLevel,
    honesty: honestyNote(evidenceLevel),
    ...(record.connector
      ? {
          connector: {
            ...record.connector,
            guidance: awarenessConnectorGuidance(record.connector.status),
          },
        }
      : {}),
  };
}

function annotateGeneratedConnector(connector: GeneratedConnectorRecord): Record<string, unknown> {
  const evidenceLevel = normalizeEvidenceLevel(connector.evidenceLevel);
  return {
    ...connector,
    evidenceLevel,
    honesty: honestyNote(evidenceLevel),
    guidance: generatedConnectorGuidance(connector.status),
    humanApprovalRequiredForPhysicalOutput:
      connector.status === 'QUARANTINED' ||
      connector.status === 'CANDIDATE' ||
      connector.status === 'APPROVED',
  };
}

function parseNearbyFilter(args: Record<string, unknown>): NearbyDevicesFilter {
  return {
    ...(args.state !== undefined ? { state: args.state as AwarenessState | AwarenessState[] } : {}),
    ...(args.transport !== undefined
      ? { transport: args.transport as AwarenessTransport | AwarenessTransport[] }
      : {}),
    ...(args.evidenceLevel !== undefined
      ? { evidenceLevel: args.evidenceLevel as SupportLevel | SupportLevel[] }
      : {}),
    ...(typeof args.moduleId === 'string' ? { moduleId: args.moduleId } : {}),
    ...(typeof args.hasConnector === 'boolean' ? { hasConnector: args.hasConnector } : {}),
  };
}

function parseStatusFilter(value: unknown): Set<string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return new Set([value]);
  if (Array.isArray(value)) return new Set(value.filter((entry) => typeof entry === 'string'));
  return undefined;
}

function resourceJson(uri: string, payload: Record<string, unknown>) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(payload),
      },
    ],
  };
}

function awarenessDeviceUri(id: string): string {
  return `pinout://awareness/device/${encodeURIComponent(id)}`;
}

function parseAwarenessDeviceUri(uri: string): string | null {
  const prefix = 'pinout://awareness/device/';
  if (!uri.startsWith(prefix)) return null;
  return decodeURIComponent(uri.slice(prefix.length));
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw structured('VALIDATION_ERROR', `${name} must be a non-empty string.`);
  }
  return value;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function structured(code: string, message: string) {
  return { code, message, retryable: false };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

const awarenessStateEnum = [
  'SEEN',
  'IDENTIFIED',
  'PENDING_ENROLL',
  'ONLINE',
  'STALE',
  'OFFLINE',
] as const;

const transportEnum = ['serial', 'usb', 'ble', 'mdns', 'mqtt'] as const;
const evidenceEnum = SUPPORT_LEVELS;
const generatedConnectorStatusEnum = [
  'CANDIDATE',
  'QUARANTINED',
  'APPROVED',
  'INSTALLED',
  'REJECTED',
] as const;
