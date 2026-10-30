# @pinout/ros2-sidecar

Narrow ROS 2 sidecar mapping robot actions to Pinout operations, feedback streams, and controller-confirmed evidence.

> **Status: SIMULATION-FIRST**: The exercised path in this package is the
> in-process simulator (`FakeRosActionServer`). A real `rclnodejs`-backed
> transport is implemented but has **never been executed against a live ROS 2
> graph** — see "Real ROS 2 transport" below. Physical testing remains BLOCKED /
> PENDING Phase 2–4 hardware gates.

## Overview

`@pinout/ros2-sidecar` maps bounded ROS 2 action executions (such as Cartesian arm positioning `arm.move_to_pose` and independent halt `arm.stop`) into Pinout's governed runtime:

- **Transport Abstraction**: `RosActionTransport` defines zero-dependency ROS 2 action semantics (`action_msgs`).
- **In-Process Simulator**: `FakeRosActionServer` models goal handles, progress feedback, controller loss, cancel acceptance, and abort injection.
- **Frame & Freshness Safety**: Strictly rejects missing coordinate frames (`FRAME_MISSING`) and stale perception transforms (`TRANSFORM_STALE`).
- **Stream Bus Integration**: High-rate trajectory feedback (50 Hz+) streams over `@pinout/core`'s `StreamBus`, keeping high-rate frames off the MCP/daemon control plane.
- **Physical Evidence**: Distinguishes commanded intent, acknowledgement, and controller-confirmed sensor evidence.
- **Uncertainty Preservation**: Controller loss mid-motion transitions to `requires_reconciliation`, preventing silent replays.

## Installation & Usage

```typescript
import { PinoutRuntime } from '@pinout/core';
import {
  createRos2SidecarBackend,
  FakeRosActionServer,
  ros2SidecarModule,
} from '@pinout/ros2-sidecar';

const transport = new FakeRosActionServer();
const backend = createRos2SidecarBackend({ transport });

const runtime = new PinoutRuntime();
runtime.registerModule(ros2SidecarModule);

const device = await runtime.registerDevice({
  id: 'arm-01',
  moduleId: ros2SidecarModule.id,
  backend,
});

const result = await device.invoke('arm.move_to_pose', {
  target: {
    frame: 'base_link',
    position: { x: 0.35, y: 0.15, z: 0.45 },
  },
  transformAt: Date.now(),
});
```

## Real ROS 2 transport (`rclnodejs`)

> **Status: IMPLEMENTED — NEVER EXERCISED against a live ROS 2 graph or a real
> `rclnodejs` installation.** The adapter is written against the documented
> `rclnodejs` action-client surface. Everything shipped in this repository is
> behavior-tested against the in-process fake module only. Treat the first
> integration run as bring-up, not as validation.

`rclnodejs` is deliberately **not** a dependency of this package. It is loaded
lazily through a dependency-injection seam, and a structured
`RCLNODEJS_UNAVAILABLE` error is raised when it cannot be loaded:

```typescript
import { createRclnodejsTransport, createRos2SidecarBackend } from '@pinout/ros2-sidecar';

// Default loader: `await import('rclnodejs')`. Requires rclnodejs to be
// installed by the embedding (ROS 2) application; this workspace never
// installs or bundles it.
const transport = createRclnodejsTransport({
  nodeName: 'pinout_ros2_sidecar',
  actionType: 'cartesian_control_msgs/action/MoveToPose',
  actionTopic: '/arm_controller/move_to_pose',
});

const backend = createRos2SidecarBackend({
  transport,
  // The sidecar's safety gates (frames, freshness, workspace bounds, including
  // the default `[-1, 1] x [-1, 1] x [0, 1.5]` envelope) apply before a goal
  // reaches this transport. Widen/limit explicitly for a real robot.
});

// Tests and custom embeddings can pass their own module through the same seam:
const testTransport = createRclnodejsTransport({
  loader: async () => fakeRclnodejsModule,
});
```

Initialization is lazy (first `sendGoal()` or an explicit `init()`), idempotent
and sticky: a failed initialization is reported identically on later calls, and
recovery requires a new transport instance. Controller liveness is derived from
`ActionClient#isActionServerAvailable()` polling (`livenessIntervalMs`, default
1000 ms; `0` disables) and is surfaced through
`onControllerStatus`/`controller.lost`/`controller.recovered`.

### Defaults

| Option | Default | Notes |
| --- | --- | --- |
| `nodeName` | `pinout_ros2_sidecar` | |
| `actionType` | `cartesian_control_msgs/action/MoveToPose` | Override for your stack's action definition. |
| `actionTopic` | `/arm_controller/move_to_pose` | |
| `manageSpin` | `true` | Calls `node.spin()` (or `module.spin(node)`); pass `false` when the embedding owns its executor. |
| `livenessIntervalMs` | `1000` | `0` disables availability polling. |
| `sendGoalTimeoutMs` | `10000` | Bounds goal acceptance. `0` disables. |
| `resultTimeoutMs` | `120000` | Bounds the result wait. `0` disables. |

### Error codes

Transport-level failures are `PinoutStructuredError`s and surface to callers as
`CONTROLLER_COMMUNICATION_ERROR` (send path) or pass through unchanged:

| Code | Category | Meaning |
| --- | --- | --- |
| `RCLNODEJS_UNAVAILABLE` | `CONFIG` | `rclnodejs` could not be loaded; install it in a ROS 2 environment or provide a `loader`. |
| `RCLNODEJS_API_MISMATCH` | `CONFIG` | The loaded module does not match the expected `Node`/`ActionClient` surface, or no spin capability exists with `manageSpin: true`. |
| `RCLNODEJS_INIT_FAILED` | `TRANSPORT` | `rclnodejs.init()` or node construction failed. |
| `RCLNODEJS_ACTION_SERVER_UNAVAILABLE` | `DEVICE` | No action server on the configured topic (`DEVICE`, so callers can distinguish "robot absent" from "code wrong"). |
| `RCLNODEJS_SEND_TIMEOUT` | `TIMEOUT` | The action server did not answer `sendGoal` within `sendGoalTimeoutMs`. |
| `RCLNODEJS_GOAL_SEND_FAILED` | `TRANSPORT` | `sendGoal` rejected natively. |
| `RCLNODEJS_GOAL_TIMEOUT` | `TIMEOUT` | No result within `resultTimeoutMs`. **The goal is not cancelled automatically**; details carry `stopConfirmed: false`, and the sidecar's state stays unconfirmed. |

A transport loss *while waiting for the result* is reported as
`DeviceError('DISCONNECTED')`, which `Ros2Sidecar` converts into
`OPERATION_REQUIRES_RECONCILIATION` (`stopConfirmed: false`) — the same
uncertainty semantics as the simulated controller-loss path.

Non-fatal conditions are reported through `onDiagnostic` (`RCLNODEJS_` codes):
unmappable feedback frames, feedback backlog overflow, feedback after result,
feedback handler errors, unsupported `cancelGoal`, unknown cancel codes, and
shutdown errors.

### Feedback mapping

Raw feedback messages are mapped by `defaultFeedbackMapper`, which accepts the
action feedback envelope (`{ goal_id, feedback }`) or the inner payload with
snake_case/camelCase fields (`fraction`, `current_position`, `joint_positions`,
`joint_velocities`, `frame`, `controller_timestamp`). A frame missing any
required field is **dropped with a diagnostic** rather than filled with zeroes.
Provide `feedbackMapper` for your message layout.

### Package-local integration notes

`INTEGRATION_NOTES.md` in this package records the intended
`optionalPeerDependencies` metadata and the remaining repo wiring that must be
applied outside this package.
