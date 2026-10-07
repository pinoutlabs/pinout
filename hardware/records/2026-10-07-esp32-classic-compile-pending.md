# ESP32 Classic Compile Record — Pending

## Status: NOT RUN / PENDING

**Date:** 2026-10-07
**Evidence level:** `NOT RUN` (compile-only; no board, no flash, no HIL claim)
**Target:** `firmware/esp32-bridge`, env `esp32dev`

## What to run (compile-only, no upload)

```bash
pip install platformio
cd firmware/esp32-bridge
pio run -e esp32dev
```

Record here: PlatformIO Core version, `platform = espressif32@6.5.0`, board `esp32dev`, git SHA, exit status, and firmware identity the binary would advertise (`firmware`, `version`, `protocol`). Do not run `-t upload`. Do not raise catalog above `COMPILE_TESTED` from this issue alone.

Refs: issue #14, `firmware/esp32-bridge/README.md`, `docs/acceptance-ledger.md` Phase 2.
