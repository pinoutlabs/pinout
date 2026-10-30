import type { CapabilityDescriptor, DeviceBackend, PinoutModuleDefinition } from '@pinout/core';
import { UrBackend, type UrBackendOptions } from './urBackend.js';

export const urModuleId = 'pinout/ur';

const emptyObject = { type: 'object' as const, additionalProperties: false, properties: {} };

const poseProperties = {
  x: { type: 'number' as const, description: 'Base-frame X, meters.' },
  y: { type: 'number' as const, description: 'Base-frame Y, meters.' },
  z: { type: 'number' as const, description: 'Base-frame Z, meters.' },
  rx: { type: 'number' as const, description: 'Rotation vector X, radians (axis-angle).' },
  ry: { type: 'number' as const, description: 'Rotation vector Y, radians (axis-angle).' },
  rz: { type: 'number' as const, description: 'Rotation vector Z, radians (axis-angle).' },
};

const motionNote =
  'PHYSICAL ROBOT MOTION. On-robot safety configuration (safety limits, protective stops, emergency stop) remains authoritative; this adapter adds no safety-rated functions and no workspace bounds.';

const administrativeNote =
  'Changes controller state; this adapter cannot confirm physical outcomes beyond the controller reply.';

export const urCapabilities: CapabilityDescriptor[] = [
  {
    name: 'ur.status',
    description:
      'Read robot mode, safety mode/status, and program state from the dashboard server. Read-only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { includeIdentity: { type: 'boolean' } },
    },
    outputSchema: {
      type: 'object',
      required: ['robotMode', 'safetyMode', 'program', 'running'],
      properties: {
        robotMode: { type: 'string' },
        safetyMode: { type: 'string' },
        program: { type: 'object' },
        running: { type: 'boolean' },
      },
    },
    safety: { physicalOutput: false, reversible: true },
  },
  {
    name: 'ur.telemetry',
    description:
      'Read the next RTDE data package: joint positions (radians), TCP pose (meters + radians axis-angle), controller modes. Read-only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { timeoutMs: { type: 'number', minimum: 0 } },
    },
    outputSchema: {
      type: 'object',
      required: ['at', 'values'],
      properties: { at: { type: 'number' }, values: { type: 'object' } },
    },
    safety: { physicalOutput: false, reversible: true },
  },
  {
    name: 'ur.power_on',
    description: 'Dashboard `power on`. Required before any motion; does not release brakes.',
    inputSchema: emptyObject,
    outputSchema: {
      type: 'object',
      required: ['poweredOn'],
      properties: { poweredOn: { type: 'boolean' }, reply: { type: 'string' } },
    },
    safety: { physicalOutput: true, reversible: true, notes: administrativeNote },
  },
  {
    name: 'ur.power_off',
    description:
      'Dashboard `power off`. Releases motor control; an arm holding a pose may sag or fall under gravity.',
    inputSchema: emptyObject,
    outputSchema: {
      type: 'object',
      required: ['poweredOff'],
      properties: { poweredOff: { type: 'boolean' }, reply: { type: 'string' } },
    },
    safety: { physicalOutput: true, reversible: true, notes: administrativeNote },
  },
  {
    name: 'ur.brake_release',
    description:
      'Dashboard `brake release`. The arm becomes movable by hand and may fall under gravity.',
    inputSchema: emptyObject,
    outputSchema: {
      type: 'object',
      required: ['brakesReleased'],
      properties: { brakesReleased: { type: 'boolean' }, reply: { type: 'string' } },
    },
    safety: { physicalOutput: true, reversible: true, notes: administrativeNote },
  },
  {
    name: 'ur.move_to_pose',
    description:
      'Command a pose via URScript (`movel`/`movej`): meters + axis-angle radians. Speed/acceleration/blend limits are enforced before sending; completion is not acknowledged by the script interface — confirm with ur.telemetry.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pose'],
      properties: {
        pose: {
          type: 'object',
          required: ['x', 'y', 'z', 'rx', 'ry', 'rz'],
          additionalProperties: false,
          properties: poseProperties,
        },
        movement: { type: 'string', enum: ['linear', 'joint'] },
        speed: { type: 'number', minimum: 0, description: 'm/s (linear) or rad/s (joint).' },
        acceleration: {
          type: 'number',
          minimum: 0,
          description: 'm/s² (linear) or rad/s² (joint).',
        },
        blendRadius: { type: 'number', minimum: 0, description: 'Meters; 0 = exact stop.' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['commanded', 'movement', 'pose'],
      properties: {
        commanded: { type: 'boolean' },
        movement: { type: 'string' },
        pose: { type: 'object' },
        script: { type: 'string' },
      },
    },
    safety: { physicalOutput: true, reversible: true, notes: motionNote },
  },
  {
    name: 'ur.stop',
    description:
      'Stop the running program and decelerate scripted motion (`stopl`). Motion is never resumed automatically; restarting requires an explicit command.',
    inputSchema: emptyObject,
    outputSchema: {
      type: 'object',
      required: ['stopRequested', 'stopConfirmed', 'programStop', 'scriptStop'],
      properties: {
        stopRequested: { type: 'boolean' },
        stopConfirmed: { type: 'boolean' },
        programStop: { type: 'string' },
        scriptStop: { type: 'string' },
      },
    },
    safety: {
      physicalOutput: true,
      reversible: false,
      notes: `${motionNote} A software stop does not replace a hardware emergency stop, and this adapter cannot confirm the robot physically halted.`,
    },
  },
  {
    name: 'ur.load_program',
    description: 'Dashboard `load <path>`. Does not execute anything by itself.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1 } },
    },
    outputSchema: {
      type: 'object',
      required: ['loaded', 'program'],
      properties: { loaded: { type: 'boolean' }, program: { type: 'string' } },
    },
    safety: { physicalOutput: false, reversible: true },
  },
  {
    name: 'ur.play_program',
    description:
      'Dashboard `play`. Runs the loaded program, which this adapter does not inspect — it may command arbitrary motion.',
    inputSchema: emptyObject,
    outputSchema: {
      type: 'object',
      required: ['playing'],
      properties: { playing: { type: 'boolean' }, reply: { type: 'string' } },
    },
    safety: { physicalOutput: true, reversible: false, notes: motionNote },
  },
  {
    name: 'ur.pause_program',
    description: 'Dashboard `pause`. Paused programs do not resume automatically.',
    inputSchema: emptyObject,
    outputSchema: {
      type: 'object',
      required: ['paused'],
      properties: { paused: { type: 'boolean' }, reply: { type: 'string' } },
    },
    safety: { physicalOutput: true, reversible: true, notes: administrativeNote },
  },
  {
    name: 'ur.execute_script',
    description:
      'Send raw URScript to a client interface. Executes immediately, is not inspected or sandboxed, and can command arbitrary motion. Only send vetted scripts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['script'],
      properties: { script: { type: 'string', minLength: 1 } },
    },
    outputSchema: {
      type: 'object',
      required: ['sent', 'bytes'],
      properties: { sent: { type: 'boolean' }, bytes: { type: 'number' } },
    },
    safety: { physicalOutput: true, reversible: false, notes: motionNote },
  },
];

export const urModule: PinoutModuleDefinition = {
  id: urModuleId,
  version: '0.1.0',
  deviceClass: 'robot.manipulator',
  vendor: 'Universal Robots',
  model: 'UR Series (dashboard + RTDE + URScript adapter)',
  capabilities: urCapabilities,
  capabilityNames: urCapabilities.map((capability) => capability.name),
  policies: [],
  supportedTransportKinds: ['simulated', 'tcp', 'loopback'],
  createSimulatedBackend(options: Record<string, unknown> = {}): DeviceBackend {
    return UrBackend.createSimulated(options as UrBackendOptions);
  },
  async createProtocolBackend(options: Record<string, unknown>): Promise<DeviceBackend> {
    return UrBackend.create({ ...(options as UrBackendOptions), simulated: false });
  },
};
