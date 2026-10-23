# Pinout protocol v1

Host and device exchange **newline-delimited JSON** (NDJSON) over a byte transport. The first implementation uses USB serial at **115200 8N1**, no hardware flow control. The same framing also rides BLE GATT (RX write / TX notify) — see [ble-gatt.md](ble-gatt.md). Host CI covers the BLE path with a SIMULATED bridge; physical radio HIL is not claimed.

The protocol is not ESP32-specific. ESP32 is the first device that speaks it.

## Framing

- UTF-8
- One JSON object per line
- Lines end with `\n` (`\r\n` is accepted)
- Lines that do not start with `{` are ignored (ESP32 ROM boot logs, debug prints)
- Maximum request and response line: 1024 bytes on the ESP32 bridge (`maxProtocolLineBytes` in the SDK, `lineMax` in firmware)

## Request (host → device)

```json
{
  "v": 1,
  "id": "3f1c0a2e-7b64-4c0d-9e2a-0c0b1d2e3f40",
  "action": "gpio.write",
  "payload": { "pin": 2, "value": true, "validityMs": 100 }
}
```

| Field | Rule |
| --- | --- |
| `v` | Protocol version. Currently `1`. |
| `id` | Non-empty string. Unique among in-flight requests. Echoed in the response. |
| `action` | Dotted name: `family.operation`. |
| `payload` | Object. Use `{}` when the action has no input. May optionally contain `validityMs`. |

### Bounded Command Validity (`validityMs`)

Actuation requests may include an optional `validityMs` (positive integer) in their `payload`. If a command has remained buffered or delayed beyond its validity window prior to execution, the device or simulator rejects it immediately with error code `COMMAND_EXPIRED`. This prevents stale, delayed actuation commands from being applied late after operating conditions have changed.

## Success response (device → host)

```json
{
  "v": 1,
  "id": "3f1c0a2e-7b64-4c0d-9e2a-0c0b1d2e3f40",
  "ok": true,
  "result": { "pin": 2, "value": true }
}
```

## Error response (device → host)

```json
{
  "v": 1,
  "id": "3f1c0a2e-7b64-4c0d-9e2a-0c0b1d2e3f40",
  "ok": false,
  "error": {
    "code": "INVALID_PIN",
    "message": "GPIO 34 is input-only on ESP32 and cannot be driven."
  }
}
```

## Events (device → host, unsolicited)

Events have `event` and no `id`.

### `ready`

Emitted on boot / transport open:

```json
{
  "v": 1,
  "event": "ready",
  "payload": {
    "firmware": "esp32-bridge",
    "version": "0.1.0",
    "protocol": 1,
    "capabilities": [
      "sys.hello", "sys.ping", "sys.info", "sys.arm", "sys.disarm",
      "watchdog.configure", "watchdog.kick",
      "gpio.mode", "gpio.configSafeState", "gpio.write", "gpio.batchWrite",
      "gpio.stopAll", "gpio.read", "gpio.toggle", "gpio.pulse", "gpio.pwm",
      "gpio.analogRead", "gpio.watch", "gpio.unwatch",
      "i2c.begin", "i2c.write", "i2c.read", "i2c.scan",
      "spi.begin", "spi.transfer", "gpio.servo", "gpio.motor"
    ],
    "features": ["watchdog", "arming", "safe-state", "command-validity"]
  }
}
```

The ESP32 bridge emits `ready` after `Serial.begin`. A host listens for up to
300 ms for that event, then actively probes `sys.hello` with bounded 300 ms
request attempts until the configured connection budget expires. This handles
native USB Serial/JTAG devices that are already running when opened. Late
responses to timed-out request ids are ignored. The shared wire examples live
in `fixtures/protocol/v1/messages.jsonl`.

### `gpio.changed`

Unsolicited event emitted when a watched pin changes level:

```json
{
  "v": 1,
  "event": "gpio.changed",
  "payload": { "pin": 2, "value": true }
}
```

### `device.tripped`

Unsolicited event emitted when the watchdog expires or a safe-state trip condition occurs:

```json
{
  "v": 1,
  "event": "device.tripped",
  "payload": {
    "reason": "WATCHDOG_EXPIRED",
    "message": "Watchdog timeout elapsed without heartbeat.",
    "stoppedPins": [2]
  }
}
```

## State machine and explicit arming

Devices operate according to a strict safety state machine:

```
          [Boot / Reset / Reconnect]
                     |
                     v
             +---------------+
             |   DISARMED    | <---------+
             +---------------+           |
                     |                   |
               sys.arm                   | sys.disarm
                     v                   |
             +---------------+           |
             |     ARMED     | ----------+
             +---------------+           |
                     |                   |
              watchdog expiry            |
                     v                   |
             +---------------+           |
             |    TRIPPED    | ----------+
             +---------------+
```

1. **`disarmed`**: Initial state after boot, reset, disconnect, reconnect, or after an explicit `sys.disarm`.
   - Read-only queries, bus scans, pin mode / safe-state configuration, and arming commands (`sys.hello`, `sys.ping`, `sys.info`, `sys.arm`, `sys.disarm`, `watchdog.configure`, `gpio.mode`, `gpio.configSafeState`, `gpio.read`, `gpio.analogRead`, `gpio.watch`, `gpio.unwatch`, `i2c.begin`, `i2c.read`, `i2c.scan`, `spi.begin`, `gpio.stopAll`) are allowed.
   - Actuation commands (`gpio.write`, `gpio.batchWrite`, `gpio.toggle`, `gpio.pulse`, `gpio.pwm`, `gpio.servo`, `gpio.motor`, `i2c.write`, `spi.transfer`) are **REJECTED** with error code `NOT_ARMED`.
2. **`armed`**: Entered exclusively via `sys.arm`.
   - Actuation commands are executed.
   - Watchdog timer is actively counting down. Every `watchdog.kick` or valid actuation resets the deadline.
3. **`tripped`**: Watchdog deadline elapsed without a kick.
   - The device immediately and locally applies its declared per-output safe-state table (driving outputs to declared safe levels, detaching PWM/servos/motors, cancelling pulses).
   - Actuation commands are **REJECTED** with error code `WATCHDOG_TRIPPED`.
   - **No automatic resumption**: Re-entering `armed` requires an explicit `sys.arm` command after operator/host recovery.

Arming is strictly explicit and governed. Backends, SDK layers, and runtime routers must never arm a device implicitly during an actuation call. Any `autoArm` configuration in test fixtures is strictly demo/test-only and logs an explicit warning.

## Actions

### `sys.hello`

Payload: `{}`

Result: same identity object as the `ready` event payload, including `capabilities` and `features`.

### `sys.arm`

Explicitly arms the device for physical actuation and arms/resets the watchdog timer.

Payload:

```json
{ "timeoutMs": 1000 }
```

All fields are optional. If `timeoutMs` is provided, it configures the watchdog timeout interval (0 disables the watchdog timer).

Result:

```json
{ "armed": true, "state": "armed", "timeoutMs": 1000 }
```

### `sys.disarm`

Explicitly disarms the device, stops the watchdog timer, and applies safe state immediately.

Payload: `{}`

Result:

```json
{ "armed": false, "state": "disarmed" }
```

### `watchdog.configure`

Configures the hardware/firmware watchdog timeout interval.

Payload:

```json
{ "timeoutMs": 1000 }
```

`timeoutMs`: integer milliseconds >= 0. `0` disables watchdog timeout.

Result:

```json
{ "timeoutMs": 1000, "enabled": true }
```

### `watchdog.kick`

Deadman heartbeat command. Resets the watchdog countdown deadline.

Payload: `{}` (optional `{ "validityMs": 100 }`)

Result:

```json
{ "kicked": true, "timeoutMs": 1000 }
```

### `gpio.configSafeState`

Declares the commissioned safe level and electrical polarity for an output pin.

Payload:

```json
{
  "pin": 2,
  "safeLevel": "high",
  "polarity": "active-low"
}
```

| Field | Values | Description |
| --- | --- | --- |
| `pin` | Integer GPIO pin | Valid output pin. |
| `safeLevel` | `"low"`, `"high"`, `"high-z"`, `"hold"` | Electrical safe state when tripped/stopped. Defaults to `"low"`. |
| `polarity` | `"active-high"`, `"active-low"` | Circuit polarity. Defaults to `"active-high"`. |

When safe state is applied (via watchdog trip, `gpio.stopAll`, `sys.disarm`, or fault):
- `"low"`: driven LOW (`pinMode(OUTPUT)`, `digitalWrite(LOW)`).
- `"high"`: driven HIGH (`pinMode(OUTPUT)`, `digitalWrite(HIGH)`). Essential for active-low loads (e.g. relays energizing on low).
- `"high-z"`: floating input (`pinMode(INPUT)`).
- `"hold"`: leaves pin at its current output level (opt-in only).

Configurations with missing or unsupported parameters are rejected with `INVALID_PAYLOAD` or `UNSUPPORTED_CONFIGURATION`.

Result: `{ "pin": 2, "safeLevel": "high", "polarity": "active-low" }`

### `gpio.mode`

Payload:

```json
{ "pin": 4, "mode": "pullup", "safeLevel": "low", "polarity": "active-high" }
```

`mode` is one of `input`, `output`, `pullup`, or `pulldown`. Optional `safeLevel` and `polarity` can configure output safe state during mode assignment.

Result: `{ "pin": 4, "mode": "pullup" }`

### `gpio.write`

Payload:

```json
{ "pin": 2, "value": true, "validityMs": 100 }
```

Requires device to be in `armed` state. Sets the pin to `OUTPUT` and drives it.

Result: `{ "pin": 2, "value": true }`

### `gpio.batchWrite`

Payload:

```json
{
  "writes": [
    { "pin": 2, "value": true },
    { "pin": 4, "value": false }
  ],
  "validityMs": 100
}
```

Requires device to be in `armed` state. Validates all entries (1–16 writes) before changing any output pin.

Result: `{ "writes": [{ "pin": 2, "value": true }, { "pin": 4, "value": false }] }`

### `gpio.stopAll`

Applies the declared per-pin safe state across all configured and active outputs, detaches PWM/motor/servo channels, and cancels pending pulses. Allowed in any state.

Result: `{ "stoppedPins": [2, 4] }`

### `gpio.read`

Payload: `{ "pin": 2 }`

Result: `{ "pin": 2, "value": false }`

Allowed in `disarmed` or `armed` state.

### `gpio.toggle`

Payload: `{ "pin": 2, "validityMs": 100 }`

Requires device to be in `armed` state. Toggles an output pin.

Result: `{ "pin": 2, "value": true }`

### `gpio.pulse`

Payload:

```json
{ "pin": 2, "value": true, "durationMs": 100, "validityMs": 100 }
```

Requires device to be in `armed` state. Drives the pin for `durationMs` and restores the previous level without blocking command processing. A stop or safe-state trip cancels restoration.

Result: `{ "pin": 2, "value": true, "durationMs": 100, "previousValue": false }`

### `gpio.pwm`

Payload:

```json
{ "pin": 2, "duty": 0.5, "frequency": 5000, "channel": 0, "validityMs": 100 }
```

Requires device to be in `armed` state.

Result: `{ "pin": 2, "duty": 0.5, "frequency": 5000, "channel": 0 }`

### `gpio.analogRead`

Payload: `{ "pin": 32 }`

Result: `{ "pin": 32, "value": 2048 }`

### `gpio.watch` / `gpio.unwatch`

Payload: `{ "pin": 2 }`

Result: `{ "pin": 2, "watching": true }` or `{ "pin": 2, "watching": false }`

### `i2c.begin`

Payload (all fields optional): `{ "sda": 21, "scl": 22, "frequency": 100000 }`

### `i2c.write`

Payload: `{ "address": 60, "data": [0, 175], "validityMs": 100 }`

Requires device to be in `armed` state.

Result: `{ "address": 60, "bytesWritten": 2 }`

### `i2c.read`

Payload: `{ "address": 60, "length": 2 }`

Result: `{ "address": 60, "data": [0, 175] }`

### `i2c.scan`

Payload: `{}`

Result: `{ "addresses": [60] }`

### `spi.begin`

Payload (all fields optional): `{ "sck": 18, "miso": 19, "mosi": 23, "chipSelect": 5, "frequency": 1000000 }`

### `spi.transfer`

Payload: `{ "data": [18, 52], "chipSelect": 5, "validityMs": 100 }`

Requires device to be in `armed` state.

Result: `{ "chipSelect": 5, "data": [18, 52] }`

### `gpio.servo`

Payload: `{ "pin": 13, "angle": 90, "validityMs": 100 }`

Requires device to be in `armed` state.

Result: `{ "pin": 13, "angle": 90 }`

### `gpio.motor`

Payload: `{ "pwmPin": 25, "speed": 0.4, "dirPin": 26, "validityMs": 100 }`

Requires device to be in `armed` state.

Result: `{ "pwmPin": 25, "speed": 0.4, "dirPin": 26 }`

## Lifecycle and failure behaviors

| Event | Device Behavior | Host Behavior |
| --- | --- | --- |
| **Boot** | Device initializes in `disarmed` state. Watchdog is initialized. Outputs unconfigured/low. Advertises `features` and `capabilities` in `ready`. | Host listens for `ready` or probes `sys.hello`. Verifies feature flags. Configures pin modes & safe states before arming. |
| **Host Crash / Link Loss** | Watchdog deadline expires without heartbeat. Device applies per-pin safe state locally, detaches PWM/servos/motors, enters `tripped` state (`WATCHDOG_EXPIRED`), emits `device.tripped`. | None (host is dead or disconnected). |
| **Watchdog Expiry** | Device enters `tripped` state and applies local safe state. Subsequent actuations return `WATCHDOG_TRIPPED`. | Receives `device.tripped` or `WATCHDOG_TRIPPED`. Must diagnose issue and explicitly send `sys.arm` to resume. |
| **Disconnect** | If armed, device local watchdog trips within `timeoutMs` and enforces safe state. | Host tears down background heartbeat and closes transport. |
| **Reconnect** | Device remains in `disarmed` or `tripped` state until new handshake and configuration. No automatic actuation resumption. | Host discovers state via `sys.hello`, re-establishes output configuration, and explicitly arms. |
| **Hardware Reset** | Device reboots into `disarmed` state with clean defaults. Emits `ready`. | Host discovers reset, performs fresh initialization, and arms. |

## Error codes

| Code | Meaning |
| --- | --- |
| `INVALID_JSON` | Line started with `{` but was not valid JSON. |
| `INVALID_MESSAGE` | JSON parsed but is not a valid request (wrong version, missing fields, line too long). |
| `UNKNOWN_ACTION` | Action is not implemented on this device. |
| `INVALID_PIN` | Pin is out of range or forbidden on this device. |
| `INVALID_PAYLOAD` | Action input failed validation. |
| `BUS_ERROR` | I2C NACK or other bus failure (hardware only). |
| `NOT_ARMED` | Actuation command attempted while device is in `disarmed` state. |
| `WATCHDOG_TRIPPED` | Actuation command attempted while device is in `tripped` state. |
| `COMMAND_EXPIRED` | Command validity window (`validityMs`) expired before execution. |
| `UNSUPPORTED_CONFIGURATION` | Output safe-state or pin configuration is invalid or unsupported. |

Host-only errors (never sent by the device): `TIMEOUT`, `TRANSPORT_ERROR`, `PROTOCOL_ERROR`, `DISCONNECTED`, `UNSUPPORTED_CAPABILITY`, `VALIDATION_ERROR`, `ABORTED`, `WATCHDOG_NOT_SUPPORTED`.

The simulator uses the same device error codes as firmware. There is no `INTERNAL` code.

## Legacy Firmware Guarantee

Older firmware versions omit the `"features"` field and do not advertise `"sys.arm"`, `"watchdog.configure"`, `"watchdog.kick"`, or `"gpio.configSafeState"`.

The host SDK treats absence of the `"watchdog"` / `"arming"` feature flags as `unsupported`. Any host runtime or actuation policy requiring deadman watchdog guarantees must fail closed with `WATCHDOG_NOT_SUPPORTED` rather than assuming older firmware provides host-loss protection.

## Extending the protocol

Add a new action name and document its payload. Do not invent a second framing format for the next sensor.

Keep `v: 1` until a breaking change is required. Additional fields on existing objects should be ignored by older hosts and devices.
