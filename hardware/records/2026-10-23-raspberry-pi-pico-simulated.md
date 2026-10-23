# Raspberry Pi Pico MicroPython bridge — host simulation record

**Date:** 2026-10-23  
**Target:** Raspberry Pi Pico (RP2040) via `firmware/micropython-bridge`  
**Evidence Level:** `SIMULATED` only  

## What was run

- `node firmware/micropython-bridge/validate.js` — generic software-mode wire contract.
- `node firmware/micropython-bridge/validate-pico.js` — Pico `config.py` + `sim/machine.py` stub (blink GPIO 25, reserved pins → `INVALID_PIN`, ADC/I2C/SPI hooks).
- Board descriptor load via `packages/core` board tests (`firmware/boards/raspberry-pi-pico.json`).

## What was not run

- No physical Pico was flashed or observed in this session.
- No PlatformIO / C compile path (MicroPython source deploy only) — do not label `COMPILE_TESTED`.
- Status must not be raised to `HARDWARE_VERIFIED` without a dated physical HIL record.

## Notes

Desk setup for operators: [`docs/raspberry-pi-pico.md`](../../docs/raspberry-pi-pico.md).
