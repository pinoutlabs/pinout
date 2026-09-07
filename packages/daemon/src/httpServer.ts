/**
 * pinoutd — the local physical execution service.
 *
 * Responsibilities (spec v1):
 * - host the runtime, device lifecycle, and module backends
 * - enforce leases, policies, and the halt coordinator before any invocation
 * - manage long-running operations with idempotency keys
 * - journal control activity and stream runtime events over SSE
 * - expose a local HTTP API bound to loopback by default
 *
 * REMOTE ACCESS IS OFF BY DEFAULT. The daemon refuses to bind a non-loopback
 * host unless `allowRemote` is set AND an auth token is configured. It is
 * never sensible to expose physical control to a network without auth.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { attachStreamSockets } from './streamSocket.js';
import {
  Journal,
  LeaseManager,
  HaltCoordinator,
  OperationManager,
  StreamBus,
  SafetyEngine,
  toStructuredError,
  UnsupportedCapabilityError,
  validateInputSchema,
  ValidationError,
  PinoutError,
  FileJournalStorage,
  type PinoutRuntime,
  type RuntimeEventEnvelope,
  type JournalEntryKind,
  type SafetyRule,
  type Lease,
  type LeaseScopeInput,
  type LeaseMode,
  type ReconciliationResolution,
  runtimeToAgentTools,
} from '@pinout/core';

export interface DaemonConfig {
  host?: string;
  port?: number;
  /** Unix socket path instead of TCP (mutually exclusive with host/port). */
  socketPath?: string;
  /** Bearer token; required when binding a non-loopback host. */
  token?: string;
  /** Explicit opt-in for non-loopback binding. */
  allowRemote?: boolean;
  /** Journal persistence path (JSONL). In-memory when omitted. */
  journalPath?: string;
  /** Safety rules enforced by the daemon for every invocation. */
  safetyRules?: SafetyRule[];
  /** Require an exclusive caller lease for physical outputs. Defaults to true. */
  requireLeases?: boolean;
}

export const DEFAULT_DAEMON_PORT = 8787;

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// ---------------------------------------------------------------------------
// Event hub: fans runtime + operation + safety + lease events to subscribers.
// ---------------------------------------------------------------------------

export interface DaemonEvent {
  kind: 'runtime.event' | 'operation' | 'safety' | 'lease' | 'stream.opened' | 'stream.closed';
  at: number;
  data: Record<string, unknown>;
}

class EventHub {
  private readonly subscribers = new Set<(event: DaemonEvent) => void>();

  subscribe(handler: (event: DaemonEvent) => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  publish(event: DaemonEvent): void {
    for (const handler of this.subscribers) {
      try {
        handler(event);
      } catch {
        // A broken subscriber must never break the runtime event path.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Daemon context: wires all subsystems together.
// ---------------------------------------------------------------------------

export class DaemonContext {
  readonly runtime: PinoutRuntime;
  readonly operations: OperationManager;
  readonly leases: LeaseManager;
  readonly halt: HaltCoordinator;
  readonly safety: SafetyEngine;
  readonly journal: Journal;
  readonly streams: StreamBus;
  readonly events: EventHub;
  readonly startedAt: number;
  readonly ready: Promise<void>;

  constructor(runtime: PinoutRuntime, config: DaemonConfig = {}) {
    this.runtime = runtime;
    this.startedAt = Date.now();
    this.events = new EventHub();
    this.streams = new StreamBus();

    this.journal = new Journal(
      config.journalPath ? { storage: new FileJournalStorage(config.journalPath) } : {},
    );

    this.halt = new HaltCoordinator({
      onStateChange: (change) => {
        this.journal.append('safety.state_changed', {}, { ...change });
        this.events.publish({ kind: 'safety', at: change.at, data: { ...change } });
      },
    });

    this.leases = new LeaseManager();

    const leaseRules: SafetyRule[] =
      config.requireLeases === false
        ? []
        : runtime.devices().flatMap((summary) =>
            runtime
              .getDevice(summary.id)
              .capabilities.filter((capability) => capability.safety.physicalOutput)
              .map((capability) => ({
                kind: 'lease' as const,
                capability: capability.name,
                id: `daemon.default-lease.${summary.id}.${capability.name}`,
              })),
          );
    this.safety = new SafetyEngine({
      rules: [...leaseRules, ...(config.safetyRules ?? [])],
      leaseManager: this.leases,
    });

    this.operations = new OperationManager(
      {
        onOperationEvent: (event) => {
          this.journal.append(
            event.kind as JournalEntryKind,
            {
              deviceId: event.deviceId,
              operationId: event.operationId,
            },
            event.data ?? {},
          );
          this.events.publish({ kind: 'operation', at: event.at, data: { ...event } });
        },
      },
      undefined,
      { journal: this.journal },
    );
    this.ready = this.operations.hydrate();

    // The daemon is the policy authority for an already-registered runtime.
    // Reattach every device before accepting requests so direct runtime calls
    // cannot retain an ungoverned or stale safety engine.
    this.runtime.configureGovernance({
      halt: this.halt,
      safetyEngine: this.safety,
      journal: this.journal,
    });

    this.runtime.on((envelope: RuntimeEventEnvelope) => {
      this.journal.append(
        'event.emitted',
        { deviceId: envelope.deviceId },
        {
          event: envelope.event,
          payload: envelope.payload,
          ...(envelope.stateEvidence ? { stateEvidence: envelope.stateEvidence } : {}),
        },
      );
      this.events.publish({ kind: 'runtime.event', at: envelope.timestamp, data: { ...envelope } });
    });
  }

  /** Acquire a lease with journaling. */
  acquireLease(
    scope: LeaseScopeInput,
    owner: string,
    ttlMs?: number,
    mode: LeaseMode = 'exclusive',
  ): Lease {
    const lease = this.leases.acquire({
      scope,
      owner,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      mode,
    });
    this.journal.append(
      'lease.acquired',
      { deviceId: scope.deviceId },
      {
        leaseId: lease.id,
        owner,
        mode,
        scope,
        expiresAt: lease.expiresAt,
      },
    );
    return lease;
  }

  releaseLease(leaseId: string, owner: string): void {
    const lease = this.leases.get(leaseId);
    this.leases.release(leaseId, owner);
    this.journal.append('lease.released', lease ? { deviceId: lease.scope.deviceId } : {}, {
      leaseId,
      owner,
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

interface RouteMatch {
  params: Record<string, string>;
}

type Handler = (
  ctx: DaemonContext,
  req: IncomingMessage,
  res: ServerResponse,
  match: RouteMatch,
  body: Record<string, unknown> | undefined,
) => Promise<void>;

interface Route {
  method: string;
  pattern: string[];
  handler: Handler;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Expected object.');
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new ValidationError('Request body must be a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function bearerMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const actual = Buffer.from(provided, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1'
    );
  } catch {
    return false;
  }
}

export class DaemonHttpServer {
  private readonly routes: Route[] = [];
  private server: Server | undefined;
  private closeStreamSockets: (() => void) | undefined;
  private readonly ctx!: DaemonContext;

  constructor(private readonly context: DaemonContext) {
    this.registerRoutes();
  }

  private route(method: string, path: string, handler: Handler): void {
    this.routes.push({ method, pattern: path.split('/').filter(Boolean), handler });
  }

  private match(
    method: string,
    pathname: string,
  ): { route: Route; params: Record<string, string> } | undefined {
    const segments = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.pattern.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.pattern.length; i += 1) {
        const part = route.pattern[i];
        const segment = segments[i];
        if (part === undefined || segment === undefined) {
          ok = false;
          break;
        }
        if (part.startsWith(':')) {
          params[part.slice(1)] = decodeURIComponent(segment);
        } else if (part !== segment) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return undefined;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    try {
      await this.context.ready;
      if (pathname === '/v1/health' && req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          uptimeMs: Date.now() - this.context.startedAt,
          safety: this.context.halt.state,
          devices: this.context.runtime.devices().length,
        });
        return;
      }

      const match = this.match(req.method ?? 'GET', pathname);
      if (!match) {
        sendJson(res, 404, {
          error: {
            code: 'NOT_FOUND',
            category: 'DEVICE',
            message: `No route for ${req.method} ${pathname}`,
            retryable: false,
          },
        });
        return;
      }

      const body = ['POST', 'PUT', 'DELETE'].includes(req.method ?? '')
        ? await readBody(req)
        : undefined;
      await match.route.handler(this.context, req, res, { params: match.params }, body);
    } catch (error) {
      const structured = toStructuredError(error);
      const status =
        structured.code === 'DEVICE_NOT_FOUND' || structured.code === 'OPERATION_NOT_FOUND'
          ? 404
          : structured.category === 'VALIDATION'
            ? 400
            : structured.code === 'UNSUPPORTED_CAPABILITY'
              ? 400
              : structured.code === 'OPERATION_REQUIRES_RECONCILIATION' ||
                  structured.code === 'OPERATION_NOT_UNCERTAIN' ||
                  structured.category === 'LEASE' ||
                  structured.category === 'SAFETY' ||
                  structured.category === 'POLICY'
                ? 409
                : structured.category === 'AUTH'
                  ? 401
                  : 500;
      sendJson(res, status, { error: structured });
    }
  }

  private registerRoutes(): void {
    // -- Devices ------------------------------------------------------------
    this.route('GET', '/v1/devices', async (c, req, res) => {
      const includeCapabilities = parseInclude(req).has('capabilities');
      if (!includeCapabilities) {
        sendJson(res, 200, { devices: c.runtime.devices() });
        return;
      }
      sendJson(res, 200, {
        devices: c.runtime.devices().map((summary) => {
          const device = c.runtime.getDevice(summary.id);
          return {
            ...summary,
            capabilityDescriptors: device.capabilities,
          };
        }),
      });
    });

    this.route('GET', '/v1/tools', async (c, _req, res) => {
      sendJson(res, 200, {
        tools: runtimeToAgentTools(c.runtime).map((tool) => ({
          deviceId: tool.deviceId,
          capability: tool.capability,
          mcpName: tool.mcpName,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: tool.annotations,
        })),
      });
    });

    this.route('GET', '/v1/snapshot', async (c, _req, res) => {
      sendJson(res, 200, {
        ok: true,
        uptimeMs: Date.now() - c.startedAt,
        safety: c.halt.state,
        reason: c.halt.reason,
        estopRequested: c.halt.isEstopRequested,
        devices: c.runtime.devices().map((summary) => {
          return snapshotDevice(c.runtime.getDevice(summary.id));
        }),
      });
    });

    this.route('GET', '/v1/devices/:id', async (c, _req, res, match) => {
      const device = c.runtime.getDevice(match.params.id!);
      sendJson(res, 200, {
        ...deviceSummary(device),
        capabilities: device.capabilityNames(),
        capabilityDescriptors: device.capabilities,
        operationalState: device.getOperationalStateSnapshot(),
        stateEvidence: device.getStateEvidence(),
      });
    });

    this.route('GET', '/v1/devices/:id/state', async (c, _req, res, match) => {
      const device = c.runtime.getDevice(match.params.id!);
      sendJson(res, 200, {
        deviceId: device.id,
        state: device.getOperationalStateSnapshot(),
        stateEvidence: device.getStateEvidence(),
        health: device.getHealth(),
      });
    });

    // -- Invoke (dry-run + operations) ---------------------------------------
    this.route('POST', '/v1/devices/:id/invoke', async (c, _req, res, match, body) => {
      const deviceId = match.params.id!;
      const device = c.runtime.getDevice(deviceId);
      const capability = requiredString(body, 'capability');
      if (!device.supports(capability)) {
        throw new UnsupportedCapabilityError(capability);
      }
      const args = (body?.args ?? {}) as Record<string, unknown>;
      const owner = typeof body?.owner === 'string' ? body.owner : undefined;
      const dryRun = body?.dryRun === true;
      const waitFor = body?.waitFor === 'result' ? 'result' : 'accepted';
      const idempotencyKey =
        typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : undefined;

      // A retry observes an existing operation, even after its approval was
      // consumed or the machine halted. It must never spend policy state again.
      const existing =
        !dryRun && idempotencyKey
          ? c.operations.idempotencyStore.lookup(deviceId, capability, owner, idempotencyKey)
          : undefined;
      if (existing?.operationId && c.operations.get(existing.operationId)) {
        const handle = c.operations.getHandle(existing.operationId);
        const snapshot = handle.snapshot();
        if (snapshot.status === 'requires_reconciliation' || snapshot.status === 'uncertain') {
          sendJson(res, 409, {
            error: {
              code: 'OPERATION_REQUIRES_RECONCILIATION',
              category: 'OPERATION',
              message:
                'Operation outcome is uncertain after process restart and requires reconciliation before reuse.',
              operation: snapshot.id,
              status: snapshot.status,
            },
            operation: snapshot,
            deduped: true,
          });
          return;
        }
        if (waitFor === 'result') {
          const result = await handle.waitForResult();
          sendJson(res, 200, { operation: handle.snapshot(), result, deduped: true });
        } else {
          sendJson(res, 202, { operation: handle.snapshot(), deduped: true });
        }
        return;
      }

      // Dry-run plans without executing; the halt gate applies to execution.
      if (!dryRun) {
        c.halt.enforceGate();
      }
      const validated = validateInputSchema(
        device.capabilities.find((cap) => cap.name === capability)!.inputSchema,
        args,
      );
      // Include the device's own baseline/deployment policies in planning.
      await c.runtime.invoke(deviceId, capability, validated, {
        dryRun: true,
        ...(owner !== undefined ? { owner } : {}),
      });
      if (dryRun) {
        sendJson(res, 200, {
          dryRun: true,
          deviceId,
          capability,
          resolvedArgs: validated,
          haltState: c.halt.state,
          policy: { allowed: true },
          wouldExecute: 'runtime.invoke',
        });
        return;
      }

      const { handle, deduped } = c.operations.begin({
        deviceId,
        capability,
        ...(owner !== undefined ? { owner } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        ...(typeof body?.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
        run: async (runCtx) => {
          runCtx.throwIfCancelled();
          c.halt.enforceGate();
          const result = await c.runtime.invoke(deviceId, capability, validated, {
            ...(owner !== undefined ? { owner } : {}),
            signal: runCtx.signal,
            reportProgress: runCtx.reportProgress,
          });
          runCtx.reportProgress(1, 'completed');
          return result;
        },
      });

      if (waitFor === 'result') {
        const result = await handle.waitForResult();
        sendJson(res, 200, { operation: handle.snapshot(), result });
        return;
      }
      sendJson(res, 202, { operation: handle.snapshot(), deduped });
    });

    // -- Operations ----------------------------------------------------------
    this.route('GET', '/v1/operations', async (c, req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const deviceId = url.searchParams.get('deviceId');
      sendJson(res, 200, { operations: c.operations.list(deviceId ? { deviceId } : {}) });
    });

    this.route('GET', '/v1/operations/:id', async (c, _req, res, match) => {
      const snapshot = c.operations.get(match.params.id!);
      if (!snapshot) throw notFound(`Operation '${match.params.id!}' not found.`);
      sendJson(res, 200, { operation: snapshot });
    });

    this.route('POST', '/v1/operations/:id/cancel', async (c, _req, res, match, body) => {
      const reason = typeof body?.reason === 'string' ? body.reason : undefined;
      const snapshot = await c.operations.cancel(match.params.id!, reason);
      sendJson(res, 200, { operation: snapshot });
    });

    this.route('POST', '/v1/operations/:id/reconcile', async (c, _req, res, match, body) => {
      const operationId = match.params.id!;
      const resolution = requiredString(body, 'resolution') as ReconciliationResolution;
      if (
        resolution !== 'observedComplete' &&
        resolution !== 'observedNotDone' &&
        resolution !== 'abandoned'
      ) {
        throw new ValidationError(
          "body.resolution must be 'observedComplete', 'observedNotDone', or 'abandoned'.",
        );
      }
      const note = typeof body?.note === 'string' ? body.note : undefined;
      const actor = typeof body?.actor === 'string' ? body.actor : undefined;
      const snapshot = await c.operations.reconcile(operationId, {
        resolution,
        ...(note !== undefined ? { note } : {}),
        ...(actor !== undefined ? { actor } : {}),
      });
      sendJson(res, 200, { operation: snapshot });
    });

    // -- Leases --------------------------------------------------------------
    this.route('GET', '/v1/leases', async (c, _req, res) => {
      sendJson(res, 200, { leases: c.leases.list() });
    });

    this.route('POST', '/v1/leases', async (c, _req, res, _match, body) => {
      const owner = requiredString(body, 'owner');
      const scope = body?.scope as LeaseScopeInput | undefined;
      if (!scope || (scope.kind !== 'device' && scope.kind !== 'capability')) {
        throw new ValidationError(
          "body.scope must be { kind: 'device', deviceId } or { kind: 'capability', deviceId, capabilities }.",
        );
      }
      const mode = body?.mode === 'shared-read' ? 'shared-read' : 'exclusive';
      const lease = c.acquireLease(
        scope,
        owner,
        typeof body?.ttlMs === 'number' ? body.ttlMs : undefined,
        mode,
      );
      sendJson(res, 201, { lease });
    });

    this.route('POST', '/v1/leases/:id/renew', async (c, _req, res, match, body) => {
      const owner = requiredString(body, 'owner');
      const lease = c.leases.renew(
        match.params.id!,
        owner,
        typeof body?.ttlMs === 'number' ? body.ttlMs : undefined,
      );
      sendJson(res, 200, { lease });
    });

    this.route('DELETE', '/v1/leases/:id', async (c, req, res, match, body) => {
      const owner =
        typeof body?.owner === 'string'
          ? body.owner
          : requiredString(
              {
                owner:
                  new URL(req.url ?? '', 'http://localhost').searchParams.get('owner') ?? undefined,
              },
              'owner',
            );
      c.releaseLease(match.params.id!, owner);
      sendJson(res, 200, { released: true });
    });

    // -- Safety --------------------------------------------------------------
    this.route('GET', '/v1/safety', async (c, _req, res) => {
      sendJson(res, 200, {
        state: c.halt.state,
        reason: c.halt.reason,
        estopRequested: c.halt.isEstopRequested,
      });
    });

    this.route('POST', '/v1/halt', async (c, _req, res, _match, body) => {
      c.halt.halt(
        requiredString(body, 'reason'),
        typeof body?.actor === 'string' ? body.actor : undefined,
      );
      sendJson(res, 200, { state: c.halt.state });
    });

    this.route('POST', '/v1/resume', async (c, _req, res, _match, body) => {
      c.halt.resume(
        typeof body?.reason === 'string' ? body.reason : 'Resume requested via API',
        typeof body?.actor === 'string' ? body.actor : undefined,
      );
      sendJson(res, 200, { state: c.halt.state });
    });

    this.route('POST', '/v1/estop', async (c, _req, res, _match, body) => {
      // Software estop: coordinates runtime response. NOT a certified
      // emergency stop; hardware safeguards remain mandatory.
      c.halt.requestEstop(
        requiredString(body, 'reason'),
        typeof body?.actor === 'string' ? body.actor : undefined,
      );
      sendJson(res, 200, {
        state: c.halt.state,
        note: 'Software estop only. Independent hardware e-stop is still required for any safety-critical deployment.',
      });
    });

    this.route('POST', '/v1/estop/clear', async (c, _req, res, _match, body) => {
      c.halt.clearEstop(typeof body?.actor === 'string' ? body.actor : undefined);
      sendJson(res, 200, { state: c.halt.state });
    });

    // -- Policy feeds -------------------------------------------------------
    this.route('POST', '/v1/approvals', async (c, _req, res, _match, body) => {
      const id = requiredString(body, 'id');
      const deviceId = requiredString(body, 'deviceId');
      const capability = requiredString(body, 'capability');
      const grantedBy = requiredString(body, 'grantedBy');
      const approval = c.safety.recordApproval({
        id,
        deviceId,
        capability,
        grantedBy,
        ...(typeof body?.expiresAt === 'number' ? { expiresAt: body.expiresAt } : {}),
        ...(typeof body?.grantedAt === 'number' ? { grantedAt: body.grantedAt } : {}),
      });
      c.journal.append(
        'policy.rejected',
        { deviceId },
        {
          event: 'approval.granted',
          approvalId: approval.id,
          capability,
          grantedBy,
          expiresAt: approval.expiresAt,
        },
      );
      sendJson(res, 201, { approval });
    });

    this.route('POST', '/v1/devices/:id/heartbeat', async (c, _req, res, match, body) => {
      const deviceId = match.params.id!;
      c.runtime.getDevice(deviceId);
      c.safety.heartbeatDeadman(deviceId);
      c.journal.append(
        'state.changed',
        { deviceId },
        {
          event: 'safety.deadman_heartbeat',
          actor: typeof body?.actor === 'string' ? body.actor : undefined,
          at: Date.now(),
        },
      );
      sendJson(res, 200, { deviceId, alive: true, at: Date.now() });
    });

    // -- Events (SSE) ----------------------------------------------------------
    this.route('GET', '/v1/events', async (c, req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ kind: 'hello', at: Date.now() })}\n\n`);
      const unsubscribe = c.events.subscribe((event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      req.on('close', () => {
        unsubscribe();
      });
    });

    // -- Streams (metadata/snapshot; raw frames use the WebSocket endpoint) -----
    this.route('GET', '/v1/streams', async (c, req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const deviceId = url.searchParams.get('deviceId');
      sendJson(res, 200, { streams: c.streams.list(deviceId ?? undefined) });
    });

    this.route('GET', '/v1/streams/:id/snapshot', async (c, _req, res, match) => {
      const frame = c.streams.snapshot(match.params.id!);
      if (!frame) throw notFound(`No frame available for stream '${match.params.id!}'.`);
      sendJson(res, 200, { frame: { ...frame, data: encodeFrameData(frame.data) } });
    });

    // -- Journal ---------------------------------------------------------------
    this.route('GET', '/v1/journal', async (c, req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const deviceId = url.searchParams.get('deviceId');
      const limit = url.searchParams.get('limit');
      const entries = await c.journal.query({
        ...(deviceId ? { deviceId } : {}),
        ...(limit ? { limit: Number.parseInt(limit, 10) } : {}),
      });
      sendJson(res, 200, { entries });
    });

    // -- Modules (informational) -------------------------------------------------
    this.route('GET', '/v1/modules', async (c, _req, res) => {
      const seen = new Set<string>();
      for (const device of c.runtime.devices()) seen.add(device.moduleId);
      sendJson(res, 200, { modules: [...seen].sort().map((id) => ({ id })) });
    });
  }

  /** Start listening. Returns the resolved address information. */
  async listen(config: DaemonConfig): Promise<{ host: string; port: number; socketPath?: string }> {
    const host = config.host ?? '127.0.0.1';
    const token = config.token;

    if (!isLoopbackHost(host) && (!config.allowRemote || !token)) {
      throw new Error(
        `Refusing to bind non-loopback host '${host}'. Remote access requires allowRemote=true AND an auth token.`,
      );
    }

    const server = createServer((req, res) => {
      // Auth: every /v1 route except health requires the bearer token when set.
      const url = new URL(req.url ?? '/', 'http://localhost');
      const origin = req.headers.origin;
      if (origin && !isLoopbackOrigin(origin)) {
        sendJson(res, 403, {
          error: {
            code: 'ORIGIN_REJECTED',
            category: 'AUTH',
            message: 'Cross-origin requests are not accepted.',
            retryable: false,
          },
        });
        return;
      }
      if (
        ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') &&
        url.pathname.startsWith('/v1/') &&
        url.pathname !== '/v1/health'
      ) {
        const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
        if (contentType !== 'application/json') {
          sendJson(res, 400, {
            error: {
              code: 'JSON_REQUIRED',
              category: 'VALIDATION',
              message: 'Mutating requests must use application/json.',
              retryable: false,
            },
          });
          return;
        }
      }
      if (token && url.pathname.startsWith('/v1/') && url.pathname !== '/v1/health') {
        const provided = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!bearerMatches(provided, token)) {
          sendJson(res, 401, {
            error: {
              code: 'AUTH_REQUIRED',
              category: 'AUTH',
              message: 'Missing or invalid bearer token.',
              retryable: false,
            },
          });
          return;
        }
      }
      void this.handle(req, res);
    });

    this.server = server;
    this.closeStreamSockets = attachStreamSockets(server, this.context.streams, token);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      if (config.socketPath) {
        server.listen(config.socketPath, () => resolve());
      } else {
        server.listen(config.port ?? DEFAULT_DAEMON_PORT, host, () => resolve());
      }
    });

    return config.socketPath
      ? { host: '', port: 0, socketPath: config.socketPath }
      : { host, port: (server.address() as { port: number }).port };
  }

  async close(): Promise<void> {
    this.closeStreamSockets?.();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      // Force-close lingering keep-alive/SSE connections.
      this.server.closeAllConnections?.();
    });
    await this.context.journal.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseInclude(req: IncomingMessage): Set<string> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  return new Set(
    (url.searchParams.get('include') ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
}

function snapshotDevice(device: ReturnType<PinoutRuntime['getDevice']>): Record<string, unknown> {
  return {
    ...deviceSummary(device),
    capabilities: device.capabilityNames(),
    capabilityDescriptors: device.capabilities,
    operationalState: device.getOperationalStateSnapshot(),
    stateEvidence: device.getStateEvidence(),
    health: device.getHealth(),
  };
}

function deviceSummary(device: ReturnType<PinoutRuntime['getDevice']>): Record<string, unknown> {
  const health = device.getHealth();
  const summary: Record<string, unknown> = {
    id: device.id,
    deviceClass: device.deviceClass,
    moduleId: device.moduleId,
    lifecycle: health.lifecycle,
    simulated: device.simulated,
    activeTransportKind: device.activeTransportKind,
    stateEvidence: device.getStateEvidence(),
  };
  if (device.identity.vendor !== undefined) {
    summary.vendor = device.identity.vendor;
  }
  if (device.identity.model !== undefined) {
    summary.model = device.identity.model;
  }
  if (device.identity.label !== undefined) {
    summary.label = device.identity.label;
  }
  return summary;
}

function requiredString(body: Record<string, unknown> | undefined, field: string): string {
  const value = body?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`Body field '${field}' is required and must be a non-empty string.`);
  }
  return value;
}

function notFound(message: string): Error {
  return new PinoutError('DEVICE_NOT_FOUND', message);
}

function encodeFrameData(data: unknown): unknown {
  if (data instanceof Uint8Array) {
    return { encoding: 'base64', bytes: Buffer.from(data).toString('base64') };
  }
  return data;
}

export { randomUUID };
