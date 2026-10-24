/**
 * MCP server exposing PR2 awareness/connector tools against the demo control
 * plane (or a future real pinoutd baseUrl with the same routes).
 *
 * SIMULATED — tools never touch physical hardware.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface DemoMcpOptions {
  baseUrl: string;
  token: string;
  owner?: string;
  fetchImpl?: typeof fetch;
}

async function daemonCall(
  options: DemoMcpOptions,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${options.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } }).error;
    const err = new Error(error?.message ?? `HTTP ${response.status} for ${path}`);
    (err as Error & { code?: string; status?: number }).code = error?.code ?? 'HTTP_ERROR';
    (err as Error & { code?: string; status?: number }).status = response.status;
    throw err;
  }
  return payload;
}

function toolSuccess(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function toolError(error: unknown) {
  const err = error as { code?: string; message?: string };
  const payload = {
    error: {
      code: err.code ?? 'TOOL_ERROR',
      message: err.message ?? String(error),
      retryable: false,
      label: 'SIMULATED',
    },
  };
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

const tools = [
  {
    name: 'pinout__nearby_devices',
    description:
      'List nearby / awareness devices from pinoutd (SIMULATED fixtures in this demo). Read-only.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        transport: { type: 'string' },
        state: { type: 'string' },
      },
    },
  },
  {
    name: 'pinout__awareness_events',
    description: 'Recent awareness events (bounded). SIMULATED in this demo.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
    },
  },
  {
    name: 'pinout__describe_nearby',
    description: 'Describe one awareness record by id. Read-only.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['awarenessId'],
      properties: { awarenessId: { type: 'string' } },
    },
  },
  {
    name: 'pinout__request_enroll',
    description:
      'Request enrollment for an awareness id. Creates a pending request only — never silently approves physical output or auto-arms.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['awarenessId'],
      properties: { awarenessId: { type: 'string' } },
    },
  },
  {
    name: 'pinout__generate_connector',
    description:
      'Generate a quarantined, read-only connector from awareness evidence. Evidence ≤ COMPILE_TESTED. SIMULATED.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['awarenessId'],
      properties: { awarenessId: { type: 'string' } },
    },
  },
  {
    name: 'pinout__connector_status',
    description: 'Show connector status, capabilities, ranges, and evidence level.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['connectorId'],
      properties: { connectorId: { type: 'string' } },
    },
  },
  {
    name: 'pinout__list_connectors',
    description: 'List generated connectors (quarantined / approved / installed / rejected).',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'pinout__invoke_connector',
    description:
      'Demo helper: invoke a connector capability through the control plane (same rejection rules as HTTP). SIMULATED.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['connectorId', 'capability'],
      properties: {
        connectorId: { type: 'string' },
        capability: { type: 'string' },
        args: { type: 'object', additionalProperties: true },
      },
    },
  },
];

export function createAwarenessConnectorMcpServer(options: DemoMcpOptions): Server {
  const server = new Server(
    { name: 'pinout-awareness-connector-demo', version: '0.0.1-alpha.1' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'pinout__nearby_devices': {
          const payload = (await daemonCall(options, 'GET', '/v1/awareness')) as {
            devices: Array<Record<string, unknown>>;
          };
          let devices = payload.devices;
          if (typeof args.transport === 'string') {
            devices = devices.filter((d) => d.transport === args.transport);
          }
          if (typeof args.state === 'string') {
            devices = devices.filter((d) => d.state === args.state);
          }
          return toolSuccess({ devices, label: 'SIMULATED', owner: options.owner ?? 'mcp-demo' });
        }
        case 'pinout__awareness_events': {
          const response = await fetch(`${options.baseUrl}/v1/awareness/events`, {
            headers: { authorization: `Bearer ${options.token}` },
          });
          const text = await response.text();
          return toolSuccess({
            eventsRaw: text.slice(0, 4000),
            label: 'SIMULATED',
            note: 'SSE snapshot (demo drains a bounded window then ends)',
          });
        }
        case 'pinout__describe_nearby': {
          const awarenessId = String(args.awarenessId ?? '');
          const payload = await daemonCall(
            options,
            'GET',
            `/v1/awareness/${encodeURIComponent(awarenessId)}`,
          );
          return toolSuccess(payload);
        }
        case 'pinout__request_enroll': {
          const awarenessId = String(args.awarenessId ?? '');
          const payload = await daemonCall(
            options,
            'POST',
            `/v1/awareness/${encodeURIComponent(awarenessId)}/enroll`,
            {},
          );
          return toolSuccess(payload);
        }
        case 'pinout__generate_connector': {
          const awarenessId = String(args.awarenessId ?? '');
          const payload = await daemonCall(options, 'POST', '/v1/connectors/generate', {
            awarenessId,
          });
          return toolSuccess(payload);
        }
        case 'pinout__connector_status': {
          const connectorId = String(args.connectorId ?? '');
          const payload = await daemonCall(
            options,
            'GET',
            `/v1/connectors/${encodeURIComponent(connectorId)}`,
          );
          return toolSuccess(payload);
        }
        case 'pinout__list_connectors': {
          const payload = await daemonCall(options, 'GET', '/v1/connectors');
          return toolSuccess(payload);
        }
        case 'pinout__invoke_connector': {
          const connectorId = String(args.connectorId ?? '');
          const capability = String(args.capability ?? '');
          const invokeArgs =
            args.args && typeof args.args === 'object' && !Array.isArray(args.args)
              ? (args.args as Record<string, unknown>)
              : {};
          const payload = await daemonCall(
            options,
            'POST',
            `/v1/connectors/${encodeURIComponent(connectorId)}/invoke`,
            { capability, args: invokeArgs },
          );
          return toolSuccess(payload);
        }
        default:
          return toolError({ code: 'UNKNOWN_TOOL', message: `Unknown tool ${name}` });
      }
    } catch (error) {
      return toolError(error);
    }
  });

  return server;
}
