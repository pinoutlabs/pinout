import { afterEach, describe, expect, it } from 'vitest';
import { createRegisterMapBackend } from '../src/index.js';
import type { RegisterMapEntry } from '../src/registerMap.js';

const sampleMap: RegisterMapEntry[] = [
  {
    name: 'setpoint',
    area: 'holding',
    address: 10,
    access: 'write',
    type: 'uint16',
    scale: 0.5,
    unit: 'C',
  },
  {
    name: 'temperature',
    area: 'input',
    address: 0,
    access: 'read',
    type: 'uint16',
    scale: 0.1,
    offset: -50,
    unit: 'C',
  },
  { name: 'pump.start', area: 'coil', address: 30, access: 'write', type: 'bool' },
];

describe('createRegisterMapBackend', () => {
  const closers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      await closers
        .pop()!
        .close()
        .catch(() => undefined);
    }
  });

  it('reads and writes via modbus.read/modbus.write and per-entry capabilities', async () => {
    const backend = await createRegisterMapBackend({ map: sampleMap, simulated: true });
    closers.push(backend);
    expect(backend.kind).toBe('simulated');

    const written = await backend.invoke('modbus.write', { name: 'setpoint', value: 25 });
    expect(written.value).toBe(25);
    const read = await backend.invoke('modbus.read', { name: 'setpoint' });
    expect(read.value).toBe(25);

    const perEntryWrite = await backend.invoke('modbus.pump.start.write', { value: true });
    expect(perEntryWrite.value).toBe(true);
    const perEntryRead = await backend.invoke('modbus.pump.start.read', {});
    expect(perEntryRead.value).toBe(true);

    const temperature = await backend.invoke('modbus.temperature.read', {});
    expect(temperature.value).toBe(-50);

    await expect(
      backend.invoke('modbus.write', { name: 'temperature', value: 1 }),
    ).rejects.toMatchObject({
      code: 'MODBUS_MAP_READ_ONLY',
    });
    await expect(backend.invoke('modbus.nope', {})).rejects.toMatchObject({
      code: 'UNKNOWN_ACTION',
    });
  });
});
