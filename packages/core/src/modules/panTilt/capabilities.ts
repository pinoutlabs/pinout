import type { CapabilityDescriptor } from '../../types.js';

export const panTiltArmCapability: CapabilityDescriptor = {
  name: 'panTilt.arm',
  description:
    'Explicitly arm the pan-tilt mount for physical servo actuation and configure the host-loss watchdog.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        description: 'Watchdog timeout in milliseconds.',
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['armed'],
    properties: {
      armed: { type: 'string', enum: ['armed'] },
      timeoutMs: { type: 'integer', minimum: 0 },
    },
  },
  safety: {
    physicalOutput: true,
    reversible: true,
    notes:
      'Transitions the mount into armed state allowing servo PWM. Requires host-loss watchdog. Stay within commissioned angle limits.',
  },
};

export const panTiltDisarmCapability: CapabilityDescriptor = {
  name: 'panTilt.disarm',
  description:
    'Disarm the pan-tilt mount: drive each axis to its commissioned safe angle, then stop actuation.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
  outputSchema: {
    type: 'object',
    required: ['armed', 'angles'],
    properties: {
      armed: { type: 'string', enum: ['disarmed'] },
      angles: {
        type: 'object',
        required: ['pan'],
        properties: {
          pan: { type: 'number' },
          tilt: { type: 'number' },
        },
      },
    },
  },
  safety: {
    physicalOutput: true,
    reversible: true,
    notes:
      'Always applies commissioned safe angles before disarming. Safe angles must lie within each axis min/max limit. Not a certified e-stop.',
  },
};

export const panTiltSetAnglesCapability: CapabilityDescriptor = {
  name: 'panTilt.setAngles',
  description: 'Set pan and/or tilt hobby-servo angles in degrees (one or two axes).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      pan: {
        type: 'number',
        description: 'Target pan angle in degrees within commissioned pan limits.',
      },
      tilt: {
        type: 'number',
        description: 'Target tilt angle in degrees within commissioned tilt limits (when configured).',
      },
      validityMs: {
        type: 'integer',
        minimum: 1,
        description: 'Command validity TTL in milliseconds.',
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['angles'],
    properties: {
      angles: {
        type: 'object',
        required: ['pan'],
        properties: {
          pan: { type: 'number' },
          tilt: { type: 'number' },
        },
      },
    },
  },
  safety: {
    physicalOutput: true,
    reversible: true,
    notes:
      'Moves physical servo horns via 50 Hz PWM. Requires armed device. Angles outside commissioned min/max are rejected. Mechanical linkage collision is the caller’s responsibility.',
  },
};

export const panTiltSetAngleCapability: CapabilityDescriptor = {
  name: 'panTilt.setAngle',
  description:
    'Set a single axis angle. Defaults to pan when axis is omitted (single-servo desk mounts).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['angle'],
    properties: {
      angle: {
        type: 'number',
        description: 'Target angle in degrees within the selected axis limits.',
      },
      axis: {
        type: 'string',
        enum: ['pan', 'tilt'],
        description: 'Which axis to move. Defaults to pan.',
      },
      validityMs: {
        type: 'integer',
        minimum: 1,
        description: 'Command validity TTL in milliseconds.',
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['axis', 'angle', 'angles'],
    properties: {
      axis: { type: 'string', enum: ['pan', 'tilt'] },
      angle: { type: 'number' },
      angles: {
        type: 'object',
        required: ['pan'],
        properties: {
          pan: { type: 'number' },
          tilt: { type: 'number' },
        },
      },
    },
  },
  safety: {
    physicalOutput: true,
    reversible: true,
    notes:
      'Requires armed device. Rejects angles outside commissioned limits. Prefer panTilt.setAngles when moving both axes.',
  },
};

export const panTiltStatusCapability: CapabilityDescriptor = {
  name: 'panTilt.status',
  description:
    'Read pan-tilt armed state, commanded/acknowledged angles, and evidence (no fake position observation).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
  outputSchema: {
    type: 'object',
    required: ['commanded', 'acknowledged', 'observed', 'provenance', 'armed', 'angles'],
    properties: {
      commanded: {
        type: 'object',
        properties: {
          pan: { description: 'Commanded pan angle, or null if uncommanded.' },
          tilt: { description: 'Commanded tilt angle, or null.' },
          at: { description: 'ISO timestamp of command, or null.' },
        },
      },
      acknowledged: {
        type: 'object',
        properties: {
          pan: { description: 'Acknowledged pan angle, or null.' },
          tilt: { description: 'Acknowledged tilt angle, or null.' },
          at: { description: 'ISO timestamp of acknowledgment, or null.' },
        },
      },
      observed: {
        type: 'object',
        required: ['source'],
        properties: {
          pan: { description: 'Independently observed pan angle, or null.' },
          tilt: { description: 'Independently observed tilt angle, or null.' },
          at: { description: 'ISO timestamp of observation, or null.' },
          source: { type: 'string', enum: ['none', 'simulated'] },
        },
      },
      freshnessMs: { description: 'Age of angle evidence in milliseconds, or null.' },
      provenance: { type: 'string', enum: ['simulated', 'hardware'] },
      armed: { type: 'string', enum: ['armed', 'disarmed', 'tripped', 'unknown'] },
      angles: {
        type: 'object',
        required: ['pan'],
        properties: {
          pan: { type: 'number' },
          tilt: { type: 'number' },
        },
      },
      axes: {
        type: 'object',
        description: 'Commissioned axis limits and safe angles.',
      },
    },
  },
  safety: {
    physicalOutput: false,
    reversible: true,
    notes:
      'Read-only. Hobby servos without feedback do not populate observed angles; ACK alone is not hardware evidence.',
  },
};

export const panTiltStatusReadCapability: CapabilityDescriptor = {
  ...panTiltStatusCapability,
  name: 'status.read',
  description: 'Generic status read alias for pan-tilt operational state.',
};

export const panTiltCapabilities = [
  panTiltArmCapability,
  panTiltDisarmCapability,
  panTiltSetAnglesCapability,
  panTiltSetAngleCapability,
  panTiltStatusCapability,
  panTiltStatusReadCapability,
] as const;

export const panTiltCapabilityNames = panTiltCapabilities.map((capability) => capability.name);
