# Modbus Lamp HIL Procedure & Evidence Matrix

Physical backend for `@pinout/protocols-modbus`: coil write + separate discrete-input readback. Reading back the same coil is `acknowledged`, never `observed`.

> Rules: never auto-flash a PLC. Catalog stays `SIMULATED` until a dated `hardware/records/` entry exists. `observed` only from the discrete input.

## Equipment

- Modbus TCP/RTU coupler (eg ADAM-6050, ioLogik E1212, or PLC slave)
- 24 V indicator lamp/relay on coil 0, independent optical/current sensor on discrete input 1
- DMM or scope for coil vs sensor timing

## Procedure

1. Record coupler model, firmware, IP/port or serial path, host OS, git SHA.
2. Wire lamp to DO 0 (coil 0). Wire independent sensor to DI 1. No shared sense wire.
3. Configure backend with `requireWatchdog: false` explicitly (slave has no deadman; do not advertise ESP32 guarantees).
4. Run semantic flow: `lamp.arm` -> `on` -> `status` -> `off` -> `disarm`.
5. Wiring-fault case: force discrete input to disagree with coil, confirm `status` reports mismatch and `observed` reflects sensor, not coil echo.

## Evidence matrix (copy into record)

| Step | Command | Coil ACK | Discrete input | Physical observation |
| :--- | :--- | :--- | :--- | :--- |
| 1.1 | `lamp.arm` | | n/a | operator + lamp state |
| 1.2 | `lamp.on` | coil 0 accepted | DI 1 level + timestamp | lamp lit? sensor voltage? |
| 1.3 | `lamp.status` | coil echo (`acknowledged`) | DI 1 (`observed`, source) | photo of lamp + meter reading |
| 1.4 | fault: DI disagrees | coil state | DI state + `observed` | how disagreement was forced |
| 1.5 | `lamp.off` -> `disarm` | coil safe level | DI safe level | lamp dark, meter at 0 |

Refs: `docs/lamp-modbus.md`, `packages/protocols-modbus/tests/lampBackend.test.ts`, `hardware/records/2026-09-05-modbus-lamp-pending.md`.
