# Integration notes — @pinout/ros2-sidecar

This file records repository-level wiring that the ros2-sidecar package owner
cannot apply (files outside `packages/ros2-sidecar/**` live under other owners),
plus the intended peer-dependency metadata for the optional `rclnodejs`
transport. Nothing here is applied to the repository by this package; it is a
proposal for the integration pass.

## 1. Optional peer dependency (`rclnodejs`)

`rclnodejs` must stay **optional**. The transport loads it lazily through
`RclnodejsTransportOptions.loader` (default: `await import('rclnodejs')`) and
reports the structured `RCLNODEJS_UNAVAILABLE` error when the module cannot be
resolved. Proposed metadata for `packages/ros2-sidecar/package.json`:

```json
{
  "peerDependencies": {
    "rclnodejs": "^0.28"
  },
  "peerDependenciesMeta": {
    "rclnodejs": {
      "optional": true
    }
  },
  "devDependencies": {
    "rclnodejs": "^0.28"
  }
}
```

Notes:

- The version range is a placeholder. Pin it against the ROS 2 distro actually
  deployed; rclnodejs tracks ROS 2 distributions closely. Do **not** add it to
  `dependencies` — a hard dependency would break installs in non-ROS
  environments and in this workspace (no native build toolchain).
- The `devDependencies` entry is only useful in a ROS 2-provisioned CI runner;
  this workspace's dependency set is intentionally minimal and zero-runtime-dep.
- Deliberately **not** added by this package: no `package.json` changes were
  made. Apply the metadata above during integration if a real rclnodejs install
  is desired.
- `RclnodejsModuleLike`/`RclnodejsNodeLike`/`RclnodejsActionClientLike` describe
  the structural seam and are the mechanism by which a fake module (tests) or a
  pinning wrapper (production) can be injected without compiling against
  rclnodejs types. `packages/ros2-sidecar/src/rclnodejsTransport.ts` contains
  the single `@ts-expect-error` import point for the absent optional peer.

## 2. ROS 2 environment requirements (for the embedder, not this repo)

- ROS 2 distro + `rclnodejs` installed and `source`d in the application that
  embeds the sidecar.
- An action server matching the configured `actionType`/`actionTopic`
  (defaults `cartesian_control_msgs/action/MoveToPose` and
  `/arm_controller/move_to_pose`, aligned with `docs/ros2-sidecar.md` §3).
- Feedback fields expected by `defaultFeedbackMapper`: `fraction`,
  `current_position` `{x,y,z}`, `joint_positions[]`, `joint_velocities[]`,
  `frame`, and `controller_timestamp` (ms number or ROS `{sec, nanosec}`).
  If the deployed action definition differs, supply a custom `feedbackMapper`
  and expect `RCLNODEJS_FEEDBACK_UNMAPPABLE` diagnostics otherwise.
- The controller must own real-time limits, protective stops, collision
  reflexes, and executor scheduling. This sidecar is not a safety controller.

## 3. Root TypeScript project references (new packages)

Not yet registered in the root `tsconfig.json`. Proposed additions to the
`references` array:

```json
{ "path": "packages/protocols-ur" },
{ "path": "packages/protocols-dynamixel" }
```

`packages/protocols-ur` and `packages/protocols-dynamixel` each:
- extend `../../tsconfig.base.json` with `composite: true`, `rootDir: src`,
  `outDir: dist`, and `references: [{ "path": "../core" }]`;
- declare only `@pinout/core: "0.0.1-alpha.1"` as a dependency (zero runtime
  deps beyond core);
- need workspace/`package-lock.json` entries if the workspace uses lockfile
  catalog resolution for members (nothing added by this package).

Also consider adding corresponding entries to CI matrices that iterate
`packages/*` — no CI changes were made here.

## 4. Hardware catalog / discovery (optional, later)

`hardware/catalog.json` does not yet describe a UR arm or a DYNAMIXEL bus.
If/when the integration pass wants these visible to discovery, propose:

- UR arm devices: `deviceClass: "robot.manipulator"` (matching the sidecar's
  device class), manufacturer `Universal Robots`, connection `tcp` on ports
  29999 (dashboard), 30004 (RTDE), 30002 (secondary/URScript, if used).
- DYNAMIXEL buses: `deviceClass: "actuator.servo"`, connection `serial` with
  baud rate + protocol version (2.0 only).

No catalog changes were made by this package.

## 5. Cross-package API expectations

- `@pinout/core` `Transport` is the only cross-package runtime contract used by
  the UR and DYNAMIXEL packages (`open/close/write/readable` + `kind`).
  No core changes are required.
- `ros2-sidecar` continues to expose the `RosActionTransport` interface; the
  rclnodejs transport is an additional implementation. No core changes needed.

## 6. Open items to resolve during real integration

1. Confirm the exact rclnodejs `ActionClient` construction convention for the
   deployed version (`new ActionClient(node, type, topic)` vs
   `node.createActionClient(type, topic)`) — both paths are supported by the
   adapter, but only one will be hit in practice.
2. Confirm whether the installed rclnodejs requires `spin()` to be called by
   the embedder (`manageSpin: false`) because the embedding app owns the
   executor. With `manageSpin: true` and no spin capability, the adapter fails
   fast with `RCLNODEJS_API_MISMATCH`.
3. Decide the production `livenessIntervalMs`/timeouts for the deployment; the
   defaults are conservative but not tuned to a specific controller.
4. The action definition default is aligned to `docs/ros2-sidecar.md` §3
   (`cartesian_control_msgs/action/MoveToPose`). The earlier skeleton used
   `FollowJointTrajectory` defaults; the change was made deliberately and is
   flagged in the delivery report.
