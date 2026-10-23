import type { DeviceBackend, PinoutModuleDefinition } from '../runtime/types.js';
import { panTiltCapabilities, panTiltCapabilityNames } from './panTilt/capabilities.js';
import { createSimulatedPanTiltBackend, SimulatedPanTiltBackend } from './panTilt/simulator.js';
import { createEsp32PanTiltBackend, Esp32PanTiltBackend } from './panTilt/esp32Backend.js';
import { validatePanTiltConfig } from './panTilt/types.js';
import { runPanTiltConformance } from './panTilt/conformance.js';

export const panTiltModuleId = 'pinout/pan-tilt';

export const panTiltModule: PinoutModuleDefinition = {
  id: panTiltModuleId,
  version: '0.1.0',
  deviceClass: 'actuator.pan_tilt',
  vendor: 'Pinout',
  model: 'Desk Pan-Tilt (1–2 hobby servos)',
  capabilities: [...panTiltCapabilities],
  capabilityNames: [...panTiltCapabilityNames],
  policies: [],
  supportedTransportKinds: ['simulated', 'serial', 'tcp', 'simulated-esp32', 'loopback'],
  createSimulatedBackend(options: Record<string, unknown> = {}): DeviceBackend {
    return createSimulatedPanTiltBackend(options);
  },
  async createProtocolBackend(options: Record<string, unknown> = {}): Promise<DeviceBackend> {
    return createEsp32PanTiltBackend(options);
  },
};

export {
  createSimulatedPanTiltBackend,
  createEsp32PanTiltBackend,
  SimulatedPanTiltBackend,
  Esp32PanTiltBackend,
  validatePanTiltConfig,
  panTiltCapabilities,
  panTiltCapabilityNames,
  runPanTiltConformance,
};
export type {
  PanTiltConfig,
  ValidatedPanTiltConfig,
  PanTiltStatus,
  PanTiltArmedState,
  PanTiltAxisName,
  PanTiltAxisAngles,
  PanTiltAxisLimits,
  PanTiltObservedSource,
  PanTiltCommandedState,
  PanTiltAcknowledgedState,
  PanTiltObservedState,
  PanTiltEvidenceBundle,
} from './panTilt/types.js';
export type {
  PanTiltBackendLike,
  PanTiltConformanceCheck,
  PanTiltConformanceResult,
  PanTiltCheckStatus,
} from './panTilt/conformance.js';
