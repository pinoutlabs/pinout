import { AbortedError, PinoutRuntime, StopUnconfirmedError, StreamBus } from '@pinout/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRosActionServer } from '../src/fakeRosActionServer.js';
import {
  createRos2SidecarBackend,
  Ros2Sidecar,
  ros2SidecarCapabilities,
  ros2SidecarCapabilityNames,
  ros2SidecarModule,
} from '../src/index.js';

afterEach(() => vi.useRealTimers());

describe('Ros2Sidecar Integration and Lifecycle', () => {
  it('executes happy path with feedback, streamBus fanout, and controller-confirmed evidence', async () => {
    vi.useFakeTimers();
    const streamBus = new StreamBus();
    const transport = new FakeRosActionServer({ motionDelayMs: 25, feedbackIntervalMs: 5 });
    const backend = createRos2SidecarBackend({ transport, streamBus, deviceId: 'arm-sim-01' });

    const runtime = new PinoutRuntime();
    const device = await runtime.registerModuleDevice(ros2SidecarModule, {
      id: 'arm-sim-01',
      backendOptions: {},
      simulated: true,
    });

    // Directly use backend or device
    const streamHandle = streamBus.subscribe(backend.feedbackStreamId);
    const streamFramesPromise = streamHandle.sample(3);

    const resultPromise = backend.invoke('arm.move_to_pose', {
      target: {
        frame: 'base_link',
        position: { x: 0.35, y: -0.2, z: 0.45 },
      },
      transformAt: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(30);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.position).toEqual({ x: 0.35, y: -0.2, z: 0.45 });
    expect(result.frame).toBe('base_link');
    expect(typeof result.durationMs).toBe('number');
    expect(typeof result.commandOverheadMs).toBe('number');

    // Evidence must be sensor-source from controller
    expect(result.evidence).toMatchObject({
      source: 'sensor',
      provenance: 'simulated',
    });

    // Capability result holds only a stream reference, not raw stream data
    expect(result.stream).toMatchObject({
      streamId: backend.feedbackStreamId,
      sampleRateHz: 50,
    });
    expect((result.stream as { framesEmitted: number }).framesEmitted).toBeGreaterThanOrEqual(2);

    // High-rate data arrived on StreamBus
    const sampledFrames = await streamFramesPromise;
    expect(sampledFrames.length).toBeGreaterThanOrEqual(2);
    expect(sampledFrames[0]?.streamId).toBe(backend.feedbackStreamId);
    expect(sampledFrames[0]?.data).toHaveProperty('currentPosition');
    expect(sampledFrames[0]?.data).toHaveProperty('jointPositions');

    // Verify operational state & state evidence
    const evidence = backend.getOperationalStateEvidence();
    expect(evidence.position?.observed.value).toEqual({ x: 0.35, y: -0.2, z: 0.45 });
    expect(evidence.position?.observed.source).toBe('sensor');

    streamHandle.close();
    await device.close();
    await runtime.close();
  });

  it('rejects missing or undeclared coordinate frames with FRAME_MISSING', async () => {
    const backend = createRos2SidecarBackend();

    await expect(
      backend.invoke('arm.move_to_pose', {
        target: {
          frame: 'camera_wrist_optical_uncalibrated',
          position: { x: 0.2, y: 0.2, z: 0.2 },
        },
      }),
    ).rejects.toMatchObject({
      code: 'FRAME_MISSING',
    });

    await backend.close();
  });

  it('rejects stale perception transforms with TRANSFORM_STALE', async () => {
    const backend = createRos2SidecarBackend({ maxTransformAgeMs: 3000 });

    // Transform recorded 5 seconds ago (> 3s limit)
    const staleTime = Date.now() - 5000;

    await expect(
      backend.invoke('arm.move_to_pose', {
        target: {
          frame: 'base_link',
          position: { x: 0.1, y: 0.1, z: 0.3 },
        },
        transformAt: staleTime,
      }),
    ).rejects.toMatchObject({
      code: 'TRANSFORM_STALE',
    });

    await backend.close();
  });

  it('rejects target positions outside workspace bounds', async () => {
    const backend = createRos2SidecarBackend();

    await expect(
      backend.invoke('arm.move_to_pose', {
        target: {
          frame: 'base_link',
          position: { x: 2.5, y: 0.0, z: 0.5 }, // x is beyond 1.0m
        },
        transformAt: Date.now(),
      }),
    ).rejects.toMatchObject({
      code: 'OUT_OF_BOUNDS',
    });

    await backend.close();
  });

  it('handles confirmed cancellation mid-goal and updates evidence', async () => {
    const transport = new FakeRosActionServer({ motionDelayMs: 60, feedbackIntervalMs: 5 });
    const backend = createRos2SidecarBackend({ transport });

    const abortController = new AbortController();
    const movePromise = backend.invoke(
      'arm.move_to_pose',
      {
        target: {
          frame: 'base_link',
          position: { x: 0.8, y: 0.8, z: 0.8 },
        },
        transformAt: Date.now(),
      },
      { signal: abortController.signal },
    );

    // Cancel after 15ms
    await new Promise((resolve) => setTimeout(resolve, 15));
    abortController.abort();

    await expect(movePromise).rejects.toBeInstanceOf(AbortedError);

    // State evidence should show stopped status
    const evidence = backend.getOperationalStateEvidence();
    expect(evidence.status?.observed.value).toBe('stopped');

    await backend.close();
  });

  it('detects unconfirmed stop when controller ignores or rejects cancel', async () => {
    const transport = new FakeRosActionServer({
      motionDelayMs: 40,
      feedbackIntervalMs: 5,
      ignoreCancel: true,
    });
    const sidecar = new Ros2Sidecar({ transport });

    // Start in-flight motion
    const movePromise = sidecar.invoke('arm.move_to_pose', {
      target: {
        frame: 'base_link',
        position: { x: 0.5, y: 0.5, z: 0.5 },
      },
      transformAt: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Independent stop should fail with StopUnconfirmedError because controller ignored cancel
    await expect(sidecar.invoke('arm.stop', {})).rejects.toBeInstanceOf(StopUnconfirmedError);

    await movePromise.catch(() => undefined);
    await sidecar.close();
  });

  it('transitions to uncertain outcome when controller disconnects mid-goal', async () => {
    const transport = new FakeRosActionServer({
      motionDelayMs: 80,
      feedbackIntervalMs: 5,
      simulateControllerLossMs: 20,
    });
    const backend = createRos2SidecarBackend({ transport });

    await expect(
      backend.invoke('arm.move_to_pose', {
        target: {
          frame: 'base_link',
          position: { x: 0.4, y: 0.4, z: 0.4 },
        },
        transformAt: Date.now(),
      }),
    ).rejects.toMatchObject({
      code: 'OPERATION_REQUIRES_RECONCILIATION',
    });

    expect(backend.getOperationalState().status).toBe('faulted');

    await backend.close();
  });

  it('executes independent arm.stop and reads pose', async () => {
    const transport = new FakeRosActionServer({ motionDelayMs: 50, feedbackIntervalMs: 5 });
    const sidecar = new Ros2Sidecar({ transport });

    // Stop while idle
    const idleStop = await sidecar.invoke('arm.stop', {});
    expect(idleStop).toMatchObject({
      status: 'stopped',
      stopConfirmed: true,
      activeGoalCancelled: false,
    });

    // Read initial pose
    const initialPose = await sidecar.invoke('arm.read_pose', {});
    expect(initialPose.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(initialPose.status).toBe('stopped');

    // Start motion and stop mid-flight (with generous 200ms motion duration)
    const longTransport = new FakeRosActionServer({ motionDelayMs: 200, feedbackIntervalMs: 5 });
    const movingSidecar = new Ros2Sidecar({ transport: longTransport });

    const movePromise = movingSidecar.invoke('arm.move_to_pose', {
      target: {
        frame: 'base_link',
        position: { x: 0.6, y: 0.3, z: 0.5 },
      },
      transformAt: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const activeStop = await movingSidecar.invoke('arm.stop', {});

    expect(activeStop).toMatchObject({
      status: 'stopped',
      stopConfirmed: true,
      activeGoalCancelled: true,
    });

    await movePromise.catch(() => undefined);
    await movingSidecar.close();
    await sidecar.close();
  });

  it('scopes advertised capabilities exactly to controller support', () => {
    expect(ros2SidecarCapabilityNames).toEqual(['arm.move_to_pose', 'arm.stop', 'arm.read_pose']);
    expect(ros2SidecarCapabilities.length).toBe(3);
    for (const cap of ros2SidecarCapabilities) {
      expect(cap.name).toMatch(/^arm\.(move_to_pose|stop|read_pose)$/);
      expect(cap.inputSchema).toBeDefined();
      expect(cap.outputSchema).toBeDefined();
    }
  });

  it('runs within a PinoutRuntime instance and passes module policies', async () => {
    const runtime = new PinoutRuntime();
    const device = await runtime.registerModuleDevice(ros2SidecarModule, {
      id: 'arm-governed-01',
      simulated: true,
      backendOptions: { motionDelayMs: 15, feedbackIntervalMs: 3 },
    });

    expect(device.supports('arm.move_to_pose')).toBe(true);
    expect(device.supports('arm.stop')).toBe(true);
    expect(device.supports('arm.read_pose')).toBe(true);

    const result = await device.invoke('arm.move_to_pose', {
      target: {
        frame: 'base_link',
        position: { x: 0.2, y: 0.2, z: 0.2 },
      },
      transformAt: Date.now(),
    });

    expect(result.success).toBe(true);
    expect(result.position).toEqual({ x: 0.2, y: 0.2, z: 0.2 });

    await runtime.close();
  });
});
