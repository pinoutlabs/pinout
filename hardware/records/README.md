# Hardware records

Each record is an operator-observed, dated HIL result. Include board and
adapter identity, OS/tool versions, firmware SHA, exact commands, wiring, and
raw protocol/journal excerpts. Automated simulator or compile tests are not
hardware evidence.

## Index of Records

| Date | Target | Type | Record File | Status |
| :--- | :--- | :--- | :--- | :--- |
| 2026-09-04 | ESP32 Classic DevKit | Basic HIL Check | [`2026-09-04-esp32-classic-pending.md`](2026-09-04-esp32-classic-pending.md) | `NOT RUN` / Pending |
| 2026-09-05 | ESP32 Classic DevKit | Reference Circuit & Safe State | [`2026-09-05-esp32-classic-reference-circuit-pending.md`](2026-09-05-esp32-classic-reference-circuit-pending.md) | `NOT RUN` / Pending |
| 2026-09-05 | Modbus TCP/RTU coupler | Lamp backend (coil + DI) | [`2026-09-05-modbus-lamp-pending.md`](2026-09-05-modbus-lamp-pending.md) | `SIMULATED` / Pending |
| 2026-09-08 | Uno + ESP32 classic + C3 | Three-board prep (compile + MCP static) | [`2026-09-08-three-board-preparation.md`](2026-09-08-three-board-preparation.md) | `COMPILE_TESTED` / LEDs pending |
| 2026-10-07 | ESP32 classic (`esp32dev`) | Compile-only gate (no flash) | [`2026-10-07-esp32-classic-compile-pending.md`](2026-10-07-esp32-classic-compile-pending.md) | `NOT RUN` / Pending |

New records: copy `scripts/hil/esp32-classic.md`, `scripts/hil/modbus-lamp.md`, or `scripts/hil/crash-window-b-lamp.md` evidence matrix into a dated file. Never overwrite another operator's record.
