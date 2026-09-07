import { afterEach, describe, expect, it } from 'vitest';
import { PinoutRuntime, registerModule } from '@pinout/core';
import { GrblBackend, GrblSimulatorTransport, grblModule } from '../src/index.js';

describe('GrblBackend', () => {
  const closers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      await closers
        .pop()!
        .close()
        .catch(() => undefined);
    }
  });

  it('homes, moves, and reports status against GrblSimulatorTransport', async () => {
    const backend = GrblBackend.createSimulated();
    closers.push(backend);
    expect(backend.kind).toBe('simulated');

    const idle = await backend.invoke('grbl.status', {});
    expect(idle.state).toBe('Idle');

    await backend.invoke('grbl.home', {});
    await backend.invoke('grbl.rapidMove', { x: 10, y: 5 });
    const afterRapid = await backend.invoke('grbl.status', {});
    expect(afterRapid.wpos).toEqual({ x: 10, y: 5, z: 0 });

    await backend.invoke('grbl.linearMove', { x: 12, feedRate: 300 });
    const afterLinear = await backend.invoke('grbl.status', {});
    expect((afterLinear.wpos as { x: number }).x).toBeCloseTo(12);

    const held = await backend.invoke('grbl.hold', {});
    expect(held.held).toBe(true);
    expect(String(held.note)).toMatch(/mechanical safety/i);

    const safe = await backend.safeState();
    expect(safe.applied).toBe(true);
    expect(String(safe.note)).toMatch(/e-stop/i);

    await expect(backend.invoke('grbl.fly', {})).rejects.toMatchObject({ code: 'UNKNOWN_ACTION' });
  });

  it('registers on PinoutRuntime via pinout/grbl', async () => {
    registerModule(grblModule);
    const runtime = new PinoutRuntime();
    closers.push(runtime);
    const device = await runtime.registerFromModule('pinout/grbl', {
      id: 'cnc-1',
      simulated: true,
    });
    await device.invoke('grbl.home', {});
    await device.invoke('grbl.rapidMove', { x: 3 });
    const status = await device.invoke('grbl.status', {});
    expect((status.wpos as { x: number }).x).toBe(3);
  });

  it('uses GrblSimulatorTransport when constructed with an explicit transport', async () => {
    const transport = new GrblSimulatorTransport();
    const backend = await GrblBackend.create({ transport, simulated: true });
    closers.push(backend);
    expect(backend.kind).toBe('simulated');
    const status = await backend.invoke('grbl.status', {});
    expect(status.state).toBe('Idle');
  });
});
