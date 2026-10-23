# ESP32 bridge firmware

Minimal firmware that speaks Pinout protocol v1 over USB serial (UART0 or native USB CDC at 115200 8N1).

For a desk path without Wi-Fi credentials, see the adjacent BLE GATT sketch
[`firmware/esp32-ble-bridge`](../esp32-ble-bridge/) and [docs/ble-gatt.md](../../docs/ble-gatt.md)
(host **SIMULATED**; firmware **COMPILE_TESTED** only when PlatformIO succeeds; no HIL).

It does not implement a full board support package. It accepts structured commands, validates them, executes GPIO read/write, and returns JSON responses.

## Targets (honest status)

| PlatformIO env | Board JSON | `boardId` advertised | Status | CI |
| --- | --- | --- | --- | --- |
| `esp32dev` (default) | `firmware/boards/esp32-devkit-v1.json` | `esp32-devkit-v1` | `COMPILE_TESTED` (classic alpha gate) | Default firmware job |
| `esp32-c3-supermini` | `firmware/boards/esp32-c3-supermini.json` | `esp32-c3-supermini` | `COMPILE_TESTED` | Release-candidate workflow only |
| `esp32-s3-devkitc-1` | `firmware/boards/esp32-s3-devkitc-1.json` | `esp32-s3-devkitc-1` | `COMPILE_TESTED` | Release-candidate workflow only |

There is **no** physical HIL evidence for C3 or S3 in this repository. Do not treat compile success as hardware verification. Pinout tools **never auto-flash**.

See the [three-board guide](../../docs/three-board-demo.md) for classic + C3 daemon/MCP workflow. C3 I2C defaults are GPIO 4/5 (GPIO 2/8/9 reserved). S3 I2C defaults are GPIO 8/9 (USB 19/20, UART 43/44, flash 22–33, straps 45/46 reserved).

## What it supports

- `sys.hello`, `sys.ping`, `sys.info`
- `gpio.mode`, `gpio.write`, `gpio.batchWrite`, `gpio.stopAll`, `gpio.read`, `gpio.toggle`, `gpio.pulse`
- `gpio.pwm`, `gpio.analogRead`, `gpio.watch`, `gpio.unwatch` (`gpio.changed` events)
- `i2c.begin`, `i2c.write`, `i2c.read`, `i2c.scan` (defaults from board map)
- `spi.begin`, `spi.transfer` (defaults from board map)
- `gpio.servo` (50 Hz hobby servo on a GPIO) — **COMPILE_TESTED** PWM hook used by the host `pinout/pan-tilt` module for 1–2 desk servos; not HIL-verified
- `gpio.motor` (PWM + optional direction pin)

`gpio.batchWrite` validates all entries before changing any output (1–16 writes), making
multi-pin updates predictable. `gpio.stopAll` is a best-effort software stop: it drives every
output activated by the bridge to its configured safe level (default low) and clears PWM channels. It is not a certified safety
function, and it does not restore the previous state. Pulses are scheduled without blocking
the serial loop; their response is sent immediately and the previous pin level is restored when
the duration expires. A stop cancels pending pulse expirations and leaves those pins low.

See [docs/protocol.md](../../docs/protocol.md) for the message format.

## Protocol vector check

The host and firmware share golden protocol vectors in
`fixtures/protocol/v1/messages.jsonl`. When a message or action changes, use
this sequence to keep the wire contract aligned:

1. Update the canonical protocol schema and host parser/encoder.
2. Update the JSONL vectors with the expected request, response, or event.
3. Update the simulator and `src/main.cpp` firmware handler together.
4. Run the host-side vector test from the repository root:

   ```bash
   npm test -- packages/core/tests/protocolVectors.test.ts
   ```

5. Compile the classic target without uploading it:

   ```bash
   cd firmware/esp32-bridge
   pio run -e esp32dev
   ```

Optional local compile of the cheap-board targets (still no flash):

```bash
pio run -e esp32-c3-supermini -e esp32-s3-devkitc-1
```

The vector test is host-only and does not require a board. A successful
PlatformIO run is compile evidence; it does not flash or establish
hardware-in-the-loop evidence. For physical verification, follow the
[ESP32 Classic HIL procedure](../../scripts/hil/esp32-classic.md) and add a
dated record under `hardware/records/`.

## Identify the board (before any flash)

1. Visually confirm silkscreen / module marking (classic DevKit/WROOM vs C3 SuperMini vs S3-DevKitC-1).
2. List ports: `npm run pinout -- ports` (or `pio device list`).
3. Match USB VID/PID against `firmware/boards/*.json` when possible. Espressif native CDC often appears as `303a:1001` for both C3 and S3 — **VID/PID alone is not positive identity**; use markings + the firmware `boardId` after a known-good flash.
4. Only then choose the matching PlatformIO env and upload explicitly.

## Hardware notes by target

### Classic ESP32 (`esp32dev`)

Compile-tested for DevKit / WROOM 30-pin boards (`firmware/boards/esp32-devkit-v1.json`). Onboard LED is usually **GPIO 2**.

Do not use:

- GPIO 6–11 (SPI flash)
- GPIO 1 and 3 (USB serial)
- GPIO 12 (boot strap; held high at reset can prevent boot)
- GPIO 34–39 as outputs (input-only)

Reference circuit: [`hardware/reference/esp32-classic-led-sensor.md`](../../hardware/reference/esp32-classic-led-sensor.md). HIL: [`scripts/hil/esp32-classic.md`](../../scripts/hil/esp32-classic.md).

### ESP32-C3 SuperMini (`esp32-c3-supermini`)

Native USB CDC. Usable GPIOs: 0, 1, 3, 4, 5, 6, 7, 10. Prefer an external LED on **GPIO 4**.

Do not use:

- GPIO 2, 8, 9 (boot straps; onboard LED on 8 is intentionally unavailable)
- GPIO 11–17 (flash), 18–19 (USB), 20–21 (UART0)

Experimental HIL notes: [`scripts/hil/esp32-c3-experimental.md`](../../scripts/hil/esp32-c3-experimental.md).

### ESP32-S3-DevKitC-1 (`esp32-s3-devkitc-1`)

Native USB CDC. I2C defaults SDA **8** / SCL **9**. Prefer an external LED on **GPIO 2** or **4**.

Do not use:

- GPIO 19–20 (USB D−/D+)
- GPIO 22–33 (flash / reserved block on this map)
- GPIO 43–44 (UART0)
- GPIO 45–46 (strap pins)

Experimental HIL notes: [`scripts/hil/esp32-s3-experimental.md`](../../scripts/hil/esp32-s3-experimental.md).

## Flashing Policy

Pinout tools **never automatically flash** attached hardware. Firmware must be built and flashed explicitly by an operator following manual visual and USB identity confirmation.

### Compile only (no upload)

```bash
cd firmware/esp32-bridge
pio run -e esp32dev
pio run -e esp32-c3-supermini
pio run -e esp32-s3-devkitc-1
```

### Flash with PlatformIO (explicit, after identity confirmation)

```bash
cd firmware/esp32-bridge
# Classic UART bridge boards
pio run -e esp32dev -t upload --upload-port PORT
# C3 / S3 native USB — replace PORT after visual confirmation
pio run -e esp32-c3-supermini -t upload --upload-port PORT
pio run -e esp32-s3-devkitc-1 -t upload --upload-port PORT
pio device monitor --port PORT
```

You should see a JSON `ready` event after reset, possibly mixed with ROM boot log lines. The host SDK ignores non-JSON lines. Confirm `boardId` in `sys.hello` / `ready` matches the board you intended.

If a C3/S3 upload fails, hold BOOT, tap RESET, release BOOT, retry the **explicitly selected** env, then reset afterward.

### Flash with Arduino IDE

1. Install the ESP32 board package.
2. Install **ArduinoJson** 7 from Library Manager.
3. Open `src/main.cpp` (or copy it into a `.ino` sketch).
4. Board: **ESP32 Dev Module** (classic), **ESP32C3 Dev Module**, or **ESP32S3 Dev Module**; baud **115200**.
5. For C3/S3 enable USB CDC on boot to match PlatformIO flags.
6. Upload only after confirming the physical board.

## Run from Pinout

```bash
npm run pinout -- devices
npm run pinout -- hello --port /dev/cu.usbserial-10
npm run pinout -- gpio write 2 high --port /dev/cu.usbserial-10
npm run pinout -- gpio write 2 low --port /dev/cu.usbserial-10
```

On Linux the port is often `/dev/ttyUSB0` or `/dev/ttyACM0`. On macOS use `/dev/cu.*`, not `/dev/tty.*`.
