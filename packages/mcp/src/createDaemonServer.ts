import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AwarenessClient } from '@pinout/awareness';
import {
  buildMcpToolName,
  parseMcpToolName,
  PINOUT_VERSION,
  type CapabilityDescriptor,
  type RuntimeAgentTool,
} from '@pinout/core';
import {
  awarenessControlPlaneTools,
  awarenessToolNames,
  attachAwarenessSurface,
} from './awarenessSurface.js';
import { controlPlaneTools, formatToolError, success, toMcpTool } from './createRuntimeServer.js';

const toolsCacheTtlMs = 2000;
/** Default max time pinout__invoke blocks waiting for a terminal result. */
export const DEFAULT_INVOKE_WAIT_MS = 10_000;
const operationPollIntervalMs = 50;

export interface DaemonMcpServerOptions {
  baseUrl?: string;
  token?: string;
  owner?: string;
  fetch?: typeof globalThis.fetch;
  /** Compatibility only: expose per-device tool names. Default catalog is static. */
  dynamicTools?: boolean;
  /**
   * Subscribe to awareness/connector SSE and emit MCP list-changed / resource updates.
   * Default true for daemon-backed servers.
   */
  awarenessWatch?: boolean;
  /**
   * Max milliseconds `pinout__invoke` (waitFor=result) will block before returning
   * OPERATION_PENDING. Default 10_000. Aligns the client fetch timeout with this budget.
   */
  invokeWaitMs?: number;
}

interface DaemonDeviceSummary {
  id: string;
  [key: string]: unknown;
}

interface DaemonDeviceDescription {
  capabilityDescriptors?: CapabilityDescriptor[];
  capabilities?: unknown;
  [key: string]: unknown;
}

interface DaemonJsonResult {
  response: Response;
  payload: Record<string, unknown>;
}

/** MCP client for the single authoritative pinoutd process. */
export function createDaemonMcpServer(options: DaemonMcpServerOptions = {}): Server {
  const client = new DaemonClient(options);
  const invokeWaitMs = options.invokeWaitMs ?? DEFAULT_INVOKE_WAIT_MS;
  const baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
  const awarenessClient = new AwarenessClient({
    baseUrl,
    ...(options.token ? { token: options.token } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const server = new Server(
    { name: 'pinout-daemon', version: PINOUT_VERSION },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
      },
    },
  );

  const awareness = attachAwarenessSurface({
    server,
    client,
    awarenessClient,
    onToolsMayHaveChanged: () => {
      void server.sendToolListChanged().catch(() => undefined);
    },
  });

  const watchEnabled = options.awarenessWatch !== false;
  const previousOnInitialized = server.oninitialized;
  server.oninitialized = () => {
    previousOnInitialized?.();
    if (watchEnabled) awareness.start();
  };
  const previousOnClose = server.onclose;
  server.onclose = () => {
    awareness.stop();
    previousOnClose?.();
  };
  const originalClose = server.close.bind(server);
  server.close = async () => {
    awareness.stop();
    return originalClose();
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let runtimeToolsList: RuntimeAgentTool[] = [];
    try {
      if (options.dynamicTools) runtimeToolsList = await client.runtimeTools();
    } catch {
      runtimeToolsList = [];
    }
    return {
      tools: [
        ...controlPlaneTools(),
        ...awarenessControlPlaneTools(),
        staticInvokeTool,
        ...runtimeToolsList.map(toMcpTool),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (awarenessToolNames.has(request.params.name)) {
        const handled = await awareness.handleToolCall(request.params.name, args);
        if (handled) return handled;
      }

      switch (request.params.name) {
        case 'pinout__invoke': {
          if (!args.args || typeof args.args !== 'object' || Array.isArray(args.args))
            throw structured('VALIDATION_ERROR', 'args must be an object.');
          client.invalidateToolsCache();
          return success(
            await invokeWithBoundedWait(client, {
              deviceId: required(args, 'deviceId'),
              capability: required(args, 'capability'),
              args: args.args as Record<string, unknown>,
              owner: client.ownerFor(args),
              waitFor: args.waitFor === 'accepted' ? 'accepted' : 'result',
              invokeWaitMs,
              ...(typeof args.idempotencyKey === 'string'
                ? { idempotencyKey: args.idempotencyKey }
                : {}),
              ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
            }),
          );
        }
        case 'pinout__list_devices':
          return success(await client.call('GET', '/v1/devices'));
        case 'pinout__snapshot':
          return success(await client.snapshot());
        case 'pinout__describe_device': {
          const raw = await client.call(
            'GET',
            `/v1/devices/${segment(required(args, 'deviceId'))}`,
          );
          return success(describeDeviceView(raw));
        }
        case 'pinout__read_state': {
          const raw = await client.call(
            'GET',
            `/v1/devices/${segment(required(args, 'deviceId'))}/state`,
          );
          return success({
            deviceId: raw.deviceId,
            state: (raw.state as Record<string, unknown>) ?? {},
            stateEvidence: (raw.stateEvidence as Record<string, unknown>) ?? {},
            ...(raw.health ? { health: raw.health } : {}),
          });
        }
        case 'pinout__safety_status':
          return success(await client.call('GET', '/v1/safety'));
        case 'pinout__acquire_lease':
          client.invalidateToolsCache();
          return success(
            await client.call('POST', '/v1/leases', {
              owner: client.ownerFor(args),
              mode: args.mode ?? 'exclusive',
              ...(typeof args.ttlMs === 'number' ? { ttlMs: args.ttlMs } : {}),
              scope: { kind: 'device', deviceId: required(args, 'deviceId') },
            }),
          );
        case 'pinout__renew_lease': {
          client.invalidateToolsCache();
          const owner = client.ownerFor(args);
          return success(
            await client.call('POST', `/v1/leases/${segment(required(args, 'leaseId'))}/renew`, {
              owner,
              ...(typeof args.ttlMs === 'number' ? { ttlMs: args.ttlMs } : {}),
            }),
          );
        }
        case 'pinout__release_lease': {
          client.invalidateToolsCache();
          const owner = client.ownerFor(args);
          return success(
            await client.call(
              'DELETE',
              `/v1/leases/${segment(required(args, 'leaseId'))}?owner=${encodeURIComponent(owner)}`,
              { owner },
            ),
          );
        }
        case 'pinout__heartbeat':
          return success(
            await client.call(
              'POST',
              `/v1/devices/${segment(required(args, 'deviceId'))}/heartbeat`,
              {
                actor: client.ownerFor(args),
              },
            ),
          );
        case 'pinout__dry_run':
          return success(
            await client.call('POST', `/v1/devices/${segment(required(args, 'deviceId'))}/invoke`, {
              capability: required(args, 'capability'),
              args: objectArg(args.args),
              owner: client.ownerFor(args),
              dryRun: true,
            }),
          );
        case 'pinout__operation_status':
          return success(
            await client.call('GET', `/v1/operations/${segment(required(args, 'operationId'))}`),
          );
        case 'pinout__cancel_operation':
          return success(
            await client.call(
              'POST',
              `/v1/operations/${segment(required(args, 'operationId'))}/cancel`,
              typeof args.reason === 'string' ? { reason: args.reason } : {},
            ),
          );
      }

      const resolved = await resolveCapabilityTarget(client, request.params.name);
      if (!resolved) throw structured('UNKNOWN_TOOL', `Unknown tool '${request.params.name}'.`);
      const control = objectArg(args._pinout);
      const capabilityArgs = { ...args };
      delete capabilityArgs._pinout;
      const physicalFromTool = resolved.physicalOutput;
      client.invalidateToolsCache();
      return success(
        await invokeWithBoundedWait(client, {
          deviceId: resolved.deviceId,
          capability: resolved.capability,
          args: capabilityArgs,
          owner: client.ownerFor({ ...control, ...capabilityArgs }),
          waitFor: control.waitFor === 'accepted' ? 'accepted' : 'result',
          invokeWaitMs,
          ...(physicalFromTool !== undefined ? { physicalOutput: physicalFromTool } : {}),
          ...(typeof control.idempotencyKey === 'string'
            ? { idempotencyKey: control.idempotencyKey }
            : {}),
          ...(typeof control.timeoutMs === 'number' ? { timeoutMs: control.timeoutMs } : {}),
        }),
      );
    } catch (error) {
      return formatToolError(error);
    }
  });

  return server;
}

class DaemonClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchFn: typeof globalThis.fetch;
  readonly owner: string;
  private toolsCache: { tools: RuntimeAgentTool[]; expiresAt: number } | undefined;

  constructor(options: DaemonMcpServerOptions) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
    this.token = options.token;
    this.owner = options.owner ?? process.env.PINOUT_OWNER ?? 'mcp-stdio';
    // Reuse one fetch so Node's undici dispatcher can keep-alive to pinoutd.
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  /**
   * Resolve the lease/idempotency owner for a call.
   * Preference: explicit `owner` arg → `threadId` / `ownerThreadId` → default owner.
   * This lets Infinity (and similar runtimes) isolate per-thread principals without
   * sharing one global PINOUT_OWNER across concurrent agent threads.
   */
  ownerFor(args: Record<string, unknown>): string {
    if (typeof args.owner === 'string' && args.owner.length > 0) return args.owner;
    if (typeof args.threadId === 'string' && args.threadId.length > 0) {
      return `${this.owner}:${args.threadId}`;
    }
    if (typeof args.ownerThreadId === 'string' && args.ownerThreadId.length > 0) {
      return `${this.owner}:${args.ownerThreadId}`;
    }
    return this.owner;
  }

  invalidateToolsCache(): void {
    this.toolsCache = undefined;
  }

  async call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    callOptions?: { fetchTimeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const result = await this.request(method, path, body, callOptions?.fetchTimeoutMs);
    if (!result.response.ok) {
      throw daemonHttpError(result.response.status, result.payload);
    }
    return result.payload;
  }

  /** GET an additive route; null if the daemon has not implemented it yet. */
  async tryGetOptional(path: string): Promise<Record<string, unknown> | null> {
    const result = await this.request('GET', path);
    if (result.response.ok) {
      return result.payload;
    }
    if (isMissingRoute(result.response.status, result.payload)) {
      return null;
    }
    throw daemonHttpError(result.response.status, result.payload);
  }

  /** Open an SSE body stream; null when the route is missing. */
  async openEventStream(
    path: string,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array> | null> {
    if (signal?.aborted) return null;
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers,
        ...(signal ? { signal } : {}),
      });
    } catch {
      return null;
    }
    if (!response.ok || !response.body) {
      return null;
    }
    return response.body;
  }

  async runtimeTools(): Promise<RuntimeAgentTool[]> {
    const now = Date.now();
    if (this.toolsCache && this.toolsCache.expiresAt > now) {
      return this.toolsCache.tools;
    }
    const tools = await this.loadRuntimeTools();
    this.toolsCache = { tools, expiresAt: now + toolsCacheTtlMs };
    return tools;
  }

  async snapshot(): Promise<Record<string, unknown>> {
    const fromEndpoint = await this.tryGetOptional('/v1/snapshot');
    if (fromEndpoint) {
      return fromEndpoint;
    }
    return this.snapshotFromDevices();
  }

  private async loadRuntimeTools(): Promise<RuntimeAgentTool[]> {
    const fromEndpoint = await this.tryGetOptional('/v1/tools');
    if (fromEndpoint) {
      const parsed = toolsFromDaemonPayload(fromEndpoint);
      if (parsed) return parsed;
    }
    return this.runtimeToolsFromDeviceDescribes();
  }

  private async runtimeToolsFromDeviceDescribes(): Promise<RuntimeAgentTool[]> {
    const list = await this.call('GET', '/v1/devices');
    const devices = Array.isArray(list.devices) ? (list.devices as DaemonDeviceSummary[]) : [];
    const descriptions = await Promise.all(
      devices.map(async (device) => ({
        device,
        description: (await this.call(
          'GET',
          `/v1/devices/${segment(device.id)}`,
        )) as DaemonDeviceDescription,
      })),
    );
    return descriptions.flatMap(({ device, description }) => {
      const descriptors = Array.isArray(description.capabilityDescriptors)
        ? description.capabilityDescriptors
        : [];
      return descriptors.map((capability) => toRuntimeTool(device.id, capability));
    });
  }

  private async snapshotFromDevices(): Promise<Record<string, unknown>> {
    const [list, safety] = await Promise.all([
      this.call('GET', '/v1/devices'),
      this.call('GET', '/v1/safety'),
    ]);
    const devices = Array.isArray(list.devices) ? (list.devices as DaemonDeviceSummary[]) : [];
    const detailed = await Promise.all(
      devices.map(async (device) => {
        try {
          const description = await this.call('GET', `/v1/devices/${segment(device.id)}`);
          const merged: Record<string, unknown> = { ...device, ...description };
          if (merged.simulated === undefined && typeof device.simulated === 'boolean') {
            merged.simulated = device.simulated;
          }
          return describeDeviceView(merged);
        } catch {
          const state = await this.call('GET', `/v1/devices/${segment(device.id)}/state`);
          return {
            identity: { id: device.id },
            health: (state.health as Record<string, unknown>) ?? {},
            operationalState: (state.state as Record<string, unknown>) ?? {},
            stateEvidence: (state.stateEvidence as Record<string, unknown>) ?? {},
            capabilities: [],
          };
        }
      }),
    );
    return {
      safety: typeof safety.state === 'string' ? safety.state : safety,
      devices: detailed,
    };
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    fetchTimeoutMs = 30_000,
  ): Promise<DaemonJsonResult> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const timeoutMs = Math.max(1_000, fetchTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (networkError) {
      throw structured(
        'DAEMON_UNAVAILABLE',
        `Unable to reach pinoutd daemon at ${this.baseUrl}: ${networkError instanceof Error ? networkError.message : String(networkError)}. Ensure pinoutd is running and PINOUT_DAEMON_URL is configured correctly.`,
      );
    }
    let payload: Record<string, unknown>;
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    return { response, payload };
  }
}

interface InvokeBoundedOptions {
  deviceId: string;
  capability: string;
  args: Record<string, unknown>;
  owner: string;
  waitFor: 'result' | 'accepted';
  invokeWaitMs: number;
  idempotencyKey?: string;
  timeoutMs?: number;
  /** When known (e.g. from dynamic tool annotations), skip the device GET. */
  physicalOutput?: boolean;
}

/**
 * Accept the operation immediately, then optionally wait up to `invokeWaitMs`
 * for a terminal status. Long-running work returns OPERATION_PENDING with
 * poll/cancel instructions instead of hanging until the fetch aborts as
 * DAEMON_UNAVAILABLE (critical when Infinity pauses the agent mid-tool-call).
 */
async function invokeWithBoundedWait(
  client: DaemonClient,
  options: InvokeBoundedOptions,
): Promise<Record<string, unknown>> {
  // Prefer a caller key; otherwise generate only when we already know the
  // capability is a physical output (dynamic tool annotations). Otherwise let
  // the daemon auto-generate so we never N+1 GET /v1/devices/:id on invoke.
  let idempotencyKey = options.idempotencyKey;
  let idempotencyKeyGenerated = false;
  if (!idempotencyKey && options.physicalOutput === true) {
    idempotencyKey = deterministicIdempotencyKey(
      options.deviceId,
      options.capability,
      options.args,
      options.owner,
    );
    idempotencyKeyGenerated = true;
  }

  const waitBudgetMs = Math.max(1, options.invokeWaitMs);
  const operationTimeoutMs = options.timeoutMs;
  // Fetch timeout must cover the accept round-trip; keep it aligned with the
  // caller's timeoutMs when provided, otherwise the wait budget (+slack).
  const fetchTimeoutMs =
    typeof operationTimeoutMs === 'number'
      ? Math.max(operationTimeoutMs + 1_000, waitBudgetMs + 1_000)
      : waitBudgetMs + 5_000;

  const accepted = await client.call(
    'POST',
    `/v1/devices/${segment(options.deviceId)}/invoke`,
    {
      capability: options.capability,
      args: options.args,
      owner: options.owner,
      waitFor: 'accepted',
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(typeof operationTimeoutMs === 'number' ? { timeoutMs: operationTimeoutMs } : {}),
    },
    { fetchTimeoutMs },
  );

  const operation = objectArg(accepted.operation);
  const operationId = typeof operation.id === 'string' ? operation.id : undefined;
  const keyMeta = {
    ...(typeof accepted.idempotencyKey === 'string'
      ? { idempotencyKey: accepted.idempotencyKey }
      : idempotencyKey
        ? { idempotencyKey }
        : {}),
    ...(idempotencyKeyGenerated || accepted.idempotencyKeyGenerated
      ? { idempotencyKeyGenerated: true }
      : {}),
    ...(accepted.deduped === true ? { deduped: true } : {}),
  };

  if (options.waitFor === 'accepted' || !operationId) {
    return { ...accepted, ...keyMeta };
  }

  if (isTerminalOperationStatus(operation.status)) {
    throwIfOperationFailed(operation, keyMeta);
    return { ...accepted, ...keyMeta };
  }

  const deadline = Date.now() + waitBudgetMs;
  let latest: Record<string, unknown> = accepted;
  while (Date.now() < deadline) {
    await sleep(operationPollIntervalMs);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const statusPayload = await client.call(
      'GET',
      `/v1/operations/${segment(operationId)}`,
      undefined,
      { fetchTimeoutMs: Math.max(1_000, remaining + 500) },
    );
    latest = statusPayload;
    const snapshot = objectArg(statusPayload.operation);
    if (isTerminalOperationStatus(snapshot.status)) {
      throwIfOperationFailed(snapshot, keyMeta);
      return {
        operation: snapshot,
        ...(snapshot.result !== undefined
          ? { result: snapshot.result }
          : statusPayload.result !== undefined
            ? { result: statusPayload.result }
            : {}),
        ...keyMeta,
      };
    }
  }

  const pendingOperation = objectArg(latest.operation);
  return {
    code: 'OPERATION_PENDING',
    message:
      'Operation accepted but did not reach a terminal state within the invoke wait budget. Poll pinout__operation_status or cancel with pinout__cancel_operation; retry with the same idempotencyKey to observe the original operation without re-actuating.',
    operationId,
    operation: Object.keys(pendingOperation).length > 0 ? pendingOperation : operation,
    waitMs: waitBudgetMs,
    poll: { tool: 'pinout__operation_status', arguments: { operationId } },
    cancel: { tool: 'pinout__cancel_operation', arguments: { operationId } },
    retryable: true,
    ...keyMeta,
  };
}

function isTerminalOperationStatus(status: unknown): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timed_out' ||
    status === 'rejected'
  );
}

function throwIfOperationFailed(
  snapshot: Record<string, unknown>,
  keyMeta: Record<string, unknown>,
): void {
  if (snapshot.status === 'completed') return;
  const error = objectArg(snapshot.error);
  throw structured(
    typeof error.code === 'string' ? error.code : `OPERATION_${String(snapshot.status).toUpperCase()}`,
    typeof error.message === 'string'
      ? error.message
      : `Operation ended with status '${String(snapshot.status)}'.`,
    {
      ...error,
      operationId: snapshot.id,
      status: snapshot.status,
      ...keyMeta,
    },
  );
}

function deterministicIdempotencyKey(
  deviceId: string,
  capability: string,
  args: Record<string, unknown>,
  owner: string,
): string {
  const payload = stableStringify({ deviceId, capability, args, owner });
  return `auto-${createHash('sha256').update(payload).digest('hex').slice(0, 32)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveCapabilityTarget(
  client: DaemonClient,
  mcpName: string,
): Promise<{ deviceId: string; capability: string; physicalOutput?: boolean } | null> {
  // Prefer parsing the static MCP name so capability invokes do not N+1 GET devices.
  const parsed = parseMcpToolName(mcpName);
  if (parsed) {
    return parsed;
  }
  const tool = (await client.runtimeTools()).find((candidate) => candidate.mcpName === mcpName);
  if (!tool) return null;
  return {
    deviceId: tool.deviceId,
    capability: tool.capability,
    physicalOutput: tool.annotations.physicalOutput,
  };
}

function toolsFromDaemonPayload(payload: Record<string, unknown>): RuntimeAgentTool[] | null {
  if (!Array.isArray(payload.tools)) {
    return null;
  }
  return payload.tools.map((raw) => toolFromDaemonEntry(raw));
}

function toolFromDaemonEntry(raw: unknown): RuntimeAgentTool {
  const tool = objectArg(raw);
  const deviceId = typeof tool.deviceId === 'string' ? tool.deviceId : '';
  const capability =
    typeof tool.capability === 'string'
      ? tool.capability
      : typeof tool.name === 'string'
        ? tool.name
        : '';
  const annotations = objectArg(tool.annotations);
  return {
    name: typeof tool.name === 'string' ? tool.name : capability,
    mcpName:
      typeof tool.mcpName === 'string' ? tool.mcpName : buildMcpToolName(deviceId, capability),
    deviceId,
    capability,
    description: typeof tool.description === 'string' ? tool.description : '',
    inputSchema: objectArg(tool.inputSchema) as RuntimeAgentTool['inputSchema'],
    outputSchema: objectArg(tool.outputSchema) as RuntimeAgentTool['outputSchema'],
    annotations: {
      physicalOutput: Boolean(annotations.physicalOutput),
      reversible: Boolean(annotations.reversible),
      ...(typeof annotations.notes === 'string' ? { notes: annotations.notes } : {}),
    },
  };
}

function describeDeviceView(raw: Record<string, unknown>): Record<string, unknown> {
  const rawHealth =
    raw.health && typeof raw.health === 'object'
      ? (raw.health as Record<string, unknown>)
      : { lifecycle: raw.lifecycle ?? 'ready', healthy: true };
  const rawIdentity =
    raw.identity && typeof raw.identity === 'object'
      ? (raw.identity as Record<string, unknown>)
      : { id: raw.id, moduleId: raw.moduleId, deviceClass: raw.deviceClass };
  const rawSupportedTransports = Array.isArray(raw.supportedTransportKinds)
    ? (raw.supportedTransportKinds as string[])
    : typeof raw.activeTransportKind === 'string'
      ? [raw.activeTransportKind]
      : ['simulated'];
  const capabilityDescriptors = Array.isArray(raw.capabilityDescriptors)
    ? raw.capabilityDescriptors
    : Array.isArray(raw.capabilities)
      ? raw.capabilities
      : [];
  return {
    identity: rawIdentity,
    health: rawHealth,
    simulated: Boolean(raw.simulated),
    activeTransportKind: (raw.activeTransportKind as string) ?? 'simulated',
    supportedTransportKinds: rawSupportedTransports,
    capabilities: capabilityDescriptors,
    operationalState: (raw.operationalState as Record<string, unknown>) ?? {},
    stateEvidence: (raw.stateEvidence as Record<string, unknown>) ?? {},
  };
}

function toRuntimeTool(deviceId: string, capability: CapabilityDescriptor): RuntimeAgentTool {
  return {
    name: capability.name,
    mcpName: buildMcpToolName(deviceId, capability.name),
    deviceId,
    capability: capability.name,
    description: `[${deviceId}] ${capability.description}`,
    inputSchema: capability.inputSchema,
    outputSchema: capability.outputSchema,
    annotations: {
      physicalOutput: capability.safety.physicalOutput,
      reversible: capability.safety.reversible,
      ...(capability.safety.notes ? { notes: capability.safety.notes } : {}),
    },
  };
}

function isMissingRoute(status: number, payload: Record<string, unknown>): boolean {
  if (status === 404) return true;
  const error = objectArg(payload.error);
  if (error.code === 'NOT_FOUND') return true;
  return typeof error.message === 'string' && /no route/i.test(error.message);
}

function daemonHttpError(status: number, payload: Record<string, unknown>) {
  const error = objectArg(payload.error);
  return structured(
    typeof error.code === 'string' ? error.code : 'DAEMON_REQUEST_FAILED',
    typeof error.message === 'string' ? error.message : `pinoutd returned HTTP ${status}.`,
    error,
  );
}

function required(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw structured('VALIDATION_ERROR', `${name} must be a non-empty string.`);
  }
  return value;
}

function objectArg(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function structured(code: string, message: string, details?: Record<string, unknown>) {
  return { code, message, retryable: false, ...(details ? { metadata: details } : {}) };
}

const staticInvokeTool = {
  name: 'pinout__invoke',
  description:
    'Invoke a supported capability on a currently connected device. First list and describe devices for capability schemas and board pin maps. Pins are numeric: Uno A0-A5 = 14-19. Acquire a lease, explicitly sys.arm before output, then gpio.write. Never guess wiring. Acknowledgment/readback is not proof an LED physically illuminated. Unsupported capabilities and pins are rejected by the runtime. waitFor=result blocks at most ~10s (configurable) then returns OPERATION_PENDING with operationId — poll pinout__operation_status or cancel with pinout__cancel_operation. Physical outputs auto-generate a deterministic idempotencyKey when omitted so retries after an agent pause never double-actuate.',
  inputSchema: {
    type: 'object' as const,
    additionalProperties: false,
    required: ['deviceId', 'capability', 'args'],
    properties: {
      deviceId: { type: 'string' },
      capability: { type: 'string' },
      args: { type: 'object', additionalProperties: true },
      idempotencyKey: { type: 'string' },
      timeoutMs: { type: 'integer', minimum: 1 },
      waitFor: { type: 'string', enum: ['result', 'accepted'] },
      owner: {
        type: 'string',
        description: 'Optional per-call owner / principal (overrides PINOUT_OWNER).',
      },
      threadId: {
        type: 'string',
        description: 'Optional agent thread id; scopes owner as <defaultOwner>:<threadId>.',
      },
    },
  },
  annotations: {
    readOnlyHint: false,
    // Conservative: pinout__invoke can actuate physical outputs.
    destructiveHint: true,
    // Retries are only safe when the same idempotencyKey is reused.
    idempotentHint: false,
    title: 'Invoke Pinout capability',
  },
};
