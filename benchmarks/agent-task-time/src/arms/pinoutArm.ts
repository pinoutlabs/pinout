import { toAgentTools, type Device } from '@pinout/core';
import { pinoutTaskCapabilityNames } from './fairTools.js';
import type { BenchDevice } from '../devices/benchDevice.js';
import type { AgentTool, AgentToolResult } from '../types.js';

/**
 * Arm B (SIMULATED): Pinout MCP/SDK-shaped tools against the shared simulator.
 * Tool list is intentionally compact and task-relevant (fair vs raw arm).
 */
export async function createPinoutArmTools(bench: BenchDevice): Promise<AgentTool[]> {
  const device = await bench.openPinoutDevice();
  const deviceId = `${bench.profile.id}-sim-01`;
  const allowed = new Set<string>(pinoutTaskCapabilityNames);

  const capabilityTools = toAgentTools(device.capabilities)
    .filter((tool) => allowed.has(tool.name))
    .map((tool) =>
      wrapCapabilityTool(
        device,
        bench,
        tool.name,
        tool.description,
        tool.inputSchema as Record<string, unknown>,
        'SIMULATED',
      ),
    );

  const discoveryTools: AgentTool[] = [
    {
      name: 'pinout__list_devices',
      description: 'List devices visible to Pinout.',
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
            },
          ],
          evidence: 'SIMULATED',
        });
      },
    },
    {
      name: 'pinout__describe_device',
      description: 'Describe device identity and task-relevant pins.',
      inputSchema: {
        type: 'object',
        properties: { deviceId: { type: 'string' } },
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
          capabilities: [...allowed],
          pins: {
            ledPin: bench.profile.ledPin,
            servoPin: bench.profile.servoPin,
            adcPin: bench.profile.adcPin,
          },
        });
      },
    },
    {
      name: 'pinout__read_state',
      description: 'Read observed device state evidence.',
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
  evidence: string,
): AgentTool {
  return {
    name,
    description: `${description} (Pinout; evidence=${evidence}.)`,
    inputSchema,
    async invoke(args): Promise<AgentToolResult> {
      try {
        const result = await device.invoke(name, args);
        bench.syncJournal(name, args);
        return ok({ action: name, result, evidence });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          content: JSON.stringify({ ok: false, action: name, error: message, evidence }),
          structured: { ok: false, action: name, error: message, evidence },
        };
      }
    },
  };
}

function ok(structured: Record<string, unknown>): AgentToolResult {
  return { ok: true, content: JSON.stringify(structured), structured };
}
