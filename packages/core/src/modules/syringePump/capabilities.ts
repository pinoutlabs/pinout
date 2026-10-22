import type { CapabilityDescriptor } from '../../types.js';

export const syringePumpInfuseCapability: CapabilityDescriptor = {
  name: 'syringe_pump.infuse',
  description: 'Infuse (dispense) a specified volume of liquid at a given flow rate.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['volumeMl'],
    properties: {
      volumeMl: {
        type: 'number',
        minimum: 0.001,
        maximum: 100,
        description: 'Volume to dispense in milliliters.',
      },
      rateMlPerMin: {
        type: 'number',
        minimum: 0.001,
        maximum: 50,
        description: 'Optional flow rate in mL/min.',
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['infusedMl', 'remainingVolumeMl'],
    properties: {
      infusedMl: { type: 'number' },
      remainingVolumeMl: { type: 'number' },
    },
  },
  safety: {
    physicalOutput: true,
    reversible: true,
    notes: 'Dispenses liquid from syringe. Ensure downstream fluidic path is unobstructed.',
  },
};

export const syringePumpWithdrawCapability: CapabilityDescriptor = {
  name: 'syringe_pump.withdraw',
  description: 'Withdraw (aspirate) a specified volume of liquid at a given flow rate.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['volumeMl'],
    properties: {
      volumeMl: {
        type: 'number',
        minimum: 0.001,
        maximum: 100,
        description: 'Volume to withdraw in milliliters.',
      },
      rateMlPerMin: {
        type: 'number',
        minimum: 0.001,
        maximum: 50,
        description: 'Optional flow rate in mL/min.',
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['withdrawnMl', 'remainingVolumeMl'],
    properties: {
      withdrawnMl: { type: 'number' },
      remainingVolumeMl: { type: 'number' },
    },
  },
  safety: {
    physicalOutput: true,
    reversible: true,
    notes: 'Aspirates liquid into syringe.',
  },
};

export const syringePumpSetRateCapability: CapabilityDescriptor = {
  name: 'syringe_pump.set_rate',
  description: 'Set default flow rate for syringe pump operations.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['rateMlPerMin'],
    properties: {
      rateMlPerMin: {
        type: 'number',
        minimum: 0.001,
        maximum: 50,
        description: 'Flow rate in mL/min.',
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['rateMlPerMin'],
    properties: {
      rateMlPerMin: { type: 'number' },
    },
  },
  safety: { physicalOutput: false, reversible: true },
};

export const syringePumpStopCapability: CapabilityDescriptor = {
  name: 'syringe_pump.stop',
  description: 'Halt any active infusion or withdrawal immediately.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['stopped'],
    properties: {
      stopped: { type: 'boolean' },
    },
  },
  safety: { physicalOutput: true, reversible: true },
};

export const syringePumpReadCapability: CapabilityDescriptor = {
  name: 'syringe_pump.read',
  description: 'Read the current position, rate, and status of the syringe pump.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['remainingVolumeMl', 'totalInfusedMl', 'rateMlPerMin', 'direction', 'running'],
    properties: {
      remainingVolumeMl: { type: 'number' },
      totalInfusedMl: { type: 'number' },
      rateMlPerMin: { type: 'number' },
      direction: { type: 'string', enum: ['infuse', 'withdraw', 'idle'] },
      running: { type: 'boolean' },
    },
  },
  safety: { physicalOutput: false, reversible: true },
};

export const syringePumpStatusReadCapability: CapabilityDescriptor = {
  name: 'status.read',
  description: 'Read syringe pump operational state.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['status', 'remainingVolumeMl', 'totalInfusedMl', 'rateMlPerMin', 'running'],
    properties: {
      status: { type: 'string', enum: ['ready', 'running', 'stopped', 'faulted'] },
      remainingVolumeMl: { type: 'number' },
      totalInfusedMl: { type: 'number' },
      rateMlPerMin: { type: 'number' },
      running: { type: 'boolean' },
    },
  },
  safety: { physicalOutput: false, reversible: true },
};

export const syringePumpCapabilities = [
  syringePumpInfuseCapability,
  syringePumpWithdrawCapability,
  syringePumpSetRateCapability,
  syringePumpStopCapability,
  syringePumpReadCapability,
  syringePumpStatusReadCapability,
] as const;

export const syringePumpCapabilityNames = syringePumpCapabilities.map((c) => c.name);

export const syringePumpRatePolicy = {
  kind: 'numericRange' as const,
  capability: 'syringe_pump.set_rate',
  field: 'rateMlPerMin',
  min: 0.001,
  max: 50,
  message: 'Syringe pump flow rate must be between 0.001 and 50 mL/min.',
};
