import { describe, expect, it } from 'vitest';
import {
  PinoutRuntime,
  encodeEvent,
  encodeFailure,
  encodeResponse,
  loopbackTransport,
  type SerialPortInfo,
} from '@pinout/core';
import {
  BoardDiscovery,
  boardDiscoveryFirmwareIds,
  boardDiscoveryVendorIds,
  isBoardDiscoveryFirmware,
  isBoardDiscoveryVendorId,
} from '../src/boardDiscovery.js';

function simulatedBridgeTransport(info: {
  boardId: string;
  firmware: string;
  capabilities?: string[];
  features?: string[];
}) {
  let armed = false;
  const identity = {
    boardId: info.boardId,
    firmware: info.firmware,
    version: 'test',
    protocol: 1,
    capabilities: info.capabilities ?? [
      'sys.hello',
      'sys.ping',
      'sys.arm',
      'sys.disarm',
      'watchdog.kick',
      'gpio.write',
      'gpio.read',
    ],
    features: info.features ?? ['watchdog', 'arming'],
  };
  return loopbackTransport({
    onOpen: () => [encodeEvent('ready', identity)],
    onWrite: (data) => {
      const { id, action } = JSON.parse(data) as { id: string; action: string };
      if (action === 'sys.hello') return encodeResponse(id, identity);
      if (action === 'sys.ping') return encodeResponse(id, { pong: true });
      if (action === 'sys.arm' || action === 'sys.disarm') {
        armed = action === 'sys.arm';
        return encodeResponse(id, {
          armed,
          state: armed ? 'armed' : 'disarmed',
          timeoutMs: 300,
        });
      }
      if (action === 'watchdog.kick') return encodeResponse(id, { kicked: true, timeoutMs: 300 });
      return encodeFailure(id, 'UNSUPPORTED_ACTION', action);
    },
  });
}

describe('BoardDiscovery Pico + firmware allowlists', () => {
  it('includes Raspberry Pi Pico VID 2e8a and micropython-bridge firmware', () => {
    expect(boardDiscoveryVendorIds).toContain('2e8a');
    expect(isBoardDiscoveryVendorId('2E8A')).toBe(true);
    expect(isBoardDiscoveryVendorId('ffff')).toBe(false);
    expect(boardDiscoveryFirmwareIds).toContain('micropython-bridge');
    expect(isBoardDiscoveryFirmware('micropython-bridge')).toBe(true);
    expect(isBoardDiscoveryFirmware('mystery-firmware')).toBe(false);
  });

  it('attaches a simulated Pico (VID 2e8a) advertising micropython-bridge', async () => {
    const runtime = new PinoutRuntime();
    const logs: string[] = [];
    const ports: SerialPortInfo[] = [
      {
        path: '/dev/cu.usbmodem-pico',
        vendorId: '2e8a',
        productId: '0005',
        serialNumber: 'pico-sim-1',
      },
    ];
    const discovery = new BoardDiscovery(runtime, {
      listPorts: async () => ports,
      log: (message) => logs.push(message),
      transport: () =>
        simulatedBridgeTransport({
          boardId: 'raspberry-pi-pico',
          firmware: 'micropython-bridge',
          // MicroPython desk path: no watchdog/arming features advertised.
          capabilities: ['sys.hello', 'sys.ping', 'sys.disarm', 'gpio.write', 'gpio.read'],
          features: [],
        }),
    });
    try {
      await discovery.scan();
      const devices = runtime.devices();
      expect(devices).toHaveLength(1);
      expect(devices[0]!.id).toMatch(/^raspberry-pi-pico-/);
      expect(devices[0]!.vendor).toBe('Raspberry Pi');
      expect(logs.some((line) => line.includes('Connected raspberry-pi-pico-'))).toBe(true);
    } finally {
      await discovery.close();
    }
  });

  it('ignores Pico VID ports that do not speak a Pinout bridge identity', async () => {
    const runtime = new PinoutRuntime();
    const logs: string[] = [];
    const discovery = new BoardDiscovery(runtime, {
      listPorts: async () => [
        {
          path: '/dev/cu.usbmodem-raw',
          vendorId: '2e8a',
          productId: '0005',
          serialNumber: 'raw',
        },
      ],
      log: (message) => logs.push(message),
      transport: () =>
        simulatedBridgeTransport({
          boardId: 'raspberry-pi-pico',
          firmware: 'not-a-pinout-bridge',
        }),
    });
    try {
      await discovery.scan();
      expect(runtime.devices()).toHaveLength(0);
      expect(logs.some((line) => /Flash the matching Pinout bridge/.test(line))).toBe(true);
    } finally {
      await discovery.close();
    }
  });

  it('still attaches classic ESP32 simulated serial identities', async () => {
    const runtime = new PinoutRuntime();
    const discovery = new BoardDiscovery(runtime, {
      listPorts: async () => [
        {
          path: '/dev/cu.usbserial-esp',
          vendorId: '303a',
          productId: '1001',
          serialNumber: 'esp-sim',
        },
      ],
      transport: () =>
        simulatedBridgeTransport({
          boardId: 'esp32-devkit-v1',
          firmware: 'esp32-bridge',
        }),
    });
    try {
      await discovery.scan();
      const devices = runtime.devices();
      expect(devices).toHaveLength(1);
      expect(devices[0]!.id).toMatch(/^esp32-devkit-v1-/);
      expect(devices[0]!.vendor).toBe('Espressif');
    } finally {
      await discovery.close();
    }
  });
});
