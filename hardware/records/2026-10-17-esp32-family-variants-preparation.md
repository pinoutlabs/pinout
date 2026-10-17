# ESP32 family variants — software preparation — 2026-10-17

Scope: ESP32-S2-DevKitC-1, ESP32-S3-DevKitC-1, ESP32-C6-DevKitC-1 descriptors,
firmware variant environments, and MicroPython bridge hardening. Local working
tree; **nothing was compiled, flashed, or run on hardware**. No
`HARDWARE_VERIFIED` status is claimed, and none of the new targets exceed
`EXPERIMENTAL`.

| Acceptance | Result | Evidence |
| --- | --- | --- |
| Board descriptors + JSON parity (S2/S3/C6) | PASS, host-side | `packages/core/tests/esp32FamilyBoards.test.ts` (written; execution pending — `node_modules` absent in this workspace); byte-level JSON↔descriptor parity regenerated and compared |
| Firmware variant pin tables + `#error` selector | PASS, inspection | `firmware/esp32-bridge/src/boards/{board,board_esp32s2,board_esp32s3,board_esp32c6,ledc_compat}.h`; zero/multiple variant flags fail loudly |
| Classic `esp32dev` behavior preserved | PASS, inspection | Per-board channel math reduces to the previous `8 + pin % 8` / `pin % 8` on classic; no protocol or payload changes |
| C3 servo/motor LEDC channel fix | PASS, inspection | Per-board `pwmChannels`/`motorChannels`/`servoChannelBase` replace the out-of-range hard-coded channels |
| PlatformIO envs added (opt-in) | NOT RUN | `esp32s2-devkit`, `esp32s3-devkit`, `esp32c6-devkit`; PlatformIO is not installed here. CI now compiles S2/S3 alongside classic; C6 requires the pioarduino platform and stays manual-first |
| MicroPython bridge v0.2.0 matrix | PASS, host-side | `node validate.js` exit 0: "software, reserved-pin and fake-hardware matrices match the v1 wire contract", 59 `ok` checks + 2 cross-checks |
| MicroPython syntax / descriptor JSON | PASS | `python3 -m py_compile main.py`; `python3 -m json.tool board-descriptor.json`; `node --check validate.js` |
| TypeScript suite execution | PENDING | No `node_modules`/install permitted in this session; tests are written but never executed |
| Firmware compile (all variants) | PENDING | `pio run` not performed; expected compile-clean by inspection only |
| Physical HIL (identity, actuation, watchdog) | PENDING | No attached supported hardware; requires operator-observed dated runs |

MicroPython remains `EXPERIMENTAL` and requires the MicroPython `machine`
module; CircuitPython is explicitly unsupported. The `validate.js` fake-`machine`
stub logs peripheral calls but is not hardware evidence. See
[`firmware/INTEGRATION_NOTES.md`](../../firmware/INTEGRATION_NOTES.md) for
review notes, the C6 LEDC shim caveat, and S2 build-board limitations.
