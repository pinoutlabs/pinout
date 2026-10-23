# Hardware records

Physical HIL records contain operator-observed, dated results. Include board and
adapter identity, OS/tool versions, firmware SHA, exact commands, wiring, and
raw protocol/journal excerpts. Automated simulator or compile tests are not
hardware evidence.

Compile-only records are also indexed below with an explicit `COMPILE_TESTED`
type; they do not qualify a device for `HARDWARE_VERIFIED` status.

## Index of Records

| Date | Target | Type | Record File | Status |
| :--- | :--- | :--- | :--- | :--- |
| 2026-09-04 | ESP32 Classic DevKit | Basic HIL Check | [`2026-09-04-esp32-classic-pending.md`](2026-09-04-esp32-classic-pending.md) | `NOT RUN` / Pending |
| 2026-09-05 | ESP32 Classic DevKit | Reference Circuit & Safe State | [`2026-09-05-esp32-classic-reference-circuit-pending.md`](2026-09-05-esp32-classic-reference-circuit-pending.md) | `NOT RUN` / Pending |
| 2026-09-05 | Modbus TCP/RTU coupler | Lamp backend (coil + DI) | [`2026-09-05-modbus-lamp-pending.md`](2026-09-05-modbus-lamp-pending.md) | `SIMULATED` / Pending |
| 2026-09-08 | Uno + ESP32 classic + C3 | Three-board prep (compile + MCP static) | [`2026-09-08-three-board-preparation.md`](2026-09-08-three-board-preparation.md) | `COMPILE_TESTED` / LEDs pending |
| 2026-09-09 | ESP32 classic (`esp32dev`) | Compile only | [`2026-09-09-esp32-classic-compile.md`](2026-09-09-esp32-classic-compile.md) | `COMPILE_TESTED` / Passed |
| 2026-10-23 | Raspberry Pi Pico (MicroPython) | Host sim validators | [`2026-10-23-raspberry-pi-pico-simulated.md`](2026-10-23-raspberry-pi-pico-simulated.md) | `SIMULATED` / Passed |
| 2026-10-07 | ESP32 classic (`esp32dev`) | Compile-only gate (no flash) | [`2026-10-07-esp32-classic-compile-pending.md`](2026-10-07-esp32-classic-compile-pending.md) | `NOT RUN` / Pending (superseded by 2026-09-09 Passed compile record; kept for history) |
| 2026-10-23 | ESP32 + hobby servos | Pan-tilt module (`gpio.servo`) | [`2026-10-23-pan-tilt-servo-pending.md`](2026-10-23-pan-tilt-servo-pending.md) | `SIMULATED` / `COMPILE_TESTED` firmware path; HIL pending |

New records: copy `scripts/hil/esp32-classic.md`, `scripts/hil/modbus-lamp.md`, or `scripts/hil/crash-window-b-lamp.md` evidence matrix into a dated file. Never overwrite another operator's record.
