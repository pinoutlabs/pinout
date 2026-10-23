import { describe, expect, it } from 'vitest';
import {
  createEsp32PanTiltBackend,
  createSimulatedPanTiltBackend,
  getModule,
  panTiltCapabilities,
  panTiltModule,
  panTiltModuleId,
  PinoutRuntime,
  runPanTiltConformance,
  simulatedEsp32,
  SimulatedPanTiltBackend,
  validatePanTiltConfig,
  type PanTiltStatus,
} from '@pinout/core';

describe('Pan-tilt module - configuration', () => {
  it('registers as a built-in module with arm/disarm/setAngles/status capabilities', () => {
    const module = getModule(panTiltModuleId);
    expect(module).toBe(panTiltModule);
    expect(module.id).toBe('pinout/pan-tilt');
    expect(module.deviceClass).toBe('actuator.pan_tilt');
    expect(module.capabilityNames).toEqual([
      'panTilt.arm',
      'panTilt.disarm',
      'panTilt.setAngles',
      'panTilt.setAngle',
      'panTilt.status',
      'status.read',
    ]);
    expect(panTiltCapabilities.length).toBe(6);
  });

  it('defaults to a single pan axis for empty simulated config', () => {
    const config = validatePanTiltConfig({});
    expect(config.pan.pin).toBe(13);
    expect(config.pan.safeAngle).toBe(90);
    expect(config.tilt).toBeUndefined();
    expect(config.autoArm).toBe(false);
    expect(config.provenance).toBe('simulated');
  });

  it('accepts one or two hobby-servo axes with limits and safe angles', () => {
    const dual = validatePanTiltConfig(
      {
        pan: { pin: 13, minAngle: 0, maxAngle: 180, safeAngle: 90 },
        tilt: { pin: 14, minAngle: 20, maxAngle: 160, safeAngle: 90 },
      },
      false,
    );
    expect(dual.pan.pin).toBe(13);
    expect(dual.tilt?.pin).toBe(14);
    expect(dual.tilt?.minAngle).toBe(20);
  });

  it('rejects safeAngle outside commissioned limits', () => {
    expect(() =>
      validatePanTiltConfig(
        { pan: { pin: 13, minAngle: 30, maxAngle: 150, safeAngle: 10 } },
        false,
      ),
    ).toThrowError(/safeAngle|UNSUPPORTED_CONFIGURATION/i);
  });

  it('rejects duplicate pan/tilt pins and input-only GPIOs', () => {
    expect(() => validatePanTiltConfig({ panPin: 13, tiltPin: 13 }, false)).toThrowError(
      /distinct|UNSUPPORTED_CONFIGURATION/i,
    );
    expect(() => validatePanTiltConfig({ panPin: 34 }, false)).toThrowError(
      /input-only|VALIDATION_ERROR/i,
    );
  });
});

describe('Pan-tilt module - simulated backend', () => {
  it('requires arm before setAngles and applies safe angles on disarm', async () => {
    const backend = createSimulatedPanTiltBackend({
      pan: { pin: 13, safeAngle: 90 },
      tilt: { pin: 27, safeAngle: 85, minAngle: 0, maxAngle: 180 },
    }) as SimulatedPanTiltBackend;

    await expect(backend.invoke('panTilt.setAngles', { pan: 40 })).rejects.toMatchObject({
      code: 'NOT_ARMED',
    });

    await backend.invoke('panTilt.arm', { timeoutMs: 2000 });
    await backend.invoke('panTilt.setAngles', { pan: 40, tilt: 50 });

    const status = (await backend.invoke('panTilt.status', {})) as PanTiltStatus;
    expect(status.armed).toBe('armed');
    expect(status.angles).toEqual({ pan: 40, tilt: 50 });
    expect(status.commanded.pan).toBe(40);
    expect(status.acknowledged.tilt).toBe(50);
    expect(status.observed.source).toBe('none');
    expect(status.observed.pan).toBeNull();

    const disarm = await backend.invoke('panTilt.disarm', {});
    expect(disarm).toEqual({ armed: 'disarmed', angles: { pan: 90, tilt: 85 } });

    await expect(backend.invoke('panTilt.setAngle', { angle: 10 })).rejects.toMatchObject({
      code: 'NOT_ARMED',
    });

    await backend.close();
  });

  it('enforces per-axis angle limits', async () => {
    const backend = createSimulatedPanTiltBackend({
      pan: { pin: 13, minAngle: 10, maxAngle: 170, safeAngle: 90 },
    });
    await backend.invoke('panTilt.arm', {});
    await expect(backend.invoke('panTilt.setAngle', { angle: 5 })).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(
      backend.invoke('panTilt.setAngles', { tilt: 40 }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
    await backend.close();
  });

  it('passes shared conformance suite against the simulator', async () => {
    const result = await runPanTiltConformance((options) =>
      createSimulatedPanTiltBackend(options ?? {}),
    );
    expect(result.passed).toBe(true);
    expect(result.checks.every((check) => check.status !== 'failed')).toBe(true);
  });
});

describe('Pan-tilt module - ESP32 gpio.servo path (simulated transport)', () => {
  it('drives gpio.servo after arm and returns honest non-observed status', async () => {
    const transport = simulatedEsp32();
    const backend = await createEsp32PanTiltBackend({
      panPin: 13,
      tiltPin: 14,
      pan: { pin: 13, safeAngle: 90 },
      tilt: { pin: 14, safeAngle: 90 },
      transport,
      provenance: 'simulated',
    });

    try {
      await expect(backend.invoke('panTilt.setAngles', { pan: 20 })).rejects.toThrowError(
        /NOT_ARMED|disarmed/i,
      );

      await backend.invoke('panTilt.arm', { timeoutMs: 1000 });
      const setResult = await backend.invoke('panTilt.setAngles', { pan: 25, tilt: 35 });
      expect(setResult.angles).toEqual({ pan: 25, tilt: 35 });

      const status = (await backend.invoke('panTilt.status', {})) as PanTiltStatus;
      expect(status.armed).toBe('armed');
      expect(status.provenance).toBe('simulated');
      expect(status.observed.source).toBe('none');
      expect(status.angles).toEqual({ pan: 25, tilt: 35 });

      const disarm = await backend.invoke('panTilt.disarm', {});
      expect(disarm.armed).toBe('disarmed');
      expect(disarm.angles).toEqual({ pan: 90, tilt: 90 });
    } finally {
      await backend.close();
    }
  });

  it('registers through PinoutRuntime with simulated backend options', async () => {
    const runtime = new PinoutRuntime();
    try {
      await runtime.registerFromModule(panTiltModuleId, {
        id: 'desk-pan-tilt-01',
        simulated: true,
        backendOptions: {
          panPin: 13,
          tiltPin: 27,
        },
      });

      await expect(
        runtime.invoke('desk-pan-tilt-01', 'panTilt.setAngles', { pan: 15 }),
      ).rejects.toBeTruthy();

      await runtime.invoke('desk-pan-tilt-01', 'panTilt.arm', { timeoutMs: 1000 });
      const result = await runtime.invoke('desk-pan-tilt-01', 'panTilt.setAngle', {
        axis: 'tilt',
        angle: 60,
      });
      expect(result.axis).toBe('tilt');
      expect(result.angle).toBe(60);
      expect(result.angles).toMatchObject({ pan: 90, tilt: 60 });
    } finally {
      await runtime.close();
    }
  });
});
