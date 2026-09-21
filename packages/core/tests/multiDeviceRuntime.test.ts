import { describe, expect, it } from 'vitest';
import {
  PinoutRuntime,
  createBackendEventBus,
  createCompositeDevice,
  createSimulatedPumpBackend,
  createSimulatedRelayBackend,
  pumpModule,
  relayModule,
  registerModule,
  resetRuntimeModulesForTests,
} from '@pinout/core';
import { scpiPowerSupplyModule } from '@pinout/protocols-scpi';
import { grblModule } from '@pinout/protocols-grbl';
import { mqttBridgeModule } from '@pinout/protocols-mqtt';

describe('createBackendEventBus', () => {
  it('notifies subscribers and supports unsubscribe and clear', () => {
    const bus = createBackendEventBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((event, payload) => {
      seen.push(`${event}:${String(payload.value)}`);
    });
    bus.emit('tick', { value: 1 });
    unsubscribe();
    bus.emit('tick', { value: 2 });
    expect(seen).toEqual(['tick:1']);
    bus.subscribe(() => undefined);
    expect(bus.size).toBe(1);
    bus.clear();
    expect(bus.size).toBe(0);
  });
});

describe('multi-device runtime governance', () => {
  it('applies safeState across composite and peer devices on halt', async () => {
    const runtime = new PinoutRuntime();
    const applied: string[] = [];
    runtime.on((event) => {
      if (event.event === 'device.safe_state_applied') {
        applied.push(event.deviceId);
      }
    });

    const rig = createCompositeDevice({
      id: 'fluid-rig',
      moduleId: 'example/fluid-rig',
      deviceClass: 'system.fluid_rig',
      drivers: {
        pump: createSimulatedPumpBackend(),
        contactor: createSimulatedRelayBackend(),
      },
      capabilities: [
        ...pumpModule.capabilities.filter((capability) => capability.name !== 'status.read'),
        ...relayModule.capabilities.filter((capability) => capability.name !== 'status.read'),
      ],
      routes: {
        'pump.set': { driver: 'pump' },
        'pump.stop': { driver: 'pump' },
        'pump.read': { driver: 'pump' },
        'relay.set': { driver: 'contactor' },
        'relay.read': { driver: 'contactor' },
      },
    });
    await runtime.register(rig);
    await runtime.registerModuleDevice(pumpModule, { id: 'standalone-pump', simulated: true });

    await runtime.invoke('fluid-rig', 'relay.set', { on: true });
    await runtime.invoke('fluid-rig', 'pump.set', { speed: 40 });
    await runtime.invoke('standalone-pump', 'pump.set', { speed: 55 });

    runtime.halt.halt('multi-device safe state');
    await runtime.waitForSafeState();

    expect(applied.sort()).toEqual(['fluid-rig', 'standalone-pump']);
    expect(rig.getOperationalStateSnapshot()).toMatchObject({
      pump: { speed: 0 },
      contactor: { on: false },
    });
    const standalone = runtime.getDevice('standalone-pump');
    expect(standalone.getOperationalStateSnapshot()).toMatchObject({ speed: 0 });
    await runtime.close();
  });
});

describe('multi-protocol PinoutRuntime registration', () => {
  it('registers SCPI, GRBL, and MQTT modules side by side without cross-talk', async () => {
    resetRuntimeModulesForTests();
    registerModule(scpiPowerSupplyModule);
    registerModule(grblModule);
    registerModule(mqttBridgeModule);

    const runtime = new PinoutRuntime();
    try {
      await runtime.registerFromModule(scpiPowerSupplyModule.id, {
        id: 'psu-01',
        simulated: true,
      });
      await runtime.registerFromModule(grblModule.id, {
        id: 'cnc-01',
        simulated: true,
        backendOptions: { motionDelayMs: 0 },
      });
      await runtime.registerFromModule(mqttBridgeModule.id, {
        id: 'mqtt-01',
        simulated: true,
      });

      const classes = runtime
        .devices()
        .map((device) => device.deviceClass)
        .sort();
      expect(classes).toEqual(['bridge.mqtt', 'motion.cnc', 'supply.power']);

      await runtime.invoke('psu-01', 'psu.setVoltage', { volts: 12 });
      const psuStatus = await runtime.invoke('psu-01', 'psu.status', {});
      expect(psuStatus).toMatchObject({ commandedVolts: 12 });

      const grblStatus = await runtime.invoke('cnc-01', 'grbl.status', {});
      expect(grblStatus).toBeTypeOf('object');

      const mqttStatus = await runtime.invoke('mqtt-01', 'mqtt.status', {});
      expect(mqttStatus).toBeTypeOf('object');

      // Capability routing stays device-scoped.
      await expect(runtime.invoke('psu-01', 'grbl.status', {})).rejects.toBeDefined();
      await expect(runtime.invoke('cnc-01', 'psu.status', {})).rejects.toBeDefined();
    } finally {
      await runtime.close();
      resetRuntimeModulesForTests();
    }
  });
});
