import { centrifugeModuleId } from '../modules/centrifugeModule.js';
import { chamberModuleId } from '../modules/chamberModule.js';
import { heaterShakerModuleId } from '../modules/heaterShakerModule.js';
import { pipetteModuleId } from '../modules/pipetteModule.js';
import { syringePumpModuleId } from '../modules/syringePumpModule.js';
import { PinoutRuntime, type PinoutRuntimeOptions } from './runtime.js';

export interface LabWorkbenchOptions extends PinoutRuntimeOptions {
  includeSyringePump?: boolean;
  includeCentrifuge?: boolean;
  includeHeaterShaker?: boolean;
  includePipette?: boolean;
  includeChamber?: boolean;
}

export const defaultLabDeviceIds = {
  syringePump: 'lab.syringe_pump',
  centrifuge: 'lab.centrifuge',
  heaterShaker: 'lab.heater_shaker',
  pipette: 'lab.pipette',
  chamber: 'lab.chamber',
} as const;

export async function createLabWorkbench(
  options: LabWorkbenchOptions = {},
): Promise<PinoutRuntime> {
  const runtime = new PinoutRuntime(options);

  if (options.includeSyringePump !== false) {
    await runtime.registerFromModule(syringePumpModuleId, {
      id: defaultLabDeviceIds.syringePump,
      label: 'Lab Syringe Pump',
      simulated: true,
      backendOptions: { syringeCapacityMl: 50, initialVolumeMl: 40 },
    });
  }

  if (options.includeCentrifuge !== false) {
    await runtime.registerFromModule(centrifugeModuleId, {
      id: defaultLabDeviceIds.centrifuge,
      label: 'Lab Centrifuge',
      simulated: true,
      backendOptions: { initialRpm: 4000, initialLidOpen: false },
    });
  }

  if (options.includeHeaterShaker !== false) {
    await runtime.registerFromModule(heaterShakerModuleId, {
      id: defaultLabDeviceIds.heaterShaker,
      label: 'Lab Heater-Shaker',
      simulated: true,
      backendOptions: { initialTemperatureC: 25, initialTargetTempC: 37, initialTargetRpm: 800 },
    });
  }

  if (options.includePipette !== false) {
    await runtime.registerFromModule(pipetteModuleId, {
      id: defaultLabDeviceIds.pipette,
      label: 'Lab Electronic Pipette',
      simulated: true,
      backendOptions: { maxVolumeUl: 1000, initialHasTip: true, initialVolumeUl: 0 },
    });
  }

  if (options.includeChamber) {
    await runtime.registerFromModule(chamberModuleId, {
      id: defaultLabDeviceIds.chamber,
      label: 'Lab Environmental Chamber',
      simulated: true,
    });
  }

  return runtime;
}
