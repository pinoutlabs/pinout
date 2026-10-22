import type { DeviceBackend, PinoutModuleDefinition } from '../runtime/types.js';
import {
  syringePumpCapabilities,
  syringePumpCapabilityNames,
  syringePumpRatePolicy,
} from './syringePump/capabilities.js';
import { createSimulatedSyringePumpBackend } from './syringePump/simulator.js';

export const syringePumpModuleId = 'pinout/syringe-pump';

export const syringePumpModule: PinoutModuleDefinition = {
  id: syringePumpModuleId,
  version: '0.1.0',
  deviceClass: 'lab.syringe_pump',
  vendor: 'Pinout',
  model: 'Simulated Precision Syringe Pump',
  capabilities: [...syringePumpCapabilities],
  capabilityNames: [...syringePumpCapabilityNames],
  policies: [syringePumpRatePolicy],
  supportedTransportKinds: ['simulated'],
  createSimulatedBackend(options = {}): DeviceBackend {
    return createSimulatedSyringePumpBackend(
      options as {
        syringeCapacityMl?: number;
        initialVolumeMl?: number;
        defaultRateMlPerMin?: number;
      },
    );
  },
};
