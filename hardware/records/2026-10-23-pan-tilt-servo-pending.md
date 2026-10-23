# Pan-tilt hobby servo (ESP32 PWM) — pending physical record

**Date:** 2026-10-23  
**Target:** ESP32 classic + 1–2 hobby servos (desk pan-tilt)  
**Module:** `pinout/pan-tilt`  
**Firmware path:** `gpio.servo` in `firmware/esp32-bridge`  
**Status:** `SIMULATED` / `COMPILE_TESTED` (firmware PWM) — **physical HIL not run**

## Honesty

Simulator conformance and host tests exercise the semantic contract
(`panTilt.arm` / `disarm` / `setAngles` / `status`). The ESP32 backend issues
protocol `gpio.servo` commands. Firmware hobby-servo PWM is **COMPILE_TESTED**
only when PlatformIO builds the classic target. This record does **not** claim
hardware-verified motion, pulse timing, or mechanical safe-angle behavior.

## Planned physical steps (operator)

1. Identify board and adapter; flash only after explicit operator confirmation.
2. Wire pan (and optional tilt) signal wires to commissioned GPIOs; separate
   5 V servo supply with common ground (do not power servos from ESP32 3V3).
3. Commission limits and safe angles in device config; arm; move; disarm;
   confirm safe angles with independent observation (protractor / camera), not
   protocol ACK alone.
4. Replace this pending file with a dated PASS/FAIL record including firmware
   SHA, wiring, commands, and instrument notes.

## Software evidence (this change)

- Host: `packages/core/tests/panTilt.test.ts`, `runPanTiltConformance()`
- Docs: `docs/capabilities.md`, `docs/modules.md`
- Example: `examples/pan-tilt.ts`
