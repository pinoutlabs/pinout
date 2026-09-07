import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  buildMcpToolName,
  parseMcpToolName,
  PINOUT_VERSION,
  type CapabilityDescriptor,
  type RuntimeAgentTool,
} from '@pinout/core';
import { controlPlaneTools, formatToolError, success, toMcpTool } from './createRuntimeServer.js';

const toolsCacheTtlMs = 2000;

export interface DaemonMcpServerOptions {
  baseUrl?: string;
  token?: string;
  owner?: string;
  fetch?: typeof globalThis.fetch;
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
  const server = new Server(
    { name: 'pinout-daemon', version: PINOUT_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let runtimeToolsList: RuntimeAgentTool[] = [];
    try {
      runtimeToolsList = await client.runtimeTools();
    } catch {
      runtimeToolsList = [];
    }
    return {
      tools: [...controlPlaneTools(), ...runtimeToolsList.map(toMcpTool)],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (request.params.name) {
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
      client.invalidateToolsCache();
      return success(
        await client.call('POST', `/v1/devices/${segment(resolved.deviceId)}/invoke`, {
          capability: resolved.capability,
          args: capabilityArgs,
          owner: client.ownerFor(control),
          waitFor: control.waitFor === 'accepted' ? 'accepted' : 'result',
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
    this.owner = options.owner ?? 'mcp-stdio';
    // Reuse one fetch so Node's undici dispatcher can keep-alive to pinoutd.
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  ownerFor(_args: Record<string, unknown>): string {
    return this.owner;
  }

  invalidateToolsCache(): void {
    this.toolsCache = undefined;
  }

  async call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.request(method, path, body);
    if (!result.response.ok) {
      throw daemonHttpError(result.response.status, result.payload);
    }
    return result.payload;
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

  /** GET an additive route; null if the daemon has not implemented it yet. */
  private async tryGetOptional(path: string): Promise<Record<string, unknown> | null> {
    const result = await this.request('GET', path);
    if (result.response.ok) {
      return result.payload;
    }
    if (isMissingRoute(result.response.status, result.payload)) {
      return null;
    }
    throw daemonHttpError(result.response.status, result.payload);
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<DaemonJsonResult> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
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

async function resolveCapabilityTarget(
  client: DaemonClient,
  mcpName: string,
): Promise<{ deviceId: string; capability: string } | null> {
  const parsed = parseMcpToolName(mcpName);
  if (parsed) {
    return parsed;
  }
  const tool = (await client.runtimeTools()).find((candidate) => candidate.mcpName === mcpName);
  if (!tool) return null;
  return { deviceId: tool.deviceId, capability: tool.capability };
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
