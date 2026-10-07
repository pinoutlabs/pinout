import type { DeviceBackend, PinoutModuleDefinition } from '../runtime/types.js';
import {
  pipetteCapabilities,
  pipetteCapabilityNames,
  pipetteVolumePolicy,
} from './pipette/capabilities.js';
import { createSimulatedPipetteBackend } from './pipette/simulator.js';

export const pipetteModuleId = 'pinout/pipette';

export const pipetteModule: PinoutModuleDefinition = {
  id: pipetteModuleId,
  version: '0.1.0',
  deviceClass: 'lab.pipette',
  vendor: 'Pinout',
  model: 'Simulated Single-Channel Pipette',
  capabilities: [...pipetteCapabilities],
  capabilityNames: [...pipetteCapabilityNames],
  policies: [pipetteVolumePolicy],
  supportedTransportKinds: ['simulated'],
  createSimulatedBackend(options = {}): DeviceBackend {
    return createSimulatedPipetteBackend(
      options as {
        maxVolumeUl?: number;
        initialHasTip?: boolean;
        initialVolumeUl?: number;
        defaultFlowRateUlPerSec?: number;
      },
    );
  },
};
