import { afterEach, describe, expect, it } from 'vitest';
import { DeviceError, PinoutRuntime, registerModule, runLampConformance } from '@pinout/core';
import {
  buildMqttLampMapping,
  createMqttLampBackend,
  MqttLampBackend,
  mqttLampModule,
  resolveMqttLampTopics,
  validateMqttLampConfig,
} from '../src/index.js';

describe('MQTT lamp topic templates', () => {
  it('resolves Tasmota defaults', () => {
    const topics = resolveMqttLampTopics({ deviceId: 'desk_lamp', preset: 'tasmota' });
    expect(topics.commandTopic).toBe('cmnd/desk_lamp/POWER');
    expect(topics.stateTopic).toBe('stat/desk_lamp/POWER');
    expect(topics.onPayload).toBe('ON');
    expect(topics.offPayload).toBe('OFF');
  });

  it('resolves Shelly defaults', () => {
    const topics = resolveMqttLampTopics({ deviceId: 'shelly1-AABB', preset: 'shelly' });
    expect(topics.commandTopic).toBe('shellies/shelly1-AABB/relay/0/command');
    expect(topics.stateTopic).toBe('shellies/shelly1-AABB/relay/0');
    expect(topics.onPayload).toBe('on');
    expect(topics.offPayload).toBe('off');
  });

  it('builds declarative mapping with lamp.power publish rule', () => {
    const topics = resolveMqttLampTopics({ deviceId: 'plug1', preset: 'tasmota' });
    const mapping = buildMqttLampMapping(topics);
    expect(mapping.ingests[0]?.as).toEqual({ kind: 'state', field: 'on' });
    expect(mapping.publishes[0]?.capability).toBe('lamp.power');
    expect(mapping.publishes[0]?.topic).toBe('cmnd/plug1/POWER');
  });
});

describe('validateMqttLampConfig', () => {
  it('rejects active-low with safeLevel low', () => {
    expect(() =>
      validateMqttLampConfig({ deviceId: 'x', polarity: 'active-low', safeLevel: 'low' }, false),
    ).toThrow(DeviceError);
  });

  it('requires custom topics for custom preset', () => {
    expect(() =>
      validateMqttLampConfig(
        { deviceId: 'x', preset: 'custom', polarity: 'active-high', safeLevel: 'low' },
        false,
      ),
    ).toThrow(/commandTopic|stateTopic|UNSUPPORTED_CONFIGURATION/);
  });
});

describe('MqttLampBackend lifecycle and evidence', () => {
  const closers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      await closers
        .pop()!
        .close()
        .catch(() => undefined);
    }
  });

  it('starts disarmed and rejects actuation until arm', async () => {
    const backend = await createMqttLampBackend({
      deviceId: 'lamp_a',
      polarity: 'active-high',
      safeLevel: 'low',
      requireWatchdog: false,
    });
    closers.push(backend);

    const status = (await backend.invoke('lamp.status', {})) as { armed: string };
    expect(status.armed).toBe('disarmed');

    await expect(backend.invoke('lamp.on', {})).rejects.toMatchObject({ code: 'NOT_ARMED' });

    const arm = await backend.invoke('lamp.arm', { timeoutMs: 1000 });
    expect(arm.armed).toBe('armed');

    const on = await backend.invoke('lamp.on', {});
    expect(on.on).toBe(true);

    const afterOn = (await backend.invoke('lamp.status', {})) as {
      commanded: { on: boolean | null };
      acknowledged: { on: boolean | null };
      observed: { on: boolean | null; source: string };
      topics: { commandTopic: string; stateTopic: string };
    };
    expect(afterOn.commanded.on).toBe(true);
    expect(afterOn.acknowledged.on).toBe(true);
    expect(afterOn.observed.on).toBe(true);
    expect(afterOn.observed.source).toBe('simulated');
    expect(afterOn.topics.commandTopic).toBe('cmnd/lamp_a/POWER');
    expect(afterOn.topics.stateTopic).toBe('stat/lamp_a/POWER');
  });

  it('exposes topic templates and mapping', async () => {
    const backend = await createMqttLampBackend({
      deviceId: 'kitchen_plug',
      preset: 'shelly',
      polarity: 'active-high',
      safeLevel: 'low',
      requireWatchdog: false,
    });
    closers.push(backend);

    const topics = backend.getTopicTemplates();
    expect(topics.preset).toBe('shelly');
    expect(topics.commandTopic).toContain('shellies/kitchen_plug');
    expect(backend.getMapping().publishes[0]?.capability).toBe('lamp.power');
  });

  it('requires explicit requireWatchdog:false to arm', async () => {
    const backend = await createMqttLampBackend({
      deviceId: 'lamp_wd',
      polarity: 'active-high',
      safeLevel: 'low',
      requireWatchdog: true,
    });
    closers.push(backend);

    await expect(backend.invoke('lamp.arm', {})).rejects.toMatchObject({
      code: 'WATCHDOG_NOT_SUPPORTED',
    });
  });

  it('preserves honest disagreement via setSimulatedReadbackLevel', async () => {
    const backend = await createMqttLampBackend({
      deviceId: 'lamp_fault',
      polarity: 'active-high',
      safeLevel: 'low',
      requireWatchdog: false,
    });
    closers.push(backend);

    await backend.invoke('lamp.arm', {});
    await backend.invoke('lamp.on', {});
    backend.setSimulatedReadbackLevel(false);

    const status = (await backend.invoke('lamp.status', {})) as {
      commanded: { on: boolean | null };
      observed: { on: boolean | null };
    };
    expect(status.commanded.on).toBe(true);
    expect(status.observed.on).toBe(false);
  });

  it('registers pinout/mqtt-lamp on PinoutRuntime', async () => {
    registerModule(mqttLampModule);
    const runtime = new PinoutRuntime();
    closers.push(runtime);

    const device = await runtime.registerFromModule('pinout/mqtt-lamp', {
      id: 'home-lamp-1',
      simulated: true,
      backendOptions: {
        deviceId: 'runtime_lamp',
        polarity: 'active-high',
        safeLevel: 'low',
        requireWatchdog: false,
      },
    });

    await device.invoke('lamp.arm', {});
    const on = await device.invoke('lamp.on', {});
    expect(on.on).toBe(true);
  });
});

describe('MqttLampBackend Shared Conformance Suite', () => {
  it('passes shared lamp conformance suite without state readback', async () => {
    const result = await runLampConformance(
      () =>
        createMqttLampBackend({
          deviceId: 'conf_a',
          polarity: 'active-high',
          safeLevel: 'low',
          requireWatchdog: false,
          enableStateReadback: false,
        }),
      { hasReadback: false },
    );

    expect(result.passed).toBe(true);
    for (const check of result.checks) {
      expect(check.status).not.toBe('failed');
    }
  });

  it('passes shared lamp conformance suite with state-topic readback', async () => {
    const result = await runLampConformance(
      () =>
        createMqttLampBackend({
          deviceId: 'conf_b',
          polarity: 'active-high',
          safeLevel: 'low',
          requireWatchdog: false,
          enableStateReadback: true,
        }),
      { hasReadback: true },
    );

    expect(result.passed).toBe(true);
    for (const check of result.checks) {
      expect(check.status).not.toBe('failed');
    }
  });

  it('createSimulated returns a ready-gated backend without awaiting', async () => {
    const backend = MqttLampBackend.createSimulated({
      deviceId: 'sync_sim',
      polarity: 'active-high',
      safeLevel: 'low',
      requireWatchdog: false,
    });
    expect(backend.kind).toBe('simulated');
    await backend.invoke('lamp.arm', {});
    const on = await backend.invoke('lamp.on', {});
    expect(on.on).toBe(true);
    await backend.close();
  });
});
