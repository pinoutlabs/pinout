# Pinout MicroPython Bridge

A single, conservative bridge that makes **many** MicroPython boards speak the
Pinout NDJSON wire protocol (v1) — no bespoke firmware per board. It requires
the MicroPython `machine` module; CircuitPython is **not** supported yet (it
has no `machine` module, so it would need a separate shim).

## Status: EXPERIMENTAL

Host-validated only: `node validate.js` runs a three-part matrix with plain
`node` plus `python3` (no npm install):

1. **software mode** against the shipped `config.py` — wire shape, error
   taxonomy, PWM/servo software shadow, deterministic `sys.info`,
   malformed-input handling;
2. **reserved-pin mode** — a temp config with `RESERVED_PINS` and a small
   `MAX_WATCHES` asserts reserved-pin rejection and `WATCH_TABLE_FULL`;
3. **fake-hardware mode** — a stub `machine.py` logs every peripheral call so
   GPIO/PWM/servo/ADC/I2C/SPI code paths and `BUS_ERROR` mapping are asserted
   without a board.

Hardware behavior is **not verified**; treat this as a starting point, not a
supported target.

## Install

1. Copy `main.py` and `config.py` to the board's filesystem
   (`mpremote cp main.py :/`, Thonny, `ampy`, …).
2. Edit `config.py` for your board: UART id/baud/pins, I2C/SPI defaults,
   `RESERVED_PINS` (flash/strap pins you never want driven), `MAX_WATCHES`.
3. Reset the board. It now speaks Pinout over UART at 115200.

## Capability matrix

`sys.hello` and `sys.info` advertise exactly this per-runtime subset; anything
not advertised is rejected with `UNSUPPORTED_CAPABILITY` rather than faked.

| Capability                                         | Software mode (host)   | Hardware                                   |
| -------------------------------------------------- | ---------------------- | ------------------------------------------ |
| `sys.hello`, `sys.ping`, `sys.info`                | yes                    | yes                                        |
| `gpio.mode/read/write/toggle/watch`                | yes (software shadow)  | yes (drives the physical pin)              |
| `pwm.configure`, `pwm.write`, `gpio.servo`         | yes (software shadow)  | needs `machine.PWM`                        |
| `adc.read`                                         | no                     | needs `machine.ADC`                        |
| `i2c.scan`, `i2c.read`, `i2c.write`                | no                     | needs `machine.I2C` / `machine.SoftI2C`    |
| `spi.transfer`                                     | no                     | needs `machine.SPI` / `machine.SoftSPI`    |

Pin state is always mirrored in software, so `gpio.read`/`gpio.toggle` behave
consistently; on hardware the physical pin is driven too. Software-only mode
(no `machine` module — e.g. a laptop) runs the same protocol over
stdin/stdout; that is what part 1 of `validate.js` exercises.

`gpio.servo` uses a 50 Hz PWM voice with a 1–2 ms pulse window (angle 0–180),
matching the ESP32 bridge. Servo and `pwm.*` share one PWM slot per pin; a
plain `gpio.write` releases the pin's PWM voice first.

## Error codes

| Code                    | Meaning                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `INVALID_PIN`           | pin malformed, reserved, unsupported or not configured           |
| `INVALID_PAYLOAD`       | missing or out-of-range request fields                           |
| `UNSUPPORTED_CAPABILITY` | this runtime lacks the requested peripheral                     |
| `BUS_ERROR`             | peripheral I/O failed (e.g. an I2C NACK)                         |
| `WATCH_TABLE_FULL`      | too many `gpio.watch` points                                     |
| `UNSUPPORTED_ACTION`    | unknown action                                                   |
| `ACTION_FAILED`         | anything else                                                    |

Lines that do not start with `{` are ignored (UART boot noise). A `{` line
that is not valid JSON, a non-v1 request, or a request without string
`id`/`action` gets an `INVALID_JSON`/`INVALID_MESSAGE` failure with
`"id":"invalid"`, mirroring the ESP32 bridge.

## Wire protocol

Identical to the ESP32 bridge (`firmware/esp32-bridge`) and
`packages/core/src/protocol.ts`:

```
→ {"v":1,"id":"1","action":"gpio.write","payload":{"pin":2,"value":1}}
← {"v":1,"id":"1","ok":true,"result":{"pin":2,"value":1}}
← {"v":1,"id":"2","ok":false,"error":{"code":"ACTION_FAILED","message":"..."}}
```

## Boards

Any MicroPython board with the `machine` module should work for
GPIO/PWM/ADC/I2C/SPI, subject to its own pin capabilities. Because the bridge
never assumes a pin map it was not given, board-specific knowledge stays in
`config.py` and in Pinout's data-driven board descriptors (see
`board-descriptor.json`).
