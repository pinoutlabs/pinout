import { describe, expect, it } from 'vitest';
import {
  centrifugeModuleId,
  createLabWorkbench,
  defaultLabDeviceIds,
  getModule,
  heaterShakerModuleId,
  pipetteModuleId,
  syringePumpModuleId,
} from '../src/index.js';

describe('Lab Automation Modules', () => {
  describe('Module Registry', () => {
    it('registers all 4 lab automation modules in builtin registry', () => {
      expect(getModule(syringePumpModuleId)).toBeDefined();
      expect(getModule(centrifugeModuleId)).toBeDefined();
      expect(getModule(heaterShakerModuleId)).toBeDefined();
      expect(getModule(pipetteModuleId)).toBeDefined();
    });
  });

  describe('Syringe Pump Module', () => {
    it('infuses and withdraws fluids accurately and respects volume limits', async () => {
      const module = getModule(syringePumpModuleId);
      const backend = module.createSimulatedBackend!({
        syringeCapacityMl: 20,
        initialVolumeMl: 10,
        defaultRateMlPerMin: 2,
      });

      // Read initial state
      const initial = await backend.invoke('syringe_pump.read', {});
      expect(initial).toEqual({
        remainingVolumeMl: 10,
        totalInfusedMl: 0,
        rateMlPerMin: 2,
        direction: 'idle',
        running: false,
      });

      // Infuse 3 mL
      const infuseRes = await backend.invoke('syringe_pump.infuse', { volumeMl: 3 });
      expect(infuseRes).toEqual({
        infusedMl: 3,
        remainingVolumeMl: 7,
      });

      // Cannot infuse 10 mL when only 7 mL remains
      await expect(backend.invoke('syringe_pump.infuse', { volumeMl: 10 })).rejects.toThrow(
        /exceeds available volume/,
      );

      // Withdraw 5 mL
      const withdrawRes = await backend.invoke('syringe_pump.withdraw', { volumeMl: 5 });
      expect(withdrawRes).toEqual({
        withdrawnMl: 5,
        remainingVolumeMl: 12,
      });

      // Syringe capacity is 20 mL, remaining is 12 mL, so max withdraw is 8 mL.
      // Trying to withdraw 10 mL must fail.
      await expect(backend.invoke('syringe_pump.withdraw', { volumeMl: 10 })).rejects.toThrow(
        /exceeds syringe remaining capacity/,
      );

      // Set rate
      const rateRes = await backend.invoke('syringe_pump.set_rate', { rateMlPerMin: 5 });
      expect(rateRes).toEqual({ rateMlPerMin: 5 });

      // Stop
      const stopRes = await backend.invoke('syringe_pump.stop', {});
      expect(stopRes).toEqual({ stopped: true });

      // Status read
      const status = await backend.invoke('status.read', {});
      expect(status.status).toBe('stopped');
      expect(status.remainingVolumeMl).toBe(12);

      await backend.close();
    });
  });

  describe('Centrifuge Module', () => {
    it('enforces safety interlocks for lid and rotor speed', async () => {
      const module = getModule(centrifugeModuleId);
      const backend = module.createSimulatedBackend!({
        initialRpm: 5000,
        initialLidOpen: true,
      });

      // Cannot start when lid is open
      await expect(backend.invoke('centrifuge.start', {})).rejects.toThrow(/lid is open/);

      // Close lid
      const closeRes = await backend.invoke('centrifuge.close_lid', {});
      expect(closeRes).toEqual({ lidOpen: false });

      // Start spinning
      const startRes = await backend.invoke('centrifuge.start', {});
      expect(startRes).toEqual({ running: true, targetRpm: 5000 });

      // Cannot open lid while spinning
      await expect(backend.invoke('centrifuge.open_lid', {})).rejects.toThrow(/rotor is spinning/);

      // Stop centrifuge
      const stopRes = await backend.invoke('centrifuge.stop', {});
      expect(stopRes).toEqual({ running: false });

      // Now lid can open
      const openRes = await backend.invoke('centrifuge.open_lid', {});
      expect(openRes).toEqual({ lidOpen: true });

      // Set speed policy test
      const speedRes = await backend.invoke('centrifuge.set_speed', { rpm: 8000 });
      expect(speedRes).toEqual({ targetRpm: 8000 });

      // Out of range speed
      await expect(backend.invoke('centrifuge.set_speed', { rpm: 25000 })).rejects.toThrow(
        /exceeds maximum limit/,
      );

      await backend.close();
    });
  });

  describe('Heater-Shaker Module', () => {
    it('regulates temperature and orbital shaker speed', async () => {
      const module = getModule(heaterShakerModuleId);
      const backend = module.createSimulatedBackend!({
        initialTemperatureC: 22,
        initialTargetRpm: 1200,
      });

      // Set temperature
      const tempRes = await backend.invoke('temperature.set', { targetTemperatureC: 37 });
      expect(tempRes).toEqual({ targetTemperatureC: 37 });

      const tempRead = await backend.invoke('temperature.read', {});
      expect(tempRead).toEqual({
        currentTemperatureC: 37,
        targetTemperatureC: 37,
        heating: true,
      });

      // Reject out of bounds temperature
      await expect(backend.invoke('temperature.set', { targetTemperatureC: 150 })).rejects.toThrow(
        /between 4°C and 100°C/,
      );

      // Set speed & start shaker
      await backend.invoke('shaker.set_speed', { rpm: 1500 });
      const startRes = await backend.invoke('shaker.start', {});
      expect(startRes).toEqual({ running: true, targetRpm: 1500 });

      const shakerRead = await backend.invoke('shaker.read', {});
      expect(shakerRead).toEqual({
        currentRpm: 1500,
        targetRpm: 1500,
        running: true,
      });

      // Stop shaker
      const stopRes = await backend.invoke('shaker.stop', {});
      expect(stopRes).toEqual({ running: false });

      await backend.close();
    });
  });

  describe('Pipette Module', () => {
    it('manages tips and liquid aspiration/dispensation with safety interlocks', async () => {
      const module = getModule(pipetteModuleId);
      const backend = module.createSimulatedBackend!({
        maxVolumeUl: 200,
        initialHasTip: false,
      });

      // Cannot aspirate without a tip
      await expect(backend.invoke('pipette.aspirate', { volumeUl: 50 })).rejects.toThrow(
        /tip attached/,
      );

      // Attach tip
      const attachRes = await backend.invoke('pipette.attach_tip', {});
      expect(attachRes).toEqual({ hasTip: true });

      // Aspirate 100 µL
      const aspRes = await backend.invoke('pipette.aspirate', { volumeUl: 100 });
      expect(aspRes).toEqual({
        currentVolumeUl: 100,
        aspiratedUl: 100,
      });

      // Aspirate beyond capacity (100 + 150 > 200) throws error
      await expect(backend.invoke('pipette.aspirate', { volumeUl: 150 })).rejects.toThrow(
        /exceeds remaining tip capacity/,
      );

      // Dispense 40 µL
      const dispRes = await backend.invoke('pipette.dispense', { volumeUl: 40 });
      expect(dispRes).toEqual({
        currentVolumeUl: 60,
        dispensedUl: 40,
      });

      // Dispense more than present throws error
      await expect(backend.invoke('pipette.dispense', { volumeUl: 100 })).rejects.toThrow(
        /exceeds liquid in tip/,
      );

      // Blowout empties tip
      const blowoutRes = await backend.invoke('pipette.blowout', {});
      expect(blowoutRes).toEqual({ blownOut: true, currentVolumeUl: 0 });

      // Eject tip
      const ejectRes = await backend.invoke('pipette.eject_tip', {});
      expect(ejectRes).toEqual({ hasTip: false });

      await backend.close();
    });
  });

  describe('createLabWorkbench runtime helper', () => {
    it('instantiates a fully wired PinoutRuntime with lab automation devices', async () => {
      const runtime = await createLabWorkbench({
        includeSyringePump: true,
        includeCentrifuge: true,
        includeHeaterShaker: true,
        includePipette: true,
      });

      const devices = runtime.devices();
      expect(devices.map((d) => d.id)).toEqual([
        defaultLabDeviceIds.syringePump,
        defaultLabDeviceIds.centrifuge,
        defaultLabDeviceIds.heaterShaker,
        defaultLabDeviceIds.pipette,
      ]);

      // Invoke capability through runtime
      const syringeResult = await runtime.invoke(
        defaultLabDeviceIds.syringePump,
        'syringe_pump.infuse',
        { volumeMl: 2 },
      );
      expect(syringeResult.infusedMl).toBe(2);

      const pipetteResult = await runtime.invoke(defaultLabDeviceIds.pipette, 'pipette.aspirate', {
        volumeUl: 50,
      });
      expect(pipetteResult.aspiratedUl).toBe(50);
    });
  });
});
