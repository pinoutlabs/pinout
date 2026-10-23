import { afterEach, describe, expect, it } from 'vitest';
import { PinoutRuntime, registerModule } from '@pinout/core';
import {
  createEsp32MqttBackend,
  createEsp32MqttMapping,
  decodeIngestion,
  encodePublishPayload,
  esp32MqttModule,
  esp32MqttTopicPrefix,
  topicMatches,
} from '../src/index.js';

describe('ESP32 MQTT mapping', () => {
  it('builds declarative cmd/state topics for a device id', () => {
    const mapping = createEsp32MqttMapping({ deviceId: 'bench-1' });
    const prefix = esp32MqttTopicPrefix('bench-1');
    expect(prefix).toBe('pinout/esp32/bench-1');
    expect(mapping.publishes.map((rule) => rule.capability)).toEqual([
      'sys.arm',
      'sys.disarm',
      'gpio.write',
      'gpio.toggle',
      'gpio.read',
    ]);
    expect(mapping.publishes.find((rule) => rule.capability === 'gpio.write')?.topic).toBe(
      `${prefix}/cmd/gpio.write`,
    );
    expect(mapping.ingests.some((rule) => rule.topic === `${prefix}/state/gpio/+`)).toBe(true);
  });

  it('encodes json publish payloads and decodes gpio state numbers', () => {
    const mapping = createEsp32MqttMapping({ deviceId: 'local' });
    const write = mapping.publishes.find((rule) => rule.capability === 'gpio.write')!;
    expect(encodePublishPayload(write, { pin: 2, value: true })).toBe(
      JSON.stringify({ pin: 2, value: true }),
    );

    const gpioRule = mapping.ingests.find((rule) => rule.as.kind === 'event')!;
    expect(topicMatches(gpioRule.topic, 'pinout/esp32/local/state/gpio/2')).toBe(true);
    expect(decodeIngestion(gpioRule, Buffer.from('1')).value).toBe(1);
  });
});

describe('Esp32MqttBackend simulator', () => {
  const closers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      await closers
        .pop()!
        .close()
        .catch(() => undefined);
    }
  });

  it('rejects actuation while disarmed, then arms and writes gpio over MQTT', async () => {
    const backend = await createEsp32MqttBackend({ deviceId: 'sim-a' });
    closers.push(backend);
    expect(backend.kind).toBe('simulated');

    await expect(backend.invoke('gpio.write', { pin: 2, value: true })).rejects.toMatchObject({
      code: 'NOT_ARMED',
    });

    await backend.invoke('sys.arm', {});
    expect(backend.getOperationalState().armed).toBe('armed');

    const written = await backend.invoke('gpio.write', { pin: 2, value: true });
    expect(written.topic).toBe('pinout/esp32/sim-a/cmd/gpio.write');
    expect(written.value).toBe(true);
    expect(backend.getOperationalState().gpio).toMatchObject({ '2': 1 });

    const read = await backend.invoke('gpio.read', { pin: 2 });
    expect(read).toMatchObject({ pin: 2, value: true, level: 1 });

    await backend.invoke('gpio.toggle', { pin: 2 });
    expect(backend.getOperationalState().gpio).toMatchObject({ '2': 0 });

    const status = await backend.invoke('mqtt.status', {});
    expect(status.evidenceStatus).toBe('SIMULATED');
    expect(status.topicPrefix).toBe('pinout/esp32/sim-a');
  });

  it('registers pinout/esp32-mqtt on PinoutRuntime (SIMULATED)', async () => {
    registerModule(esp32MqttModule);
    const runtime = new PinoutRuntime();
    closers.push(runtime);
    const device = await runtime.registerFromModule('pinout/esp32-mqtt', {
      id: 'wifi-1',
      simulated: true,
      backendOptions: { deviceId: 'wifi-1' },
    });
    await device.invoke('sys.arm', {});
    const result = await device.invoke('gpio.write', { pin: 4, value: true });
    expect(result.payload).toContain('"pin":4');
    const status = await device.invoke('mqtt.status', {});
    expect(status.evidenceStatus).toBe('SIMULATED');
    expect(status.gpio).toMatchObject({ '4': 1 });
  });

  it('requires a client for non-simulated protocol mode', async () => {
    await expect(createEsp32MqttBackend({ simulated: false })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
    });
  });
});
