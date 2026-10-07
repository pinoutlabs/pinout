import type { CapabilityDescriptor } from '../../types.js';

export const centrifugeSetSpeedCapability: CapabilityDescriptor = {
  name: 'centrifuge.set_speed',
  description: 'Set target rotational speed in RPM (revolutions per minute).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['rpm'],
    properties: {
      rpm: {
        type: 'number',
        minimum: 0,
        maximum: 15000,
        description: 'Target rotor speed in RPM (0 to 15,000).',
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

export const centrifugeStartCapability: CapabilityDescriptor = {
  name: 'centrifuge.start',
  description: 'Start spinning the centrifuge rotor towards target RPM. Requires lid to be closed.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      durationSec: {
        type: 'number',
        minimum: 1,
        maximum: 3600,
        description: 'Optional run duration in seconds.',
      },
    },
  },
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
    notes: 'High-speed rotating equipment. Lid must be interlocked and samples balanced.',
  },
};

export const centrifugeStopCapability: CapabilityDescriptor = {
  name: 'centrifuge.stop',
  description: 'Decelerate and brake the rotor to a complete standstill.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['running'],
    properties: { running: { type: 'boolean' } },
  },
  safety: { physicalOutput: true, reversible: true },
};

export const centrifugeOpenLidCapability: CapabilityDescriptor = {
  name: 'centrifuge.open_lid',
  description:
    'Open the centrifuge lid. Hardware safety interlock prohibits opening while rotor is spinning.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['lidOpen'],
    properties: { lidOpen: { type: 'boolean' } },
  },
  safety: {
    physicalOutput: true,
    reversible: true,
    notes: 'Safety interlocked: rejected if RPM > 0.',
  },
};

export const centrifugeCloseLidCapability: CapabilityDescriptor = {
  name: 'centrifuge.close_lid',
  description: 'Close and lock the centrifuge lid.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['lidOpen'],
    properties: { lidOpen: { type: 'boolean' } },
  },
  safety: { physicalOutput: true, reversible: true },
};

export const centrifugeReadCapability: CapabilityDescriptor = {
  name: 'centrifuge.read',
  description: 'Read current rotor speed, target speed, lid state, and temperature.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['currentRpm', 'targetRpm', 'lidOpen', 'running', 'temperatureC'],
    properties: {
      currentRpm: { type: 'number' },
      targetRpm: { type: 'number' },
      lidOpen: { type: 'boolean' },
      running: { type: 'boolean' },
      temperatureC: { type: 'number' },
    },
  },
  safety: { physicalOutput: false, reversible: true },
};

export const centrifugeStatusReadCapability: CapabilityDescriptor = {
  name: 'status.read',
  description: 'Read centrifuge operational status.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['status', 'currentRpm', 'targetRpm', 'lidOpen', 'running'],
    properties: {
      status: { type: 'string', enum: ['ready', 'spinning', 'braking', 'faulted'] },
      currentRpm: { type: 'number' },
      targetRpm: { type: 'number' },
      lidOpen: { type: 'boolean' },
      running: { type: 'boolean' },
    },
  },
  safety: { physicalOutput: false, reversible: true },
};

export const centrifugeCapabilities = [
  centrifugeSetSpeedCapability,
  centrifugeStartCapability,
  centrifugeStopCapability,
  centrifugeOpenLidCapability,
  centrifugeCloseLidCapability,
  centrifugeReadCapability,
  centrifugeStatusReadCapability,
] as const;

export const centrifugeCapabilityNames = centrifugeCapabilities.map((c) => c.name);

export const centrifugeSpeedPolicy = {
  kind: 'numericRange' as const,
  capability: 'centrifuge.set_speed',
  field: 'rpm',
  min: 0,
  max: 15000,
  message: 'Centrifuge speed must be between 0 and 15,000 RPM.',
};
