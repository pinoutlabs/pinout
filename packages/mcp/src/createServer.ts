import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  DeviceInstance,
  PinoutRuntime,
  ProtocolDeviceBackend,
  type AgentTool,
  type Device,
} from '@pinout/core';

export function createPinoutMcpServer(device: Device): Server {
  // Keep the original single-device MCP API for compatibility, but place the
  // device behind the same runtime boundary used by heterogeneous runtimes.
  // No MCP tools may invoke a protocol Device directly.
  const runtime = new PinoutRuntime();
  const deviceId = 'mcp-device-01';
  const instance = new DeviceInstance({
    identity: {
      id: deviceId,
      moduleId: 'pinout/esp32',
      deviceClass: 'microcontroller',
      vendor: 'Espressif',
      model: device.info.firmware,
    },
    backend: new ProtocolDeviceBackend(device),
    capabilities: device.capabilities,
    policies: [],
    simulated: false,
    activeTransportKind: 'protocol',
    transportKinds: ['protocol'],
    getOperationalState: () => ({
      firmware: device.info.firmware,
      version: device.info.version,
      protocol: device.info.protocol,
    }),
  });
  // register() currently completes synchronously before its resolved promise;
  // retain the public synchronous factory while retaining runtime ownership.
  void runtime.register(instance);
  const tools = device.toAgentTools();
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

  const server = new Server(
    { name: 'pinout', version: device.info.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(toMcpTool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolByName.get(request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool '${request.params.name}'.` }],
      };
    }

    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await runtime.invoke(deviceId, tool.name, args, { owner: 'mcp-stdio' });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
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
  });

  return server;
}

function toMcpTool(tool: AgentTool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object' as const,
      ...tool.inputSchema,
    },
    outputSchema: {
      type: 'object' as const,
      ...tool.outputSchema,
    },
    annotations: {
      readOnlyHint: !tool.annotations.physicalOutput,
      // Physical outputs always receive the conservative destructive hint.
      // Reversible actions such as toggle are still neither harmless nor idempotent.
      destructiveHint: tool.annotations.physicalOutput,
      ...(tool.annotations.physicalOutput ? {} : { idempotentHint: true }),
      title: tool.name,
    },
  };
}
