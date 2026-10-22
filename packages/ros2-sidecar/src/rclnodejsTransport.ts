import type {
  ArmPoseFeedback,
  ArmPoseGoal,
  ArmPoseResult,
  ControllerStatus,
  RosActionResult,
  RosCancelResponse,
  RosFeedback,
  RosGoalHandle,
} from './types.js';
import type { RosActionTransport } from './transport.js';

// Optional rclnodejs adapter skeleton - zero workspace dependency.
// Install rclnodejs manually in a ROS 2 env; this file dynamic-imports it.
export interface RclnodejsTransportOptions {
  actionType?: string;
  actionTopic?: string;
  nodeName?: string;
}

interface RclNodeLike {
  spin(): void;
  destroy?(): Promise<void> | void;
}

interface RclGoalHandleLike {
  getGoalId?(): unknown;
  isAccepted?(): unknown;
}

interface RclActionClientLike {
  isActionServerAvailable?(): Promise<boolean>;
  sendGoal(goal: unknown): Promise<RclGoalHandleLike>;
}

interface RclLike {
  init(): Promise<void>;
  shutdown?(): Promise<void> | void;
  Node: new (name: string) => RclNodeLike;
  ActionClient: new (node: RclNodeLike, type: string, topic: string) => RclActionClientLike;
}

export class RclnodejsActionTransport implements RosActionTransport<
  ArmPoseGoal,
  ArmPoseFeedback,
  ArmPoseResult
> {
  private rcl: RclLike | undefined;
  private node: RclNodeLike | undefined;
  private client: RclActionClientLike | undefined;
  private seq = 0;
  private feedbacks = new Map<string, Set<(fb: RosFeedback<ArmPoseFeedback>) => void>>();
  private listeners = new Set<(s: ControllerStatus) => void>();
  private alive = true;
  constructor(private opts: RclnodejsTransportOptions = {}) {}

  async init(): Promise<void> {
    // @ts-expect-error rclnodejs is an optional peer dependency
    const mod = (await import('rclnodejs')) as unknown as RclLike;
    this.rcl = mod;
    await this.rcl.init();
    this.node = new this.rcl.Node(this.opts.nodeName ?? 'pinout_ros2_sidecar');
    this.client = new this.rcl.ActionClient(
      this.node,
      this.opts.actionType ?? 'control_msgs/action/FollowJointTrajectory',
      this.opts.actionTopic ?? '/arm_controller/follow_joint_trajectory',
    );
    this.node.spin();
  }

  async sendGoal(
    goal: ArmPoseGoal,
    options?: { timeoutMs?: number },
  ): Promise<RosGoalHandle<ArmPoseGoal>> {
    void options;
    const ready = await this.client?.isActionServerAvailable?.();
    if (!ready || this.client === undefined) {
      this.setAlive(false, 'Action server not available');
      throw new Error('ROS 2 action server is not available.');
    }
    const rosGoal = {
      target_frame: goal.target.frame,
      target_pose: {
        position: goal.target.position,
        orientation: goal.target.orientation ?? { x: 0, y: 0, z: 0, w: 1 },
      },
      velocity_scaling: goal.velocityScaling ?? 1.0,
    };
    const handle = await this.client.sendGoal(rosGoal);
    return {
      goalId: String(handle?.getGoalId?.() ?? `goal_${Date.now()}_${this.seq++}`),
      accepted: Boolean(handle?.isAccepted?.() ?? true),
      acceptedAt: Date.now(),
      goal,
      status: 'STATUS_ACCEPTED',
    };
  }

  onFeedback(
    handle: RosGoalHandle<ArmPoseGoal>,
    cb: (fb: RosFeedback<ArmPoseFeedback>) => void,
  ): () => void {
    let set = this.feedbacks.get(handle.goalId);
    if (!set) {
      set = new Set();
      this.feedbacks.set(handle.goalId, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
    };
  }

  async getResult(handle: RosGoalHandle<ArmPoseGoal>): Promise<RosActionResult<ArmPoseResult>> {
    // Real mapping: await native handle, translate GoalStatus. Skeleton keeps contract.
    return { goalId: handle.goalId, status: 'SUCCEEDED', at: Date.now() };
  }

  async cancelGoal(handle: RosGoalHandle<ArmPoseGoal>): Promise<RosCancelResponse> {
    return { returnCode: 'ERROR_NONE', goalsCanceling: [handle.goalId], timestamp: Date.now() };
  }

  onControllerStatus(cb: (s: ControllerStatus) => void): () => void {
    this.listeners.add(cb);
    cb({ alive: this.alive, at: Date.now() });
    return () => {
      this.listeners.delete(cb);
    };
  }

  private setAlive(alive: boolean, reason?: string): void {
    this.alive = alive;
    const s: ControllerStatus =
      reason !== undefined ? { alive, at: Date.now(), reason } : { alive, at: Date.now() };
    for (const l of this.listeners) l(s);
  }

  async close(): Promise<void> {
    this.feedbacks.clear();
    this.listeners.clear();
    try {
      await this.node?.destroy?.();
      await this.rcl?.shutdown?.();
    } finally {
      this.setAlive(false, 'Closed');
    }
  }
}
