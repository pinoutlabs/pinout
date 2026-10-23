# Raspberry Pi Pico + MicroPython bridge

First-time desk/school path: a cheap Pico, MicroPython, and Pinout's shared
NDJSON protocol over USB. No PlatformIO toolchain and no factory protocols.

## Evidence (honesty)

| Claim | Status |
| --- | --- |
| Host protocol + Pico pin-policy tests | **SIMULATED** (`node validate.js`, `node validate-pico.js` in CI) |
| Firmware compile (C/PlatformIO) | **N/A** — this path is MicroPython source, not a compiled binary |
| Physical LED / sensor on a real Pico | **Not HARDWARE_VERIFIED** — confirm yourself after flashing |

Catalog row: `hardware/catalog.json` → Raspberry Pi Pico / Pico W (RP2040).
Do not treat a green simulator run as a blink on hardware.

## What you need

- Raspberry Pi Pico (non-W preferred for the onboard LED on GPIO 25)
- USB data cable
- [MicroPython UF2 for RPI_PICO](https://micropython.org/download/RPI_PICO/)
- Host tools: `mpremote` (`pip install mpremote`) or Thonny
- This repository checked out

Pico W works for USB serial and GPIO, but the onboard LED is **not** GPIO 25;
use an external LED on a free GPIO if you want a blink demo on Pico W.

## 1. Flash MicroPython

1. Hold the **BOOTSEL** button, plug USB into the host, then release BOOTSEL.
2. The board appears as a USB mass-storage device (often named `RPI-RP2`).
3. Copy the MicroPython `.uf2` onto that drive. The board reboots into
   MicroPython (USB CDC serial; VID/PID typically `2e8a:0005`).

BOOTSEL mode itself is `2e8a:0003` — that is the bootloader, not the bridge.

## 2. Deploy the Pinout bridge

From the repository root:

```bash
cd firmware/micropython-bridge
mpremote cp main.py :
mpremote cp boards/raspberry-pi-pico/config.py :config.py
mpremote reset
```

Thonny: open both files, save `main.py` and `config.py` to the Pico
filesystem (config must be named `config.py` on the board).

After reset the bridge emits a `ready` event, then accepts Pinout requests on
the USB serial port (`/dev/ttyACM0` on Linux, `/dev/cu.usbmodem*` on macOS,
`COMx` on Windows). Host baud is typically **115200 8N1**.

## 3. Blink the onboard LED (GPIO 25)

Send NDJSON lines (one JSON object per line). Example with a serial monitor or
any tool that writes lines to the port:

```json
{"v":1,"id":"1","action":"sys.hello","payload":{}}
{"v":1,"id":"2","action":"gpio.write","payload":{"pin":25,"value":1}}
{"v":1,"id":"3","action":"gpio.toggle","payload":{"pin":25}}
```

Expect `ok: true` responses with `result.pin` / `result.value`. Reserved pins
`23`, `24`, and `29` return `error.code: "INVALID_PIN"`.

Pin map source of truth: [`firmware/boards/raspberry-pi-pico.json`](../firmware/boards/raspberry-pi-pico.json).

## 4. Sensor-ready hooks (I2C / ADC / SPI)

The Pico profile defaults match the board descriptor:

| Bus | Pins |
| --- | --- |
| I2C | SDA **GP4**, SCL **GP5** |
| SPI | SCK **GP18**, MISO **GP16**, MOSI **GP19**, CS **GP17** |
| ADC | **GP26**, **GP27**, **GP28** |

Example I2C scan / ADC read (after wiring a 3.3 V sensor — never 5 V logic):

```json
{"v":1,"id":"10","action":"i2c.scan","payload":{}}
{"v":1,"id":"11","action":"adc.read","payload":{"pin":26}}
```

These actions use the same capability names as the ESP32 bridge dialect
(`i2c.*`, `adc.read`, `spi.transfer`). Unsupported or misconfigured calls fail
with structured `error.code` values — they do not invent sensor readings.

## 5. Host tests without hardware (CI)

```bash
cd firmware/micropython-bridge
node validate.js        # generic software mode
node validate-pico.js   # Pico config + sim/machine.py stub
```

`validate-pico.js` puts `boards/raspberry-pi-pico` and `sim/` on `PYTHONPATH`
so the bridge sees Pico pin policy and a fake `machine` module. That proves
protocol and policy shape only (**SIMULATED**).

## Safety notes

- Pinout never auto-flashes attached hardware. You copy UF2 / `main.py` yourself.
- 3.3 V logic only.
- Do not drive reserved pins 23 / 24 / 29.
- This bridge does **not** implement ESP32 arming/watchdog features yet; treat
  it as an experimental desk actuator path and keep power/current limits sane.

## Related

- Bridge source: [`firmware/micropython-bridge`](../firmware/micropython-bridge/)
- Hardware support matrix: [`docs/hardware-support.md`](hardware-support.md)
- Wire protocol: [`docs/protocol.md`](protocol.md)
