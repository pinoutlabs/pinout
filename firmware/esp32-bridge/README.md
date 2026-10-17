# ESP32 bridge firmware

Minimal firmware that speaks Pinout protocol v1 over USB serial (UART0 at 115200 8N1).

It does not implement a full board support package. It accepts structured commands, validates them, executes GPIO read/write, and returns JSON responses.

Classic ESP32 and C3 SuperMini builds advertise distinct `boardId` values. See the [three-board guide](../../docs/three-board-demo.md) for the current daemon/MCP workflow; physical testing remains pending. C3 I2C defaults are GPIO 4/5, and GPIO 2/8/9 are reserved.

## Build variants

Each PlatformIO environment compiles a distinct `boardId` from a compile-time
board header in `src/boards/`. Exactly one `PINOUT_ESP32_*` flag may be set;
the selector rejects conflicting or unknown configurations with `#error`
instead of silently falling back.

| Environment        | Board header         | `boardId`             | Core / platform                  | Status |
| ------------------ | -------------------- | --------------------- | -------------------------------- | ------ |
| `esp32dev`         | `board_esp32.h`      | `esp32-devkit-v1`     | `espressif32@6.5.0` (Arduino 2.x) | alpha baseline; compile-tested |
| `esp32-c3-supermini` | `board_esp32c3.h`  | `esp32-c3-supermini`  | `espressif32@6.5.0` (Arduino 2.x) | EXPERIMENTAL, opt-in |
| `esp32s2-devkit`   | `board_esp32s2.h`    | `esp32-s2-devkitc-1`  | `espressif32@6.5.0` (Arduino 2.x), Saola-1 board definition¹ | EXPERIMENTAL, opt-in |
| `esp32s3-devkit`   | `board_esp32s3.h`    | `esp32-s3-devkitc-1`  | `espressif32@6.5.0` (Arduino 2.x) | EXPERIMENTAL, opt-in |
| `esp32c6-devkit`   | `board_esp32c6.h`    | `esp32-c6-devkitc-1`  | pioarduino `55.03.312-1` (Arduino 3.x) | EXPERIMENTAL, opt-in |

¹ PlatformIO 6.5.0 ships no ESP32-S2-DevKitC-1 board definition, so the
environment builds with the ESP32-S2-Saola-1 definition (same ESP32-S2 module
family, 4 MB flash, and UART0 on GPIO 43/44). Flash the DevKitC-1 hardware;
the firmware's validated pin table is still the DevKitC-1 descriptor in
`firmware/boards/esp32-s2-devkitc-1.json`.

The S2, S3, and C6 profiles are expected compile-clean by inspection only.
Compilation and hardware-in-the-loop testing are still pending; do not treat
these environments as verified. All four non-classic environments keep UART0
as the protocol transport: S2/S3 expose it through their USB-to-UART bridge
port, and the C6 through its "USB Type-C to UART" port. Only the C3 SuperMini
build uses native USB (`PINOUT_NATIVE_USB_SERIAL`). The C6 requires the
community pioarduino platform (Arduino-ESP32 3.x), which the environment pins
by URL so first builds need network access.

## What it supports

- `sys.hello`, `sys.ping`, `sys.info`
- `gpio.mode`, `gpio.write`, `gpio.batchWrite`, `gpio.stopAll`, `gpio.read`, `gpio.toggle`, `gpio.pulse`
- `gpio.pwm`, `gpio.analogRead`, `gpio.watch`, `gpio.unwatch` (`gpio.changed` events)
- `i2c.begin`, `i2c.write`, `i2c.read`, `i2c.scan` (default SDA 21 / SCL 22)
- `spi.begin`, `spi.transfer` (default SCK 18 / MISO 19 / MOSI 23 / CS 5)
- `gpio.servo` (50 Hz hobby servo on a GPIO)
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

   For the experimental S2/S3 profiles, the same check is
   `pio run -e esp32s2-devkit -e esp32s3-devkit`. The C6 environment is
   opt-in (`pio run -e esp32c6-devkit`) because it downloads the community
   pioarduino platform.

The vector test is host-only and does not require a board. A successful
PlatformIO run is compile evidence; it does not flash or establish
hardware-in-the-loop evidence. For physical verification, follow the
[ESP32 Classic HIL procedure](../../scripts/hil/esp32-classic.md) and add a
dated record under `hardware/records/`.

## Hardware & Reference Circuit

Compile-tested for classic ESP32 DevKit boards (WROOM / 30-pin, `firmware/boards/esp32-devkit-v1.json`). The onboard LED is usually **GPIO 2**.

For the documented low-voltage reference circuit fixture and wiring specifications, see [`hardware/reference/esp32-classic-led-sensor.md`](../../hardware/reference/esp32-classic-led-sensor.md). For the hardware-in-the-loop (HIL) physical verification procedure, see [`scripts/hil/esp32-classic.md`](../../scripts/hil/esp32-classic.md).

Do not use:

- GPIO 6–11 (SPI flash)
- GPIO 1 and 3 (USB serial)
- GPIO 12 (boot strap; held high at reset can prevent boot)
- GPIO 34–39 as outputs (input-only)

## Flashing Policy

Pinout tools **never automatically flash** attached hardware. Firmware must be built and flashed explicitly by an operator following manual visual and USB identity confirmation.

### Flash with PlatformIO

```bash
cd firmware/esp32-bridge
pio run -e esp32dev -t upload
pio device monitor
```

You should see a JSON `ready` event after reset, possibly mixed with ROM boot log lines. The host SDK ignores non-JSON lines.

### Flash with Arduino IDE

1. Install the ESP32 board package.
2. Install **ArduinoJson** 7 from Library Manager.
3. Open `src/main.cpp` (or copy it into a `.ino` sketch).
4. Board: **ESP32 Dev Module**, baud **115200**.
5. Upload.

## Run from Pinout

```bash
npm run pinout -- devices
npm run pinout -- hello --port /dev/cu.usbserial-10
npm run pinout -- gpio write 2 high --port /dev/cu.usbserial-10
npm run pinout -- gpio write 2 low --port /dev/cu.usbserial-10
```

On Linux the port is often `/dev/ttyUSB0` or `/dev/ttyACM0`. On macOS use `/dev/cu.*`, not `/dev/tty.*`.
