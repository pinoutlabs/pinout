/**
 * Optional rclnodejs-backed ROS 2 action transport (spec v1).
 *
 * Maps the Pinout {@link RosActionTransport} contract onto a real ROS 2 action
 * client through `rclnodejs`. `rclnodejs` is intentionally NOT a dependency of
 * this package: the module is loaded lazily through a dependency-injection
 * seam (`RclnodejsTransportOptions.loader`), and a structured
 * `RCLNODEJS_UNAVAILABLE` error is raised when it cannot be loaded. Tests and
 * embeddings can pass a fake module through the same seam.
 *
 * SUPPORT STATUS: IMPLEMENTED — NOT EXERCISED. This adapter has never been
 * executed against a live ROS 2 graph or `rclnodejs` installation. The
 * structural seam below is written against the documented rclnodejs
 * `ActionClient` surface (constructor or `Node#createActionClient`,
 * `sendGoal(goal, { feedbackCallback })`, goal handles with
 * `getGoalId/isAccepted/getResult/cancelGoal`); verify the exact call
 * convention of your installed rclnodejs version before use.
 *
 * Motion is a PHYSICAL SIDE EFFECT. This transport only forwards goals; the
 * controller owns real-time limits, protective stops, and collision reflexes.
 */
import { DeviceError, PinoutStructuredError } from '@pinout/core';
import type {
  ArmPoseFeedback,
  ArmPoseGoal,
  ArmPoseResult,
  CartesianPose,
  ControllerStatus,
  RosActionResult,
  RosCancelCode,
  RosCancelResponse,
  RosFeedback,
  RosGoalHandle,
} from './types.js';
import type { RosActionTransport } from './transport.js';

export const RCLNODEJS_DEFAULT_NODE_NAME = 'pinout_ros2_sidecar';
export const RCLNODEJS_DEFAULT_ACTION_TYPE = 'cartesian_control_msgs/action/MoveToPose';
export const RCLNODEJS_DEFAULT_ACTION_TOPIC = '/arm_controller/move_to_pose';

const DEFAULT_SEND_GOAL_TIMEOUT_MS = 10_000;
const DEFAULT_RESULT_TIMEOUT_MS = 120_000;
const DEFAULT_LIVENESS_INTERVAL_MS = 1_000;
const FEEDBACK_BACKLOG_CAPACITY = 32;
const SETTLED_GOAL_HISTORY = 128;

/** Loads the optional `rclnodejs` module. Rejections are reported as `RCLNODEJS_UNAVAILABLE`. */
export type RclnodejsLoader = () => Promise<unknown>;

/** Maps a raw ROS 2 action feedback message to {@link ArmPoseFeedback}; `undefined` drops the frame. */
export type RclnodejsFeedbackMapper = (raw: unknown) => ArmPoseFeedback | undefined;

export interface RclnodejsDiagnostic {
  code: string;
  message: string;
  at: number;
  goalId?: string;
}

// ---------------------------------------------------------------------------
// Structural rclnodejs seam
//
// These interfaces describe only the members this adapter uses. None of them
// creates a hard dependency on `rclnodejs`; see the package README.
// ---------------------------------------------------------------------------

export interface RclnodejsGoalHandleLike {
  getGoalId?(): unknown;
  isAccepted?(): unknown;
  getResult(): Promise<unknown> | unknown;
  cancelGoal?(): Promise<unknown> | unknown;
}

export interface RclnodejsActionClientLike {
  isActionServerAvailable?(): Promise<boolean> | boolean;
  sendGoal(
    goal: unknown,
    options?: { feedbackCallback?: (message: unknown) => void },
  ): Promise<RclnodejsGoalHandleLike> | RclnodejsGoalHandleLike;
}

export interface RclnodejsNodeLike {
  createActionClient?(actionType: string, actionTopic: string): RclnodejsActionClientLike;
  spin?(): void;
  destroy?(): Promise<void> | void;
}

export interface RclnodejsModuleLike {
  init(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
  spin?(node: RclnodejsNodeLike): void;
  Node: new (name: string) => RclnodejsNodeLike;
  ActionClient?: new (
    node: RclnodejsNodeLike,
    actionType: string,
    actionTopic: string,
  ) => RclnodejsActionClientLike;
}

export interface RclnodejsTransportOptions {
  /** DI seam: returns the loaded rclnodejs module. Defaults to `import('rclnodejs')`. */
  loader?: RclnodejsLoader;
  nodeName?: string;
  actionType?: string;
  actionTopic?: string;
  /**
   * When true (default), the transport starts spinning the node. Set false when
   * the embedding application owns the executor; no spin capability is then required.
   */
  manageSpin?: boolean;
  /** Maps raw action feedback; defaults to {@link defaultFeedbackMapper}. */
  feedbackMapper?: RclnodejsFeedbackMapper;
  /** Availability poll interval in ms. `0` disables liveness polling. Default 1000. */
  livenessIntervalMs?: number;
  /** Bound on the `sendGoal` acceptance round-trip. `0` disables. Default 10000. */
  sendGoalTimeoutMs?: number;
  /** Bound on the result wait. `0` disables. Default 120000. */
  resultTimeoutMs?: number;
  /** Non-fatal diagnostics (dropped frames, shutdown errors, unknown codes). */
  onDiagnostic?: (diagnostic: RclnodejsDiagnostic) => void;
}

/**
 * Default loader: lazily imports the optional `rclnodejs` peer.
 * `rclnodejs` is deliberately not installed by this workspace; in a ROS 2
 * environment the embedder installs it and this import resolves.
 */
export async function defaultRclnodejsLoader(): Promise<unknown> {
  // @ts-expect-error rclnodejs is an optional peer dependency and is intentionally absent.
  return (await import('rclnodejs')) as unknown;
}

/**
 * Default feedback mapper for raw ROS 2 action feedback messages.
 *
 * Accepts either the action feedback message (`{ goal_id, feedback }`) or the
 * inner feedback payload directly. Expected fields (snake_case or camelCase):
 * `fraction`, `current_position`/`currentPosition` `{x,y,z}`, `joint_positions`/
 * `jointPositions`, `joint_velocities`/`jointVelocities`, `frame`, and
 * `controller_timestamp`/`controllerTimestamp` (milliseconds, or a ROS time
 * struct `{sec, nanosec}` / `{secs, nsecs}`). A frame missing any required
 * field is dropped with a diagnostic rather than filled with zeroes.
 */
export function defaultFeedbackMapper(raw: unknown): ArmPoseFeedback | undefined {
  const record = isRecord(raw) ? raw : undefined;
  if (!record) return undefined;
  const fraction = readNumber(record.fraction);
  const currentPosition = readVec3(record.current_position ?? record.currentPosition);
  const jointPositions = readNumberArray(record.joint_positions ?? record.jointPositions);
  const jointVelocities = readNumberArray(record.joint_velocities ?? record.jointVelocities);
  const frame =
    typeof record.frame === 'string' && record.frame.length > 0 ? record.frame : undefined;
  if (
    fraction === undefined ||
    currentPosition === undefined ||
    jointPositions === undefined ||
    jointVelocities === undefined ||
    frame === undefined
  ) {
    return undefined;
  }
  const controllerTimestamp =
    readControllerTimestamp(record.controller_timestamp ?? record.controllerTimestamp) ??
    Date.now();
  return { fraction, currentPosition, jointPositions, jointVelocities, frame, controllerTimestamp };
}

export function createRclnodejsTransport(
  options: RclnodejsTransportOptions = {},
): RclnodejsActionTransport {
  return new RclnodejsActionTransport(options);
}

/**
 * ROS 2 action transport over the optional `rclnodejs` module.
 *
 * Initialization is lazy (first `sendGoal`/explicit `init()`) and sticky: a
 * failed initialization is reported identically on later calls and requires a
 * new transport instance. Controller liveness is derived from
 * `isActionServerAvailable()` polling; availability changes are reported to
 * `onControllerStatus` subscribers. A result wait that fails at the transport
 * level throws `DeviceError('DISCONNECTED')`, which the sidecar maps to
 * `OPERATION_REQUIRES_RECONCILIATION`.
 */
export class RclnodejsActionTransport implements RosActionTransport<
  ArmPoseGoal,
  ArmPoseFeedback,
  ArmPoseResult
> {
  private readonly loader: RclnodejsLoader;
  private readonly mapper: RclnodejsFeedbackMapper;

  private module: RclnodejsModuleLike | undefined;
  private node: RclnodejsNodeLike | undefined;
  private client: RclnodejsActionClientLike | undefined;
  private ready: Promise<void> | undefined;
  private closed = false;
  private seq = 0;

  private statusKnown = false;
  private controllerAlive = false;
  private controllerReason: string | undefined;
  private livenessTimer: ReturnType<typeof setInterval> | undefined;

  private readonly nativeHandles = new Map<string, RclnodejsGoalHandleLike>();
  private readonly resultPromises = new Map<string, Promise<unknown>>();
  private readonly goalIdByPendingKey = new Map<string, string>();
  private readonly pendingFeedback = new Map<string, Array<RosFeedback<ArmPoseFeedback>>>();
  private readonly feedbackListeners = new Map<
    string,
    Set<(feedback: RosFeedback<ArmPoseFeedback>) => void>
  >();
  private readonly feedbackSequences = new Map<string, number>();
  private readonly lastFeedback = new Map<string, ArmPoseFeedback>();
  private readonly settledGoals = new Set<string>();
  private readonly statusListeners = new Set<(status: ControllerStatus) => void>();

  constructor(private readonly options: RclnodejsTransportOptions = {}) {
    this.loader = options.loader ?? defaultRclnodejsLoader;
    this.mapper = options.feedbackMapper ?? defaultFeedbackMapper;
  }

  /** Initialize the transport. Idempotent; lazy-called by `sendGoal` when omitted. */
  async init(): Promise<void> {
    return this.ensureReady();
  }

  async sendGoal(
    goal: ArmPoseGoal,
    options?: { timeoutMs?: number },
  ): Promise<RosGoalHandle<ArmPoseGoal>> {
    await this.ensureReady();
    const client = this.client;
    if (!client) {
      throw apiMismatch('The action client was not created during initialization.');
    }

    const available = await this.checkAvailability();
    if (!available) {
      this.setAlive(false, 'ROS 2 action server is not available.');
      throw new PinoutStructuredError(
        'RCLNODEJS_ACTION_SERVER_UNAVAILABLE',
        'DEVICE',
        `ROS 2 action server '${this.actionTopic()}' is not available.`,
        { details: { actionTopic: this.actionTopic(), actionType: this.actionType() } },
      );
    }
    this.setAlive(true);

    const rosGoal = {
      target_frame: goal.target.frame,
      target_pose: {
        position: { ...goal.target.position },
        orientation: goal.target.orientation
          ? { ...goal.target.orientation }
          : { x: 0, y: 0, z: 0, w: 1 },
      },
      velocity_scaling: goal.velocityScaling ?? 1.0,
    };

    const pendingKey = `pending_${++this.seq}`;
    this.pendingFeedback.set(pendingKey, []);
    const timeoutMs =
      options?.timeoutMs ?? this.options.sendGoalTimeoutMs ?? DEFAULT_SEND_GOAL_TIMEOUT_MS;

    let native: RclnodejsGoalHandleLike;
    try {
      native = await withTimeout(
        Promise.resolve().then(() =>
          client.sendGoal(rosGoal, {
            feedbackCallback: (message: unknown) => this.handleNativeFeedback(pendingKey, message),
          }),
        ),
        timeoutMs,
        () =>
          new PinoutStructuredError(
            'RCLNODEJS_SEND_TIMEOUT',
            'TIMEOUT',
            `The ROS 2 action server did not respond to the goal within ${timeoutMs}ms.`,
            { details: { actionTopic: this.actionTopic(), timeoutMs } },
          ),
      );
    } catch (error) {
      this.pendingFeedback.delete(pendingKey);
      if (error instanceof PinoutStructuredError && error.code === 'RCLNODEJS_SEND_TIMEOUT') {
        throw error;
      }
      this.setAlive(false, 'Sending the goal to the ROS 2 action server failed.');
      throw new PinoutStructuredError(
        'RCLNODEJS_GOAL_SEND_FAILED',
        'TRANSPORT',
        `Sending the ROS 2 goal failed: ${errorMessage(error)}`,
        { cause: error, details: { actionTopic: this.actionTopic() } },
      );
    }

    if (typeof native?.isAccepted !== 'function') {
      this.pendingFeedback.delete(pendingKey);
      throw apiMismatch('sendGoal() returned a goal handle without isAccepted().');
    }
    const accepted = Boolean(native.isAccepted());
    const goalId = this.registerGoalHandle(pendingKey, native);

    return {
      goalId,
      accepted,
      acceptedAt: Date.now(),
      goal,
      status: accepted ? 'STATUS_ACCEPTED' : 'STATUS_ABORTED',
    };
  }

  onFeedback(
    handle: RosGoalHandle<ArmPoseGoal>,
    callback: (feedback: RosFeedback<ArmPoseFeedback>) => void,
  ): () => void {
    let listeners = this.feedbackListeners.get(handle.goalId);
    if (!listeners) {
      listeners = new Set();
      this.feedbackListeners.set(handle.goalId, listeners);
    }
    listeners.add(callback);

    // Deliver frames that arrived between sendGoal() and registration.
    const backlog = this.pendingFeedback.get(handle.goalId);
    if (backlog && backlog.length > 0) {
      for (const frame of backlog.splice(0, backlog.length)) {
        callback(frame);
      }
    }

    return () => {
      listeners?.delete(callback);
    };
  }

  async getResult(handle: RosGoalHandle<ArmPoseGoal>): Promise<RosActionResult<ArmPoseResult>> {
    if (this.closed) {
      throw new DeviceError('DISCONNECTED', 'rclnodejs transport is closed.');
    }
    const native = this.nativeHandles.get(handle.goalId);
    if (!native) {
      return {
        goalId: handle.goalId,
        status: 'ABORTED',
        error: `Unknown goal ID '${handle.goalId}'.`,
        at: Date.now(),
      };
    }

    const timeoutMs = this.options.resultTimeoutMs ?? DEFAULT_RESULT_TIMEOUT_MS;
    const pendingResult = this.resultPromises.get(handle.goalId);
    let raw: unknown;
    try {
      raw = await withTimeout(
        pendingResult ?? Promise.resolve().then(() => native.getResult()),
        timeoutMs,
        () =>
          new PinoutStructuredError(
            'RCLNODEJS_GOAL_TIMEOUT',
            'TIMEOUT',
            `No ROS 2 action result within ${timeoutMs}ms. The goal was NOT cancelled automatically; physical state is unconfirmed.`,
            { details: { goalId: handle.goalId, timeoutMs, stopConfirmed: false } },
          ),
      );
    } catch (error) {
      if (error instanceof PinoutStructuredError && error.code === 'RCLNODEJS_GOAL_TIMEOUT') {
        throw error;
      }
      this.setAlive(false, 'Waiting for the ROS 2 action result failed.');
      throw new DeviceError(
        'DISCONNECTED',
        `ROS 2 action result unavailable: ${errorMessage(error)}`,
      );
    }

    const outcome = mapGoalOutcome(raw);
    const payload = this.buildResultPayload(raw, handle);
    this.markSettled(handle.goalId);

    const at = Date.now();
    if (outcome.status === 'ABORTED') {
      return {
        goalId: handle.goalId,
        status: 'ABORTED',
        result: payload,
        error: outcome.error ?? 'ROS 2 action was aborted by the controller.',
        at,
      };
    }
    if (outcome.status === 'CANCELED') {
      return { goalId: handle.goalId, status: 'CANCELED', result: payload, at };
    }
    return { goalId: handle.goalId, status: 'SUCCEEDED', result: payload, at };
  }

  async cancelGoal(handle: RosGoalHandle<ArmPoseGoal>): Promise<RosCancelResponse> {
    const now = Date.now();
    const native = this.nativeHandles.get(handle.goalId);
    if (!native) {
      return {
        returnCode: this.settledGoals.has(handle.goalId)
          ? 'ERROR_GOAL_TERMINATED'
          : 'ERROR_UNKNOWN_GOAL_ID',
        goalsCanceling: [],
        timestamp: now,
      };
    }
    if (typeof native.cancelGoal !== 'function') {
      this.diagnostic(
        'RCLNODEJS_CANCEL_UNSUPPORTED',
        'The rclnodejs goal handle does not expose cancelGoal(); no cancel request was sent.',
        handle.goalId,
      );
      return { returnCode: 'ERROR_REJECTED', goalsCanceling: [], timestamp: now };
    }

    let raw: unknown;
    try {
      raw = await native.cancelGoal();
    } catch (error) {
      this.setAlive(false, 'Cancelling the ROS 2 goal failed.');
      throw new DeviceError('DISCONNECTED', `ROS 2 cancel request failed: ${errorMessage(error)}`);
    }

    const record = isRecord(raw) ? raw : undefined;
    const codeValue = record ? (record.return_code ?? record.returnCode ?? raw) : raw;
    const numeric = readNumber(codeValue);
    if (numeric !== undefined && (numeric < 0 || numeric > 3)) {
      this.diagnostic(
        'RCLNODEJS_UNKNOWN_CANCEL_CODE',
        `Action server returned unknown cancel code ${numeric}; reporting ERROR_REJECTED.`,
        handle.goalId,
      );
    }
    const returnCode = mapCancelReturnCode(codeValue);
    const goalsCanceling = readCancelGoalIds(record);
    return {
      returnCode,
      goalsCanceling: goalsCanceling ?? (returnCode === 'ERROR_NONE' ? [handle.goalId] : []),
      timestamp: Date.now(),
    };
  }

  onControllerStatus(callback: (status: ControllerStatus) => void): () => void {
    this.statusListeners.add(callback);
    if (this.statusKnown) {
      callback(this.currentStatus());
    }
    return () => {
      this.statusListeners.delete(callback);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.livenessTimer !== undefined) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = undefined;
    }
    this.setAlive(false, 'Closed');

    try {
      await this.node?.destroy?.();
    } catch (error) {
      this.diagnostic(
        'RCLNODEJS_SHUTDOWN_ERROR',
        `Destroying the rclnodejs node failed: ${errorMessage(error)}`,
      );
    }
    try {
      await this.module?.shutdown?.();
    } catch (error) {
      this.diagnostic(
        'RCLNODEJS_SHUTDOWN_ERROR',
        `rclnodejs.shutdown() failed: ${errorMessage(error)}`,
      );
    }

    this.nativeHandles.clear();
    this.resultPromises.clear();
    this.goalIdByPendingKey.clear();
    this.pendingFeedback.clear();
    this.feedbackListeners.clear();
    this.feedbackSequences.clear();
    this.lastFeedback.clear();
    this.settledGoals.clear();
    this.statusListeners.clear();
  }

  // -------------------------------------------------------------------------

  private ensureReady(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new DeviceError('DISCONNECTED', 'rclnodejs transport is closed.'));
    }
    if (!this.ready) {
      this.ready = this.initialize();
    }
    return this.ready;
  }

  private async initialize(): Promise<void> {
    let loaded: unknown;
    try {
      loaded = await this.loader();
    } catch (error) {
      this.setAlive(false, 'rclnodejs is unavailable.');
      throw new PinoutStructuredError(
        'RCLNODEJS_UNAVAILABLE',
        'CONFIG',
        `rclnodejs could not be loaded. Install it in a ROS 2 environment or provide a custom loader. (${errorMessage(error)})`,
        { cause: error, details: { reason: errorMessage(error) } },
      );
    }

    const api = validateRclnodejsModule(loaded);
    this.module = api;

    try {
      await api.init();
    } catch (error) {
      this.setAlive(false, 'rclnodejs initialization failed.');
      throw new PinoutStructuredError(
        'RCLNODEJS_INIT_FAILED',
        'TRANSPORT',
        `rclnodejs.init() failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    let node: RclnodejsNodeLike;
    try {
      node = new api.Node(this.options.nodeName ?? RCLNODEJS_DEFAULT_NODE_NAME);
    } catch (error) {
      this.setAlive(false, 'Creating the rclnodejs node failed.');
      throw new PinoutStructuredError(
        'RCLNODEJS_INIT_FAILED',
        'TRANSPORT',
        `Creating the rclnodejs node failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    this.node = node;
    this.client = createActionClient(api, node, this.actionType(), this.actionTopic());
    this.startSpinning(api, node);

    const available = await this.checkAvailability();
    this.setAlive(
      available,
      available ? undefined : 'ROS 2 action server is not available at initialization.',
    );
    this.startLivenessPolling();
  }

  private actionType(): string {
    return this.options.actionType ?? RCLNODEJS_DEFAULT_ACTION_TYPE;
  }

  private actionTopic(): string {
    return this.options.actionTopic ?? RCLNODEJS_DEFAULT_ACTION_TOPIC;
  }

  private startSpinning(api: RclnodejsModuleLike, node: RclnodejsNodeLike): void {
    if (this.options.manageSpin === false) return;
    if (typeof node.spin === 'function') {
      node.spin();
      return;
    }
    if (typeof api.spin === 'function') {
      api.spin(node);
      return;
    }
    throw apiMismatch(
      'no spin() was found on the node or module; pass manageSpin: false if the embedding application runs its own executor.',
    );
  }

  private async checkAvailability(): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    if (typeof client.isActionServerAvailable !== 'function') {
      // Unknown: assume reachable; a real failure surfaces on sendGoal().
      return true;
    }
    try {
      return Boolean(await client.isActionServerAvailable());
    } catch {
      return false;
    }
  }

  private startLivenessPolling(): void {
    const intervalMs = this.options.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    this.livenessTimer = setInterval(() => {
      void this.pollLiveness();
    }, intervalMs);
    (this.livenessTimer as { unref?: () => void }).unref?.();
  }

  private async pollLiveness(): Promise<void> {
    if (this.closed || !this.client) return;
    const available = await this.checkAvailability();
    this.setAlive(available, available ? undefined : 'ROS 2 action server became unavailable.');
  }

  private registerGoalHandle(pendingKey: string, native: RclnodejsGoalHandleLike): string {
    const rawId =
      typeof native.getGoalId === 'function' ? normalizeGoalId(native.getGoalId()) : undefined;
    const baseId = rawId ?? pendingKey;
    let goalId = baseId;
    let suffix = 0;
    while (this.nativeHandles.has(goalId) && this.nativeHandles.get(goalId) !== native) {
      suffix += 1;
      goalId = `${baseId}#${suffix}`;
    }
    this.nativeHandles.set(goalId, native);
    this.goalIdByPendingKey.set(pendingKey, goalId);

    // Start waiting for the result as soon as the handle exists. A controller
    // may settle a short goal before the caller asks for the result, and
    // rclnodejs only exposes one result promise per handle.
    const resultPromise = Promise.resolve().then(() => native.getResult());
    void resultPromise.catch(() => undefined);
    this.resultPromises.set(goalId, resultPromise);

    // Re-key any feedback that arrived between sendGoal() and handle resolution.
    const backlog = this.pendingFeedback.get(pendingKey);
    this.pendingFeedback.delete(pendingKey);
    if (backlog && backlog.length > 0) {
      const existing = this.pendingFeedback.get(goalId) ?? [];
      this.pendingFeedback.set(
        goalId,
        [...existing, ...backlog.map((frame) => ({ ...frame, goalId }))].slice(
          -FEEDBACK_BACKLOG_CAPACITY,
        ),
      );
    }
    const sequence = this.feedbackSequences.get(pendingKey);
    if (sequence !== undefined) {
      this.feedbackSequences.set(goalId, sequence);
      this.feedbackSequences.delete(pendingKey);
    }
    const last = this.lastFeedback.get(pendingKey);
    if (last) {
      this.lastFeedback.set(goalId, last);
      this.lastFeedback.delete(pendingKey);
    }
    return goalId;
  }

  private handleNativeFeedback(rawKey: string, message: unknown): void {
    const key = this.goalIdByPendingKey.get(rawKey) ?? rawKey;
    try {
      if (this.settledGoals.has(key)) {
        this.diagnostic(
          'RCLNODEJS_FEEDBACK_AFTER_RESULT',
          'Feedback arrived after the goal result was already returned; frame dropped.',
          key,
        );
        return;
      }
      const raw = isRecord(message) && 'feedback' in message ? message.feedback : message;
      const mapped = this.mapper(raw);
      if (!mapped) {
        this.diagnostic(
          'RCLNODEJS_FEEDBACK_UNMAPPABLE',
          'A feedback frame could not be mapped to ArmPoseFeedback and was dropped.',
          key,
        );
        return;
      }
      const sequence = (this.feedbackSequences.get(key) ?? 0) + 1;
      this.feedbackSequences.set(key, sequence);
      this.lastFeedback.set(key, mapped);
      const frame: RosFeedback<ArmPoseFeedback> = {
        goalId: key,
        sequence,
        at: Date.now(),
        feedback: mapped,
      };

      const listeners = this.feedbackListeners.get(key);
      if (listeners && listeners.size > 0) {
        for (const listener of [...listeners]) listener(frame);
        return;
      }
      const backlog = this.pendingFeedback.get(key) ?? [];
      backlog.push(frame);
      while (backlog.length > FEEDBACK_BACKLOG_CAPACITY) {
        backlog.shift();
        this.diagnostic(
          'RCLNODEJS_FEEDBACK_BACKLOG_OVERFLOW',
          'Feedback backlog exceeded its capacity; the oldest frame was dropped.',
          key,
        );
      }
      this.pendingFeedback.set(key, backlog);
    } catch (error) {
      this.diagnostic(
        'RCLNODEJS_FEEDBACK_HANDLER_ERROR',
        `Feedback handler threw: ${errorMessage(error)}`,
        key,
      );
    }
  }

  private buildResultPayload(raw: unknown, handle: RosGoalHandle<ArmPoseGoal>): ArmPoseResult {
    const record = isRecord(raw) ? raw : undefined;
    const resultMessage = record && isRecord(record.result) ? record.result : undefined;
    const message = resultMessage ?? {};
    const last = this.lastFeedback.get(handle.goalId);
    const reachedPosition =
      readVec3(message.reached_position ?? message.reachedPosition) ??
      (last ? { ...last.currentPosition } : { ...handle.goal.target.position });
    const jointPositions =
      readNumberArray(message.joint_positions ?? message.jointPositions) ??
      (last ? [...last.jointPositions] : []);
    const frame =
      typeof message.frame === 'string' && message.frame.length > 0
        ? message.frame
        : (last?.frame ?? handle.goal.target.frame);
    const durationMs =
      readNumber(message.duration_ms ?? message.durationMs) ??
      Math.max(0, Date.now() - handle.acceptedAt);
    const confirmedBy: ArmPoseResult['confirmedBy'] =
      (message.confirmed_by ?? message.confirmedBy) === 'encoder'
        ? 'encoder'
        : 'trajectory_controller';
    return {
      reachedPosition,
      jointPositions,
      frame,
      durationMs,
      confirmedBy,
      completedAt: Date.now(),
    };
  }

  private markSettled(goalId: string): void {
    this.nativeHandles.delete(goalId);
    this.resultPromises.delete(goalId);
    this.pendingFeedback.delete(goalId);
    this.feedbackSequences.delete(goalId);
    this.lastFeedback.delete(goalId);
    this.settledGoals.add(goalId);
    while (this.settledGoals.size > SETTLED_GOAL_HISTORY) {
      const oldest = this.settledGoals.values().next();
      if (oldest.done) break;
      this.settledGoals.delete(oldest.value);
    }
  }

  private currentStatus(): ControllerStatus {
    return {
      alive: this.controllerAlive,
      at: Date.now(),
      ...(this.controllerReason !== undefined ? { reason: this.controllerReason } : {}),
    };
  }

  private setAlive(alive: boolean, reason?: string): void {
    const changed =
      !this.statusKnown || this.controllerAlive !== alive || this.controllerReason !== reason;
    this.statusKnown = true;
    this.controllerAlive = alive;
    this.controllerReason = reason;
    if (!changed) return;
    const status = this.currentStatus();
    for (const listener of [...this.statusListeners]) listener(status);
  }

  private diagnostic(code: string, message: string, goalId?: string): void {
    const sink = this.options.onDiagnostic;
    if (!sink) return;
    sink({
      code,
      message,
      at: Date.now(),
      ...(goalId !== undefined ? { goalId } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function validateRclnodejsModule(loaded: unknown): RclnodejsModuleLike {
  if (!isRecord(loaded)) {
    throw apiMismatch('the loaded module is not an object.');
  }
  if (typeof loaded.init !== 'function') {
    throw apiMismatch('the loaded module does not expose init().');
  }
  if (typeof loaded.Node !== 'function') {
    throw apiMismatch('the loaded module does not expose the Node constructor.');
  }
  return loaded as unknown as RclnodejsModuleLike;
}

function createActionClient(
  api: RclnodejsModuleLike,
  node: RclnodejsNodeLike,
  actionType: string,
  actionTopic: string,
): RclnodejsActionClientLike {
  if (typeof api.ActionClient === 'function') {
    return new api.ActionClient(node, actionType, actionTopic);
  }
  if (typeof node.createActionClient === 'function') {
    return node.createActionClient(actionType, actionTopic);
  }
  throw apiMismatch(
    'the module exposes neither ActionClient nor Node#createActionClient; cannot create an action client.',
  );
}

function apiMismatch(message: string): PinoutStructuredError {
  return new PinoutStructuredError(
    'RCLNODEJS_API_MISMATCH',
    'CONFIG',
    `rclnodejs API mismatch: ${message}`,
    {
      details: {
        hint: 'This adapter targets the documented rclnodejs ActionClient surface; verify your installed version or provide a custom loader.',
      },
    },
  );
}

function mapGoalOutcome(raw: unknown): {
  status: 'SUCCEEDED' | 'CANCELED' | 'ABORTED';
  error?: string;
} {
  const record = isRecord(raw) ? raw : undefined;
  const status = record?.status;
  if (status === 'SUCCEEDED' || status === 'CANCELED' || status === 'ABORTED') {
    return { status };
  }
  const numeric = typeof status === 'number' ? status : readNumber(status);
  if (numeric === 4) return { status: 'SUCCEEDED' };
  if (numeric === 5) return { status: 'CANCELED' };
  if (numeric === 6) return { status: 'ABORTED' };
  return { status: 'ABORTED', error: `Unexpected ROS 2 goal status ${String(status)}.` };
}

function mapCancelReturnCode(value: unknown): RosCancelCode {
  const numeric = typeof value === 'number' ? value : readNumber(value);
  switch (numeric) {
    case 0:
      return 'ERROR_NONE';
    case 1:
      return 'ERROR_REJECTED';
    case 2:
      return 'ERROR_UNKNOWN_GOAL_ID';
    case 3:
      return 'ERROR_GOAL_TERMINATED';
    default:
      return 'ERROR_REJECTED';
  }
}

function readCancelGoalIds(record: Record<string, unknown> | undefined): string[] | undefined {
  if (!record) return undefined;
  const raw = record.goals_canceling ?? record.goalsCanceling;
  if (!Array.isArray(raw)) return undefined;
  const ids: string[] = [];
  for (const entry of raw) {
    const id = normalizeGoalId(entry);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

function normalizeGoalId(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return `goal_${value}`;
  if (value instanceof Uint8Array) return value.length > 0 ? bytesToHex(value) : undefined;
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    const bytes: number[] = [];
    for (const entry of value) {
      if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > 255) {
        return undefined;
      }
      bytes.push(entry);
    }
    return bytesToHex(Uint8Array.from(bytes));
  }
  if (isRecord(value)) {
    const inner = normalizeGoalId(value.uuid);
    if (inner !== undefined) return inner;
    if (typeof value.toString === 'function') {
      const text = String(value);
      if (text.length > 0 && text !== '[object Object]') return text;
    }
  }
  return undefined;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(onTimeout());
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const numbers: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return undefined;
    numbers.push(entry);
  }
  return numbers;
}

function readVec3(value: unknown): CartesianPose | undefined {
  if (!isRecord(value)) return undefined;
  const x = readNumber(value.x);
  const y = readNumber(value.y);
  const z = readNumber(value.z);
  if (x === undefined || y === undefined || z === undefined) return undefined;
  return { x, y, z };
}

function readControllerTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!isRecord(value)) return undefined;
  const sec = readNumber(value.sec ?? value.secs);
  const nanosec = readNumber(value.nanosec ?? value.nsecs);
  if (sec === undefined || nanosec === undefined) return undefined;
  return Math.round(sec * 1000 + nanosec / 1e6);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
