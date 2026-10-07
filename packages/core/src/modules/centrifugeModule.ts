import type { DeviceBackend, PinoutModuleDefinition } from '../runtime/types.js';
import {
  centrifugeCapabilities,
  centrifugeCapabilityNames,
  centrifugeSpeedPolicy,
} from './centrifuge/capabilities.js';
import { createSimulatedCentrifugeBackend } from './centrifuge/simulator.js';

export const centrifugeModuleId = 'pinout/centrifuge';

export const centrifugeModule: PinoutModuleDefinition = {
  id: centrifugeModuleId,
  version: '0.1.0',
  deviceClass: 'lab.centrifuge',
  vendor: 'Pinout',
  model: 'Simulated High-Speed Microcentrifuge',
  capabilities: [...centrifugeCapabilities],
  capabilityNames: [...centrifugeCapabilityNames],
  policies: [centrifugeSpeedPolicy],
  supportedTransportKinds: ['simulated'],
  createSimulatedBackend(options = {}): DeviceBackend {
    return createSimulatedCentrifugeBackend(
      options as {
        initialRpm?: number;
        initialLidOpen?: boolean;
        initialTemperatureC?: number;
      },
    );
  },
};
