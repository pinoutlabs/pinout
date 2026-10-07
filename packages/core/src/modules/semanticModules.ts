import { DeviceError } from '../errors.js';
import type { CapabilityDescriptor } from '../types.js';
import { createBackendEventBus } from '../runtime/backendEvents.js';
import type { DeviceBackend, PinoutModuleDefinition } from '../runtime/types.js';

const emptyInput = { type: 'object' as const, additionalProperties: false, properties: {} };
const boolOutput = (name: string) => ({
  type: 'object' as const,
  required: [name],
  properties: { [name]: { type: 'boolean' as const } },
});

const relayCapabilities: CapabilityDescriptor[] = [
  {
    name: 'relay.set',
    description: 'Set relay contact state.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['on'],
      properties: { on: { type: 'boolean' } },
    },
    outputSchema: boolOutput('on'),
    safety: { physicalOutput: true, reversible: true },
  },
  {
    name: 'relay.read',
    description: 'Read relay contact state.',
    inputSchema: emptyInput,
    outputSchema: boolOutput('on'),
    safety: { physicalOutput: false, reversible: true },
  },
  {
    name: 'status.read',
    description: 'Read relay status.',
    inputSchema: emptyInput,
    outputSchema: {
      type: 'object',
      required: ['status', 'on'],
      properties: {
        status: { type: 'string', enum: ['ready', 'faulted'] },
        on: { type: 'boolean' },
      },
    },
    safety: { physicalOutput: false, reversible: true },
  },
];

const valveCapabilities: CapabilityDescriptor[] = [
  {
    name: 'valve.set',
    description: 'Set proportional valve opening from 0 to 100 percent.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['opening'],
      properties: { opening: { type: 'number', minimum: 0, maximum: 100 } },
    },
    outputSchema: {
      type: 'object',
      required: ['opening'],
      properties: { opening: { type: 'number' } },
    },
    safety: { physicalOutput: true, reversible: true },
  },
  {
    name: 'valve.read',
    description: 'Read valve opening.',
    inputSchema: emptyInput,
    outputSchema: {
      type: 'object',
      required: ['opening'],
      properties: { opening: { type: 'number' } },
    },
    safety: { physicalOutput: false, reversible: true },
  },
  {
    name: 'status.read',
    description: 'Read valve status.',
    inputSchema: emptyInput,
    outputSchema: {
      type: 'object',
      required: ['status', 'opening'],
      properties: {
        status: { type: 'string', enum: ['ready', 'faulted'] },
        opening: { type: 'number' },
      },
    },
    safety: { physicalOutput: false, reversible: true },
  },
];

const pumpCapabilities: CapabilityDescriptor[] = [
  {
    name: 'pump.set',
    description: 'Set pump speed from 0 to 100 percent.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['speed'],
      properties: { speed: { type: 'number', minimum: 0, maximum: 100 } },
    },
    outputSchema: {
      type: 'object',
      required: ['speed'],
      properties: { speed: { type: 'number' } },
    },
    safety: { physicalOutput: true, reversible: true },
  },
  {
    name: 'pump.stop',
    description: 'Stop the pump.',
    inputSchema: emptyInput,
    outputSchema: {
      type: 'object',
      required: ['speed'],
      properties: { speed: { type: 'number' } },
    },
    safety: { physicalOutput: true, reversible: true },
  },
  {
    name: 'pump.read',
    description: 'Read pump speed.',
    inputSchema: emptyInput,
    outputSchema: {
      type: 'object',
      required: ['speed'],
      properties: { speed: { type: 'number' } },
    },
    safety: { physicalOutput: false, reversible: true },
  },
  {
    name: 'status.read',
    description: 'Read pump status.',
    inputSchema: emptyInput,
    outputSchema: {
      type: 'object',
      required: ['status', 'speed'],
      properties: {
        status: { type: 'string', enum: ['ready', 'running', 'stopped', 'faulted'] },
        speed: { type: 'number' },
      },
    },
    safety: { physicalOutput: false, reversible: true },
  },
];

const powerSupplyCapabilities: CapabilityDescriptor[] = [
  {
    name: 'power.set',
    description: 'Set output voltage and current limit.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['voltage', 'currentLimit'],
      properties: {
        voltage: { type: 'number', minimum: 0, maximum: 60 },
        currentLimit: { type: 'number', minimum: 0, maximum: 20 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['voltage', 'currentLimit'],
      properties: { voltage: { type: 'number' }, currentLimit: { type: 'number' } },
    },
    safety: {
      physicalOutput: true,
      reversible: true,
      notes: 'Energizes an electrical output; verify wiring and load ratings.',
    },
  },
  {
    name: 'power.output',
    description: 'Enable or disable the power output.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled'],
      properties: { enabled: { type: 'boolean' } },
    },
    outputSchema: boolOutput('enabled'),
    safety: { physicalOutput: true, reversible: true },
  },
  {
    name: 'power.read',
    description: 'Read configured output.',
    inputSchema: emptyInput,
    outputSchema: {
      type: 'object',
      required: ['voltage', 'currentLimit', 'enabled'],
      properties: {
        voltage: { type: 'number' },
        currentLimit: { type: 'number' },
        enabled: { type: 'boolean' },
      },
    },
    safety: { physicalOutput: false, reversible: true },
  },
  {
    name: 'status.read',
    description: 'Read power supply status.',
    inputSchema: emptyInput,
    outputSchema: {
      type: 'object',
      required: ['status', 'voltage', 'currentLimit', 'enabled'],
      properties: {
        status: { type: 'string', enum: ['ready', 'enabled', 'faulted'] },
        voltage: { type: 'number' },
        currentLimit: { type: 'number' },
        enabled: { type: 'boolean' },
      },
    },
    safety: { physicalOutput: false, reversible: true },
  },
];

class SemanticBackend implements DeviceBackend {
  readonly kind = 'simulated' as const;
  private closed = false;
  private readonly eventBus = createBackendEventBus();
  private state: Record<string, unknown>;
  constructor(
    private readonly family: 'relay' | 'valve' | 'pump' | 'power',
    options: Record<string, unknown> = {},
  ) {
    this.state =
      family === 'relay'
        ? { on: options.on === true }
        : family === 'valve'
          ? { opening: typeof options.opening === 'number' ? options.opening : 0 }
          : family === 'pump'
            ? { speed: typeof options.speed === 'number' ? options.speed : 0 }
            : {
                voltage: typeof options.voltage === 'number' ? options.voltage : 0,
                currentLimit: typeof options.currentLimit === 'number' ? options.currentLimit : 1,
                enabled: options.enabled === true,
              };
  }
  subscribe(handler: (event: string, payload: Record<string, unknown>) => void): () => void {
    return this.eventBus.subscribe(handler);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.eventBus.clear();
  }
  getOperationalState(): Record<string, unknown> {
    return { status: this.status(), ...this.state };
  }
  async safeState(): Promise<Record<string, unknown>> {
    if (this.closed) throw new DeviceError('DISCONNECTED', `${this.family} is closed.`);
    if (this.family === 'relay') {
      this.state.on = false;
      this.emit('relay.changed', { on: false });
      return { applied: true, on: false };
    }
    if (this.family === 'valve') {
      this.state.opening = 0;
      this.emit('valve.changed', { opening: 0 });
      return { applied: true, opening: 0 };
    }
    if (this.family === 'pump') {
      this.state.speed = 0;
      this.emit('pump.changed', { speed: 0 });
      return { applied: true, speed: 0 };
    }
    this.state.enabled = false;
    this.emit('power.changed', { ...this.state });
    return { applied: true, enabled: false };
  }
  async invoke(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) throw new DeviceError('DISCONNECTED', `${this.family} is closed.`);
    if (action === 'status.read') return this.getOperationalState();
    if (this.family === 'relay' && (action === 'relay.set' || action === 'relay.read')) {
      if (action.endsWith('set')) {
        this.state.on = payload.on === true;
        this.emit('relay.changed', { on: this.state.on });
      }
      return { on: this.state.on };
    }
    if (this.family === 'valve' && (action === 'valve.set' || action === 'valve.read')) {
      if (action.endsWith('set')) {
        this.state.opening = payload.opening;
        this.emit('valve.changed', { opening: this.state.opening });
      }
      return { opening: this.state.opening };
    }
    if (
      this.family === 'pump' &&
      (action === 'pump.set' || action === 'pump.stop' || action === 'pump.read')
    ) {
      if (action === 'pump.stop' || action === 'pump.set') {
        this.state.speed = action === 'pump.stop' ? 0 : payload.speed;
        this.emit('pump.changed', { speed: this.state.speed });
      }
      return { speed: this.state.speed };
    }
    if (this.family === 'power' && action === 'power.set') {
      this.state.voltage = payload.voltage;
      if (payload.currentLimit !== undefined) this.state.currentLimit = payload.currentLimit;
      this.emit('power.changed', { ...this.state });
      return { voltage: this.state.voltage, currentLimit: this.state.currentLimit };
    }
    if (this.family === 'power' && action === 'power.output') {
      this.state.enabled = payload.enabled === true;
      this.emit('power.changed', { ...this.state });
      return { enabled: this.state.enabled };
    }
    if (this.family === 'power' && action === 'power.read') return { ...this.state };
    throw new DeviceError('UNKNOWN_ACTION', `Unknown action '${action}'.`);
  }
  private status(): string {
    if (this.family === 'pump') return (this.state.speed as number) > 0 ? 'running' : 'stopped';
    if (this.family === 'power') return this.state.enabled ? 'enabled' : 'ready';
    return 'ready';
  }
  private emit(event: string, payload: Record<string, unknown>): void {
    this.eventBus.emit(event, payload);
  }
}

function moduleDefinition(
  id: string,
  deviceClass: string,
  model: string,
  capabilities: CapabilityDescriptor[],
  policies: PinoutModuleDefinition['policies'] = [],
  family: SemanticBackend['family'],
): PinoutModuleDefinition {
  return {
    id,
    version: '0.1.0',
    deviceClass,
    vendor: 'Pinout',
    model,
    capabilities,
    capabilityNames: capabilities.map((c) => c.name),
    policies,
    supportedTransportKinds: ['simulated'],
    createSimulatedBackend: (options = {}) => new SemanticBackend(family, options),
  };
}
export const relayModule = moduleDefinition(
  'pinout/relay',
  'actuator.relay',
  'Simulated Relay',
  relayCapabilities,
  [],
  'relay',
);
export const valveModule = moduleDefinition(
  'pinout/valve',
  'actuator.valve',
  'Simulated Valve',
  valveCapabilities,
  [{ kind: 'numericRange', capability: 'valve.set', field: 'opening', min: 0, max: 100 }],
  'valve',
);
export const pumpModule = moduleDefinition(
  'pinout/pump',
  'actuator.pump',
  'Simulated Pump',
  pumpCapabilities,
  [{ kind: 'numericRange', capability: 'pump.set', field: 'speed', min: 0, max: 100 }],
  'pump',
);
export const powerSupplyModule = moduleDefinition(
  'pinout/power-supply',
  'supply.power',
  'Simulated Power Supply',
  powerSupplyCapabilities,
  [
    { kind: 'numericRange', capability: 'power.set', field: 'voltage', min: 0, max: 60 },
    { kind: 'numericRange', capability: 'power.set', field: 'currentLimit', min: 0, max: 20 },
  ],
  'power',
);
export const createSimulatedRelayBackend = (o?: Record<string, unknown>) =>
  new SemanticBackend('relay', o);
export const createSimulatedValveBackend = (o?: Record<string, unknown>) =>
  new SemanticBackend('valve', o);
export const createSimulatedPumpBackend = (o?: Record<string, unknown>) =>
  new SemanticBackend('pump', o);
export const createSimulatedPowerSupplyBackend = (o?: Record<string, unknown>) =>
  new SemanticBackend('power', o);
export {
  lampModule,
  lampModuleId,
  createSimulatedLampBackend,
  createEsp32LampBackend,
} from './lampModule.js';
