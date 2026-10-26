# Raspberry Pi Pico (RP2040) - datasheet-style brief (SIMULATED)

Evidence: **SIMULATED**. Host-side Pico profile for the raw baseline arm. Not a
physical Pico HIL run.

## Board

- MCU: RP2040
- Logic: 3.3 V
- GPIO: 0-22, 25-28
- Reserved: 23, 24, 29
- Onboard LED (non-W): **GPIO 25**
- Servo/PWM demo pin: **GPIO 15**
- ADC demo pin: **GPIO 26** (0-65535 in this simulator)

## Serial protocol (JSON lines)

Same framing as the ESP32 USB bridge brief:

```json
{"v":1,"id":"1","action":"sys.arm","payload":{"timeoutMs":5000}}
```

### Common actions

| action | payload | notes |
| --- | --- | --- |
| `sys.arm` | `{ "timeoutMs": 5000 }` | required before outputs |
| `gpio.write` | `{ "pin": 25, "value": true }` | LED |
| `gpio.servo` | `{ "pin": 15, "angle": 90 }` | 0-180 |
| `gpio.analogRead` | `{ "pin": 26 }` | numeric sample |

## Firmware sketch format

Write `firmware.json` with a `steps` array of `{ action, payload }`, then
`compile_flash`. Flash is SIMULATED only.
