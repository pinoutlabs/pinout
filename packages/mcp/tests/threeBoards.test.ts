import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { builtinBoards, PinoutRuntime, loopbackTransport, type SerialPortInfo } from '@pinout/core';
import { encodeEvent, encodeResponse, encodeFailure } from '../../core/src/protocol.js';
import { BoardDiscovery } from '../../daemon/src/boardDiscovery.js';
import { startDaemon } from '../../daemon/src/start.js';
import { createDaemonMcpServer } from '../src/createDaemonServer.js';
import { expect, it } from 'vitest';

it('keeps board descriptor data identical to firmware catalog', () => {
  for (const board of builtinBoards)
    expect(board).toEqual(
      JSON.parse(readFileSync(`firmware/boards/${board.boardId}.json`, 'utf8')),
    );
});

for (const board of builtinBoards)
  it(`${board.boardId}: static MCP, discovery, pin rules, heartbeat and reconnect`, async () => {
    const runtime = new PinoutRuntime();
    let ports: SerialPortInfo[] = [];
    let kicks = 0;
    let writes = 0;
    const discovery = new BoardDiscovery(runtime, {
      listPorts: async () => ports,
      transport: () => {
        let armed = false;
        let value = false;
        const info = {
          boardId: board.boardId,
          firmware: board.family === 'avr' ? 'uno-bridge' : 'esp32-bridge',
          version: 'test',
          protocol: 1,
          capabilities: [
            'sys.hello',
            'sys.ping',
            'sys.arm',
            'sys.disarm',
            'watchdog.kick',
            'gpio.configSafeState',
            'gpio.write',
            'gpio.read',
          ],
          features: ['watchdog', 'arming'],
        };
        return loopbackTransport({
          onOpen: () => [encodeEvent('ready', info)],
          onWrite: (data) => {
            const { id, action, payload } = JSON.parse(data) as {
              id: string;
              action: string;
              payload: Record<string, unknown>;
            };
            if (action === 'sys.hello') return encodeResponse(id, info);
            if (action === 'gpio.configSafeState') return encodeResponse(id, payload);
            if (action === 'sys.ping') return encodeResponse(id, { pong: true });
            if (action === 'sys.arm' || action === 'sys.disarm') {
              armed = action === 'sys.arm';
              if (!armed) value = false;
              return encodeResponse(id, {
                armed,
                state: armed ? 'armed' : 'disarmed',
                timeoutMs: 300,
              });
            }
            if (action === 'watchdog.kick') {
              kicks++;
              return encodeResponse(id, { kicked: true, timeoutMs: 300 });
            }
            if (action === 'gpio.write') {
              if (!armed) return encodeFailure(id, 'NOT_ARMED', 'Arm first');
              value = payload.value as boolean;
              writes++;
              return encodeResponse(id, { pin: payload.pin, value });
            }
            return encodeResponse(id, { pin: payload.pin, value });
          },
        });
      },
    });
    const daemon = await startDaemon(runtime, { port: 0, token: 'test' });
    const server = createDaemonMcpServer({
      baseUrl: `http://127.0.0.1:${daemon.port}`,
      token: 'test',
    });
    const client = new Client({ name: 'three-boards', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st);
      await client.connect(ct);
      const before = await client.listTools();
      expect(before.tools.map((t) => t.name)).toContain('pinout__invoke');
      ports = [{ path: '/dev/cu.test', vendorId: '2341', productId: '0043', serialNumber: 'test' }];
      await discovery.scan();
      const devices = await client.callTool({ name: 'pinout__list_devices' });
      const id = (devices.structuredContent as { devices: Array<{ id: string }> }).devices[0]!.id;
      expect(id).toContain(board.boardId);
      const description = await client.callTool({
        name: 'pinout__describe_device',
        arguments: { deviceId: id },
      });
      expect(description.structuredContent).toMatchObject({
        operationalState: { board: { boardId: board.boardId } },
      });
      expect(await client.listTools()).toEqual(before);
      if (board.family === 'avr') {
        const smoke = await promisify(execFile)(
          process.execPath,
          ['scripts/hardware-smoke.mjs', '--device', id, '--pin', 'A1', '--yes'],
          {
            env: {
              ...process.env,
              PINOUT_DAEMON_URL: `http://127.0.0.1:${daemon.port}`,
              PINOUT_TOKEN: 'test',
            },
          },
        );
        expect(JSON.parse(smoke.stdout)).toMatchObject({
          boardId: 'arduino-uno',
          pin: 15,
          readOn: { result: { value: true } },
          readOff: { result: { value: false } },
        });
      }
      await client.callTool({ name: 'pinout__acquire_lease', arguments: { deviceId: id } });
      const invoke = (capability: string, args: Record<string, unknown>) =>
        client.callTool({ name: 'pinout__invoke', arguments: { deviceId: id, capability, args } });
      const pin = board.family === 'avr' ? 15 : 4;
      expect((await invoke('gpio.write', { pin, value: true })).isError).toBe(true);
      expect((await invoke('sys.arm', { timeoutMs: 0 })).isError).toBe(true);
      expect((await invoke('sys.arm', { timeoutMs: 300 })).isError).not.toBe(true);
      expect((await invoke('gpio.write', { pin, value: true })).isError).not.toBe(true);
      expect((await invoke('gpio.read', { pin })).structuredContent).toMatchObject({
        result: { value: true },
      });
      const count = writes;
      expect(
        (await invoke('gpio.write', { pin: board.reservedPins[0], value: true })).isError,
      ).toBe(true);
      expect((await invoke('gpio.pwm', { pin, duty: 0.5 })).isError).toBe(true);
      expect(writes).toBe(count);
      await new Promise((resolve) => setTimeout(resolve, 360));
      expect(kicks).toBeGreaterThan(0);
      ports = [];
      await discovery.scan();
      expect((await invoke('gpio.write', { pin, value: true })).isError).toBe(true);
      expect(await client.listTools()).toEqual(before);
      // Simulate a new enumeration path after unplug; the USB serial keeps the device ID stable.
      ports = [
        { path: '/dev/cu.test2', vendorId: '2341', productId: '0043', serialNumber: 'test' },
      ];
      await discovery.scan();
      expect((await invoke('gpio.write', { pin, value: true })).isError).toBe(true);
      expect(await client.listTools()).toEqual(before);
    } finally {
      await client.close();
      await server.close();
      await discovery.close();
      await daemon.close();
    }
  }, 30_000);
