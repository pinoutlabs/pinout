# ESP32 DevKit V1 - datasheet-style brief (SIMULATED)

Evidence: **SIMULATED**. This document is for the raw baseline arm. It describes the
board and the JSON-line serial bridge a non-Pinout user would face. It does not
mention Pinout product APIs.

## Board

- MCU: ESP32-D0WD
- Logic: 3.3 V
- Useful GPIO: 0, 2, 4, 5, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33
- Input-only ADC: 34, 35, 36, 39
- Reserved (do not drive): 1, 3, 6-12
- Onboard LED demo pin: **GPIO 2**
- Servo/PWM demo pin: **GPIO 18**
- ADC demo pin: **GPIO 34** (0-4095)

## Serial protocol (JSON lines)

Each request is one UTF-8 line:

```json
{"v":1,"id":"1","action":"sys.arm","payload":{"timeoutMs":5000}}
```

Success response:

```json
{"v":1,"id":"1","ok":true,"result":{"armed":true,"state":"armed","timeoutMs":5000}}
```

Failure response:

```json
{"v":1,"id":"1","ok":false,"error":{"code":"NOT_ARMED","message":"..."}}
```

### Required safety sequence

1. `sys.arm` with `timeoutMs` (milliseconds). Non-zero enables the watchdog window.
2. Optionally `watchdog.configure` / `watchdog.kick` while armed.
3. Actuation actions (`gpio.write`, `gpio.servo`, ...) fail if disarmed.

### Common actions

| action | payload | notes |
| --- | --- | --- |
| `sys.arm` | `{ "timeoutMs": 5000 }` | required before outputs |
| `sys.disarm` | `{}` | stops outputs |
| `gpio.write` | `{ "pin": 2, "value": true }` | digital out |
| `gpio.read` | `{ "pin": 2 }` | digital in |
| `gpio.servo` | `{ "pin": 18, "angle": 90 }` | angle 0-180 |
| `gpio.analogRead` | `{ "pin": 34 }` | returns `{ value }` 0-4095 |

## Firmware sketch format for this sandbox

Write `firmware.json` as:

```json
{
  "steps": [
    { "action": "sys.arm", "payload": { "timeoutMs": 5000 } },
    { "action": "gpio.write", "payload": { "pin": 2, "value": true } }
  ]
}
```

Then call `compile_flash` with that path. The sandbox validates and applies steps
to the SIMULATED device (flash-equivalent; no physical programmer).
