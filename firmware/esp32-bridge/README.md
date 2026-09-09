# ESP32 bridge firmware

Minimal firmware that speaks Pinout protocol v1 over USB serial (UART0 at 115200 8N1).

It does not implement a full board support package. It accepts structured commands, validates them, executes GPIO read/write, and returns JSON responses.

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
output activated by the bridge low and clears PWM channels. It is not a certified safety
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

The vector test is host-only and does not require a board. A successful
PlatformIO run is compile evidence; it does not flash or establish
hardware-in-the-loop evidence. For physical verification, follow the
[ESP32 Classic HIL procedure](../../scripts/hil/esp32-classic.md) and add a
dated record under `hardware/records/`.

## Hardware & Reference Circuit

Tested against classic ESP32 DevKit boards (WROOM / 30-pin, `firmware/boards/esp32-devkit-v1.json`). The onboard LED is usually **GPIO 2**.

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
