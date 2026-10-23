# Pinout MicroPython Bridge

A single, conservative bridge that makes **many** MicroPython boards speak the Pinout NDJSON wire protocol (v1) — no bespoke
firmware per board, and no factory protocols.

## Status: SIMULATED (host-validated)

| Check | Evidence |
| --- | --- |
| node validate.js | Software, reserved-pin, and fake-machine protocol matrix |
| `node validate-pico.js` | Pico pin policy + `sim/machine.py` hardware-path stubs |
| Physical Pico | **Not HARDWARE_VERIFIED** — operator must confirm on desk hardware |

Never inflate these statuses. A green CI job is not a blink on a real LED.

## Desk path: Raspberry Pi Pico (recommended)

Cheap boards + MicroPython + USB cable. See the full first-time guide:
[docs/raspberry-pi-pico.md](../../docs/raspberry-pi-pico.md).

Short version:

1. Flash [MicroPython for Pico](https://micropython.org/download/RPI_PICO/) (UF2 / BOOTSEL).
2. Copy the bridge and Pico profile:

   ```bash
   mpremote cp main.py :
   mpremote cp boards/raspberry-pi-pico/config.py :config.py
   mpremote reset
   ```

3. The board speaks Pinout NDJSON over **USB CDC** (115200 on the host serial
   port, typically `/dev/ttyACM0` or `COMx`). Onboard LED blink uses **GPIO 25**.

## Install (other boards)

1. Copy `main.py` and a board `config.py` to the filesystem
   (`mpremote`, Thonny, `ampy`, …).
2. Edit `config.py`: `TRANSPORT`, UART/I2C/SPI defaults, `RESERVED_PINS`,
   optional `ALLOWED_PINS` / `BOARD_ID` / `LED_PIN`.
3. Reset. Default `TRANSPORT=usb` uses stdin/stdout (USB CDC on Pico).
   Set `TRANSPORT=uart` only when you have an external USB-UART adapter.

## Capability detection

`machine.*` imports are guarded: on boot the bridge detects what the runtime
provides and reports failures for peripherals that are not available, rather
than fabricating values. Reserved / out-of-map pins return `INVALID_PIN`.
Unknown actions return `UNSUPPORTED_ACTION`. Other failures use
`ACTION_FAILED` — the same dialect as `firmware/esp32-bridge`.

Pin state is always mirrored in software, so `gpio.read`/`gpio.toggle` behave
consistently; on hardware the physical pin is driven too.

Software-only mode (no `machine` module) and the host `sim/machine.py` stub
both run over stdin/stdout. That is what the validators exercise.

## Wire protocol

Identical to the ESP32 bridge (`firmware/esp32-bridge`) and
`packages/core/src/protocol.ts`:

```
→ {"v":1,"id":"1","action":"gpio.write","payload":{"pin":25,"value":1}}
← {"v":1,"event":"ready","payload":{"firmware":"micropython-bridge",...}}
← {"v":1,"id":"1","ok":true,"result":{"pin":25,"value":1}}
← {"v":1,"id":"2","ok":false,"error":{"code":"INVALID_PIN","message":"..."}}
```

## Runtime behavior and error codes

The bridge requires the MicroPython machine module; CircuitPython is not
supported. It detects available peripherals and advertises only supported
capabilities. GPIO state has a software shadow, while hardware mode also drives
the physical pin. PWM and servo share one channel per pin; gpio.write releases
a pin's PWM voice. Servo output uses 50 Hz with a 1–2 ms pulse window.

| Code | Meaning |
| --- | --- |
| INVALID_PIN | malformed, reserved, or out-of-map pin |
| INVALID_PAYLOAD | missing or out-of-range request field |
| UNSUPPORTED_CAPABILITY | runtime lacks the requested peripheral |
| BUS_ERROR | peripheral I/O failed |
| WATCH_TABLE_FULL | too many GPIO watch points |
| UNSUPPORTED_ACTION | unknown action |
| ACTION_FAILED | other handler failure |

## Boards

| Profile | Path |
| --- | --- |
| Raspberry Pi Pico (RP2040) | `boards/raspberry-pi-pico/config.py` + `firmware/boards/raspberry-pi-pico.json` |
| Generic / bring-your-own | edit root `config.py` |

Any board with the `machine` module should work for GPIO/PWM/ADC/I2C/SPI,
subject to its own pin capabilities. Board-specific knowledge stays in
`config.py` and Pinout's data-driven descriptors.
