# Hardware support

The authoritative matrix is [`hardware/catalog.json`](../hardware/catalog.json). This page explains how to read it; it intentionally does not duplicate rows that can drift.

## Evidence Levels

- `SIMULATED`, `COMPILE_TESTED`, `IMPLEMENTED`, and `INTEGRATION_VERIFIED` describe software evidence.
- `HARDWARE_VERIFIED` is strictly reserved for an operator-observed, dated hardware record under `hardware/records/` and does not imply certification or suitability for mains equipment.

## Alpha Reference Target: ESP32 Classic

For the alpha release, the classic ESP32 DevKit (`esp32-devkit-v1` / ESP-WROOM-32 30-pin) firmware is the reference embedded target:

- **Catalog Status:** `COMPILE_TESTED` (firmware builds cleanly under PlatformIO; GPIO/PWM/ADC/I2C/SPI logic tested against simulator; serial transport verified).
- **Physical Verification:** **PENDING** — physical hardware-in-the-loop (HIL) execution has not yet been conducted.
- **Reference Circuit:** See [`hardware/reference/esp32-classic-led-sensor.md`](../hardware/reference/esp32-classic-led-sensor.md) for the documented low-voltage LED and sensor test fixture (including active-high, active-low, and button wiring).
- **HIL Test Procedure:** See [`scripts/hil/esp32-classic.md`](../scripts/hil/esp32-classic.md) for the step-by-step physical test matrix, including separate recording of protocol acknowledgments and physical oscilloscope measurements.
- **Test Records:** Tracked in [`hardware/records/2026-09-04-esp32-classic-pending.md`](../hardware/records/2026-09-04-esp32-classic-pending.md) and [`hardware/records/2026-09-05-esp32-classic-reference-circuit-pending.md`](../hardware/records/2026-09-05-esp32-classic-reference-circuit-pending.md).

Uno R3 and ESP32-C3 SuperMini are now compile-tested with board-aware host validation and static MCP integration; physical HIL remains pending. See [the three-board guide](three-board-demo.md).

## Raspberry Pi Pico (MicroPython, SIMULATED)

Desk/school path over USB CDC — cheap Pico boards, no PlatformIO flash cycle:

- **Catalog Status:** `SIMULATED` (host validators `validate.js` / `validate-pico.js`; Pico pin policy and `sim/machine.py` stubs).
- **Physical Verification:** **PENDING** — not HARDWARE_VERIFIED.
- **Setup:** [Raspberry Pi Pico + MicroPython bridge](raspberry-pi-pico.md) (flash UF2, deploy `main.py` + Pico `config.py`, blink GPIO 25).
- **Board descriptor:** [`firmware/boards/raspberry-pi-pico.json`](../firmware/boards/raspberry-pi-pico.json).

ESP32-S2/S3/C6 and industrial protocol integrations remain experimental, planned, or software-only as recorded in the catalog. BLE GATT transport is **SIMULATED** on the host (CI) with an adjacent firmware sketch marked **COMPILE_TESTED** only when PlatformIO succeeds — see [ble-gatt.md](ble-gatt.md). Advertisement-only BLE discovery is available in `@pinout/discovery` (never connects or writes GATT); no physical transport HIL record yet.

## Room Environment Sensor — BME280 / DHT (SIMULATED)

External maker module for room temperature, humidity, and (BME280) pressure:

- **Catalog Status:** `SIMULATED` (in-process simulator + evidence-contract unit tests under `examples/external-module/room-sensor`).
- **Physical Verification:** **PENDING** — ESP32/MicroPython wiring notes are documentation only; no dated HIL record.
- **Documentation:** See [`docs/room-sensor.md`](room-sensor.md). Product-specific drivers stay outside `@pinout/core`.

## Modbus Lamp Backend (SIMULATED)

The second physical backend for the semantic `lamp` contract is implemented over Modbus TCP / RTU (`@pinout/protocols-modbus`):

- **Catalog Status:** `SIMULATED` (tested in software against `SimulatedModbusServer` and `@pinout/core` shared lamp conformance suite).
- **Physical Verification:** **PENDING** — physical bench tests with physical Modbus Remote I/O units or PLCs are tracked in [`hardware/records/2026-09-05-modbus-lamp-pending.md`](../hardware/records/2026-09-05-modbus-lamp-pending.md).
- **Documentation:** See [`docs/lamp-modbus.md`](lamp-modbus.md) for coil actuation, discrete input observation, and watchdog safety details.

## MQTT Lamp / Plug Backend (SIMULATED)

Home Wi-Fi lamp and smart-plug control over MQTT (`@pinout/protocols-mqtt`), using declarative Tasmota/Shelly topic templates:

- **Catalog Status:** `SIMULATED` (tested against in-process `MqttBrokerSimulator` and `@pinout/core` shared lamp conformance suite).
- **Physical Verification:** **NOT DONE** — not exercised against Mosquitto/EMQX or physical Tasmota/Shelly devices in this tree.
- **Documentation:** See [`docs/lamp-mqtt.md`](lamp-mqtt.md) for topic presets, evidence mapping, and LAN Mosquitto configuration notes.

SCPI (`pinout/scpi-power-supply`), GRBL (`pinout/grbl`), MQTT bridge (`pinout/mqtt-bridge`), MQTT lamp (`pinout/mqtt-lamp`), and Modbus register-map backends are simulator-tested DeviceBackends for runtime registration; none are HARDWARE_VERIFIED.

## Flashing Policy: Never Auto-Flash Unidentified Hardware

Pinout enforces a strict safety boundary around device flashing:

1. **No Auto-Flashing:** Pinout does not automatically flash firmware or upload code to attached serial devices. Discovery (`pinout discover`) and port listing (`pinout ports`) are strictly passive and read-only; enrollment (`pinout enroll`) handshakes only with already-running Pinout firmware.
2. **Hard Requirement for Flashing Tooling:** Any future flashing utility or command must refuse to proceed unless:
   - The target board is positively identified (USB VID/PID matching a known descriptor in `firmware/boards/`, or an explicit `--board <board-id>` flag).
   - The operator explicitly confirms the flash operation (interactive prompt or `--yes` flag).
3. **Manual Flash Workflow:** Firmware upload is performed explicitly by the operator using PlatformIO (`pio run -e esp32dev -t upload`) or Arduino IDE after verifying the physical board identity and wiring.
