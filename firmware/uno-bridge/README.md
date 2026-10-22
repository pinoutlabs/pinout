# Uno bridge

Pinout protocol v1 for Arduino Uno R3 / ATmega328P. Compile with `pio run -d firmware/uno-bridge` from the repository root. Explicit upload and wiring are in [the three-board guide](../../docs/three-board-demo.md).

Implements identity, ping, diagnostics, arming/disarming, heartbeat, per-output low/high/high-z safe state, digital mode/read/write, ADC, and stop-all. No PWM or bus/motor support is advertised. UART pins 0/1 are reserved; A0–A5 are 14–19. The board starts disarmed. Watchdog timeout is 250–10000 ms, default 1000; expiry applies safe outputs and requires explicit re-arming.

RX is bounded to 255 bytes plus newline; oversized frames are discarded in full. No dynamic Arduino `String` allocation. Firmware compilation checks the actual 2 KB SRAM / 32 KB flash target. `node scripts/test-uno-firmware.mjs` runs the same source against simulated GPIO/time after PlatformIO installs ArduinoJson. Physical USB, timing, and electrical behavior remain pending.
