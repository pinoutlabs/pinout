/**
 * Connector lifecycle stub (QUARANTINED → HUMAN APPROVES → INSTALLED).
 *
 * Generation uses real `@pinout/generator` `generateConnector` + PR3 fixtures.
 * HTTP approve/install/reject/invoke stay here until PR4 lands on pinoutd.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  generateConnector,
  type ConnectorSourceKind,
  type GenerateConnectorResult,
} from '@pinout/generator';
import type {
  ConnectorApproveRequest,
  ConnectorEvidenceFile,
  InvokeResult,
  StubConnectorCapability,
  StubConnectorRecord,
  SupportLevel,
} from './types.js';
import { capEvidenceLevel } from './types.js';

const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(demoRoot, '../..');

export class ConnectorStore {
  readonly connectors = new Map<string, StubConnectorRecord>();
  readonly generation = new Map<string, GenerateConnectorResult>();
  readonly lastArgs = new Map<string, Record<string, unknown>>();
  evidence: ConnectorEvidenceFile = { byAwarenessId: {} };

  list(): StubConnectorRecord[] {
    return [...this.connectors.values()];
  }

  get(id: string): StubConnectorRecord | undefined {
    return this.connectors.get(id);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-pinout-demo': 'SIMULATED',
    'x-pinout-connectors': 'stub-until-pr4',
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function loadConnectorEvidence(path: string): Promise<ConnectorEvidenceFile> {
  return JSON.parse(await readFile(path, 'utf8')) as ConnectorEvidenceFile;
}

function toStubCapabilities(result: GenerateConnectorResult): StubConnectorCapability[] {
  return result.capabilities.map((cap) => ({
    id: cap.id,
    physicalOutput: cap.safetyClass === 'physicalOutput',
    requiresApproval: Boolean(cap.requiresApproval || cap.safetyClass === 'physicalOutput'),
    ...(cap.arguments
      ? {
          args: Object.fromEntries(
            Object.entries(cap.arguments).map(([key, value]) => [
              key,
              {
                ...(value.type ? { type: value.type } : {}),
                ...(value.required !== undefined ? { required: value.required } : {}),
              },
            ]),
          ),
        }
      : {}),
  }));
}

export async function generateStubConnector(
  store: ConnectorStore,
  awarenessId: string,
): Promise<StubConnectorRecord> {
  const existing = [...store.connectors.values()].find((c) => c.awarenessId === awarenessId);
  if (existing) return existing;

  const entry = store.evidence.byAwarenessId[awarenessId];
  if (!entry) {
    throw Object.assign(new Error(`No connector evidence mapping for ${awarenessId}`), {
      code: 'NO_INGEST_EVIDENCE',
    });
  }

  const fixtureAbsolute = resolve(repoRoot, entry.fixturePath);
  const raw = JSON.parse(await readFile(fixtureAbsolute, 'utf8')) as unknown;
  const source = entry.source as ConnectorSourceKind;
  const generated = await generateConnector({
    source,
    raw,
    inMemory: true,
  });

  const evidenceLevel = capEvidenceLevel(generated.evidenceLevel as SupportLevel, 'COMPILE_TESTED');
  const capabilities = toStubCapabilities(generated);
  const connector: StubConnectorRecord = {
    id: `conn-${awarenessId}`,
    awarenessId,
    status: 'QUARANTINED',
    evidenceLevel,
    mode: 'read-only',
    capabilities,
    approvedCapabilities: capabilities.filter((c) => !c.physicalOutput).map((c) => c.id),
    ranges: {},
    armed: false,
    generated: true,
    source,
    moduleId: generated.report.moduleId,
    pendingApprovals: generated.report.pendingApprovals,
    report: {
      quarantine: true,
      conformanceGate: 'passed',
      neverInstalls: true,
      neverRegisters: true,
      notes: [
        `Generated via @pinout/generator generateConnector (source=${source}).`,
        `Fixture: ${entry.fixturePath}`,
        `Evidence ${evidenceLevel} (capped ≤ COMPILE_TESTED; never HARDWARE_VERIFIED here).`,
        'Physical-output capabilities blocked until HUMAN APPROVES ranges.',
        'Install/register deferred to PR4 daemon routes — this stub only simulates lifecycle.',
        'Nothing was auto-armed.',
      ],
    },
  };

  store.connectors.set(connector.id, connector);
  store.generation.set(connector.id, generated);
  return connector;
}

export function approveStubConnector(
  store: ConnectorStore,
  connectorId: string,
  body: ConnectorApproveRequest,
): StubConnectorRecord {
  const connector = store.connectors.get(connectorId);
  if (!connector) {
    throw Object.assign(new Error(`Unknown connector: ${connectorId}`), { code: 'NOT_FOUND' });
  }
  if (connector.status === 'REJECTED') {
    throw Object.assign(new Error('Connector was rejected'), { code: 'CONNECTOR_REJECTED' });
  }
  if (!body.capabilities?.length) {
    throw Object.assign(new Error('approve requires capabilities[]'), {
      code: 'VALIDATION_ERROR',
    });
  }

  connector.approvedCapabilities = [...new Set(body.capabilities)];
  connector.ranges = body.ranges ?? {};
  connector.status = 'APPROVED';
  connector.mode = 'approved';
  connector.armed = false;
  connector.evidenceLevel = capEvidenceLevel(connector.evidenceLevel, 'COMPILE_TESTED');
  return connector;
}

export function installStubConnector(
  store: ConnectorStore,
  connectorId: string,
): StubConnectorRecord {
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
  return connector;
}

export function rejectStubConnector(
  store: ConnectorStore,
  connectorId: string,
): StubConnectorRecord {
  const connector = store.connectors.get(connectorId);
  if (!connector) {
    throw Object.assign(new Error(`Unknown connector: ${connectorId}`), { code: 'NOT_FOUND' });
  }
  connector.status = 'REJECTED';
  connector.armed = false;
  return connector;
}

export function invokeStubConnector(
  store: ConnectorStore,
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
  if (connector.armed) {
    return {
      ok: false,
      code: 'SAFETY_AUTO_ARM_FORBIDDEN',
      message: 'Demo invariant violated: connector was armed without explicit human arm',
    };
  }

  const descriptor = connector.capabilities.find((c) => c.id === capability);
  if (!descriptor) {
    return {
      ok: false,
      code: 'UNSUPPORTED_CAPABILITY',
      message: `Unknown capability ${capability}`,
    };
  }

  if (descriptor.physicalOutput) {
    const approved =
      (connector.status === 'APPROVED' || connector.status === 'INSTALLED') &&
      connector.approvedCapabilities.includes(capability);
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
          message: `Expected numeric ${field} for range check`,
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
    return {
      ok: false,
      code: 'SAFETY_APPROVAL_REQUIRED',
      message: 'Capability not available in quarantine read-only set',
    };
  }

  store.lastArgs.set(`${connectorId}:${capability}`, args);
  return {
    ok: true,
    result: {
      capability,
      args,
      evidenceLevel: connector.evidenceLevel,
      simulated: true,
      armed: false,
      note: 'SIMULATED connector invoke — no physical transport opened',
    },
  };
}

export interface ConnectorStubOptions {
  evidencePath?: string;
  host?: string;
  port?: number;
  token?: string;
}

export interface RunningConnectorStub {
  baseUrl: string;
  port: number;
  token: string;
  store: ConnectorStore;
  mode: 'stub-until-pr4';
  label: 'SIMULATED';
  close(): Promise<void>;
}

export async function startConnectorStub(
  options: ConnectorStubOptions = {},
): Promise<RunningConnectorStub> {
  const store = new ConnectorStore();
  const evidencePath =
    options.evidencePath ?? join(demoRoot, 'fixtures', 'connector-evidence.json');
  store.evidence = await loadConnectorEvidence(evidencePath);
  const token = options.token ?? `connector-stub-${randomUUID().slice(0, 8)}`;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      if (pathname === '/v1/health' && method === 'GET') {
        json(res, 200, {
          ok: true,
          mode: 'stub-until-pr4',
          label: 'SIMULATED',
          connectors: true,
          awareness: false,
        });
        return;
      }

      const auth = req.headers.authorization ?? '';
      if (pathname.startsWith('/v1/') && pathname !== '/v1/health' && auth !== `Bearer ${token}`) {
        json(res, 401, {
          error: { code: 'UNAUTHORIZED', message: 'Bearer token required', retryable: false },
        });
        return;
      }

      if (pathname === '/v1/connectors' && method === 'GET') {
        json(res, 200, { connectors: store.list(), label: 'SIMULATED' });
        return;
      }

      if (pathname === '/v1/connectors/generate' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { awarenessId?: string };
        if (!body.awarenessId) {
          json(res, 400, {
            error: { code: 'VALIDATION_ERROR', message: 'awarenessId required', retryable: false },
          });
          return;
        }
        try {
          const connector = await generateStubConnector(store, body.awarenessId);
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

      const match = /^\/v1\/connectors\/([^/]+)(?:\/(approve|install|reject|invoke))?$/.exec(
        pathname,
      );
      if (match) {
        const connectorId = decodeURIComponent(match[1]!);
        const action = match[2];

        if (method === 'GET' && !action) {
          const connector = store.get(connectorId);
          if (!connector) {
            json(res, 404, {
              error: { code: 'NOT_FOUND', message: 'connector not found', retryable: false },
            });
            return;
          }
          json(res, 200, { connector, label: 'SIMULATED' });
          return;
        }

        if (method === 'POST' && action === 'approve') {
          const body = JSON.parse((await readBody(req)) || '{}') as ConnectorApproveRequest;
          try {
            const connector = approveStubConnector(store, connectorId, body);
            json(res, 200, { connector, marker: 'HUMAN APPROVES', label: 'SIMULATED' });
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
            const connector = installStubConnector(store, connectorId);
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
          const connector = rejectStubConnector(store, connectorId);
          json(res, 200, { connector, label: 'SIMULATED' });
          return;
        }

        if (method === 'POST' && action === 'invoke') {
          const body = JSON.parse((await readBody(req)) || '{}') as {
            capability?: string;
            args?: Record<string, unknown>;
          };
          const result = invokeStubConnector(
            store,
            connectorId,
            body.capability ?? '',
            body.args ?? {},
          );
          json(res, result.ok ? 200 : 403, { ...result, label: 'SIMULATED', armed: false });
          return;
        }
      }

      json(res, 404, {
        error: {
          code: 'NOT_FOUND',
          message: `No route for ${method} ${pathname}`,
          retryable: false,
        },
      });
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
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind connector stub');
  }

  return {
    baseUrl: `http://${host}:${address.port}`,
    port: address.port,
    token,
    store,
    mode: 'stub-until-pr4',
    label: 'SIMULATED',
    close: async () => {
      await new Promise<void>((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      });
    },
  };
}
