# Three-board software preparation — 2026-09-08

Scope: Uno R3 / ATmega328P, classic ESP32 DevKit / WROOM, ESP32-C3 SuperMini native USB. Local working tree; no firmware uploaded and no physical LED observed. Serial enumeration found no supported USB board. No HARDWARE_VERIFIED status is claimed.

| Acceptance | Result | Evidence |
| --- | --- | --- |
| Static MCP tools before/after attaching/removing boards | PASS, software | `packages/mcp/tests/threeBoards.test.ts`: all three board identities; tools/list stays identical |
| Firmware identity selects pin map and capabilities | PASS, software | Board-specific host validation; runtime filters firmware-advertised capabilities; C3 straps 2/8/9 blocked |
| Uno A1 LED protocol flow | PASS, software | GPIO 15 through MCP → daemon → scripted transport; actual Uno firmware source harness exercises GPIO 15 |
| Explicit arm, heartbeat, pin/capability denials, reconnect disarmed | PASS, software | Three-board integration tests; legacy watchdog/arming regression suites |
| Actual shipped daemon + stdio MCP process | PASS, local process | `pinoutd --discover` with isolated home; MCP initialized, automatically loaded local token, listed 11 tools and empty device registry |
| Three-second smoke CLI through real MCP subprocess | PASS, software | Uno scripted board fixture; high/low readback and cleanup verified |
| Uno firmware build | PASS, compile | PlatformIO atmelavr 5.1.0, ArduinoJson 6.21.5; 1,197 / 2,048 bytes static RAM, 12,714 / 32,256 bytes flash |
| Classic ESP32 firmware build | PASS, compile | PlatformIO espressif32 6.5.0, `esp32dev` |
| C3 firmware build | PASS, compile | PlatformIO espressif32 6.5.0, `esp32-c3-supermini` |
| Uno firmware source harness | PASS, simulated GPIO/time | Active-low watchdog expiry, boot disarmed, invalid pins, unsupported PWM, A1 read/write, ADC, oversized-frame recovery |
| Repository regression suite | PASS | 100 test files, 763 tests; subsequent enhanced smoke test also passed |
| Build, test typecheck, lint, docs validation | PASS | Local commands; see guide for reproduction |
| USB reset/upload behavior on actual boards | PENDING | No attached supported hardware |
| LED visibly lights and turns off on all three boards | PENDING | Operator-observed bench run required |
| Physical watchdog expiry timing and active-low electrical behavior | PENDING | Measure on hardware; host harness is not timing evidence |

The installed ESP32 Arduino core emits a pre-existing `uartSetPins` return-value warning; both target builds complete successfully. Compile status does not establish electrical behavior, signal timing, or support for unrelated board variants.

Follow [the demo guide](../../docs/three-board-demo.md) for flashing, wiring, a single MCP configuration, the video prompt, and physical acceptance steps. Record tomorrow's observations separately; do not replace pending physical evidence with these software results.
