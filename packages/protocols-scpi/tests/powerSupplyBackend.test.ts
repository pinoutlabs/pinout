import { afterEach, describe, expect, it } from 'vitest';
import { PinoutRuntime, registerModule } from '@pinout/core';
import { ScpiPowerSupplyBackend, scpiPowerSupplyModule } from '../src/index.js';

describe('ScpiPowerSupplyBackend', () => {
  const backends: Array<{ close: () => Promise<void> }> = [];
  const runtimes: PinoutRuntime[] = [];

  afterEach(async () => {
    while (backends.length > 0) {
      await backends
        .pop()!
        .close()
        .catch(() => undefined);
    }
    while (runtimes.length > 0) {
      await runtimes
        .pop()!
        .close()
        .catch(() => undefined);
    }
  });

  it('sets and reads voltage on the simulated backend, and safeState turns output off', async () => {
    const backend = ScpiPowerSupplyBackend.createSimulated();
    backends.push(backend);
    expect(backend.kind).toBe('simulated');

    await backend.invoke('psu.setVoltage', { volts: 5 });
    await backend.invoke('psu.setCurrent', { amps: 0.5 });
    await backend.invoke('psu.enableOutput', {});
    const voltage = await backend.invoke('psu.readVoltage', {});
    expect(voltage.volts).toBe(5);
    const identity = await backend.invoke('psu.identify', {});
    expect(identity.model).toBe('SimulatedPSU');

    const beforeSafe = await backend.invoke('psu.status', {});
    expect(beforeSafe.outputEnabled).toBe(true);

    const safe = await backend.safeState();
    expect(safe.applied).toBe(true);
    const afterSafe = await backend.invoke('psu.status', {});
    expect(afterSafe.outputEnabled).toBe(false);
    const offVoltage = await backend.invoke('psu.readVoltage', {});
    expect(offVoltage.volts).toBe(0);

    await expect(backend.invoke('psu.notAThing', {})).rejects.toMatchObject({
      code: 'UNKNOWN_ACTION',
    });
  });

  it('registers via PinoutRuntime.registerFromModule after registerModule', async () => {
    registerModule(scpiPowerSupplyModule);
    const runtime = new PinoutRuntime();
    runtimes.push(runtime);
    const device = await runtime.registerFromModule('pinout/scpi-power-supply', {
      id: 'psu-1',
      simulated: true,
    });
    await device.invoke('psu.setVoltage', { volts: 12 });
    await device.invoke('psu.enableOutput', {});
    const read = await device.invoke('psu.readVoltage', {});
    expect(read.volts).toBe(12);
    await device.applySafeState();
    const status = await device.invoke('psu.status', {});
    expect(status.outputEnabled).toBe(false);
  });
});
