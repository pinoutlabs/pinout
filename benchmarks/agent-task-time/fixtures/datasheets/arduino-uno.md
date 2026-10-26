# Arduino Uno (ATmega328P) - datasheet-style brief (SIMULATED)

Evidence: **SIMULATED**. Uno profile for the raw baseline arm. Firmware in this
repository may be COMPILE_TESTED elsewhere; this benchmark path is still
simulator-only unless `--device real` is implemented and actually run.

## Board

- MCU: ATmega328P
- Logic: 5 V
- Digital GPIO: 2-13
- Analog: 14-19 (A0-A5)
- Reserved UART: 0, 1
- Onboard LED: **GPIO 13**
- Servo/PWM demo pin: **GPIO 9**
- ADC demo pin: **GPIO 14** / A0 (0-1023)

## Serial protocol (JSON lines)

```json
{"v":1,"id":"1","action":"sys.arm","payload":{"timeoutMs":5000}}
```

### Common actions

| action | payload | notes |
| --- | --- | --- |
| `sys.arm` | `{ "timeoutMs": 5000 }` | required before outputs |
| `gpio.write` | `{ "pin": 13, "value": true }` | LED |
| `gpio.servo` | `{ "pin": 9, "angle": 90 }` | 0-180 |
| `gpio.analogRead` | `{ "pin": 14 }` | numeric sample |

## Firmware sketch format

Write `firmware.json` with a `steps` array of `{ action, payload }`, then
`compile_flash`. Flash is SIMULATED only.
