import { describe, expect, it } from 'vitest';
import { FakeRosActionServer } from '../src/fakeRosActionServer.js';
import type { ArmPoseFeedback, ArmPoseGoal, RosFeedback } from '../src/types.js';

describe('FakeRosActionServer', () => {
  it('accepts goals and emits feedback before resolving succeeded', async () => {
    // Wide motion window vs feedback interval: ~20 expected ticks so even a
    // heavily loaded runner emits several feedbacks before completion.
    const server = new FakeRosActionServer({ motionDelayMs: 200, feedbackIntervalMs: 10 });
    const goal: ArmPoseGoal = {
      target: {
        frame: 'base_link',
        position: { x: 0.5, y: 0.2, z: 0.3 },
      },
      transformAt: Date.now(),
    };

    const handle = await server.sendGoal(goal);
    expect(handle.accepted).toBe(true);
    expect(handle.status).toBe('STATUS_ACCEPTED');

    const feedbackList: Array<RosFeedback<ArmPoseFeedback>> = [];
    const unsubscribe = server.onFeedback(handle, (feedback) => {
      feedbackList.push(feedback);
    });

    const result = await server.getResult(handle);
    unsubscribe();

    expect(result.status).toBe('SUCCEEDED');
    expect(result.result?.reachedPosition).toEqual({ x: 0.5, y: 0.2, z: 0.3 });
    expect(result.result?.confirmedBy).toBe('encoder');
    expect(feedbackList.length).toBeGreaterThanOrEqual(2);
    expect(feedbackList[0]?.feedback.fraction).toBeGreaterThanOrEqual(0);

    await server.close();
  });

  it('handles goal rejection when configured', async () => {
    const server = new FakeRosActionServer({ rejectGoals: true });
    const goal: ArmPoseGoal = {
      target: {
        frame: 'base_link',
        position: { x: 0.1, y: 0.1, z: 0.1 },
      },
    };

    const handle = await server.sendGoal(goal);
    expect(handle.accepted).toBe(false);
    expect(handle.status).toBe('STATUS_ABORTED');

    const result = await server.getResult(handle);
    expect(result.status).toBe('ABORTED');
    expect(result.error).toContain('rejected by controller');

    await server.close();
  });

  it('cancels an in-flight goal and reports CANCELED with stopped position', async () => {
    const server = new FakeRosActionServer({ motionDelayMs: 50, feedbackIntervalMs: 5 });
    const goal: ArmPoseGoal = {
      target: {
        frame: 'base_link',
        position: { x: 0.8, y: 0.8, z: 0.8 },
      },
    };

    const handle = await server.sendGoal(goal);
    await new Promise((resolve) => setTimeout(resolve, 15));

    const cancelResponse = await server.cancelGoal(handle);
    expect(cancelResponse.returnCode).toBe('ERROR_NONE');
    expect(cancelResponse.goalsCanceling).toContain(handle.goalId);

    const result = await server.getResult(handle);
    expect(result.status).toBe('CANCELED');
    expect(result.result?.reachedPosition.x).toBeGreaterThan(0);
    expect(result.result?.reachedPosition.x).toBeLessThan(0.8);

    await server.close();
  });

  it('reports ERROR_REJECTED when controller rejects cancel', async () => {
    const server = new FakeRosActionServer({
      motionDelayMs: 30,
      feedbackIntervalMs: 5,
      rejectCancel: true,
    });
    const goal: ArmPoseGoal = {
      target: {
        frame: 'base_link',
        position: { x: 0.4, y: 0.4, z: 0.4 },
      },
    };

    const handle = await server.sendGoal(goal);
    const cancelResponse = await server.cancelGoal(handle);
    expect(cancelResponse.returnCode).toBe('ERROR_REJECTED');

    const result = await server.getResult(handle);
    expect(result.status).toBe('SUCCEEDED');

    await server.close();
  });

  it('handles abort injection mid-motion', async () => {
    const server = new FakeRosActionServer({
      motionDelayMs: 40,
      feedbackIntervalMs: 5,
      abortMidMotion: true,
    });
    const goal: ArmPoseGoal = {
      target: {
        frame: 'base_link',
        position: { x: 0.2, y: 0.3, z: 0.4 },
      },
    };

    const handle = await server.sendGoal(goal);
    const result = await server.getResult(handle);

    expect(result.status).toBe('ABORTED');
    expect(result.error).toContain('abort');

    await server.close();
  });

  it('emits controller status changes and rejects in-flight goals on disconnection', async () => {
    const server = new FakeRosActionServer({ motionDelayMs: 50, feedbackIntervalMs: 5 });
    const statuses: boolean[] = [];
    server.onControllerStatus((status) => {
      statuses.push(status.alive);
    });

    expect(statuses).toEqual([true]);

    const goal: ArmPoseGoal = {
      target: {
        frame: 'base_link',
        position: { x: 0.5, y: 0.5, z: 0.5 },
      },
    };
    const handle = await server.sendGoal(goal);

    await new Promise((resolve) => setTimeout(resolve, 10));
    server.triggerControllerLoss('Physical Ethernet cable disconnected');

    expect(statuses).toEqual([true, false]);
    await expect(server.getResult(handle)).rejects.toMatchObject({
      code: 'DISCONNECTED',
    });

    await server.close();
  });
});
