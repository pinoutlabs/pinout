import type { CapabilityDescriptor, DeviceBackend, PinoutModuleDefinition } from '@pinout/core';
import { GrblBackend, type GrblBackendOptions } from './grblBackend.js';

export const grblModuleId = 'pinout/grbl';

const emptyObject = { type: 'object' as const, additionalProperties: false, properties: {} };

const axisProperties = {
  x: { type: 'number' as const },
  y: { type: 'number' as const },
  z: { type: 'number' as const },
};

const mechanicalNote =
  'PHYSICAL MOTION. Does not replace hardware e-stops, limit switches, or other mechanical safeguards. Never claims mechanical safety.';

export const grblCapabilities: CapabilityDescriptor[] = [
  {
    name: 'grbl.status',
    description: 'Poll GRBL machine status (`?`). Read-only.',
    inputSchema: emptyObject,
    outputSchema: {
      type: 'object',
      required: ['state'],
      properties: { state: { type: 'string' }, raw: { type: 'string' } },
    },
    safety: { physicalOutput: false, reversible: true },
  },
  {
    name: 'grbl.home',
    description: 'Run the homing cycle ($H).',
    inputSchema: emptyObject,
    outputSchema: {
      type: 'object',
      required: ['homed'],
      properties: { homed: { type: 'boolean' } },
    },
    safety: { physicalOutput: true, reversible: false, notes: mechanicalNote },
  },
  {
    name: 'grbl.rapidMove',
    description: 'Rapid linear move (G0) in millimeters.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: axisProperties,
    },
    outputSchema: {
      type: 'object',
      required: ['moved'],
      properties: { moved: { type: 'boolean' }, ...axisProperties },
    },
    safety: { physicalOutput: true, reversible: true, notes: mechanicalNote },
  },
  {
    name: 'grbl.linearMove',
    description: 'Linear move (G1) in millimeters at a feed rate in mm/min.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['feedRate'],
      properties: { ...axisProperties, feedRate: { type: 'number', minimum: 0 } },
    },
    outputSchema: {
      type: 'object',
      required: ['moved', 'feedRate'],
      properties: { moved: { type: 'boolean' }, feedRate: { type: 'number' }, ...axisProperties },
    },
    safety: { physicalOutput: true, reversible: true, notes: mechanicalNote },
  },
  {
    name: 'grbl.hold',
    description: 'Feed hold (!). Pauses motion; does not replace a hardware e-stop.',
    inputSchema: emptyObject,
    outputSchema: {
      type: 'object',
      required: ['held'],
      properties: { held: { type: 'boolean' }, note: { type: 'string' } },
    },
    safety: { physicalOutput: true, reversible: true, notes: mechanicalNote },
  },
  {
    name: 'grbl.reset',
    description: 'Soft reset (0x18). Clears buffers; does not replace a hardware e-stop.',
    inputSchema: emptyObject,
    outputSchema: {
      type: 'object',
      required: ['reset'],
      properties: { reset: { type: 'boolean' }, note: { type: 'string' } },
    },
    safety: { physicalOutput: true, reversible: false, notes: mechanicalNote },
  },
];

export const grblModule: PinoutModuleDefinition = {
  id: grblModuleId,
  version: '0.1.0',
  deviceClass: 'motion.cnc',
  vendor: 'Pinout',
  model: 'GRBL Controller',
  capabilities: grblCapabilities,
  capabilityNames: grblCapabilities.map((capability) => capability.name),
  policies: [],
  supportedTransportKinds: ['simulated', 'serial', 'loopback'],
  createSimulatedBackend(options: Record<string, unknown> = {}): DeviceBackend {
    return GrblBackend.createSimulated(options as GrblBackendOptions);
  },
  async createProtocolBackend(options: Record<string, unknown>): Promise<DeviceBackend> {
    return GrblBackend.create({ ...(options as GrblBackendOptions), simulated: false });
  },
};
