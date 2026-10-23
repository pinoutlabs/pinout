import { describe, expect, it } from 'vitest';
import {
  bleGattTransport,
  connect,
  createSimulatedBleGattBridge,
  pinoutBleDefaultAttPayloadBytes,
  pinoutBleGattUuids,
  simulatedEsp32,
} from '@pinout/core';
import { createTransportFromConfig } from '../src/home/transportFactory.js';
import type { BleGattSession } from '../src/transports/bleGattSession.js';
import { ByteQueue } from '../src/transports/byteQueue.js';

describe('bleGattTransport', () => {
  it('exposes the documented Pinout GATT UUID layout', () => {
    expect(pinoutBleGattUuids.service).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(pinoutBleGattUuids.rx).not.toBe(pinoutBleGattUuids.tx);
    expect(pinoutBleGattUuids.service).not.toBe(pinoutBleGattUuids.rx);
  });

  it('handshakes and actuates through the simulated BLE GATT bridge (SIMULATED)', async () => {
    const bridge = createSimulatedBleGattBridge();
    expect(bridge.uuids).toEqual(pinoutBleGattUuids);
    expect(bridge.transport.kind).toBe('simulated-ble-gatt');

    const device = await connect({ transport: bridge.transport, timeoutMs: 2000 });
    try {
      expect(device.info.firmware).toBe('esp32-bridge');
      await device.arm();
      await device.gpio.write(2, true);
      await expect(device.gpio.read(2)).resolves.toBe(true);
    } finally {
      await device.close();
      await bridge.close();
    }
  });

  it('reassembles ATT-sized TX notification fragments into protocol lines', async () => {
    const bridge = createSimulatedBleGattBridge({
      attPayloadBytes: pinoutBleDefaultAttPayloadBytes,
    });
    const device = await connect({ transport: bridge.transport, timeoutMs: 2000 });
    try {
      await device.arm();
      await expect(device.invoke('sys.ping', {})).resolves.toMatchObject({ pong: true });
    } finally {
      await device.close();
      await bridge.close();
    }
  });

  it('creates a factory transport for simulated-ble-gatt', async () => {
    const transport = await createTransportFromConfig({ type: 'simulated-ble-gatt' });
    expect(transport.kind).toBe('simulated-ble-gatt');
    const device = await connect({ transport, timeoutMs: 2000 });
    try {
      expect(device.info.protocol).toBe(1);
    } finally {
      await device.close();
    }
  });

  it('rejects writes before open', async () => {
    const tx = new ByteQueue();
    const session: BleGattSession = {
      txNotifications: tx,
      async open() {
        /* no-op */
      },
      async close() {
        tx.close();
      },
      async writeRx() {
        /* no-op */
      },
    };
    const transport = bleGattTransport({ session });
    await expect(transport.write(new TextEncoder().encode('{}\n'))).rejects.toThrow(
      /not open/i,
    );
  });

  it('moves opaque bytes only — inner simulatedEsp32 still owns protocol', async () => {
    const inner = simulatedEsp32();
    const bridge = createSimulatedBleGattBridge({ inner, attPayloadBytes: 0 });
    const device = await connect({ transport: bridge.transport, timeoutMs: 2000 });
    try {
      await device.arm();
      await device.gpio.write(4, true);
      await expect(device.gpio.read(4)).resolves.toBe(true);
    } finally {
      await device.close();
      await bridge.close();
    }
  });
});
