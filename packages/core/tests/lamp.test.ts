import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createEsp32LampBackend,
  createRuntimeFromConfig,
  getModule,
  lampCapabilities,
  lampModule,
  lampModuleId,
  PinoutRuntime,
  PinoutStructuredError,
  runModuleConformance,
  runtimeToAgentTools,
  simulatedEsp32,
  SimulatedLampBackend,
  validateLampConfig,
  type DeviceInfo,
  type LampStatus,
  type Transport,
} from '@pinout/core';
import { ByteQueue } from '../src/transports/byteQueue.js';

describe('Lamp Module - Configuration and Commissioning', () => {
  it('registers lamp module as a built-in module with explicit arm/disarm capabilities', () => {
    const module = getModule(lampModuleId);
    expect(module).toBe(lampModule);
    expect(module.id).toBe('pinout/lamp');
    expect(module.deviceClass).toBe('actuator.lamp');
    expect(module.capabilityNames).toEqual([
      'lamp.arm',
      'lamp.disarm',
      'lamp.on',
      'lamp.off',
      'lamp.set',
      'lamp.status',
      'status.read',
    ]);
  });

  it('validates configuration and rejects missing polarity', () => {
    expect(() => validateLampConfig({ pin: 2 }, false)).toThrowError(
      /UNSUPPORTED_CONFIGURATION|polarity/i,
    );
  });

  it('rejects active-low lamp with safeLevel low', () => {
    expect(() =>
      validateLampConfig({ pin: 4, polarity: 'active-low', safeLevel: 'low' }, false),
    ).toThrowError(
      /UNSUPPORTED_CONFIGURATION|Active-low lamp configuration cannot specify safeLevel "low"/i,
    );
  });

  it('rejects active-high lamp with safeLevel high', () => {
    expect(() =>
      validateLampConfig({ pin: 2, polarity: 'active-high', safeLevel: 'high' }, false),
    ).toThrowError(
      /UNSUPPORTED_CONFIGURATION|Active-high lamp configuration cannot specify safeLevel "high"/i,
    );
  });

  it('rejects input-only ESP32 pins for lamp actuation output', () => {
    expect(() =>
      validateLampConfig({ pin: 34, polarity: 'active-high', safeLevel: 'low' }, false),
    ).toThrowError(/input-only|VALIDATION_ERROR/i);
  });

  it('rejects invalid maxOnMs', () => {
    expect(() =>
      validateLampConfig(
        { pin: 2, polarity: 'active-high', safeLevel: 'low', maxOnMs: -50 },
        false,
      ),
    ).toThrowError(/maxOnMs/i);
  });

  it('accepts valid active-high and active-low configurations with default safe levels', () => {
    const activeHigh = validateLampConfig({ pin: 2, polarity: 'active-high' }, false);
    expect(activeHigh.safeLevel).toBe('low');
    expect(activeHigh.polarity).toBe('active-high');
    expect(activeHigh.autoArm).toBe(false);

    const activeLow = validateLampConfig({ pin: 4, polarity: 'active-low' }, false);
    expect(activeLow.safeLevel).toBe('high');
    expect(activeLow.polarity).toBe('active-low');
    expect(activeLow.autoArm).toBe(false);
  });

  it('commissions output safe states with gpio.configSafeState before any actuation write', async () => {
    const transport = simulatedEsp32();
    const runtime = new PinoutRuntime();
    try {
      const lampDevice = await runtime.registerFromModule(lampModuleId, {
        id: 'lamp-01',
        transport,
        backendOptions: {
          pin: 2,
          polarity: 'active-high',
          safeLevel: 'low',
        },
      });

      expect(lampDevice).toBeDefined();
      expect(transport.state.safePinConfigs.get(2)).toEqual({
        safeLevel: 'low',
        polarity: 'active-high',
        configured: true,
      });
    } finally {
      await runtime.close();
    }
  });

  it('commissions active-low safe state correctly', async () => {
    const transport = simulatedEsp32();
    const runtime = new PinoutRuntime();
    try {
      await runtime.registerFromModule(lampModuleId, {
        id: 'lamp-active-low',
        transport,
        backendOptions: {
          pin: 4,
          polarity: 'active-low',
          safeLevel: 'high',
        },
      });

      expect(transport.state.safePinConfigs.get(4)).toEqual({
        safeLevel: 'high',
        polarity: 'active-low',
        configured: true,
      });
    } finally {
      await runtime.close();
    }
  });
});

describe('Lamp Module - Arming, Actuation, and Evidence Model', () => {
  it('is disarmed by default and rejects lamp.on and lamp.set until explicit lamp.arm', async () => {
    const transport = simulatedEsp32();
    const runtime = new PinoutRuntime();
    try {
      await runtime.registerFromModule(lampModuleId, {
        id: 'lamp-01',
        transport,
        backendOptions: {
          pin: 2,
          polarity: 'active-high',
          safeLevel: 'low',
        },
      });

      const initialStatus = await runtime.invoke('lamp-01', 'lamp.status', {});
      expect(initialStatus.armed).toBe('disarmed');
      expect(initialStatus.commanded).toMatchObject({ on: null, at: null });
      expect(initialStatus.acknowledged).toMatchObject({ on: null, at: null });
      expect(initialStatus.observed).toMatchObject({ on: null, at: null, source: 'none' });

      // Actuations fail while disarmed
      await expect(runtime.invoke('lamp-01', 'lamp.on', {})).rejects.toThrowError(
        /NOT_ARMED|disarmed/i,
      );
      await expect(runtime.invoke('lamp-01', 'lamp.set', { on: true })).rejects.toThrowError(
        /NOT_ARMED|disarmed/i,
      );
    } finally {
      await runtime.close();
    }
  });

  it('executes full explicit arm -> on -> status -> off -> disarm flow without inferring observed state', async () => {
    const transport = simulatedEsp32();
    const runtime = new PinoutRuntime();
    try {
      await runtime.registerFromModule(lampModuleId, {
        id: 'lamp-01',
        transport,
        backendOptions: {
          pin: 2,
          polarity: 'active-high',
          safeLevel: 'low',
        },
      });

      // 1. Initial state is disarmed
      const beforeArm = await runtime.invoke('lamp-01', 'lamp.status', {});
      expect(beforeArm.armed).toBe('disarmed');

      // 2. Explicit arm via lamp.arm
      const armRes = await runtime.invoke('lamp-01', 'lamp.arm', { timeoutMs: 3000 });
      expect(armRes).toMatchObject({ armed: 'armed' });

      const afterArm = await runtime.invoke('lamp-01', 'lamp.status', {});
      expect(afterArm.armed).toBe('armed');
      expect(afterArm.provenance).toBe('simulated');

      // 3. Actuate lamp.on
      const onResult = await runtime.invoke('lamp-01', 'lamp.on', {});
      expect(onResult).toEqual({ on: true });

      const statusAfterOn = (await runtime.invoke(
        'lamp-01',
        'lamp.status',
        {},
      )) as unknown as LampStatus;
      expect(statusAfterOn.commanded.on).toBe(true);
      expect(typeof statusAfterOn.commanded.at).toBe('string');
      expect(statusAfterOn.acknowledged.on).toBe(true);
      expect(typeof statusAfterOn.acknowledged.at).toBe('string');
      // Critical: A successful write does NOT claim observed status without readback
      expect(statusAfterOn.observed.source).toBe('none');
      expect(statusAfterOn.observed.on).toBeNull();
      expect(statusAfterOn.freshnessMs).toBeNull();
      expect(statusAfterOn.provenance).toBe('simulated');
      expect(statusAfterOn.armed).toBe('armed');

      // Hardware level was driven HIGH for active-high
      expect(transport.state.levels.get(2)).toBe(true);

      // 4. Actuate lamp.off
      const offResult = await runtime.invoke('lamp-01', 'lamp.off', {});
      expect(offResult).toEqual({ on: false });

      const statusAfterOff = (await runtime.invoke(
        'lamp-01',
        'lamp.status',
        {},
      )) as unknown as LampStatus;
      expect(statusAfterOff.commanded.on).toBe(false);
      expect(statusAfterOff.acknowledged.on).toBe(false);
      expect(statusAfterOff.observed.source).toBe('none');
      expect(transport.state.levels.get(2)).toBe(false);

      // 5. Test lamp.set capability
      await runtime.invoke('lamp-01', 'lamp.set', { on: true });
      expect(transport.state.levels.get(2)).toBe(true);
      await runtime.invoke('lamp-01', 'lamp.set', { on: false });
      expect(transport.state.levels.get(2)).toBe(false);

      // 6. Explicit disarm via lamp.disarm
      const disarmRes = await runtime.invoke('lamp-01', 'lamp.disarm', {});
      expect(disarmRes).toEqual({ armed: 'disarmed' });

      const statusAfterDisarm = await runtime.invoke('lamp-01', 'lamp.status', {});
      expect(statusAfterDisarm.armed).toBe('disarmed');

      // 7. Subsequent actuation is rejected after disarm
      await expect(runtime.invoke('lamp-01', 'lamp.on', {})).rejects.toThrowError(
        /NOT_ARMED|disarmed/i,
      );
    } finally {
      await runtime.close();
    }
  });

  it('drives inverted electrical level for active-low polarity after explicit arming', async () => {
    const transport = simulatedEsp32();
    const runtime = new PinoutRuntime();
    try {
      await runtime.registerFromModule(lampModuleId, {
        id: 'lamp-active-low',
        transport,
        backendOptions: {
          pin: 4,
          polarity: 'active-low',
          safeLevel: 'high',
        },
      });

      await runtime.invoke('lamp-active-low', 'lamp.arm', {});
      await runtime.invoke('lamp-active-low', 'lamp.on', {});
      // Active-low lamp is energized by driving LOW (false)
      expect(transport.state.levels.get(4)).toBe(false);

      await runtime.invoke('lamp-active-low', 'lamp.off', {});
      // Active-low lamp is de-energized by driving HIGH (true)
      expect(transport.state.levels.get(4)).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('reads independent observation via readbackPin and computes freshness and staleness', async () => {
    const transport = simulatedEsp32();
    const runtime = new PinoutRuntime();
    try {
      await runtime.registerFromModule(lampModuleId, {
        id: 'lamp-with-readback',
        transport,
        backendOptions: {
          pin: 2,
          polarity: 'active-high',
          safeLevel: 'low',
          readbackPin: 13,
          readbackPolarity: 'active-high',
          observationMaxAgeMs: 50,
        },
      });

      // Simulator readback pin 13 is currently false (LOW)
      transport.state.levels.set(13, false);
      const status1 = (await runtime.invoke(
        'lamp-with-readback',
        'lamp.status',
        {},
      )) as unknown as LampStatus;
      expect(status1.observed.on).toBe(false);
      expect(status1.observed.source).toBe('gpio-readback');
      expect(typeof status1.observed.at).toBe('string');
      expect(typeof status1.freshnessMs).toBe('number');
      expect(status1.stale).toBe(false);

      // Now independent photodiode/sensor detects light (pin 13 HIGH)
      transport.state.levels.set(13, true);
      const status2 = (await runtime.invoke(
        'lamp-with-readback',
        'lamp.status',
        {},
      )) as unknown as LampStatus;
      expect(status2.observed.on).toBe(true);
      expect(status2.observed.source).toBe('gpio-readback');
      expect(status2.stale).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it('exposes generic EvidenceState under evidence key and implements getOperationalStateEvidence', async () => {
    const transport = simulatedEsp32();
    const runtime = new PinoutRuntime();
    try {
      const device = await runtime.registerFromModule(lampModuleId, {
        id: 'lamp-evidence-test',
        transport,
        backendOptions: {
          pin: 2,
          polarity: 'active-high',
          safeLevel: 'low',
        },
      });

      const status = (await runtime.invoke(
        'lamp-evidence-test',
        'lamp.status',
        {},
      )) as unknown as LampStatus;
      expect(status.evidence).toBeDefined();
      expect(status.evidence.on).toBeDefined();
      expect(status.evidence.armed).toBeDefined();
      expect(status.evidence.on.commanded).toBeDefined();
      expect(status.evidence.on.acknowledged).toBeDefined();
      expect(status.evidence.on.observed).toBeDefined();

      const evidenceMap = device.getStateEvidence();
      expect(evidenceMap.on).toBeDefined();
      expect(evidenceMap.armed).toBeDefined();
    } finally {
      await runtime.close();
    }
  });

  it('enforces state prerequisites: rejects actuation when observation is missing or stale', async () => {
    const transport = simulatedEsp32();
    const runtime = new PinoutRuntime();
    try {
      await runtime.registerFromModule(lampModuleId, {
        id: 'lamp-prereq-test',
        transport,
        backendOptions: {
          pin: 2,
          polarity: 'active-high',
          safeLevel: 'low',
          readbackPin: 13,
          readbackPolarity: 'active-high',
          observationMaxAgeMs: 50,
        },
        prerequisites: {
          'lamp.on': [{ key: 'on', maxAgeMs: 50 }],
        },
      });

      await runtime.invoke('lamp-prereq-test', 'lamp.arm', {});

      // 1. Before reading readbackPin, observation is missing -> throws PREREQUISITE_MISSING
      await expect(runtime.invoke('lamp-prereq-test', 'lamp.on', {})).rejects.toThrowError(
        PinoutStructuredError,
      );

      try {
        await runtime.invoke('lamp-prereq-test', 'lamp.on', {});
        expect.unreachable('Should have thrown PREREQUISITE_MISSING');
      } catch (error) {
        expect((error as PinoutStructuredError).code).toBe('PREREQUISITE_MISSING');
      }

      // 2. Read status to establish a fresh observation of pin 13
      transport.state.levels.set(13, false);
      await runtime.invoke('lamp-prereq-test', 'lamp.status', {});

      // 3. Immediately invoke lamp.on while observation is fresh (< 50ms) -> succeeds!
      const onRes = await runtime.invoke('lamp-prereq-test', 'lamp.on', {});
      expect(onRes).toEqual({ on: true });

      // 4. Wait 80ms for observation to become stale (> 50ms)
      await new Promise((resolve) => setTimeout(resolve, 80));

      // 5. Next actuation with stale prerequisite throws PREREQUISITE_STALE
      try {
        await runtime.invoke('lamp-prereq-test', 'lamp.on', {});
        expect.unreachable('Should have thrown PREREQUISITE_STALE');
      } catch (error) {
        expect((error as PinoutStructuredError).code).toBe('PREREQUISITE_STALE');
      }
    } finally {
      await runtime.close();
    }
  });

  it('handles watchdog trip: marks armed as tripped, preserves commanded history, rejects actuation, and requires explicit lamp.arm to re-arm', async () => {
    const transport = simulatedEsp32();
    const runtime = new PinoutRuntime();
    try {
      await runtime.registerFromModule(lampModuleId, {
        id: 'lamp-wd-test',
        transport,
        backendOptions: {
          pin: 2,
          polarity: 'active-high',
          safeLevel: 'low',
          autoHeartbeat: false,
          watchdogTimeoutMs: 100,
        },
      });

      // 1. Arm explicitly
      await runtime.invoke('lamp-wd-test', 'lamp.arm', { timeoutMs: 100 });
      await runtime.invoke('lamp-wd-test', 'lamp.on', {});
      expect(transport.state.levels.get(2)).toBe(true);

      // 2. Trigger watchdog expiry on the simulated device
      transport.expireWatchdog();

      // Give device.tripped event a tick to process
      await new Promise((resolve) => setTimeout(resolve, 50));

      const statusAfterTrip = (await runtime.invoke(
        'lamp-wd-test',
        'lamp.status',
        {},
      )) as unknown as LampStatus;
      expect(statusAfterTrip.armed).toBe('tripped');
      // Crucial: commanded and acknowledged are NOT falsely claimed as "off"
      expect(statusAfterTrip.commanded.on).toBe(true);
      expect(statusAfterTrip.acknowledged.on).toBe(true);

      // In tripped state, actuation is refused
      await expect(runtime.invoke('lamp-wd-test', 'lamp.on', {})).rejects.toThrowError(
        /WATCHDOG_TRIPPED|watchdog/i,
      );

      // 3. Explicit re-arm via lamp.arm recovers the device
      const rearmRes = await runtime.invoke('lamp-wd-test', 'lamp.arm', { timeoutMs: 5000 });
      expect(rearmRes).toMatchObject({ armed: 'armed' });

      const statusAfterRearm = await runtime.invoke('lamp-wd-test', 'lamp.status', {});
      expect(statusAfterRearm.armed).toBe('armed');

      // 4. Actuation succeeds again after explicit re-arm
      await runtime.invoke('lamp-wd-test', 'lamp.on', {});
      expect(transport.state.levels.get(2)).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('enforces maxOnMs by automatically turning off the lamp after configured duration', async () => {
    const transport = simulatedEsp32();
    const runtime = new PinoutRuntime();
    try {
      await runtime.registerFromModule(lampModuleId, {
        id: 'lamp-timed',
        transport,
        backendOptions: {
          pin: 2,
          polarity: 'active-high',
          safeLevel: 'low',
          maxOnMs: 60,
        },
      });

      await runtime.invoke('lamp-timed', 'lamp.arm', {});
      await runtime.invoke('lamp-timed', 'lamp.on', {});
      expect(transport.state.levels.get(2)).toBe(true);

      // Wait for maxOnMs timer to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(transport.state.levels.get(2)).toBe(false);
      const status = (await runtime.invoke(
        'lamp-timed',
        'lamp.status',
        {},
      )) as unknown as LampStatus;
      expect(status.commanded.on).toBe(false);
      expect(status.acknowledged.on).toBe(false);
    } finally {
      await runtime.close();
    }
  });
});

describe('Lamp Module - In-Process Simulated Backend', () => {
  it('supports pure in-process SimulatedLampBackend without transport and explicit arm/disarm', async () => {
    const backend = new SimulatedLampBackend({
      pin: 2,
      polarity: 'active-high',
      safeLevel: 'low',
    });

    try {
      const initialStatus = await backend.invoke('lamp.status', {});
      expect(initialStatus.armed).toBe('disarmed');

      await expect(backend.invoke('lamp.on', {})).rejects.toThrowError(/NOT_ARMED|disarmed/i);

      const armRes = await backend.invoke('lamp.arm', { timeoutMs: 2000 });
      expect(armRes).toEqual({ armed: 'armed', timeoutMs: 2000 });

      const onRes = await backend.invoke('lamp.on', {});
      expect(onRes).toEqual({ on: true });

      const status = (await backend.invoke('lamp.status', {})) as unknown as LampStatus;
      expect(status.commanded.on).toBe(true);
      expect(status.acknowledged.on).toBe(true);
      expect(status.observed.on).toBeNull();
      expect(status.provenance).toBe('simulated');
      expect(status.armed).toBe('armed');
      expect(status.evidence.on).toBeDefined();

      backend.injectTrip();
      const trippedStatus = (await backend.invoke('lamp.status', {})) as unknown as LampStatus;
      expect(trippedStatus.armed).toBe('tripped');
      await expect(backend.invoke('lamp.on', {})).rejects.toMatchObject({
        code: 'WATCHDOG_TRIPPED',
      });

      // Disarm from tripped state
      const disarmRes = await backend.invoke('lamp.disarm', {});
      expect(disarmRes).toEqual({ armed: 'disarmed' });
      const disarmedStatus = (await backend.invoke('lamp.status', {})) as unknown as LampStatus;
      expect(disarmedStatus.armed).toBe('disarmed');
    } finally {
      await backend.close();
    }
  });
});

describe('Lamp Module - Legacy Firmware Guarantee', () => {
  it('refuses watchdog-dependent arming when firmware lacks watchdog feature flag', async () => {
    class LegacyTransport implements Transport {
      readonly kind = 'legacy-serial';
      private readonly inbound = new ByteQueue();

      get readable(): AsyncIterable<Uint8Array> {
        return this.inbound;
      }

      async open(): Promise<void> {
        const legacyIdentity: DeviceInfo = {
          firmware: 'esp32-legacy-bridge',
          version: '0.1.0',
          protocol: 1,
          capabilities: ['sys.hello', 'gpio.write', 'gpio.read', 'gpio.stopAll'],
        };
        this.inbound.push(
          new TextEncoder().encode(
            `${JSON.stringify({ v: 1, event: 'ready', payload: legacyIdentity })}\n`,
          ),
        );
      }

      async write(data: Uint8Array): Promise<void> {
        const text = new TextDecoder().decode(data);
        const req = JSON.parse(text);
        if (req.action === 'sys.hello') {
          const resp = {
            v: 1,
            id: req.id,
            ok: true,
            result: {
              firmware: 'esp32-legacy-bridge',
              version: '0.1.0',
              protocol: 1,
              capabilities: ['sys.hello', 'gpio.write', 'gpio.read', 'gpio.stopAll'],
            },
          };
          this.inbound.push(new TextEncoder().encode(`${JSON.stringify(resp)}\n`));
        }
      }

      async close(): Promise<void> {
        this.inbound.close();
      }
    }

    const legacyBackend = await createEsp32LampBackend({
      transport: new LegacyTransport(),
      pin: 2,
      polarity: 'active-high',
      safeLevel: 'low',
      requireWatchdog: true,
    });

    try {
      await expect(legacyBackend.invoke('lamp.arm', {})).rejects.toThrowError(
        /WATCHDOG_NOT_SUPPORTED|does not advertise watchdog/i,
      );
    } finally {
      await legacyBackend.close();
    }
  });
});

describe('Lamp Module - Agent MCP Tooling & Config File Integration', () => {
  it('exposes semantic tool names including lamp_arm/lamp_disarm without leaking GPIO pin numbers to the agent', async () => {
    const runtime = new PinoutRuntime();
    try {
      await runtime.registerFromModule(lampModuleId, {
        id: 'workbench_lamp',
        simulated: true,
        backendOptions: {
          pin: 2,
          polarity: 'active-high',
          safeLevel: 'low',
        },
      });

      const tools = runtimeToAgentTools(runtime);
      const lampTools = tools.filter((tool) => tool.mcpName.startsWith('workbench_lamp__'));

      expect(lampTools.map((t) => t.mcpName)).toEqual([
        'workbench_lamp__lamp_arm',
        'workbench_lamp__lamp_disarm',
        'workbench_lamp__lamp_on',
        'workbench_lamp__lamp_off',
        'workbench_lamp__lamp_set',
        'workbench_lamp__lamp_status',
        'workbench_lamp__status_read',
      ]);

      // Agent sees semantic schemas with no pin parameter
      for (const tool of lampTools) {
        expect(tool.inputSchema.properties).not.toHaveProperty('pin');
      }
    } finally {
      await runtime.close();
    }
  });

  it('boots runtime from devices config file containing lamp definition and executes explicit arm/actuate flow', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pinout-lamp-config-'));
    const configPath = join(tempDir, 'devices.json');
    const devicesFileContent = {
      schemaVersion: 1,
      devices: [
        {
          id: 'room-lamp',
          module: 'pinout/lamp',
          label: 'Room Ceiling Lamp',
          backend: {
            type: 'simulated',
          },
          config: {
            pin: 2,
            polarity: 'active-high',
            safeLevel: 'low',
            readbackPin: 13,
          },
        },
      ],
    };
    writeFileSync(configPath, JSON.stringify(devicesFileContent, null, 2), 'utf8');

    try {
      const { runtime } = await createRuntimeFromConfig({
        home: tempDir,
        devicesPath: configPath,
      });
      try {
        expect(runtime.hasDevice('room-lamp')).toBe(true);
        const status = await runtime.invoke('room-lamp', 'lamp.status', {});
        expect(status.provenance).toBe('simulated');
        expect(status.armed).toBe('disarmed');

        await runtime.invoke('room-lamp', 'lamp.arm', {});
        await runtime.invoke('room-lamp', 'lamp.on', {});
        const statusOn = (await runtime.invoke(
          'room-lamp',
          'lamp.status',
          {},
        )) as unknown as LampStatus;
        expect(statusOn.commanded.on).toBe(true);
        expect(statusOn.armed).toBe('armed');
      } finally {
        await runtime.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Lamp Module - Conformance Suite', () => {
  it('passes module conformance checks', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pinout-lamp-conformance-'));
    const manifestPath = join(tempDir, 'pinout.module.json');
    const manifest = {
      schemaVersion: 1,
      id: 'pinout/lamp',
      version: '0.1.0',
      deviceClass: 'actuator.lamp',
      entrypoint: './index.js',
      runtime: 'node',
      capabilities: lampCapabilities.map((c) => c.name),
      simulation: {
        provided: true,
        notes: 'In-process simulated lamp backend with explicit simulation provenance.',
      },
      status: 'TESTED',
      name: 'Commissioned Lamp',
      vendor: 'Pinout',
      model: 'Commissioned Lamp',
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    // Create an entrypoint that exports lampModule
    const entrypointPath = join(tempDir, 'index.js');
    writeFileSync(
      entrypointPath,
      `export { lampModule as default } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'packages/core/dist/modules/lampModule.js')).href)};\n`,
      'utf8',
    );

    try {
      const result = await runModuleConformance(tempDir);
      expect(result.passed).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
