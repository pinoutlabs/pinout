import { DeviceError } from '@pinout/core';
import { describe, expect, it } from 'vitest';
import {
  createRclnodejsTransport,
  createRos2SidecarBackend,
  defaultFeedbackMapper,
  defaultRclnodejsLoader,
  RclnodejsActionTransport,
  RCLNODEJS_DEFAULT_ACTION_TOPIC,
  RCLNODEJS_DEFAULT_ACTION_TYPE,
} from '../src/index.js';
import type { RclnodejsDiagnostic } from '../src/index.js';
import type { ArmPoseFeedback, ArmPoseGoal, ControllerStatus, RosFeedback } from '../src/types.js';

// ---------------------------------------------------------------------------
// A fake rclnodejs module driven through the transport's loader seam. The real
// `rclnodejs` module is never installed in this workspace; the default-loader
// test below exercises the absent-module path against the real import().
// ---------------------------------------------------------------------------

interface FakeGoalRecord {
  goal: unknown;
  accepted: boolean;
  goalId: unknown;
  feedbackCallback: ((message: unknown) => void) | undefined;
  cancelCalls: number;
  cancelResult: unknown;
  resolveResult: ((value: unknown) => void) | undefined;
  rejectResult: ((error: unknown) => void) | undefined;
}

interface FakeRclnodejsState {
  nodeName: string | undefined;
  actionType: string | undefined;
  actionTopic: string | undefined;
  goals: FakeGoalRecord[];
  availability: boolean;
  hangSendGoal: boolean;
  spins: number;
  destroys: number;
  shutdowns: number;
}

function createFakeRclnodejs(options: { availability?: boolean; hangSendGoal?: boolean } = {}): {
  module: unknown;
  state: FakeRclnodejsState;
} {
  const state: FakeRclnodejsState = {
    nodeName: undefined,
    actionType: undefined,
    actionTopic: undefined,
    goals: [],
    availability: options.availability ?? true,
    hangSendGoal: options.hangSendGoal ?? false,
    spins: 0,
    destroys: 0,
    shutdowns: 0,
  };

  class FakeActionClient {
    constructor(_node: unknown, actionType: string, actionTopic: string) {
      state.actionType = actionType;
      state.actionTopic = actionTopic;
    }

    async isActionServerAvailable(): Promise<boolean> {
      return state.availability;
    }

    async sendGoal(
      goal: unknown,
      sendOptions?: { feedbackCallback?: (message: unknown) => void },
    ): Promise<unknown> {
      if (state.hangSendGoal) {
        return new Promise(() => undefined);
      }
      const record: FakeGoalRecord = {
        goal,
        accepted: true,
        goalId: `goal-${state.goals.length + 1}-aabbccdd`,
        feedbackCallback: sendOptions?.feedbackCallback,
        cancelCalls: 0,
        cancelResult: { return_code: 0, goals_canceling: [] },
        resolveResult: undefined,
        rejectResult: undefined,
      };
      state.goals.push(record);
      return {
        getGoalId: (): unknown => record.goalId,
        isAccepted: (): boolean => record.accepted,
        getResult: (): Promise<unknown> =>
          new Promise<unknown>((resolve, reject) => {
            record.resolveResult = resolve;
            record.rejectResult = reject;
          }),
        cancelGoal: async (): Promise<unknown> => {
          record.cancelCalls += 1;
          return record.cancelResult;
        },
      };
    }
  }

  class FakeNode {
    constructor(name: string) {
      state.nodeName = name;
    }

    spin(): void {
      state.spins += 1;
    }

    async destroy(): Promise<void> {
      state.destroys += 1;
    }
  }

  const module = {
    async init(): Promise<void> {
      return undefined;
    },
    async shutdown(): Promise<void> {
      state.shutdowns += 1;
    },
    Node: FakeNode,
    ActionClient: FakeActionClient,
  };
  return { module, state };
}

function loaderFor(module: unknown): () => Promise<unknown> {
  return () => Promise.resolve(module);
}

const testGoal: ArmPoseGoal = {
  target: { frame: 'base_link', position: { x: 0.1, y: 0.2, z: 0.3 } },
  velocityScaling: 0.5,
};

function feedbackMessage(overrides: Record<string, unknown> = {}): unknown {
  return {
    feedback: {
      fraction: 0.5,
      current_position: { x: 0.05, y: 0.1, z: 0.15 },
      joint_positions: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
      joint_velocities: [0.01, 0.02, 0.03, 0.04, 0.05, 0.06],
      frame: 'base_link',
      controller_timestamp: 1234,
      ...overrides,
    },
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('RclnodejsActionTransport initialization', () => {
  it('reports RCLNODEJS_UNAVAILABLE when rclnodejs cannot be imported', async () => {
    // The workspace deliberately has no node_modules and no rclnodejs dependency,
    // so the real dynamic import() fails. If rclnodejs were installed and a ROS 2
    // stack were running, this test would fail — which is the intended signal.
    const transport = createRclnodejsTransport();
    expect(typeof defaultRclnodejsLoader).toBe('function');
    await expect(transport.init()).rejects.toMatchObject({
      code: 'RCLNODEJS_UNAVAILABLE',
      category: 'CONFIG',
    });
    await transport.close();
  });

  it('wraps a rejecting loader in RCLNODEJS_UNAVAILABLE and keeps the failure sticky', async () => {
    const transport = createRclnodejsTransport({
      loader: () => Promise.reject(new Error("Cannot find module 'rclnodejs'")),
    });
    await expect(transport.init()).rejects.toMatchObject({
      code: 'RCLNODEJS_UNAVAILABLE',
      category: 'CONFIG',
    });
    await expect(transport.sendGoal(testGoal)).rejects.toMatchObject({
      code: 'RCLNODEJS_UNAVAILABLE',
    });
    await transport.close();
  });

  it('reports RCLNODEJS_API_MISMATCH when the loaded module lacks init()/Node', async () => {
    const transport = createRclnodejsTransport({
      loader: () => Promise.resolve({ init: async () => undefined }),
    });
    await expect(transport.init()).rejects.toMatchObject({
      code: 'RCLNODEJS_API_MISMATCH',
      category: 'CONFIG',
    });
    await transport.close();
  });

  it('reports RCLNODEJS_API_MISMATCH when no action client factory exists', async () => {
    class BareNode {
      spin(): void {
        return undefined;
      }
    }
    const transport = createRclnodejsTransport({
      loader: () => Promise.resolve({ init: async () => undefined, Node: BareNode }),
    });
    await expect(transport.init()).rejects.toMatchObject({
      code: 'RCLNODEJS_API_MISMATCH',
    });
    await transport.close();
  });

  it('discovers the action client either on the module or on the node', async () => {
    const created: string[] = [];
    class NodeWithFactory {
      createActionClient(actionType: string, actionTopic: string): unknown {
        created.push(`${actionType}|${actionTopic}`);
        return {
          isActionServerAvailable: async () => true,
          sendGoal: async () => ({
            getGoalId: () => 'factory-goal',
            isAccepted: () => true,
            getResult: () => Promise.resolve({ status: 4 }),
          }),
        };
      }

      spin(): void {
        return undefined;
      }
    }
    const transport = createRclnodejsTransport({
      loader: () => Promise.resolve({ init: async () => undefined, Node: NodeWithFactory }),
      actionType: 'custom_actions/action/Custom',
      actionTopic: '/custom',
    });
    await transport.init();
    expect(created).toEqual(['custom_actions/action/Custom|/custom']);
    await transport.close();
  });
});

describe('RclnodejsActionTransport goal lifecycle', () => {
  it('maps the goal, buffers early feedback, and maps SUCCEEDED results', async () => {
    const { module, state } = createFakeRclnodejs();
    const transport = createRclnodejsTransport({ loader: loaderFor(module) });
    await transport.init();
    expect(state.nodeName).toBe('pinout_ros2_sidecar');
    expect(state.spins).toBe(1);
    expect(state.actionType).toBe(RCLNODEJS_DEFAULT_ACTION_TYPE);
    expect(state.actionTopic).toBe(RCLNODEJS_DEFAULT_ACTION_TOPIC);

    const handle = await transport.sendGoal(testGoal);
    expect(handle.accepted).toBe(true);
    expect(handle.goalId).toBe('goal-1-aabbccdd');

    const record = state.goals[0]!;
    expect(record.goal).toEqual({
      target_frame: 'base_link',
      target_pose: {
        position: { x: 0.1, y: 0.2, z: 0.3 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
      velocity_scaling: 0.5,
    });

    // Feedback arriving before onFeedback() is registered must be buffered.
    expect(record.feedbackCallback).toBeTypeOf('function');
    record.feedbackCallback?.(feedbackMessage());
    const frames: Array<RosFeedback<ArmPoseFeedback>> = [];
    const unsubscribe = transport.onFeedback(handle, (frame) => frames.push(frame));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.goalId).toBe(handle.goalId);
    expect(frames[0]!.feedback.controllerTimestamp).toBe(1234);

    record.feedbackCallback?.(
      feedbackMessage({ fraction: 0.75, current_position: { x: 0.08, y: 0.16, z: 0.24 } }),
    );
    expect(frames).toHaveLength(2);
    expect(frames[1]!.sequence).toBe(2);
    unsubscribe();

    record.resolveResult?.({
      status: 4,
      result: {
        reached_position: { x: 0.1, y: 0.2, z: 0.3 },
        joint_positions: [1, 2, 3, 4, 5, 6],
        frame: 'base_link',
        duration_ms: 123,
        confirmed_by: 'encoder',
      },
    });
    const result = await transport.getResult(handle);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.result).toMatchObject({
      reachedPosition: { x: 0.1, y: 0.2, z: 0.3 },
      jointPositions: [1, 2, 3, 4, 5, 6],
      frame: 'base_link',
      durationMs: 123,
      confirmedBy: 'encoder',
    });

    await transport.close();
    expect(state.destroys).toBe(1);
    expect(state.shutdowns).toBe(1);
  });

  it('falls back to the last feedback position when the result payload is empty', async () => {
    const { module, state } = createFakeRclnodejs();
    const transport = createRclnodejsTransport({ loader: loaderFor(module) });
    await transport.init();
    const handle = await transport.sendGoal(testGoal);
    const record = state.goals[0]!;
    record.feedbackCallback?.(feedbackMessage());
    transport.onFeedback(handle, () => undefined);
    record.resolveResult?.({ status: 4 });
    const result = await transport.getResult(handle);
    expect(result.result).toMatchObject({
      reachedPosition: { x: 0.05, y: 0.1, z: 0.15 },
      jointPositions: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
      confirmedBy: 'trajectory_controller',
    });
    await transport.close();
  });

  it('maps CANCELED, ABORTED, and unexpected statuses', async () => {
    const { module, state } = createFakeRclnodejs();
    const transport = createRclnodejsTransport({ loader: loaderFor(module) });
    await transport.init();

    const canceledHandle = await transport.sendGoal(testGoal);
    state.goals[0]!.resolveResult?.({ status: 5 });
    expect((await transport.getResult(canceledHandle)).status).toBe('CANCELED');

    const abortedHandle = await transport.sendGoal(testGoal);
    state.goals[1]!.resolveResult?.({ status: 6 });
    const aborted = await transport.getResult(abortedHandle);
    expect(aborted.status).toBe('ABORTED');
    expect(aborted.error).toContain('aborted by the controller');

    const weirdHandle = await transport.sendGoal(testGoal);
    state.goals[2]!.resolveResult?.({ status: 99 });
    const weird = await transport.getResult(weirdHandle);
    expect(weird.status).toBe('ABORTED');
    expect(weird.error).toContain('Unexpected ROS 2 goal status');
    expect(weird.result).toBeDefined();

    await transport.close();
  });

  it('returns ABORTED for an unknown goal handle', async () => {
    const { module } = createFakeRclnodejs();
    const transport = createRclnodejsTransport({ loader: loaderFor(module) });
    await transport.init();
    const result = await transport.getResult({
      goalId: 'never-seen',
      accepted: true,
      acceptedAt: Date.now(),
      goal: testGoal,
      status: 'STATUS_ACCEPTED',
    });
    expect(result.status).toBe('ABORTED');
    expect(result.error).toContain('Unknown goal ID');
    await transport.close();
  });

  it('drops unmappable feedback frames with a diagnostic', async () => {
    const { module, state } = createFakeRclnodejs();
    const diagnostics: RclnodejsDiagnostic[] = [];
    const transport = createRclnodejsTransport({
      loader: loaderFor(module),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await transport.init();
    const handle = await transport.sendGoal(testGoal);
    const frames: Array<RosFeedback<ArmPoseFeedback>> = [];
    transport.onFeedback(handle, (frame) => frames.push(frame));

    state.goals[0]!.feedbackCallback?.({ feedback: { fraction: 0.5 } });
    expect(frames).toHaveLength(0);
    expect(diagnostics).toMatchObject([
      { code: 'RCLNODEJS_FEEDBACK_UNMAPPABLE', goalId: handle.goalId },
    ]);

    state.goals[0]!.feedbackCallback?.(feedbackMessage());
    expect(frames).toHaveLength(1);
    await transport.close();
  });

  it('supports a custom feedbackMapper', async () => {
    const { module, state } = createFakeRclnodejs();
    const transport = createRclnodejsTransport({
      loader: loaderFor(module),
      feedbackMapper: (raw) => {
        const record = raw as { frac?: unknown; pose?: { x: number; y: number; z: number } };
        if (typeof record.frac !== 'number' || !record.pose) return undefined;
        return {
          fraction: record.frac,
          currentPosition: record.pose,
          jointPositions: [0, 0, 0, 0, 0, 0],
          jointVelocities: [0, 0, 0, 0, 0, 0],
          frame: 'tool0',
          controllerTimestamp: 42,
        };
      },
    });
    await transport.init();
    const handle = await transport.sendGoal(testGoal);
    const frames: Array<RosFeedback<ArmPoseFeedback>> = [];
    transport.onFeedback(handle, (frame) => frames.push(frame));
    state.goals[0]!.feedbackCallback?.({ frac: 0.25, pose: { x: 1, y: 2, z: 3 } });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.feedback).toMatchObject({
      fraction: 0.25,
      currentPosition: { x: 1, y: 2, z: 3 },
      frame: 'tool0',
      controllerTimestamp: 42,
    });
    await transport.close();
  });
});

describe('RclnodejsActionTransport cancellation and timeouts', () => {
  it('maps ROS 2 cancel return codes', async () => {
    const { module, state } = createFakeRclnodejs();
    const diagnostics: RclnodejsDiagnostic[] = [];
    const transport = createRclnodejsTransport({
      loader: loaderFor(module),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await transport.init();

    const accepted = await transport.sendGoal(testGoal);
    state.goals[0]!.cancelResult = { return_code: 0, goals_canceling: ['other-goal'] };
    expect(await transport.cancelGoal(accepted)).toMatchObject({
      returnCode: 'ERROR_NONE',
      goalsCanceling: ['other-goal'],
    });

    const rejected = await transport.sendGoal(testGoal);
    state.goals[1]!.cancelResult = { return_code: 1 };
    expect(await transport.cancelGoal(rejected)).toMatchObject({
      returnCode: 'ERROR_REJECTED',
      goalsCanceling: [],
    });

    const weird = await transport.sendGoal(testGoal);
    state.goals[2]!.cancelResult = { return_code: 9 };
    expect(await transport.cancelGoal(weird)).toMatchObject({ returnCode: 'ERROR_REJECTED' });
    expect(diagnostics.some((d) => d.code === 'RCLNODEJS_UNKNOWN_CANCEL_CODE')).toBe(true);

    expect(
      await transport.cancelGoal({
        goalId: 'never-seen',
        accepted: true,
        acceptedAt: Date.now(),
        goal: testGoal,
        status: 'STATUS_ACCEPTED',
      }),
    ).toMatchObject({ returnCode: 'ERROR_UNKNOWN_GOAL_ID' });

    const settled = await transport.sendGoal(testGoal);
    state.goals[3]!.resolveResult?.({ status: 4 });
    await transport.getResult(settled);
    expect(await transport.cancelGoal(settled)).toMatchObject({
      returnCode: 'ERROR_GOAL_TERMINATED',
    });

    await transport.close();
  });

  it('reports ERROR_REJECTED when the goal handle cannot cancel', async () => {
    const { module } = createFakeRclnodejs();
    const diagnostics: RclnodejsDiagnostic[] = [];
    const transport = createRclnodejsTransport({
      loader: loaderFor(module),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await transport.init();
    // Replace the action client with one whose goal handles lack cancelGoal().
    const internal = transport as unknown as {
      client: { sendGoal: (goal: unknown) => Promise<unknown> };
    };
    internal.client.sendGoal = async () => ({
      getGoalId: () => 'no-cancel',
      isAccepted: () => true,
      getResult: () => new Promise(() => undefined),
    });
    const handle = await transport.sendGoal(testGoal);
    expect(await transport.cancelGoal(handle)).toMatchObject({ returnCode: 'ERROR_REJECTED' });
    expect(diagnostics.some((d) => d.code === 'RCLNODEJS_CANCEL_UNSUPPORTED')).toBe(true);
    await transport.close();
  });

  it('times out the result wait without cancelling the goal', async () => {
    const { module, state } = createFakeRclnodejs();
    const transport = createRclnodejsTransport({ loader: loaderFor(module), resultTimeoutMs: 10 });
    await transport.init();
    const handle = await transport.sendGoal(testGoal);
    await expect(transport.getResult(handle)).rejects.toMatchObject({
      code: 'RCLNODEJS_GOAL_TIMEOUT',
      category: 'TIMEOUT',
      details: { stopConfirmed: false },
    });
    // No hidden auto-cancel or auto-resume: the stale goal remains untouched.
    expect(state.goals[0]!.cancelCalls).toBe(0);
    await transport.close();
  });

  it('times out a hanging sendGoal with RCLNODEJS_SEND_TIMEOUT', async () => {
    const { module } = createFakeRclnodejs({ hangSendGoal: true });
    const transport = createRclnodejsTransport({
      loader: loaderFor(module),
      sendGoalTimeoutMs: 10,
    });
    await transport.init();
    await expect(transport.sendGoal(testGoal)).rejects.toMatchObject({
      code: 'RCLNODEJS_SEND_TIMEOUT',
      category: 'TIMEOUT',
    });
    await transport.close();
  });

  it('wraps a rejected result wait as DISCONNECTED', async () => {
    const { module, state } = createFakeRclnodejs();
    const transport = createRclnodejsTransport({ loader: loaderFor(module) });
    await transport.init();
    const handle = await transport.sendGoal(testGoal);
    const rejection = transport.getResult(handle);
    state.goals[0]!.rejectResult?.(new Error('DDS link lost'));
    await expect(rejection).rejects.toBeInstanceOf(DeviceError);
    await expect(
      (async () => {
        const second = await transport.sendGoal(testGoal);
        const pending = transport.getResult(second);
        state.goals[1]!.rejectResult?.(new Error('DDS link lost again'));
        return pending;
      })(),
    ).rejects.toMatchObject({ code: 'DISCONNECTED' });
    await transport.close();
  });

  it('reports the action server as unavailable before sending', async () => {
    const { module } = createFakeRclnodejs({ availability: false });
    const transport = createRclnodejsTransport({
      loader: loaderFor(module),
      livenessIntervalMs: 0,
    });
    await transport.init();
    await expect(transport.sendGoal(testGoal)).rejects.toMatchObject({
      code: 'RCLNODEJS_ACTION_SERVER_UNAVAILABLE',
      category: 'DEVICE',
    });
    await transport.close();
  });

  it('rejects all operations after close', async () => {
    const { module } = createFakeRclnodejs();
    const transport = new RclnodejsActionTransport({ loader: loaderFor(module) });
    await transport.init();
    await transport.close();
    await expect(transport.sendGoal(testGoal)).rejects.toMatchObject({ code: 'DISCONNECTED' });
    await expect(
      transport.getResult({
        goalId: 'x',
        accepted: true,
        acceptedAt: Date.now(),
        goal: testGoal,
        status: 'STATUS_ACCEPTED',
      }),
    ).rejects.toMatchObject({ code: 'DISCONNECTED' });
  });
});

describe('RclnodejsActionTransport liveness', () => {
  it('polls availability and reports controller status transitions', async () => {
    const { module, state } = createFakeRclnodejs();
    const transport = createRclnodejsTransport({
      loader: loaderFor(module),
      livenessIntervalMs: 5,
    });
    await transport.init();

    const statuses: ControllerStatus[] = [];
    transport.onControllerStatus((status) => statuses.push(status));
    expect(statuses[0]).toMatchObject({ alive: true });

    state.availability = false;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(statuses.some((status) => !status.alive)).toBe(true);

    state.availability = true;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(statuses[statuses.length - 1]).toMatchObject({ alive: true });

    await transport.close();
    expect(statuses[statuses.length - 1]).toMatchObject({ alive: false, reason: 'Closed' });
  });
});

describe('RclnodejsActionTransport inside the ROS 2 sidecar', () => {
  it('executes a governed move_to_pose end to end', async () => {
    const { module, state } = createFakeRclnodejs();
    const transport = createRclnodejsTransport({ loader: loaderFor(module) });
    await transport.init();
    const backend = createRos2SidecarBackend({ transport });

    const pending = backend.invoke('arm.move_to_pose', {
      target: { frame: 'base_link', position: { x: 0.3, y: 0.2, z: 0.4 } },
      transformAt: Date.now(),
    });
    await nextTick();
    const record = state.goals[0]!;
    record.feedbackCallback?.({
      feedback: {
        fraction: 1,
        current_position: { x: 0.3, y: 0.2, z: 0.4 },
        joint_positions: [0, 0, 0, 0, 0, 0],
        joint_velocities: [0, 0, 0, 0, 0, 0],
        frame: 'base_link',
        controller_timestamp: Date.now(),
      },
    });
    record.resolveResult?.({ status: 4 });
    const result = await pending;

    expect(result.success).toBe(true);
    expect(result.position).toEqual({ x: 0.3, y: 0.2, z: 0.4 });
    expect(result.evidence).toMatchObject({ source: 'sensor', provenance: 'simulated' });
    await backend.close();
  });

  it('maps a dropped transport during the result wait to OPERATION_REQUIRES_RECONCILIATION', async () => {
    const { module, state } = createFakeRclnodejs();
    const transport = createRclnodejsTransport({ loader: loaderFor(module) });
    await transport.init();
    const backend = createRos2SidecarBackend({ transport });

    const pending = backend.invoke('arm.move_to_pose', {
      target: { frame: 'base_link', position: { x: 0.4, y: 0.4, z: 0.4 } },
      transformAt: Date.now(),
    });
    await nextTick();
    state.goals[0]!.rejectResult?.(new DeviceError('DISCONNECTED', 'DDS link lost'));

    await expect(pending).rejects.toMatchObject({
      code: 'OPERATION_REQUIRES_RECONCILIATION',
      category: 'OPERATION',
      details: { stopConfirmed: false },
    });
    expect(backend.getOperationalState().status).toBe('faulted');
    await backend.close();
  });
});

describe('defaultFeedbackMapper', () => {
  it('accepts camelCase and snake_case payloads and ROS time structs', () => {
    const mapped = defaultFeedbackMapper({
      fraction: 0.5,
      currentPosition: { x: 1, y: 2, z: 3 },
      jointPositions: [1, 2],
      jointVelocities: [3, 4],
      frame: 'tool0',
      controllerTimestamp: { sec: 100, nanosec: 500_000_000 },
    });
    expect(mapped).toMatchObject({
      fraction: 0.5,
      currentPosition: { x: 1, y: 2, z: 3 },
      frame: 'tool0',
      controllerTimestamp: 100_500,
    });
  });

  it('rejects partial frames instead of fabricating values', () => {
    expect(defaultFeedbackMapper({ fraction: 1 })).toBeUndefined();
    expect(defaultFeedbackMapper(undefined)).toBeUndefined();
    expect(
      defaultFeedbackMapper({
        fraction: 1,
        currentPosition: { x: 0, y: 0, z: 0 },
        jointPositions: [1],
        jointVelocities: [Number.NaN],
        frame: 'base_link',
      }),
    ).toBeUndefined();
  });
});
