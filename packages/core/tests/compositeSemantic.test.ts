import { describe, expect, it } from 'vitest';
import {
  CompositeDeviceBackend,
  DeviceInstance,
  PinoutRuntime,
  createCompositeBackend,
  createSimulatedPumpBackend,
  createSimulatedRelayBackend,
  pumpModule,
  relayModule,
  getModule,
  unknownEvidence,
} from '@pinout/core';

describe('composite backends and semantic modules', () => {
  it('routes capabilities and forwards driver events', async () => {
    const events: string[] = [];
    const backend = createCompositeBackend({
      drivers: { contact: createSimulatedRelayBackend(), flow: createSimulatedPumpBackend() },
      routes: { 'relay.set': { driver: 'contact' }, 'pump.set': { driver: 'flow' } },
    });
    const device = new DeviceInstance({
      identity: { id: 'rig', moduleId: 'test/rig', deviceClass: 'system.rig' },
      backend,
      capabilities: [
        ...relayModule.capabilities,
        ...pumpModule.capabilities.filter((c) => c.name === 'pump.set'),
      ],
      policies: [],
      simulated: true,
      transportKinds: ['simulated'],
      getOperationalState: () => backend.getOperationalState?.() ?? {},
      onRuntimeEvent: (event) => events.push(`${event.event}:${String(event.payload.driver)}`),
    });
    const runtime = new PinoutRuntime();
    await runtime.register(device);
    await runtime.invoke('rig', 'relay.set', { on: true });
    await runtime.invoke('rig', 'pump.set', { speed: 25 });
    expect(events).toEqual(['relay.changed:contact', 'pump.changed:flow']);
    await runtime.close();
    await expect(runtime.invoke('rig', 'relay.set', { on: false })).rejects.toThrow();
  });

  it('forwards events from a registered composite through PinoutRuntime', async () => {
    const runtime = new PinoutRuntime();
    const seen: string[] = [];
    runtime.on((event) => seen.push(`${event.event}:${String(event.payload.driver)}`));
    const device = new DeviceInstance({
      identity: { id: 'event-rig', moduleId: 'test/rig', deviceClass: 'system.rig' },
      backend: createCompositeBackend({
        drivers: { contact: createSimulatedRelayBackend() },
        routes: { 'relay.set': { driver: 'contact' } },
      }),
      capabilities: [relayModule.capabilities[0]!],
      policies: [],
      simulated: true,
      transportKinds: ['simulated'],
      getOperationalState: () => ({}),
    });
    await runtime.register(device);
    await runtime.invoke(device.id, 'relay.set', { on: true });
    expect(seen).toEqual(['relay.changed:contact']);
    await runtime.close();
  });

  it('fails closed for an invalid route and registers semantic modules', async () => {
    expect(getModule('pinout/relay')).toBe(relayModule);
    expect(getModule('pinout/pump')).toBe(pumpModule);
    expect(
      () =>
        new CompositeDeviceBackend({ drivers: {}, routes: { 'relay.set': { driver: 'missing' } } }),
    ).toThrow();
  });

  it('enforces pump safety policy and supports idempotent close', async () => {
    const runtime = new PinoutRuntime();
    const pump = await runtime.registerFromModule('pinout/pump', { id: 'pump', simulated: true });
    await expect(pump.invoke('pump.set', { speed: 101 })).rejects.toThrow();
    await pump.invoke('pump.set', { speed: 40 });
    expect((await pump.invoke('status.read')).status).toBe('running');
    await runtime.close();
    await runtime.close();
  });

  it('rejects duplicate driver instances and unknown invoke routes', async () => {
    const shared = createSimulatedRelayBackend();
    expect(
      () =>
        new CompositeDeviceBackend({
          drivers: { a: shared, b: shared },
          routes: { 'relay.set': { driver: 'a' } },
        }),
    ).toThrow(/registered twice/);
    const backend = createCompositeBackend({
      drivers: { contact: createSimulatedRelayBackend() },
      routes: { 'relay.set': { driver: 'contact' } },
    });
    await expect(backend.invoke('nope.set', {})).rejects.toMatchObject({ code: 'UNKNOWN_ACTION' });
    await backend.close();
  });

  it('aggregates safeState and evidence, skipping drivers that omit them', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const makeDriver = (label: string, withSafety: boolean) => {
      const evidence = unknownEvidence('simulated');
      const driver = {
        kind: 'simulated' as const,
        async invoke() {
          return { label };
        },
        async close() {
          return undefined;
        },
        subscribe() {
          return () => undefined;
        },
        getOperationalState() {
          return { label };
        },
      };
      if (!withSafety) {
        return driver;
      }
      return {
        ...driver,
        getOperationalStateEvidence: () => ({ on: evidence }),
        safeState: async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await delay(25);
          concurrent -= 1;
          return { applied: true, label };
        },
      };
    };
    const backend = new CompositeDeviceBackend({
      drivers: {
        alpha: makeDriver('alpha', true),
        beta: makeDriver('beta', true),
        gamma: makeDriver('gamma', false),
      },
      routes: {
        'alpha.ping': { driver: 'alpha' },
        'beta.ping': { driver: 'beta' },
        'gamma.ping': { driver: 'gamma' },
      },
    });
    const safe = await backend.safeState();
    expect(safe).toEqual({
      alpha: { applied: true, label: 'alpha' },
      beta: { applied: true, label: 'beta' },
    });
    expect(maxConcurrent).toBe(2);
    const evidence = backend.getOperationalStateEvidence();
    expect(evidence['alpha.on']).toBeDefined();
    expect(evidence['beta.on']).toBeDefined();
    expect(evidence['gamma.on']).toBeUndefined();
    await backend.close();
  });

  it('runs invokeIndependent in parallel across drivers and serially on one driver', async () => {
    const log: string[] = [];
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const makeDriver = (name: string) => ({
      kind: 'simulated' as const,
      async invoke(action: string) {
        log.push(`${name}:${action}:start`);
        await delay(20);
        log.push(`${name}:${action}:end`);
        return { action };
      },
      async close() {
        return undefined;
      },
      subscribe() {
        return () => undefined;
      },
    });
    const backend = new CompositeDeviceBackend({
      drivers: { left: makeDriver('left'), right: makeDriver('right') },
      routes: {
        'left.one': { driver: 'left' },
        'left.two': { driver: 'left' },
        'right.one': { driver: 'right' },
      },
    });
    const results = await backend.invokeIndependent([
      { capability: 'left.one', payload: {} },
      { capability: 'right.one', payload: {} },
      { capability: 'left.two', payload: {} },
    ]);
    expect(results).toEqual([
      { action: 'left.one' },
      { action: 'right.one' },
      { action: 'left.two' },
    ]);
    const leftOneEnd = log.indexOf('left:left.one:end');
    const leftTwoStart = log.indexOf('left:left.two:start');
    expect(leftOneEnd).toBeGreaterThanOrEqual(0);
    expect(leftTwoStart).toBeGreaterThan(leftOneEnd);
    expect(log.indexOf('right:right.one:start')).toBeGreaterThanOrEqual(0);
    await expect(
      backend.invokeIndependent([{ capability: 'missing.cap', payload: {} }]),
    ).rejects.toMatchObject({ code: 'UNKNOWN_ACTION' });
    await backend.close();
  });
});
