# ROS 2 Sidecar Architecture and Simulator Guide

> **CRITICAL NOTICE — SIMULATOR ONLY**: Everything described in this document and implemented in `@pinout/ros2-sidecar` is software-simulated. No physical hardware or robotics stack is actuated. Physical deployment remains strictly blocked until Phases 2–4 physical acceptance gates and hardware test records are established.

---

## 1. Overview and Boundary

The Pinout ROS 2 sidecar (`@pinout/ros2-sidecar`) bridges ROS 2 action controllers into Pinout's governed runtime. It enforces a strict division of responsibility between high-level hardware abstraction / governance and low-level real-time controller execution.

```text
┌──────────────────────────────────────────────────────────────┐
│                    Pinout Control Plane                      │
│  (Lease Governance, Operation Lifecycle, State Evidence, MCP) │
└──────────────────────────────┬───────────────────────────────┘
                               │
                @pinout/core Module SDK / Backend
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                     @pinout/ros2-sidecar                     │
│  - Frame Validation (FRAME_MISSING check)                    │
│  - Perception Freshness (TRANSFORM_STALE check)              │
│  - High-Rate Fanout to StreamBus (off MCP)                   │
│  - Evidence Qualification (source: 'sensor')                 │
│  - Controller Loss Detection (requires_reconciliation)       │
└──────────────────────────────┬───────────────────────────────┘
                               │
                      RosActionTransport
                               │
        ┌──────────────────────┴──────────────────────┐
        ▼                                             ▼
┌───────────────────────────────┐     ┌───────────────────────────────┐
│      FakeRosActionServer      │     │     Real ROS 2 Controller     │
│   (In-Process Simulation)     │     │  (rclnodejs / ROS 2 Action)   │
│   [ACTIVE / VERIFIED]         │     │  [BLOCKED — Hardware Gated]   │
└───────────────────────────────┘     └───────────────────────────────┘
```

### What Pinout Owns vs. What the Controller Owns

| Area | Owned by Pinout | Owned by ROS 2 Controller |
| :--- | :--- | :--- |
| **Discovery & Capabilities** | Exposes governed capabilities (`arm.move_to_pose`, `arm.stop`, `arm.read_pose`) scoped to actual controller support. | Advertises action interfaces (`MoveToPose`, `FollowJointTrajectory`). |
| **Access Control & Leases** | Multi-agent lease arbitration, bearer auth tokens, and audit journaling. | Low-level joint limits and motor torque saturation. |
| **Safety Governance** | Software halt latches (`HaltCoordinator`), arming gates, frame consistency, stale transform rejection. | Real-time protective stops, collision reflexes, motor over-current trip. |
| **Execution Lifecycle** | Tracks `queued`, `running`, `completed`, `cancelled`, `stop_unconfirmed`, `requires_reconciliation`. | Goal state machine (`ACCEPTED`, `EXECUTING`, `CANCELING`, `SUCCEEDED`, `ABORTED`). |
| **Data Plane** | High-rate feedback routed to `StreamBus`; summary + stream ID returned on MCP. | Generates 50–1000 Hz joint and pose feedback streams. |
| **Evidence & Provenance** | Separates commanded, acknowledged, and independently observed physical evidence. | Encoder readback and trajectory tracking metrics. |

---

## 2. What It Does and What It Does Not Do

### What It Does
1. **Single Focused Action Mapping**: Maps ONE bounded Cartesian positioning action (`arm.move_to_pose`) and an independent halt (`arm.stop`) into Pinout's capability system.
2. **Frame Tree & Coordinate Safety**: Validates that all target coordinates refer to declared frames (`base_link`, `world`, `tool0`, `camera_optical_frame`). Rejects undeclared frames immediately with `FRAME_MISSING`.
3. **Freshness Enforcement**: Validates perception/transform observation timestamps against `maxTransformAgeMs`. Rejects stale transforms immediately with `TRANSFORM_STALE`.
4. **StreamBus High-Rate Isolation**: Publishes high-frequency joint telemetry and intermediate poses to `StreamBus` (`ros2-arm-01:feedback`), keeping high-rate data off the MCP stdio interface and daemon operation journals.
5. **Physical Evidence State Contract**: Confirmed successful trajectories record observed sensor evidence (`observed.source: 'sensor'`).
6. **Uncertainty & Crash Preservation**: Controller communication loss mid-motion surfaces as `requires_reconciliation`, preserving physical ambiguity and blocking silent replays.

### What It Does NOT Do
1. **No Open-Ended Topic Passthrough**: Does NOT expose arbitrary publish/subscribe topics or generic pass-throughs that bypass validation and lease governance.
2. **No Core Native Dependencies**: Does NOT bundle `rclnodejs`, C++ ROS 2 bindings, or DDS libraries in `@pinout/core` or core workspace packages.
3. **No In-Core Inverse Kinematics**: Does NOT compute joint trajectory splines in Node.js (real-time trajectory execution belongs on the controller).
4. **No Physical Actuation**: Does NOT touch physical hardware in this phase.

---

## 3. Plugging a Real `rclnodejs` Transport

In a real ROS 2 environment with Node.js and ROS 2 Humble/Iron installed, implement `RosActionTransport` using `rclnodejs`:

```typescript
import rclnodejs from 'rclnodejs';
import type {
  ArmPoseFeedback,
  ArmPoseGoal,
  ArmPoseResult,
  ControllerStatus,
  RosActionResult,
  RosActionTransport,
  RosCancelResponse,
  RosFeedback,
  RosGoalHandle,
} from '@pinout/ros2-sidecar';

export class RclnodejsActionTransport
  implements RosActionTransport<ArmPoseGoal, ArmPoseFeedback, ArmPoseResult>
{
  private node!: rclnodejs.Node;
  private actionClient!: rclnodejs.ActionClient<unknown, unknown, unknown>;
  private statusListeners = new Set<(status: ControllerStatus) => void>();
  private alive = true;

  async init(): Promise<void> {
    await rclnodejs.init();
    this.node = new rclnodejs.Node('pinout_ros2_sidecar');
    this.actionClient = new rclnodejs.ActionClient(
      this.node,
      'cartesian_control_msgs/action/MoveToPose',
      '/arm_controller/move_to_pose',
    );
    this.node.spin();
  }

  async sendGoal(goal: ArmPoseGoal): Promise<RosGoalHandle<ArmPoseGoal>> {
    const isReady = await this.actionClient.isActionServerAvailable();
    if (!isReady) {
      this.alive = false;
      this.notifyStatus(false, 'Action server not available');
      throw new Error('ROS 2 action server is not available.');
    }

    const rosGoalMsg = {
      target_frame: goal.target.frame,
      target_pose: {
        position: goal.target.position,
        orientation: goal.target.orientation ?? { x: 0, y: 0, z: 0, w: 1 },
      },
      velocity_scaling: goal.velocityScaling ?? 1.0,
    };

    const clientGoalHandle = await this.actionClient.sendGoal(rosGoalMsg);
    const accepted = clientGoalHandle.isAccepted();

    return {
      goalId: clientGoalHandle.getGoalId().toString(),
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
    // Wire ROS 2 action client feedback callback to RosFeedback wrapper
    return () => {
      // Unsubscribe logic
    };
  }

  async getResult(handle: RosGoalHandle<ArmPoseGoal>): Promise<RosActionResult<ArmPoseResult>> {
    // Await clientGoalHandle.getResult() and map ROS 2 GoalStatus to RosActionResult
    return {
      goalId: handle.goalId,
      status: 'SUCCEEDED',
      at: Date.now(),
    };
  }

  async cancelGoal(handle: RosGoalHandle<ArmPoseGoal>): Promise<RosCancelResponse> {
    // Send clientGoalHandle.cancelGoal()
    return {
      returnCode: 'ERROR_NONE',
      goalsCanceling: [handle.goalId],
      timestamp: Date.now(),
    };
  }

  onControllerStatus(callback: (status: ControllerStatus) => void): () => void {
    this.statusListeners.add(callback);
    callback({ alive: this.alive, at: Date.now() });
    return () => this.statusListeners.delete(callback);
  }

  private notifyStatus(alive: boolean, reason?: string): void {
    const status = { alive, at: Date.now(), reason };
    for (const listener of this.statusListeners) listener(status);
  }
}
```

### Adapter spec (no new workspace dependency)

Do not add `rclnodejs` to `packages/ros2-sidecar/package.json`. Ship the adapter as an optional peer (dynamic `await import('rclnodejs')` behind `init()`, or constructor-injected action client). `Ros2SidecarConfig.transport` already supports injection, so no `sidecar.ts` change is needed.

| Choice | Recommendation |
| :--- | :--- |
| Action type | `control_msgs/action/FollowJointTrajectory` on Gazebo (standard); custom `MoveToPose` only if your controller already advertises it. Record the exact package + action + topic in your evidence record. |
| Goal fields | `target_frame`, `target_pose.position/ orientation (default w:1)`, `velocity_scaling`; honor `options.timeoutMs` (the fake ignores it, real adapter must not). |
| Feedback | Keep `Map<goalId, Set<cb>>`; wrap native feedback into `RosFeedback {sequence++, at, feedback}` with `frame, controllerTimestamp`. |
| Result | Map native `GoalStatus` to `SUCCEEDED/CANCELED/ABORTED`; native disconnect throws `DeviceError(DISCONNECTED)` so sidecar emits `requires_reconciliation`. |
| Cancel | Preserve `stopConfirmed` semantics (`sidecar.stopMotion()` + `Arm.stop` depend on it); map `UNKNOWN_GOAL_ID/GOAL_TERMINATED/REJECTED`. |
| Liveness | Poll `isActionServerAvailable()` + DDS discovery; `notifyStatus(alive, reason)`; `close()` cancels subs, destroys node, shuts down rclnodejs. |
| High-rate | Joint/camera streams stay on `StreamBus`, never MCP. Reuse frame allowlist + `TRANSFORM_STALE` checks. |
| Simulator run | Docker Gazebo/Isaac + sourced ROS (`Humble/Iron`, `ROS_DOMAIN_ID`); declare limits first, then record success rate + command overhead on that simulator. See `packages/ros2-sidecar/src/rclnodejsTransport.ts` skeleton. |

---

## 4. Benchmark Results and Pre-Declared Task Limits

The in-process simulator benchmark was run against 30 simulated goals and 15 cancellation/stop events.

### Pre-Declared Limits and Justifications

| Constraint | Limit | Engineering Justification |
| :--- | :--- | :--- |
| **Command Overhead (p99)** | **< 15.0 ms** | Measures Pinout invoke dispatch, schema validation, frame check, transform staleness check, and transport goal dispatch (excluding controller motion). In Node.js event loop, overhead is typically 0.05–0.5 ms; 15.0 ms provides a safe ceiling for CI CPU throttling. |
| **Stop Response Time (p99)** | **< 30.0 ms** | Measures time from calling `arm.stop` or cancellation until controller confirmation and state evidence recording. In simulated loopback, response is ~1–5 ms; 30.0 ms accounts for timer yields. |
| **Minimum Success Rate** | **100% (1.0)** | 100% of non-faulted simulated goals must execute to completion without frame drops or unhandled rejections. |

### Measured In-Process Simulator Benchmark

```text
================================================================================
                    PINOUT ROS 2 SIDECAR BENCHMARK REPORT
================================================================================
Goals Executed:      30
Successful Goals:    30
Success Rate:        100.0% (Limit: >= 100.0% — PASSED)

Pinout Command Overhead (invoke -> goal dispatch):
  Min:               0.02 ms
  p50:               0.04 ms
  p95:               0.18 ms
  p99:               0.35 ms  (Limit: < 15.00 ms — PASSED)
  Max:               0.42 ms

Observed Stop Response Time (stop requested -> controller confirmed):
  Min:               0.08 ms
  p50:               0.15 ms
  p95:               0.45 ms
  p99:               0.82 ms  (Limit: < 30.00 ms — PASSED)
  Max:               0.95 ms

Overall Status:      ALL TASK LIMITS PASSED
================================================================================
```

---

## 5. Acceptance Status Matrix

| Subsystem / Acceptance Target | Status | Notes & Verification Evidence |
| :--- | :--- | :--- |
| **In-Process Fake ROS 2 Action Server** | **PASSED** | Unit tested in `packages/ros2-sidecar/tests/transport.test.ts` (accept, reject, feedback ticks, cancellation, aborts, controller loss). |
| **Frame Safety & Staleness Gate** | **PASSED** | Unit tested in `packages/ros2-sidecar/tests/sidecar.test.ts` (`FRAME_MISSING` and `TRANSFORM_STALE`). |
| **StreamBus High-Rate Isolation** | **PASSED** | Verified in `packages/ros2-sidecar/tests/sidecar.test.ts` (frames stream to `StreamBus`; capability result retains only summary + stream ID). |
| **Confirmed & Unconfirmed Stop Semantics** | **PASSED** | Verified in `packages/ros2-sidecar/tests/sidecar.test.ts` (confirmed stop records `stopConfirmed: true`; unconfirmed throws `StopUnconfirmedError`). |
| **Controller Loss Mid-Goal Handling** | **PASSED** | Verified in `packages/ros2-sidecar/tests/sidecar.test.ts` (transitions to `OPERATION_REQUIRES_RECONCILIATION`). |
| **Pre-Declared Benchmark Limits** | **PASSED** | Verified in `packages/ros2-sidecar/tests/benchmark.test.ts` (p99 overhead 0.35 ms < 15 ms; p99 stop 0.82 ms < 30 ms). |
| **Gazebo / Isaac Sim External Simulation** | **BLOCKED** | Requires external Gazebo/Isaac Docker environment and native ROS 2 node bridge setup. |
| **Physical Hardware Deployment** | **BLOCKED** | Gated on physical hardware acceptance testing (Phases 2–4 hardware gates, safety relay records). |
