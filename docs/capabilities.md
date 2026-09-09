# Capability catalog

Pinout devices expose **capabilities** — named actions with JSON Schema inputs/outputs and safety annotations. Hosts call them through `device.invoke()` or convenience facades like `device.gpio.write()`.

The catalog below matches `@pinout/core` descriptors and the ESP32 bridge firmware. Simulator and hardware implement the same action names.

## A read-only capability in the simulator

Capability descriptors keep the input/output contract and safety metadata next
to the name and description. This complete example defines a harmless sensor
read, registers it with an in-process simulator, and invokes it:

```ts
import { PinoutRuntime, action, defineModule } from '@pinout/core';

const lightRead = action({
  id: 'light.read',
  description: 'Read simulated illuminance in lux.',
  input: { type: 'object', additionalProperties: false, properties: {} },
  output: {
    type: 'object',
    additionalProperties: false,
    properties: { lux: { type: 'number', minimum: 0 }, unit: { type: 'string', enum: ['lux'] } },
    required: ['lux', 'unit'],
  },
  safety: {
    physicalOutput: false,
    reversible: true,
    notes: 'Read-only simulated measurement.',
  },
});

const lightModule = defineModule({
  id: 'example/light-sensor',
  version: '0.1.0',
  device: { class: 'sensor.light', vendor: 'Example' },
  capabilities: [lightRead],
  createBackend: () => ({
    kind: 'simulated' as const,
    invoke: async (capability: string) => {
      if (capability !== 'light.read') throw new Error(`Unknown capability: ${capability}`);
      return { lux: 120, unit: 'lux' };
    },
    close: async () => undefined,
    subscribe: () => () => undefined,
  }),
});

const runtime = new PinoutRuntime();
await runtime.registerModuleDevice(lightModule, { id: 'light-sim-01', simulated: true });
console.log(await runtime.invoke('light-sim-01', 'light.read', {}));
await runtime.close();
```

The `input` and `output` values are standard JSON Schema. `physicalOutput:
false` marks the capability as read-only, while `simulated: true` makes the
device provenance explicit. The reading is simulator output, not a physical
measurement. See the [capability specification](spec/capabilities.md) and
[module guide](build-a-module.md) for the shared contracts.

## System

### `sys.hello`

Handshake with the device and return firmware identity, supported capabilities, and advertised feature flags.

| | |
| --- | --- |
| Input | `{}` |
| Output | `{ firmware, version, protocol, capabilities, features? }` |
| Safety | Read-only |

Also emitted unsolicited as the `ready` event payload after the transport opens.

### `sys.ping`

Round-trip liveness check.

| | |
| --- | --- |
| Input | `{}` |
| Output | `{ pong: true }` |
| Safety | Read-only |

### `sys.info`

Runtime diagnostics (uptime; free heap on hardware, stubbed on simulator).

| | |
| --- | --- |
| Input | `{}` |
| Output | `{ uptimeMs, freeHeap? }` |
| Safety | Read-only |

### `sys.arm`

Explicitly arm the device for physical actuation and configure/reset the watchdog timer.

| | |
| --- | --- |
| Input | `{ timeoutMs? }` |
| Output | `{ armed: true, state: "armed", timeoutMs }` |
| Safety | Arming gate (non-physical) |

### `sys.disarm`

Explicitly disarm the device, stop the watchdog timer, and apply safe state immediately.

| | |
| --- | --- |
| Input | `{}` |
| Output | `{ armed: false, state: "disarmed" }` |
| Safety | Physical safe-state enforcement |

## Watchdog

### `watchdog.configure`

Configure the hardware/firmware watchdog timeout interval.

| | |
| --- | --- |
| Input | `{ timeoutMs: number }` |
| Output | `{ timeoutMs: number, enabled: boolean }` |
| Safety | Non-physical configuration |

### `watchdog.kick`

Deadman heartbeat command. Resets the watchdog timer countdown deadline.

| | |
| --- | --- |
| Input | `{ validityMs? }` |
| Output | `{ kicked: true, timeoutMs: number }` |
| Safety | Non-physical heartbeat |

## GPIO

### `gpio.configSafeState`

Declare per-pin electrical fail-safe level and circuit polarity.

| | |
| --- | --- |
| Input | `{ pin, safeLevel?, polarity? }` (`safeLevel`: `low` \| `high` \| `high-z` \| `hold`; `polarity`: `active-high` \| `active-low`) |
| Output | `{ pin, safeLevel, polarity }` |
| Safety | Safety configuration |

### `gpio.mode`

Configure pin mode: `input`, `output`, `pullup`, or `pulldown`. Optional `safeLevel` and `polarity` can configure fail-safe levels during mode initialization.

### `gpio.write`

Drive a GPIO pin high or low. Requires `armed` state. Input: `{ pin, value, validityMs? }`. Output: `{ pin, value }`. Safety: physical output.

### `gpio.batchWrite`

Validate an entire set of 1–16 `{ pin, value }` writes before applying any of them. Requires `armed` state. Input: `{ writes, validityMs? }`.

### `gpio.stopAll`

Drive all tracked and configured outputs to their declared safe levels (`low`, `high`, `high-z`, `hold`), clear PWM/motor/servo state, and cancel pending pulses. Allowed in any state.

### `gpio.read`

Read pin level. Input: `{ pin }`. Output: `{ pin, value }`. Safety: read-only. Allowed while disarmed or armed.

### `gpio.toggle`

Flip the driven level of an output pin. Requires `armed` state.

### `gpio.pulse`

Drive a pin for `durationMs` without blocking command processing, then restore its previous level. A stop or safe-state trip cancels the restoration. Requires `armed` state.

### `gpio.pwm`

LEDC PWM: `{ channel, pin, duty, frequency, validityMs? }`. Requires `armed` state. Set duty to `0` to stop.

### `gpio.analogRead`

ADC sample on GPIO 32–39. Output `value` is 0–4095. Read-only.

### `gpio.watch` / `gpio.unwatch`

Subscribe or unsubscribe to `gpio.changed` events for a pin.

### `gpio.servo`

Drive a hobby servo: `{ pin, angle, validityMs? }` with angle 0–180°. Requires `armed` state.

### `gpio.motor`

Drive a DC motor: `{ pwmPin, speed, dirPin?, validityMs? }`. Requires `armed` state.

## I2C (ESP32 bridge)

Default pins: SDA 21, SCL 22, 100 kHz. Payloads are capped at 32 bytes by the protocol line.

### `i2c.begin`

Optional `{ sda, scl, frequency }`. Result echoes the active bus config.

### `i2c.write`

Input: `{ address, data, validityMs? }` where `address` is 0–127 and `data` is 1–32 bytes. Requires `armed` state. Hardware returns `BUS_ERROR` on NACK.

### `i2c.read`

Input: `{ address, length }`. Output: `{ address, data }`.

### `i2c.scan`

Returns `{ addresses }` for devices that acknowledge (1–127).

## SPI (ESP32 bridge)

Default pins: SCK 18, MISO 19, MOSI 23, CS 5, 1 MHz, mode 0.

### `spi.begin`

Optional `{ sck, miso, mosi, chipSelect, frequency }`.

### `spi.transfer`

Input: `{ data, chipSelect?, validityMs? }`. Full-duplex. Requires `armed` state.

## Robot manipulator (`pinout/robot-arm`)

Semantic motion and gripper capabilities for simulated and future real arms.

| Capability | Input | Notes |
| --- | --- | --- |
| `motion.home` | `{}` | Move to home pose |
| `motion.move_to` | `{ x, y, z }` | Workspace enforced by policy (±1 m, z 0–1.5 m) |
| `motion.stop` | `{}` | Stop in-progress motion |
| `gripper.open` / `gripper.close` | `{}` | Emits `gripper.changed` |
| `pose.read` | `{}` | Current pose + gripper |
| `status.read` | `{}` | Operational status snapshot |

Events: `motion.started`, `motion.completed`, `motion.stopped`, `gripper.changed`, `device.fault`.

## Environmental chamber (`pinout/environmental-chamber`)

| Capability | Input | Notes |
| --- | --- | --- |
| `temperature.read` | `{}` | Current and target °C |
| `temperature.set` | `{ value }` | Policy: 10–80 °C |
| `door.open` / `door.close` | `{}` | Emits `door.changed` |
| `experiment.start` | `{}` | Policy: door must be `closed` |
| `experiment.stop` | `{}` | Returns experiment to `idle` |
| `status.read` | `{}` | Full chamber state |

Events: `temperature.changed`, `door.changed`, `experiment.started`, `experiment.stopped`.

## DC motor (`pinout/dc-motor`)

| Capability | Input | Notes |
| --- | --- | --- |
| `motor.set` | `{ speed }` | Policy: speed −1 to 1 |
| `motor.stop` | `{}` | Sets speed to 0 |
| `motor.read` | `{}` | Commanded speed |
| `status.read` | `{}` | `ready` / `running` / `stopped` / `faulted` |

Events: `motor.changed`.

## Hobby servo (`pinout/servo`)

| Capability | Input | Notes |
| --- | --- | --- |
| `servo.set_angle` | `{ angle }` | Policy: 0–180° |
| `servo.read` | `{}` | Commanded angle |
| `status.read` | `{}` | Operational snapshot |

Events: `servo.changed`.

## Stepper motor (`pinout/stepper`)

| Capability | Input | Notes |
| --- | --- | --- |
| `stepper.step` | `{ steps }` | Relative steps; policy ±100000 |
| `stepper.goto` | `{ position }` | Absolute position; policy ±100000 |
| `stepper.home` | `{}` | Move to step 0 |
| `stepper.stop` | `{}` | Halt motion |
| `stepper.read` | `{}` | Position + homed |
| `status.read` | `{}` | Operational snapshot |

Events: `stepper.moved`, `stepper.stopped`.

## Distance sensor (`pinout/distance`)

| Capability | Input | Notes |
| --- | --- | --- |
| `distance.read` | `{}` | Range in meters |
| `status.read` | `{}` | Operational snapshot |

## IMU (`pinout/imu`)

| Capability | Input | Notes |
| --- | --- | --- |
| `imu.read` | `{}` | Accel (g) and gyro (rad/s) |
| `status.read` | `{}` | Operational snapshot |

## Encoder (`pinout/encoder`)

| Capability | Input | Notes |
| --- | --- | --- |
| `encoder.read` | `{}` | Tick count |
| `encoder.reset` | `{}` | Zero ticks |
| `status.read` | `{}` | Operational snapshot |

## Limit switch (`pinout/limit-switch`)

| Capability | Input | Notes |
| --- | --- | --- |
| `limit.read` | `{}` | `{ triggered }` |
| `status.read` | `{}` | Operational snapshot |

## Force sensor (`pinout/force`)

| Capability | Input | Notes |
| --- | --- | --- |
| `force.read` | `{}` | Newtons |
| `status.read` | `{}` | Operational snapshot |

## Mobile base (`pinout/mobile-base`)

| Capability | Input | Notes |
| --- | --- | --- |
| `drive.set_velocity` | `{ linear, angular }` | Policy: linear ±1.5 m/s, angular ±3 rad/s |
| `drive.stop` | `{}` | Zero velocities |
| `pose.read` | `{}` | Simulated odometry |
| `status.read` | `{}` | Operational snapshot |

Events: `drive.changed`.

## Relay (`pinout/relay`)

`relay.set { on }`, `relay.read`, and `status.read`. Emits `relay.changed`.

## Proportional valve (`pinout/valve`)

`valve.set { opening }`, `valve.read`, and `status.read`. Opening is policy-limited to 0–100 percent. Emits `valve.changed`.

## Pump (`pinout/pump`)

`pump.set { speed }`, `pump.stop`, `pump.read`, and `status.read`. Speed is policy-limited to 0–100 percent. Emits `pump.changed`.

## Programmable power supply (`pinout/power-supply`)

`power.set { voltage, currentLimit }`, `power.output { enabled }`, `power.read`, and `status.read`. The built-in simulator limits configuration to 0–60 V and 0–20 A; these are simulator policies, not ratings for arbitrary physical hardware. Emits `power.changed`.

## Verification Note

The protocol commands, arming gates, heartbeat watchdog, and per-output fail-safe levels documented here are verified against the simulator and protocol test suites. Physical hardware testing remains pending bench testing with physical hardware.
