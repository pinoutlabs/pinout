import type { DeviceBackend, PinoutModuleDefinition } from '../runtime/types.js';
import {
  heaterShakerCapabilities,
  heaterShakerCapabilityNames,
  heaterShakerSpeedPolicy,
  heaterShakerTempPolicy,
} from './heaterShaker/capabilities.js';
import { createSimulatedHeaterShakerBackend } from './heaterShaker/simulator.js';

export const heaterShakerModuleId = 'pinout/heater-shaker';

export const heaterShakerModule: PinoutModuleDefinition = {
  id: heaterShakerModuleId,
  version: '0.1.0',
  deviceClass: 'lab.heater_shaker',
  vendor: 'Pinout',
  model: 'Simulated High-Precision Heater-Shaker',
  capabilities: [...heaterShakerCapabilities],
  capabilityNames: [...heaterShakerCapabilityNames],
  policies: [heaterShakerTempPolicy, heaterShakerSpeedPolicy],
  supportedTransportKinds: ['simulated'],
  createSimulatedBackend(options = {}): DeviceBackend {
    return createSimulatedHeaterShakerBackend(options as {
      initialTemperatureC?: number;
      initialTargetTempC?: number;
      initialTargetRpm?: number;
    });
  },
};
