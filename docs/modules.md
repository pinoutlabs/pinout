# Pinout modules

A **module** describes support for a device class. A **device instance** is a concrete connected or simulated device registered with the runtime.

## Module vs device instance

| Concept | Describes |
| --- | --- |
| **Module** | Metadata, capability catalog, policies, supported transports, backend factory |
| **Device instance** | Stable id, live backend, health, operational state, session to hardware or simulator |

```text
Module (pinout/esp32)
  ├── device class: microcontroller
  ├── capabilities: gpio.*, sys.*
  ├── policies: ESP32 pin rules (via existing Device validation)
  └── factory: protocol transport → Session → Device

Device instance (esp32-01)
  ├── id: esp32-01
  ├── module: pinout/esp32
  ├── backend: protocol or simulated
  └── state: firmware identity + GPIO levels
```

## Built-in modules (Sprint 2+)

| Module id | Device class | Backend |
| --- | --- | --- |
| `pinout/esp32` | `microcontroller` | Serial / simulated ESP32 (protocol v1) |
| `pinout/robot-arm` | `robot.manipulator` | In-process simulator |
| `pinout/environmental-chamber` | `lab.environmental_chamber` | In-process simulator |
| `pinout/dc-motor` | `actuator.dc_motor` | In-process simulator |
| `pinout/servo` | `actuator.servo` | In-process simulator |
| `pinout/stepper` | `actuator.stepper` | In-process simulator |
| `pinout/distance` | `sensor.distance` | In-process simulator |
| `pinout/imu` | `sensor.imu` | In-process simulator |
| `pinout/encoder` | `sensor.encoder` | In-process simulator |
| `pinout/limit-switch` | `sensor.limit_switch` | In-process simulator |
| `pinout/force` | `sensor.force` | In-process simulator |
| `pinout/mobile-base` | `robot.mobile_base` | In-process simulator |
| `pinout/relay` | `actuator.relay` | In-process simulator |
| `pinout/valve` | `actuator.valve` | In-process simulator |
| `pinout/pump` | `actuator.pump` | In-process simulator |
| `pinout/power-supply` | `supply.power` | In-process simulator |
| `pinout/lamp` | `actuator.lamp` | Commissioned GPIO over ESP32 / in-process simulator |
| `pinout/pan-tilt` | `actuator.pan_tilt` | Commissioned 1–2 hobby servos over ESP32 `gpio.servo` / in-process simulator |

## Multi-driver devices

`createCompositeDevice()` presents several independently managed backends as one policy-enforced device. Every public capability must have exactly one explicit route, duplicate capability names are rejected, and driver events carry the originating driver name.

```ts
import {
  createCompositeDevice,
  createSimulatedPumpBackend,
  createSimulatedRelayBackend,
  pumpModule,
  relayModule,
} from '@pinout/core';

const rig = createCompositeDevice({
  id: 'fluid-rig-01',
  moduleId: 'example/fluid-rig',
  deviceClass: 'system.fluid_rig',
  drivers: {
    pump: createSimulatedPumpBackend(),
    contactor: createSimulatedRelayBackend(),
  },
  capabilities: [
    ...pumpModule.capabilities,
    relayModule.capabilities.find((capability) => capability.name === 'relay.set')!,
  ],
  routes: {
    'pump.set': { driver: 'pump' },
    'pump.stop': { driver: 'pump' },
    'pump.read': { driver: 'pump' },
    'status.read': { driver: 'pump' },
    'relay.set': { driver: 'contactor' },
  },
});
```

Composition is capability routing, not a real-time transaction coordinator. Cross-driver atomicity, certified stops, and distributed rollback remain deployment concerns.

## External modules (Sprint 3)

Third-party modules use the public SDK:

```ts
import { defineModule, action } from '@pinout/core';

export default defineModule({ /* ... */ });
```

Manifest: `pinout.module.json`. Install locally with `pinout module install ./path`. See [build-a-module.md](build-a-module.md).

Built-in and installed modules share the same registry interface (`listAvailableModules`, `ensureModuleLoaded`).

## Module registry (offline-first)

Modules can be distributed through a registry: a strictly validated JSON index
plus content-hash (and optional Ed25519) verification. Local directories are
first-class registries — no server is required — and HTTPS indexes are
supported through the same client. Pack, publish, search, install, verify, and
produce machine-readable L0–L5 conformance reports with
`pinout module pack|publish|search|info|install|verify|conformance`.

See [registry.md](registry.md) for the index format and trust model, and
[`packages/registry/README.md`](../packages/registry/README.md) for the API.

## Registering devices

### Programmatic

```ts
import { PinoutRuntime, robotArmModuleId } from '@pinout/core';

const runtime = new PinoutRuntime();
await runtime.registerFromModule(robotArmModuleId, {
  id: 'arm-sim-01',
  simulated: true,
});
await runtime.invoke('arm-sim-01', 'motion.home', {});
```

Or bootstrap from persistent config:

```ts
const runtime = await PinoutRuntime.fromConfig();
// loads ~/.pinout/devices.json + installed modules
```

Or use `createHeterogeneousRuntime()` for the in-memory lab demo (ESP32 + arm + chamber), or `createRoboticsWorkbench()` for the full first-party parts set.

## Semantic capability families

Capabilities use dotted names grouped by physical semantics:

- `gpio.*` — digital I/O (microcontrollers)
- `motion.*`, `gripper.*`, `pose.*` — manipulators
- `motor.*` — DC motors
- `servo.*` — hobby servos (simple simulated single axis)
- `panTilt.*` — desk pan-tilt mounts (1–2 hobby servos, arm/disarm + safe angles)
- `stepper.*` — stepper motors
- `distance.*` — rangefinders
- `imu.*` — inertial measurement units
- `encoder.*` — quadrature encoders
- `limit.*` — end-stops / limit switches
- `force.*` — load cells / force sensors
- `drive.*` — mobile bases / differential drive
- `relay.*` — electrical contacts
- `lamp.*` — illumination and indicator actuation (`lamp.arm`, `lamp.disarm`, `lamp.on`, `lamp.off`, `lamp.set`, `lamp.status`)
- `valve.*` — proportional flow control
- `pump.*` — pump speed and stop
- `power.*` — programmable supply configuration and output enable
- `temperature.*`, `door.*`, `experiment.*` — environmental chambers
- `temperature.*`, `humidity.*` — sensors (external modules)
- `status.*`, `sys.*` — diagnostics shared across classes

Implementation-specific details stay in module backends. The runtime and policy layer only see capability names and schemas.

## Extending

1. Run `pinout module create <name>` or copy [examples/external-module/weird-sensor](../examples/external-module/weird-sensor) / [room-sensor](../examples/external-module/room-sensor).
2. Implement capabilities with `defineModule` / `action` helpers.
3. Add `pinout.module.json` and build to `dist/`.
4. `pinout module test .` then `pinout module install .`
5. `pinout device add <id> --module <moduleId>`
6. Devices appear in runtime, MCP, and `pinout invoke` automatically.

**Generated candidates (Sprint 4):** `pinout generate ./vendor-sdk --output ./generated/device` produces an unverified module using the same SDK surface. See [generator.md](generator.md).

Legacy in-process extension: `registerModule()` still works for tests.
