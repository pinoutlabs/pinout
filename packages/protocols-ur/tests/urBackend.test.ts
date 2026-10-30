import { afterEach, describe, expect, it } from 'vitest';
import { PinoutRuntime, registerModule, type Transport } from '@pinout/core';
import {
  createUrRtdeClient,
  createUrSimulator,
  UR_DEFAULT_SAFETY_LIMITS,
  UrBackend,
  urModule,
  urModuleId,
} from '../src/index.js';

const POSE = { x: 0.1, y: 0, z: 0.3, rx: 0, ry: 0, rz: 0 };

class FailingDashboardTransport implements Transport {
  readonly kind: string = 'failing-dashboard';
  private readonly listeners = new Set<(chunk: Uint8Array) => void>();
  private closedState = false;

  get closed(): boolean {
    return this.closedState;
  }

  get readable(): AsyncIterable<Uint8Array> {
    const listeners = this.listeners;
    const isClosed = (): boolean => this.closedState;
    return {
      // This fake only holds the stream open until close(); it never yields.
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        let notify: (() => void) | undefined;
        const listener = (chunk: Uint8Array): void => {
          void chunk;
          notify?.();
        };
        listeners.add(listener);
        try {
          while (!isClosed()) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
          }
        } finally {
          listeners.delete(listener);
        }
      },
    };
  }

  async open(): Promise<void> {}

  async close(): Promise<void> {
    this.closedState = true;
    for (const listener of this.listeners) listener(new Uint8Array(0));
  }

  async write(data: Uint8Array): Promise<void> {
    const text = new TextDecoder().decode(data).trim();
    const reply = text === 'stop' ? 'Failed to stop the program' : `Unknown command: ${text}`;
    queueMicrotask(() => {
      for (const listener of this.listeners) listener(new TextEncoder().encode(`${reply}\n`));
    });
  }
}

class FailingScriptTransport extends FailingDashboardTransport {
  override readonly kind = 'failing-script';

  override async write(): Promise<void> {
    throw new Error('script interface down');
  }
}

describe('UrBackend simulated flows', () => {
  const closers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      await closers
        .pop()!
        .close()
        .catch(() => undefined);
    }
  });

  it('gates motion on power, enforces limits, and reports stop state', async () => {
    const backend = UrBackend.createSimulated();
    closers.push(backend);
    await backend.ensureReady();
    expect(backend.kind).toBe('simulated');
    expect(UR_DEFAULT_SAFETY_LIMITS.maxSpeedMps).toBe(0.25);

    await expect(backend.invoke('ur.move_to_pose', { pose: POSE })).rejects.toMatchObject({
      code: 'UR_ROBOT_NOT_READY',
    });

    await backend.invoke('ur.power_on', {});
    const moved = await backend.invoke('ur.move_to_pose', { pose: POSE, speed: 0.1 });
    expect(moved.commanded).toBe(true);
    expect(moved.movement).toBe('linear');
    expect(String(moved.script)).toMatch(/^movel\(p\[0\.1, 0, 0\.3, 0, 0, 0\]/);
    expect(moved.units).toEqual({ position: 'meters', rotation: 'radians (axis-angle)' });
    expect(moved.playRequested).toBe(false);

    const joint = await backend.invoke('ur.move_to_pose', {
      pose: POSE,
      movement: 'joint',
      speed: 0.2,
    });
    expect(String(joint.script)).toMatch(/^movej\(/);

    await expect(
      backend.invoke('ur.move_to_pose', { pose: POSE, speed: 10 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      backend.invoke('ur.move_to_pose', { pose: POSE, acceleration: 99 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      backend.invoke('ur.move_to_pose', { pose: POSE, blendRadius: 1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      backend.invoke('ur.move_to_pose', { pose: POSE, movement: 'diagonal' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(backend.invoke('ur.move_to_pose', { pose: { x: 1 } })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    const telemetry = (await backend.invoke('ur.telemetry', { timeoutMs: 2000 })) as {
      values: Record<string, unknown>;
      units: Record<string, unknown>;
    };
    expect(telemetry.values.actual_TCP_pose).toEqual([0.1, 0, 0.3, 0, 0, 0]);
    expect(telemetry.units).toMatchObject({ actual_q: 'radians' });

    const stop = await backend.invoke('ur.stop', {});
    expect(stop).toMatchObject({
      stopRequested: true,
      stopConfirmed: true,
      programStop: 'confirmed',
      scriptStop: 'sent',
    });
    expect(String(stop.note)).toMatch(/emergency stop/i);

    const status = await backend.invoke('ur.status', { includeIdentity: true });
    expect(status).toMatchObject({ robotMode: 'IDLE', safetyMode: 'NORMAL', model: 'UR5e' });
    expect((status.program as { state: string }).state).toBe('STOPPED');
    const afterStop = (await backend.invoke('ur.telemetry', { timeoutMs: 2000 })) as {
      values: Record<string, unknown>;
    };
    expect(afterStop.values.robot_mode).toBe(5);

    const safe = await backend.safeState();
    expect(safe).toMatchObject({ stopRequested: true, programStop: 'confirmed' });
    expect(String(safe.note)).toMatch(/cannot confirm/i);
    expect(backend.getOperationalState()).toMatchObject({ robotMode: 'IDLE' });
  });

  it('executes scripts without starting the loaded program by default', async () => {
    const backend = UrBackend.createSimulated();
    closers.push(backend);
    await backend.ensureReady();
    await backend.invoke('ur.power_on', {});
    await backend.invoke('ur.load_program', { path: '/programs/demo.urp' });

    const result = await backend.invoke('ur.execute_script', { script: 'set_payload(1.0)' });
    expect(result.playRequested).toBe(false);
    expect((await backend.invoke('ur.status', {})).running).toBe(false);
    expect((await backend.invoke('ur.status', {})).programName).toBe('/programs/demo.urp');

    await expect(
      backend.invoke('ur.execute_script', { script: 'x'.repeat(70_000) }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(backend.invoke('ur.execute_script', { script: '   ' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('plays the loaded program after a script when configured to', async () => {
    const backend = UrBackend.createSimulated({ playAfterScript: true });
    closers.push(backend);
    await backend.ensureReady();
    await backend.invoke('ur.power_on', {});
    await backend.invoke('ur.load_program', { path: '/programs/demo.urp' });
    const result = await backend.invoke('ur.execute_script', { script: 'set_payload(1.0)' });
    expect(result.playReply).toBe('Starting program');
    await expect(backend.invoke('ur.load_program', { path: '' })).rejects.toBeTruthy();
  });

  it('blocks motion while a protective stop is active', async () => {
    const sim = createUrSimulator();
    const backend = await UrBackend.create({
      simulated: true,
      dashboardTransport: sim.dashboard,
      rtdeTransport: sim.rtde,
      scriptTransport: sim.script,
      dashboardClientOptions: { timeoutMs: 2000 },
      rtdeClientOptions: { timeoutMs: 2000 },
    });
    closers.push(backend);
    await backend.invoke('ur.power_on', {});
    sim.controller.setSimulatedSafetyMode(3); // PROTECTIVE_STOP
    await expect(backend.invoke('ur.move_to_pose', { pose: POSE })).rejects.toMatchObject({
      code: 'UR_SAFETY_STOP_ACTIVE',
    });
    sim.controller.setSimulatedSafetyMode(1);
    await expect(backend.invoke('ur.move_to_pose', { pose: POSE })).resolves.toMatchObject({
      commanded: true,
    });
  });

  it('reports UR_STOP_UNCONFIRMED when both stop channels fail', async () => {
    const backend = await UrBackend.create({
      simulated: true,
      dashboardTransport: new FailingDashboardTransport(),
      scriptTransport: new FailingScriptTransport(),
      dashboardClientOptions: { expectWelcome: false, timeoutMs: 1000 },
    });
    closers.push(backend);
    await expect(backend.invoke('ur.stop', {})).rejects.toMatchObject({
      code: 'UR_STOP_UNCONFIRMED',
      details: { programStop: 'failed', scriptStop: 'failed' },
    });
  });

  it('maps RTDE loss to DISCONNECTED and no samples to TIMEOUT', async () => {
    const sim = createUrSimulator();
    const rtde = createUrRtdeClient({ transport: sim.rtde, timeoutMs: 2000, sampleTimeoutMs: 200 });
    closers.push(rtde);
    await rtde.start();
    const backend = await UrBackend.create({ simulated: true, rtde });
    closers.push(backend);
    await backend.invoke('ur.telemetry', { timeoutMs: 2000 });
    await sim.rtde.close();
    await expect(backend.invoke('ur.telemetry', { timeoutMs: 200 })).rejects.toMatchObject({
      code: 'DISCONNECTED',
    });

    const pausedSim = createUrSimulator({}, { streaming: false });
    const paused = createUrRtdeClient({
      transport: pausedSim.rtde,
      timeoutMs: 2000,
      sampleTimeoutMs: 200,
    });
    closers.push(paused);
    await paused.start();
    const pausedBackend = await UrBackend.create({ simulated: true, rtde: paused });
    closers.push(pausedBackend);
    await expect(pausedBackend.invoke('ur.telemetry', { timeoutMs: 150 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('rejects every action after close()', async () => {
    const backend = UrBackend.createSimulated();
    await backend.ensureReady();
    await backend.close();
    await expect(backend.invoke('ur.status', {})).rejects.toMatchObject({ code: 'DISCONNECTED' });
  });

  it('emits ur.changed events to subscribers', async () => {
    const backend = UrBackend.createSimulated();
    closers.push(backend);
    const events: string[] = [];
    const unsubscribe = backend.subscribe((event) => events.push(event));
    await backend.invoke('ur.power_on', {});
    await backend.invoke('ur.power_off', {});
    unsubscribe();
    await backend.invoke('ur.brake_release', {}).catch(() => undefined);
    expect(events).toEqual(['ur.changed', 'ur.changed']);
  });
});

describe('urModule conformance', () => {
  const closers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      await closers
        .pop()!
        .close()
        .catch(() => undefined);
    }
  });

  it('declares eleven capabilities with explicit safety metadata', () => {
    expect(urModuleId).toBe('pinout/ur');
    expect(urModule.id).toBe('pinout/ur');
    expect(urModule.capabilities).toHaveLength(11);
    expect(urModule.capabilityNames.sort()).toEqual(
      [
        'ur.brake_release',
        'ur.execute_script',
        'ur.load_program',
        'ur.move_to_pose',
        'ur.pause_program',
        'ur.play_program',
        'ur.power_off',
        'ur.power_on',
        'ur.status',
        'ur.stop',
        'ur.telemetry',
      ].sort(),
    );
    for (const capability of urModule.capabilities) {
      expect(capability.safety).toBeDefined();
      expect(typeof capability.safety?.physicalOutput).toBe('boolean');
      expect(typeof capability.safety?.reversible).toBe('boolean');
    }
    expect(urModule.capabilities.find((entry) => entry.name === 'ur.stop')?.safety).toMatchObject({
      physicalOutput: true,
      reversible: false,
    });
    expect(
      urModule.capabilities.find((entry) => entry.name === 'ur.telemetry')?.safety,
    ).toMatchObject({ physicalOutput: false });
  });

  it('registers on PinoutRuntime via pinout/ur and moves the simulated arm', async () => {
    registerModule(urModule);
    const runtime = new PinoutRuntime();
    closers.push(runtime);
    const device = await runtime.registerFromModule('pinout/ur', { id: 'ur-1', simulated: true });
    await device.invoke('ur.power_on', {});
    await device.invoke('ur.load_program', { path: '/programs/demo.urp' });
    await device.invoke('ur.play_program', {});
    const moved = await device.invoke('ur.move_to_pose', {
      pose: { x: 0.05, y: 0.05, z: 0.2, rx: 0, ry: 0, rz: 0 },
      speed: 0.05,
    });
    expect(moved.commanded).toBe(true);
    const telemetry = (await device.invoke('ur.telemetry', { timeoutMs: 2000 })) as {
      values: Record<string, unknown>;
    };
    expect(telemetry.values.actual_TCP_pose).toEqual([0.05, 0.05, 0.2, 0, 0, 0]);
    const stopped = await device.invoke('ur.stop', {});
    expect(stopped.stopConfirmed).toBe(true);
    const status = await device.invoke('ur.status', {});
    expect((status.program as { state: string }).state).toBe('STOPPED');
  });
});
