import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { PinoutRuntime } from '@pinout/core';
import {
  parseMcpToolName,
  PINOUT_VERSION,
  runtimeToAgentTools,
  type RuntimeAgentTool,
} from '@pinout/core';

const listDevicesToolName = 'pinout__list_devices';
const describeDeviceToolName = 'pinout__describe_device';
const readStateToolName = 'pinout__read_state';
const safetyStatusToolName = 'pinout__safety_status';
const snapshotToolName = 'pinout__snapshot';
const acquireLeaseToolName = 'pinout__acquire_lease';
const releaseLeaseToolName = 'pinout__release_lease';
const dryRunToolName = 'pinout__dry_run';
const operationStatusToolName = 'pinout__operation_status';
const cancelOperationToolName = 'pinout__cancel_operation';

const reservedControlPlaneNames = new Set([
  listDevicesToolName,
  describeDeviceToolName,
  readStateToolName,
  safetyStatusToolName,
  snapshotToolName,
  acquireLeaseToolName,
  releaseLeaseToolName,
  dryRunToolName,
  operationStatusToolName,
  cancelOperationToolName,
]);

export interface RuntimeMcpServerOptions {
  /** Principal associated with this MCP transport for lease-aware policies. */
  owner?: string;
}

export function createRuntimeMcpServer(
  runtime: PinoutRuntime,
  options: RuntimeMcpServerOptions = {},
): Server {
  const server = new Server(
    { name: 'pinout-runtime', version: PINOUT_VERSION },
    { capabilities: { tools: {} } },
  );

  let cachedToolsKey = '';
  let cachedRuntimeTools: RuntimeAgentTool[] = [];

  function getRuntimeTools(): RuntimeAgentTool[] {
    const key = runtimeToolsCacheKey(runtime);
    if (key === cachedToolsKey) {
      return cachedRuntimeTools;
    }
    cachedRuntimeTools = runtimeTools(runtime);
    cachedToolsKey = key;
    return cachedRuntimeTools;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...controlPlaneTools(), ...getRuntimeTools().map(toMcpTool)],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === listDevicesToolName) {
      return success({ devices: runtime.devices() });
    }

    if (request.params.name === describeDeviceToolName) {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      if (typeof args.deviceId !== 'string' || args.deviceId.length === 0) {
        return formatToolError(new Error('deviceId must be a non-empty string.'));
      }
      try {
        const device = runtime.getDevice(args.deviceId);
        return success({
          identity: device.identity,
          health: device.getHealth(),
          simulated: device.simulated,
          activeTransportKind: device.activeTransportKind,
          supportedTransportKinds: device.transportKinds,
          capabilities: device.capabilities,
          operationalState: device.getOperationalStateSnapshot(),
          stateEvidence: device.getStateEvidence(),
        });
      } catch (error) {
        return formatToolError(error);
      }
    }
    if (request.params.name === readStateToolName) {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      if (typeof args.deviceId !== 'string' || args.deviceId.length === 0) {
        return formatToolError(new Error('deviceId must be a non-empty string.'));
      }
      try {
        const device = runtime.getDevice(args.deviceId);
        return success({
          deviceId: args.deviceId,
          state: device.getOperationalStateSnapshot(),
          stateEvidence: device.getStateEvidence(),
        });
      } catch (error) {
        return formatToolError(error);
      }
    }
    if (request.params.name === safetyStatusToolName) {
      return success({ state: runtime.halt.state });
    }
    if (request.params.name === snapshotToolName) {
      return success(embeddedSnapshot(runtime));
    }
    // These control-plane tools are intentionally capability-discovery tools
    // until a daemon-backed manager is supplied. Embedded runtimes can expose
    // compatible manager methods without making MCP reach into device backends.
    if (
      [
        acquireLeaseToolName,
        releaseLeaseToolName,
        dryRunToolName,
        operationStatusToolName,
        cancelOperationToolName,
      ].includes(request.params.name)
    ) {
      return formatToolError({
        code: 'CONTROL_PLANE_UNAVAILABLE',
        message: 'This embedded MCP runtime has no daemon control-plane manager.',
        retryable: false,
      });
    }

    const parsed = parseMcpToolName(request.params.name);
    let deviceId: string | undefined;
    let capability: string | undefined;
    if (parsed) {
      deviceId = parsed.deviceId;
      capability = parsed.capability;
    } else {
      const tool = getRuntimeTools().find((candidate) => candidate.mcpName === request.params.name);
      if (tool) {
        deviceId = tool.deviceId;
        capability = tool.capability;
      }
    }
    if (!deviceId || !capability) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool '${request.params.name}'.` }],
      };
    }

    const args = { ...((request.params.arguments ?? {}) as Record<string, unknown>) };
    delete args._pinout;
    try {
      const result = await runtime.invoke(deviceId, capability, args, {
        owner: options.owner ?? 'mcp-stdio',
      });
      return success(result);
    } catch (error) {
      return formatToolError(error);
    }
  });

  return server;
}

export function controlPlaneTools() {
  return [
    {
      name: snapshotToolName,
      description:
        'Read safety plus every device identity, health, operational state, and stateEvidence in one call. Prefer this over list + N describe + N state.',
      inputSchema: { type: 'object' as const, additionalProperties: false, properties: {} },
      outputSchema: {
        type: 'object' as const,
        required: ['safety', 'devices'],
        properties: {
          safety: {},
          devices: { type: 'array', items: { type: 'object' } },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        title: 'Snapshot Pinout runtime',
      },
    },
    {
      name: readStateToolName,
      description:
        'Read the latest operational state for one device; inspect observedAt before acting. `observed` is the only field that reflects independent physical evidence; `commanded`/`acknowledged` do not prove physical effect.',
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['deviceId'],
        properties: { deviceId: { type: 'string', minLength: 1 } },
      },
      outputSchema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string' },
          state: { type: 'object' },
          stateEvidence: { type: 'object' },
        },
        required: ['deviceId', 'state'],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        title: 'Read Pinout device state',
      },
    },
    {
      name: safetyStatusToolName,
      description:
        'Read the shared Pinout safety-halt state. This tool cannot halt or resume a device.',
      inputSchema: { type: 'object' as const, additionalProperties: false, properties: {} },
      outputSchema: {
        type: 'object' as const,
        properties: { state: { type: 'string' } },
        required: ['state'],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        title: 'Read Pinout safety status',
      },
    },
    {
      name: listDevicesToolName,
      description: 'List every device currently registered in the Pinout runtime.',
      inputSchema: { type: 'object' as const, additionalProperties: false, properties: {} },
      outputSchema: {
        type: 'object' as const,
        required: ['devices'],
        properties: { devices: { type: 'array', items: { type: 'object' } } },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        title: 'List Pinout devices',
      },
    },
    {
      name: describeDeviceToolName,
      description:
        'Inspect one Pinout device, including identity, health, capabilities, transport, and current operational state. `observed` is the only field that reflects independent physical evidence; `commanded`/`acknowledged` do not prove physical effect.',
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['deviceId'],
        properties: { deviceId: { type: 'string', minLength: 1 } },
      },
      outputSchema: {
        type: 'object' as const,
        required: [
          'identity',
          'health',
          'simulated',
          'activeTransportKind',
          'supportedTransportKinds',
          'capabilities',
          'operationalState',
        ],
        properties: {
          identity: { type: 'object' },
          health: { type: 'object' },
          simulated: { type: 'boolean' },
          activeTransportKind: { type: 'string' },
          supportedTransportKinds: { type: 'array', items: { type: 'string' } },
          capabilities: { type: 'array', items: { type: 'object' } },
          operationalState: { type: 'object' },
          stateEvidence: { type: 'object' },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        title: 'Describe Pinout device',
      },
    },
    {
      name: acquireLeaseToolName,
      description:
        'Acquire an exclusive or shared-read lease before physical actuation. Leases coordinate agents; they are not a certified safety control.',
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['deviceId'],
        properties: {
          deviceId: { type: 'string' },
          ttlMs: { type: 'number' },
          mode: { type: 'string', enum: ['exclusive', 'shared-read'] },
        },
      },
      outputSchema: { type: 'object' as const },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        title: 'Acquire Pinout lease',
      },
    },
    {
      name: releaseLeaseToolName,
      description: 'Release a lease owned by the calling principal.',
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['leaseId'],
        properties: { leaseId: { type: 'string' } },
      },
      outputSchema: { type: 'object' as const },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        title: 'Release Pinout lease',
      },
    },
    {
      name: dryRunToolName,
      description:
        'Preview a capability invocation and its safety decision without executing physical effects.',
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['deviceId', 'capability'],
        properties: {
          deviceId: { type: 'string' },
          capability: { type: 'string' },
          args: { type: 'object' },
        },
      },
      outputSchema: { type: 'object' as const },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        title: 'Dry-run Pinout invocation',
      },
    },
    {
      name: operationStatusToolName,
      description: 'Read the status and result of a governed Pinout operation.',
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['operationId'],
        properties: { operationId: { type: 'string' } },
      },
      outputSchema: { type: 'object' as const },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        title: 'Read Pinout operation status',
      },
    },
    {
      name: cancelOperationToolName,
      description:
        'Request cancellation of a governed operation; physical work may be cooperative.',
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['operationId'],
        properties: { operationId: { type: 'string' }, reason: { type: 'string' } },
      },
      outputSchema: { type: 'object' as const },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        title: 'Cancel Pinout operation',
      },
    },
  ];
}

function runtimeTools(runtime: PinoutRuntime): RuntimeAgentTool[] {
  const tools = runtimeToAgentTools(runtime);
  const conflict = tools.find((tool) => reservedControlPlaneNames.has(tool.mcpName));
  if (conflict) {
    throw new Error(
      `Runtime tool '${conflict.mcpName}' conflicts with a reserved Pinout control-plane tool.`,
    );
  }
  return tools;
}

function runtimeToolsCacheKey(runtime: PinoutRuntime): string {
  return runtime
    .devices()
    .map((summary) => {
      const device = runtime.getDevice(summary.id);
      return `${summary.id}:${device.capabilities.length}`;
    })
    .join('\0');
}

function embeddedSnapshot(runtime: PinoutRuntime): Record<string, unknown> {
  const devices = runtime.devices().map((summary) => {
    const device = runtime.getDevice(summary.id);
    return {
      identity: device.identity,
      health: device.getHealth(),
      simulated: device.simulated,
      activeTransportKind: device.activeTransportKind,
      supportedTransportKinds: device.transportKinds,
      operationalState: device.getOperationalStateSnapshot(),
      stateEvidence: device.getStateEvidence(),
      capabilities: device.capabilities,
    };
  });
  return { safety: runtime.halt.state, devices };
}

export function createPinoutMcpServerFromRuntime(runtime: PinoutRuntime): Server {
  return createRuntimeMcpServer(runtime);
}

export function toMcpTool(tool: RuntimeAgentTool) {
  return {
    name: tool.mcpName,
    description: describeCapability(tool),
    inputSchema: {
      type: 'object' as const,
      ...tool.inputSchema,
      properties: {
        ...(tool.inputSchema.properties ?? {}),
        _pinout: {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            idempotencyKey: { type: 'string' as const, minLength: 1 },
            waitFor: { type: 'string' as const, enum: ['accepted', 'result'] },
            timeoutMs: { type: 'number' as const, minimum: 1 },
          },
          description: 'Governed operation controls used by daemon-backed MCP.',
        },
      },
    },
    outputSchema: {
      type: 'object' as const,
      anyOf: [
        {
          type: 'object' as const,
          required: ['operation'],
          properties: {
            operation: { type: 'object' as const },
            result: { type: 'object' as const, ...tool.outputSchema },
            deduped: { type: 'boolean' as const },
          },
        },
        {
          type: 'object' as const,
          ...tool.outputSchema,
        },
      ],
    },
    annotations: {
      readOnlyHint: !tool.annotations.physicalOutput,
      // Treat every physical output as destructive for conservative agent confirmation.
      // Reversible does not imply harmless or idempotent in the physical world.
      destructiveHint: tool.annotations.physicalOutput,
      ...(tool.annotations.physicalOutput ? {} : { idempotentHint: true }),
      title: tool.mcpName,
    },
  };
}

function describeCapability(tool: RuntimeAgentTool): string {
  const risk = tool.annotations.physicalOutput ? 'PHYSICAL_SIDE_EFFECT' : 'READ_ONLY';
  const lease = tool.annotations.physicalOutput ? ' Lease required before actuation.' : '';
  const reversible = tool.annotations.reversible ? 'reversible' : 'not reversible';
  return `${tool.description} Risk: ${risk}; ${reversible}.${lease}${tool.annotations.notes ? ` Notes: ${tool.annotations.notes}` : ''}`;
}

export function success(result: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

export function formatToolError(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const record = error as {
      code: string;
      message: string;
      retryable?: boolean;
      operationId?: string;
      metadata?: Record<string, unknown>;
    };
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            code: record.code,
            message: record.message,
            retryable: record.retryable ?? false,
            ...(record.operationId ? { operationId: record.operationId } : {}),
            ...(record.metadata ? { details: record.metadata } : {}),
          }),
        },
      ],
    };
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}
