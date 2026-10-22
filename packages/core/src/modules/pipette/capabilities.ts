import type { CapabilityDescriptor } from '../../types.js';

export const pipetteAttachTipCapability: CapabilityDescriptor = {
  name: 'pipette.attach_tip',
  description: 'Pick up and firmly attach a disposable pipette tip.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['hasTip'],
    properties: { hasTip: { type: 'boolean' } },
  },
  safety: { physicalOutput: true, reversible: true },
};

export const pipetteEjectTipCapability: CapabilityDescriptor = {
  name: 'pipette.eject_tip',
  description: 'Eject the current disposable pipette tip into waste.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['hasTip'],
    properties: { hasTip: { type: 'boolean' } },
  },
  safety: {
    physicalOutput: true,
    reversible: true,
    notes: 'Mechanical tip ejection.',
  },
};

export const pipetteAspirateCapability: CapabilityDescriptor = {
  name: 'pipette.aspirate',
  description: 'Draw specified liquid volume in microliters (µL) into the tip.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['volumeUl'],
    properties: {
      volumeUl: {
        type: 'number',
        minimum: 0.1,
        maximum: 1000,
        description: 'Volume in microliters (µL).',
      },
      flowRateUlPerSec: {
        type: 'number',
        minimum: 0.1,
        maximum: 500,
        description: 'Optional flow rate in µL/sec.',
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['currentVolumeUl', 'aspiratedUl'],
    properties: {
      currentVolumeUl: { type: 'number' },
      aspiratedUl: { type: 'number' },
    },
  },
  safety: {
    physicalOutput: true,
    reversible: true,
    notes: 'Requires tip attached. Ensure tip is immersed in fluid before aspirating.',
  },
};

export const pipetteDispenseCapability: CapabilityDescriptor = {
  name: 'pipette.dispense',
  description: 'Dispense specified liquid volume in microliters (µL) from the tip.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['volumeUl'],
    properties: {
      volumeUl: {
        type: 'number',
        minimum: 0.1,
        maximum: 1000,
        description: 'Volume in microliters (µL).',
      },
      flowRateUlPerSec: {
        type: 'number',
        minimum: 0.1,
        maximum: 500,
        description: 'Optional flow rate in µL/sec.',
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['currentVolumeUl', 'dispensedUl'],
    properties: {
      currentVolumeUl: { type: 'number' },
      dispensedUl: { type: 'number' },
    },
  },
  safety: {
    physicalOutput: true,
    reversible: true,
    notes: 'Dispenses liquid into vessel.',
  },
};

export const pipetteBlowoutCapability: CapabilityDescriptor = {
  name: 'pipette.blowout',
  description: 'Perform an air blowout to expel any residual droplets from the tip.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['blownOut', 'currentVolumeUl'],
    properties: {
      blownOut: { type: 'boolean' },
      currentVolumeUl: { type: 'number' },
    },
  },
  safety: { physicalOutput: true, reversible: true },
};

export const pipetteReadCapability: CapabilityDescriptor = {
  name: 'pipette.read',
  description: 'Read the current liquid volume, max capacity, and tip presence.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['currentVolumeUl', 'maxVolumeUl', 'hasTip'],
    properties: {
      currentVolumeUl: { type: 'number' },
      maxVolumeUl: { type: 'number' },
      hasTip: { type: 'boolean' },
    },
  },
  safety: { physicalOutput: false, reversible: true },
};

export const pipetteStatusReadCapability: CapabilityDescriptor = {
  name: 'status.read',
  description: 'Read pipette operational state.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['status', 'currentVolumeUl', 'maxVolumeUl', 'hasTip'],
    properties: {
      status: { type: 'string', enum: ['ready', 'aspirating', 'dispensing', 'faulted'] },
      currentVolumeUl: { type: 'number' },
      maxVolumeUl: { type: 'number' },
      hasTip: { type: 'boolean' },
    },
  },
  safety: { physicalOutput: false, reversible: true },
};

export const pipetteCapabilities = [
  pipetteAttachTipCapability,
  pipetteEjectTipCapability,
  pipetteAspirateCapability,
  pipetteDispenseCapability,
  pipetteBlowoutCapability,
  pipetteReadCapability,
  pipetteStatusReadCapability,
] as const;

export const pipetteCapabilityNames = pipetteCapabilities.map((c) => c.name);

export const pipetteVolumePolicy = {
  kind: 'numericRange' as const,
  capability: 'pipette.aspirate',
  field: 'volumeUl',
  min: 0.1,
  max: 1000,
  message: 'Pipette aspirate volume must be between 0.1 and 1000 µL.',
};
