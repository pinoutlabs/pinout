/**
 * SIMULATED / STUBBED awareness + connector control plane for the PR5 demo.
 *
 * Prefer real pinoutd routes (`/v1/awareness`, `/v1/connectors`, …) when the
 * upstream PRs have merged. This file exists so the demo and e2e can run
 * honestly before those land — every response is labeled SIMULATED.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type {
  AwarenessRecord,
  ConnectorApproveRequest,
  ConnectorCapability,
  ConnectorRecord,
  InvokeResult,
  MockDeviceFixture,
  MockDevicesFile,
  SupportLevel,
} from './types.js';
import { capEvidenceLevel } from './types.js';

const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface MockControlPlaneOptions {
  mockDevicesPath?: string;
  host?: string;
  port?: number;
  token?: string;
}

export interface RunningMockControlPlane {
  baseUrl: string;
  host: string;
  port: number;
  token: string;
  mode: 'stubbed-demo';
  label: 'SIMULATED';
  store: DemoStore;
  close(): Promise<void>;
}

export class DemoStore {
  readonly awareness = new Map<string, AwarenessRecord>();
  readonly connectors = new Map<string, ConnectorRecord>();
  readonly events: Array<{ type: string; record: AwarenessRecord; at: number }> = [];
  readonly fixtureById = new Map<string, MockDeviceFixture>();
  readonly gattByAwarenessId = new Map<string, { inferredCapabilities: ConnectorCapability[] }>();
  readonly mqttByAwarenessId = new Map<string, { inferredCapabilities: ConnectorCapability[] }>();
  readonly brightness = new Map<string, number>();

  listAwareness(): AwarenessRecord[] {
    return [...this.awareness.values()];
  }

  getAwareness(id: string): AwarenessRecord | undefined {
    return this.awareness.get(id);
  }

  listConnectors(): ConnectorRecord[] {
    return [...this.connectors.values()];
  }

  getConnector(id: string): ConnectorRecord | undefined {
    return this.connectors.get(id);
  }

  publish(type: string, record: AwarenessRecord): void {
    this.events.push({ type, record, at: Date.now() });
    if (this.events.length > 200) this.events.shift();
  }
}

async function loadJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function loadMockDevices(path: string): Promise<MockDevicesFile> {
  return loadJson<MockDevicesFile>(path);
}

export async function seedStoreFromFixtures(
  store: DemoStore,
  mockDevicesPath: string,
): Promise<void> {
  const absolute = resolve(mockDevicesPath);
  const fixtureDir = dirname(absolute);
  const file = await loadMockDevices(absolute);
  const now = Date.now();

  for (const device of file.devices) {
    store.fixtureById.set(device.id, device);
    const record: AwarenessRecord = {
      id: device.id,
      transport: device.transport,
      identity: device.identity,
      state: device.moduleId ? 'IDENTIFIED' : device.stateHint,
      firstSeen: now,
      lastSeen: now,
      moduleId: device.moduleId,
      capabilities: device.capabilitiesHint,
      evidenceLevel: device.evidenceLevel,
      ...(device.label !== undefined ? { label: device.label } : {}),
    };
    store.awareness.set(device.id, record);
    store.publish(device.moduleId ? 'identified' : 'seen', record);

    if (device.gattDumpPath) {
      const gatt = await loadJson<{ inferredCapabilities: ConnectorCapability[] }>(
        join(fixtureDir, device.gattDumpPath),
      );
      store.gattByAwarenessId.set(device.id, gatt);
    }
    if (device.mqttSamplesPath) {
      const mqtt = await loadJson<{ inferredCapabilities: ConnectorCapability[] }>(
        join(fixtureDir, device.mqttSamplesPath),
      );
      store.mqttByAwarenessId.set(device.id, mqtt);
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-pinout-demo': 'SIMULATED',
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function unauthorized(res: ServerResponse): void {
  json(res, 401, {
    error: { code: 'UNAUTHORIZED', message: 'Bearer token required', retryable: false },
  });
}

function notFound(res: ServerResponse, message: string): void {
  json(res, 404, {
    error: { code: 'NOT_FOUND', message, retryable: false },
  });
}

export function generateConnectorFromStore(store: DemoStore, awarenessId: string): ConnectorRecord {
  const awareness = store.awareness.get(awarenessId);
  if (!awareness) {
    throw Object.assign(new Error(`Unknown awareness id: ${awarenessId}`), {
      code: 'NOT_FOUND',
    });
  }

  const existing = [...store.connectors.values()].find((c) => c.awarenessId === awarenessId);
  if (existing) return existing;

  const inferred =
    store.gattByAwarenessId.get(awarenessId)?.inferredCapabilities ??
    store.mqttByAwarenessId.get(awarenessId)?.inferredCapabilities ??
    [];

  if (inferred.length === 0) {
    throw Object.assign(new Error(`No ingest evidence for ${awarenessId}`), {
      code: 'NO_INGEST_EVIDENCE',
    });
  }

  const evidenceLevel = capEvidenceLevel('COMPILE_TESTED', 'COMPILE_TESTED') as SupportLevel;
  const connector: ConnectorRecord = {
    id: `conn-${awarenessId}`,
    awarenessId,
    status: 'QUARANTINED',
    evidenceLevel,
    mode: 'read-only',
    capabilities: inferred,
    approvedCapabilities: inferred.filter((c) => !c.physicalOutput).map((c) => c.id),
    ranges: {},
    armed: false,
    generated: true,
    report: {
      quarantine: true,
      conformanceGate: 'stubbed',
      notes: [
        'SIMULATED connector generated from fixture ingest (GATT dump / MQTT samples).',
        'Physical-output capabilities remain blocked until HUMAN APPROVES ranges.',
        'Evidence capped at COMPILE_TESTED — Pinout has never run on real hardware here.',
        'Nothing was auto-armed.',
      ],
    },
  };

  store.connectors.set(connector.id, connector);
  awareness.connector = { id: connector.id, status: connector.status };
  awareness.state = 'PENDING_ENROLL';
  awareness.lastSeen = Date.now();
  store.publish('state_changed', awareness);
  return connector;
}

export function approveConnector(
  store: DemoStore,
  connectorId: string,
  body: ConnectorApproveRequest,
): ConnectorRecord {
  const connector = store.connectors.get(connectorId);
  if (!connector) {
    throw Object.assign(new Error(`Unknown connector: ${connectorId}`), { code: 'NOT_FOUND' });
  }
  if (connector.status === 'REJECTED') {
    throw Object.assign(new Error('Connector was rejected'), { code: 'CONNECTOR_REJECTED' });
  }
  if (!body.capabilities?.length || !body.ranges) {
    throw Object.assign(new Error('approve requires capabilities[] and ranges'), {
      code: 'VALIDATION_ERROR',
    });
  }

  connector.approvedCapabilities = [...new Set(body.capabilities)];
  connector.ranges = body.ranges;
  connector.status = 'APPROVED';
  connector.mode = 'approved';
  connector.armed = false;
  connector.evidenceLevel = capEvidenceLevel(connector.evidenceLevel, 'COMPILE_TESTED');

  const awareness = store.awareness.get(connector.awarenessId);
  if (awareness) {
    awareness.connector = { id: connector.id, status: connector.status };
    store.publish('state_changed', awareness);
  }
  return connector;
}

export function installConnector(store: DemoStore, connectorId: string): ConnectorRecord {
  const connector = store.connectors.get(connectorId);
  if (!connector) {
    throw Object.assign(new Error(`Unknown connector: ${connectorId}`), { code: 'NOT_FOUND' });
  }
  if (connector.status !== 'APPROVED' && connector.status !== 'INSTALLED') {
    throw Object.assign(new Error('Connector must be APPROVED before install'), {
      code: 'APPROVAL_REQUIRED',
    });
  }
  connector.status = 'INSTALLED';
  connector.mode = 'installed';
  connector.armed = false;
  const awareness = store.awareness.get(connector.awarenessId);
  if (awareness) {
    awareness.connector = { id: connector.id, status: connector.status };
    awareness.state = 'ONLINE';
    store.publish('online', awareness);
  }
  return connector;
}

export function rejectConnector(store: DemoStore, connectorId: string): ConnectorRecord {
  const connector = store.connectors.get(connectorId);
  if (!connector) {
    throw Object.assign(new Error(`Unknown connector: ${connectorId}`), { code: 'NOT_FOUND' });
  }
  connector.status = 'REJECTED';
  connector.armed = false;
  return connector;
}

export function invokeConnectorCapability(
  store: DemoStore,
  connectorId: string,
  capability: string,
  args: Record<string, unknown>,
): InvokeResult {
  const connector = store.connectors.get(connectorId);
  if (!connector) {
    return { ok: false, code: 'NOT_FOUND', message: `Unknown connector: ${connectorId}` };
  }
  if (connector.status === 'REJECTED') {
    return { ok: false, code: 'CONNECTOR_REJECTED', message: 'Connector was rejected' };
  }

  const descriptor = connector.capabilities.find((c) => c.id === capability);
  if (!descriptor) {
    return {
      ok: false,
      code: 'UNSUPPORTED_CAPABILITY',
      message: `Unknown capability ${capability}`,
    };
  }

  // Generated connectors never auto-arm.
  if (connector.armed) {
    return {
      ok: false,
      code: 'SAFETY_AUTO_ARM_FORBIDDEN',
      message: 'Demo invariant violated: connector was armed without explicit human arm',
    };
  }

  if (descriptor.physicalOutput) {
    const approved =
      connector.status === 'APPROVED' || connector.status === 'INSTALLED'
        ? connector.approvedCapabilities.includes(capability)
        : false;
    if (!approved) {
      return {
        ok: false,
        code: 'SAFETY_APPROVAL_REQUIRED',
        message:
          'Physical-output capability is quarantined until a human approves ranges (HUMAN APPROVES).',
      };
    }

    const ranges = connector.ranges[capability] ?? {};
    for (const [field, range] of Object.entries(ranges)) {
      const value = args[field];
      if (typeof value !== 'number') {
        return {
          ok: false,
          code: 'VALIDATION_ERROR',
          message: `Expected numeric ${field}`,
        };
      }
      if (value < range.min || value > range.max) {
        return {
          ok: false,
          code: 'POLICY_CONSTRAINT_VIOLATION',
          message: `${field}=${value} outside approved range [${range.min}, ${range.max}]`,
          result: { field, value, min: range.min, max: range.max },
        };
      }
    }
  } else if (
    connector.status === 'QUARANTINED' &&
    !connector.approvedCapabilities.includes(capability)
  ) {
    // Quarantine allows only explicitly non-physical caps from generation.
    return {
      ok: false,
      code: 'SAFETY_APPROVAL_REQUIRED',
      message: 'Capability not available in quarantine read-only set',
    };
  }

  if (capability === 'lamp.status') {
    const percent = store.brightness.get(connectorId) ?? 0;
    return {
      ok: true,
      result: {
        on: percent > 0,
        percent,
        evidenceLevel: connector.evidenceLevel,
        simulated: true,
        armed: false,
      },
    };
  }

  if (capability === 'lamp.setBrightness') {
    const percent = args.percent as number;
    store.brightness.set(connectorId, percent);
    return {
      ok: true,
      result: {
        percent,
        evidenceLevel: connector.evidenceLevel,
        simulated: true,
        armed: false,
        note: 'SIMULATED write — no physical lamp was driven',
      },
    };
  }

  if (capability === 'environment.read') {
    return {
      ok: true,
      result: {
        temperatureC: 21.4,
        humidityPct: 48.2,
        pressureHpa: 1012.6,
        evidenceLevel: connector.evidenceLevel,
        simulated: true,
      },
    };
  }

  return { ok: true, result: { capability, args, simulated: true, armed: false } };
}

export async function startMockControlPlane(
  options: MockControlPlaneOptions = {},
): Promise<RunningMockControlPlane> {
  const mockDevicesPath =
    options.mockDevicesPath ?? join(demoRoot, 'fixtures', 'mock-devices.json');
  const store = new DemoStore();
  await seedStoreFromFixtures(store, mockDevicesPath);
  const token = options.token ?? `demo-stub-${randomUUID().slice(0, 8)}`;

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${options.host ?? '127.0.0.1'}`);
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      if (pathname === '/v1/health' && method === 'GET') {
        json(res, 200, {
          ok: true,
          mode: 'stubbed-demo',
          label: 'SIMULATED',
          awareness: true,
          connectors: true,
        });
        return;
      }

      const auth = req.headers.authorization ?? '';
      const needsAuth = pathname.startsWith('/v1/') && pathname !== '/v1/health';
      if (needsAuth && auth !== `Bearer ${token}`) {
        unauthorized(res);
        return;
      }

      if (pathname === '/v1/awareness' && method === 'GET') {
        json(res, 200, {
          devices: store.listAwareness(),
          label: 'SIMULATED',
          mode: 'stubbed-demo',
        });
        return;
      }

      if (pathname === '/v1/awareness/events' && method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-pinout-demo': 'SIMULATED',
        });
        for (const event of store.events.slice(-20)) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        res.write(
          `event: hello\ndata: ${JSON.stringify({ label: 'SIMULATED', mode: 'stubbed-demo' })}\n\n`,
        );
        res.end();
        return;
      }

      const awarenessMatch = /^\/v1\/awareness\/([^/]+)(?:\/(enroll))?$/.exec(pathname);
      if (awarenessMatch && method === 'GET' && !awarenessMatch[2]) {
        const record = store.getAwareness(decodeURIComponent(awarenessMatch[1]!));
        if (!record) {
          notFound(res, `awareness id not found`);
          return;
        }
        json(res, 200, { device: record, label: 'SIMULATED' });
        return;
      }
      if (awarenessMatch && method === 'POST' && awarenessMatch[2] === 'enroll') {
        const record = store.getAwareness(decodeURIComponent(awarenessMatch[1]!));
        if (!record) {
          notFound(res, `awareness id not found`);
          return;
        }
        record.state = 'PENDING_ENROLL';
        store.publish('state_changed', record);
        json(res, 200, {
          request: { awarenessId: record.id, status: 'pending', armed: false },
          note: 'Enrollment request only — no silent physical approve, no auto-arm',
          label: 'SIMULATED',
        });
        return;
      }

      if (pathname === '/v1/connectors' && method === 'GET') {
        json(res, 200, { connectors: store.listConnectors(), label: 'SIMULATED' });
        return;
      }

      if (pathname === '/v1/connectors/generate' && method === 'POST') {
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as { awarenessId?: string }) : {};
        if (!body.awarenessId) {
          json(res, 400, {
            error: { code: 'VALIDATION_ERROR', message: 'awarenessId required', retryable: false },
          });
          return;
        }
        try {
          const connector = generateConnectorFromStore(store, body.awarenessId);
          json(res, 200, { connector, label: 'SIMULATED' });
        } catch (error) {
          const err = error as { code?: string; message?: string };
          json(res, err.code === 'NOT_FOUND' ? 404 : 400, {
            error: {
              code: err.code ?? 'GENERATE_FAILED',
              message: err.message ?? 'generate failed',
              retryable: false,
            },
          });
        }
        return;
      }

      const connectorMatch =
        /^\/v1\/connectors\/([^/]+)(?:\/(approve|install|reject|invoke))?$/.exec(pathname);
      if (connectorMatch) {
        const connectorId = decodeURIComponent(connectorMatch[1]!);
        const action = connectorMatch[2];

        if (method === 'GET' && !action) {
          const connector = store.getConnector(connectorId);
          if (!connector) {
            notFound(res, 'connector not found');
            return;
          }
          json(res, 200, { connector, label: 'SIMULATED' });
          return;
        }

        if (method === 'POST' && action === 'approve') {
          const raw = await readBody(req);
          const body = JSON.parse(raw || '{}') as ConnectorApproveRequest;
          try {
            const connector = approveConnector(store, connectorId, body);
            json(res, 200, {
              connector,
              marker: 'HUMAN APPROVES',
              label: 'SIMULATED',
            });
          } catch (error) {
            const err = error as { code?: string; message?: string };
            json(res, 400, {
              error: {
                code: err.code ?? 'APPROVE_FAILED',
                message: err.message ?? 'approve failed',
                retryable: false,
              },
            });
          }
          return;
        }

        if (method === 'POST' && action === 'install') {
          try {
            const connector = installConnector(store, connectorId);
            json(res, 200, { connector, label: 'SIMULATED', armed: false });
          } catch (error) {
            const err = error as { code?: string; message?: string };
            json(res, 400, {
              error: {
                code: err.code ?? 'INSTALL_FAILED',
                message: err.message ?? 'install failed',
                retryable: false,
              },
            });
          }
          return;
        }

        if (method === 'POST' && action === 'reject') {
          const connector = rejectConnector(store, connectorId);
          json(res, 200, { connector, label: 'SIMULATED' });
          return;
        }

        if (method === 'POST' && action === 'invoke') {
          const raw = await readBody(req);
          const body = JSON.parse(raw || '{}') as {
            capability?: string;
            args?: Record<string, unknown>;
          };
          const result = invokeConnectorCapability(
            store,
            connectorId,
            body.capability ?? '',
            body.args ?? {},
          );
          json(res, result.ok ? 200 : 403, {
            ...result,
            label: 'SIMULATED',
            armed: false,
          });
          return;
        }
      }

      notFound(res, `No route for ${method} ${pathname}`);
    } catch (error) {
      json(res, 500, {
        error: {
          code: 'INTERNAL',
          message: error instanceof Error ? error.message : 'internal error',
          retryable: false,
        },
      });
    }
  });

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind mock control plane');
  }

  return {
    baseUrl: `http://${host}:${address.port}`,
    host,
    port: address.port,
    token,
    mode: 'stubbed-demo',
    label: 'SIMULATED',
    store,
    close: async () => {
      await new Promise<void>((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      });
    },
  };
}

export function defaultMockDevicesPath(): string {
  return join(demoRoot, 'fixtures', 'mock-devices.json');
}
