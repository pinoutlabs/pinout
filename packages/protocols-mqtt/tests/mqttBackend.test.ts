import { afterEach, describe, expect, it } from 'vitest';
import { PinoutRuntime, registerModule } from '@pinout/core';
import { MqttBackend, defaultMqttBridgeMapping, mqttBridgeModule } from '../src/index.js';

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('MqttBackend', () => {
  const closers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      await closers
        .pop()!
        .close()
        .catch(() => undefined);
    }
  });

  it('publishes through a mapping and reflects commanded state; ingest echo updates observed value', async () => {
    const backend = MqttBackend.createSimulated({ mapping: defaultMqttBridgeMapping });
    closers.push(backend);
    expect(backend.kind).toBe('simulated');

    const published = await backend.invoke('mqtt.setValue', { value: '21.5' });
    expect(published.topic).toBe('pinout/cmd/value');
    expect(published.payload).toBe('21.5');

    const commanded = backend.getOperationalState();
    expect(commanded.value).toBe('21.5');

    await waitFor(() => backend.getOperationalState().value === '21.5');
    expect(backend.getOperationalState().value).toBe('21.5');
    const evidence = backend.getOperationalStateEvidence();
    expect(evidence['mqtt.setValue']?.commanded.value).toBe('21.5');
    expect(evidence['mqtt.setValue']?.acknowledged.value).toBe('21.5');

    await expect(backend.invoke('mqtt.nope', {})).rejects.toMatchObject({ code: 'UNKNOWN_ACTION' });
  });

  it('registers pinout/mqtt-bridge on PinoutRuntime', async () => {
    registerModule(mqttBridgeModule);
    const runtime = new PinoutRuntime();
    closers.push(runtime);
    const device = await runtime.registerFromModule('pinout/mqtt-bridge', {
      id: 'mqtt-1',
      simulated: true,
    });
    const result = await device.invoke('mqtt.setValue', { value: 'on' });
    expect(result.payload).toBe('on');
    const status = await device.invoke('mqtt.status', {});
    expect(status.value).toBe('on');
  });
});
