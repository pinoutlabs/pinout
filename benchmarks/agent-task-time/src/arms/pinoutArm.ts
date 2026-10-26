import { toAgentTools, type Device } from '@pinout/core';
import type { BenchDevice } from '../devices/benchDevice.js';
import type { AgentTool, AgentToolResult } from '../types.js';

/**
 * Arm B: agent uses Pinout through the same capability tools exposed by
 * packages/mcp (device.toAgentTools / runtime invoke), against the shared
 * SIMULATED board. Discovery tools mirror MCP list/describe/read_state.
 */
export async function createPinoutArmTools(bench: BenchDevice): Promise<AgentTool[]> {
  const device = await bench.openPinoutDevice();
  const deviceId = `${bench.profile.id}-sim-01`;

  const capabilityTools = toAgentTools(device.capabilities).map((tool) =>
    wrapCapabilityTool(device, bench, tool.name, tool.description, tool.inputSchema as Record<string, unknown>),
  );

  const discoveryTools: AgentTool[] = [
    {
      name: 'pinout__list_devices',
      description: 'List devices visible to the Pinout runtime (MCP control plane).',
      inputSchema: { type: 'object', properties: {} },
      async invoke() {
        return ok({
          devices: [
            {
              id: deviceId,
              boardId: bench.profile.boardId,
              displayName: bench.profile.displayName,
              simulated: true,
              evidence: 'SIMULATED',
              mcu: bench.profile.mcu,
            },
          ],
          evidence: 'SIMULATED',
        });
      },
    },
    {
      name: 'pinout__describe_device',
      description: 'Describe a device identity, capabilities, and simulated flag.',
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: { type: 'string' },
        },
        required: ['deviceId'],
      },
      async invoke(args) {
        return ok({
          identity: {
            id: typeof args.deviceId === 'string' ? args.deviceId : deviceId,
            boardId: bench.profile.boardId,
            model: bench.profile.displayName,
          },
          simulated: true,
          evidence: 'SIMULATED',
          capabilities: device.capabilities.map((capability) => capability.name),
          pins: {
            ledPin: bench.profile.ledPin,
            servoPin: bench.profile.servoPin,
            adcPin: bench.profile.adcPin,
          },
          info: device.info,
        });
      },
    },
    {
      name: 'pinout__read_state',
      description: 'Read observed/commanded state evidence for the SIMULATED device.',
      inputSchema: {
        type: 'object',
        properties: { deviceId: { type: 'string' } },
        required: ['deviceId'],
      },
      async invoke() {
        const snap = bench.snapshot();
        return ok({
          deviceState: snap.deviceState,
          levels: snap.levels,
          servos: snap.servos,
          analogLevels: snap.analogLevels,
          evidence: 'SIMULATED',
        });
      },
    },
  ];

  return [...discoveryTools, ...capabilityTools];
}

function wrapCapabilityTool(
  device: Device,
  bench: BenchDevice,
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): AgentTool {
  return {
    name,
    description: `${description} (Pinout MCP/SDK capability; device is SIMULATED in this benchmark.)`,
    inputSchema,
    async invoke(args): Promise<AgentToolResult> {
      try {
        const result = await device.invoke(name, args);
        bench.syncJournal(name, args);
        return ok({ action: name, result, evidence: 'SIMULATED' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          content: JSON.stringify({ ok: false, action: name, error: message, evidence: 'SIMULATED' }),
          structured: { ok: false, action: name, error: message, evidence: 'SIMULATED' },
        };
      }
    },
  };
}

function ok(structured: Record<string, unknown>): AgentToolResult {
  return { ok: true, content: JSON.stringify(structured), structured };
}
