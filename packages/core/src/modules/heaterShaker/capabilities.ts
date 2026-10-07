import type { CapabilityDescriptor } from '../../types.js';

export const heaterShakerSetTempCapability: CapabilityDescriptor = {
  name: 'temperature.set',
  description: 'Set target temperature in Celsius (4°C to 100°C).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['targetTemperatureC'],
    properties: {
      targetTemperatureC: {
        type: 'number',
        minimum: 4,
        maximum: 100,
        description: 'Target block temperature in °C.',
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['targetTemperatureC'],
    properties: { targetTemperatureC: { type: 'number' } },
  },
  safety: {
    physicalOutput: true,
    reversible: true,
    notes: 'Thermal block heating/cooling element.',
  },
};

export const heaterShakerReadTempCapability: CapabilityDescriptor = {
  name: 'temperature.read',
  description: 'Read current and target block temperature in Celsius.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['currentTemperatureC', 'targetTemperatureC', 'heating'],
    properties: {
      currentTemperatureC: { type: 'number' },
      targetTemperatureC: { type: 'number' },
      heating: { type: 'boolean' },
    },
  },
  safety: { physicalOutput: false, reversible: true },
};

export const heaterShakerSetSpeedCapability: CapabilityDescriptor = {
  name: 'shaker.set_speed',
  description: 'Set orbital shaking speed in RPM (revolutions per minute).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['rpm'],
    properties: {
      rpm: {
        type: 'number',
        minimum: 0,
        maximum: 3000,
        description: 'Orbital shaking speed (0 to 3000 RPM).',
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['targetRpm'],
    properties: { targetRpm: { type: 'number' } },
  },
  safety: { physicalOutput: false, reversible: true },
};

export const heaterShakerStartCapability: CapabilityDescriptor = {
  name: 'shaker.start',
  description: 'Start the orbital shaker.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['running', 'targetRpm'],
    properties: {
      running: { type: 'boolean' },
      targetRpm: { type: 'number' },
    },
  },
  safety: {
    physicalOutput: true,
    reversible: true,
    notes: 'Orbital oscillation agitation.',
  },
};

export const heaterShakerStopCapability: CapabilityDescriptor = {
  name: 'shaker.stop',
  description: 'Stop the orbital shaker oscillation.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['running'],
    properties: { running: { type: 'boolean' } },
  },
  safety: { physicalOutput: true, reversible: true },
};

export const heaterShakerReadShakerCapability: CapabilityDescriptor = {
  name: 'shaker.read',
  description: 'Read shaker motion state.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['currentRpm', 'targetRpm', 'running'],
    properties: {
      currentRpm: { type: 'number' },
      targetRpm: { type: 'number' },
      running: { type: 'boolean' },
    },
  },
  safety: { physicalOutput: false, reversible: true },
};

export const heaterShakerStatusReadCapability: CapabilityDescriptor = {
  name: 'status.read',
  description: 'Read overall heater-shaker operational state.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: [
      'status',
      'currentTemperatureC',
      'targetTemperatureC',
      'currentRpm',
      'targetRpm',
      'running',
      'heating',
    ],
    properties: {
      status: { type: 'string', enum: ['ready', 'running', 'faulted'] },
      currentTemperatureC: { type: 'number' },
      targetTemperatureC: { type: 'number' },
      currentRpm: { type: 'number' },
      targetRpm: { type: 'number' },
      running: { type: 'boolean' },
      heating: { type: 'boolean' },
    },
  },
  safety: { physicalOutput: false, reversible: true },
};

export const heaterShakerCapabilities = [
  heaterShakerSetTempCapability,
  heaterShakerReadTempCapability,
  heaterShakerSetSpeedCapability,
  heaterShakerStartCapability,
  heaterShakerStopCapability,
  heaterShakerReadShakerCapability,
  heaterShakerStatusReadCapability,
] as const;

export const heaterShakerCapabilityNames = heaterShakerCapabilities.map((c) => c.name);

export const heaterShakerTempPolicy = {
  kind: 'numericRange' as const,
  capability: 'temperature.set',
  field: 'targetTemperatureC',
  min: 4,
  max: 100,
  message: 'Heater-shaker temperature must be between 4°C and 100°C.',
};

export const heaterShakerSpeedPolicy = {
  kind: 'numericRange' as const,
  capability: 'shaker.set_speed',
  field: 'rpm',
  min: 0,
  max: 3000,
  message: 'Heater-shaker RPM must be between 0 and 3,000 RPM.',
};
