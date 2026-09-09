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
| 2026-09-09 | ESP32 classic (`esp32dev`) | Compile only | [`2026-09-09-esp32-classic-compile.md`](2026-09-09-esp32-classic-compile.md) | `COMPILE_TESTED` / Passed |
