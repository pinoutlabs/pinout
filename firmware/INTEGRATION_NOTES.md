# Firmware workstream integration notes

Handoff notes for shared files that the ESP32-family/MicroPython firmware
workstream must not edit directly. Everything below is a **proposal** for the
maintainer to review and apply; this file is the only shared-surface artifact
this workstream adds.

Scope of the workstream:

- **A.** Core descriptors for ESP32-S2/S3/C6 (`packages/core/src/boards/**`
  plus `firmware/boards/*.json`) and a new test suite.
- **B.** `firmware/esp32-bridge` build variants (`esp32s2-devkit`,
  `esp32s3-devkit`, `esp32c6-devkit`) via compile-time board headers.
- **C.** `firmware/micropython-bridge` error-taxonomy/feature hardening with an
  extended `validate.js` matrix.

Honesty baseline: **nothing here has been compiled, flashed, or run on
hardware.** All three new firmware environments are "expected compile-clean by
inspection; compile + HIL pending". MicroPython remains **EXPERIMENTAL** and
hardware-unverified. No catalog status may exceed `EXPERIMENTAL` for these
targets until a maintainer records compile and physical evidence.

## 1. New and changed files (this workstream)

New:

- `packages/core/tests/esp32FamilyBoards.test.ts` — parity, pin-rule, ADC/PWM
  membership, channel-bound, and classic-descriptor-guard tests.
- `firmware/boards/esp32-s2-devkitc-1.json`,
  `firmware/boards/esp32-s3-devkitc-1.json`,
  `firmware/boards/esp32-c6-devkitc-1.json` — board JSON, exactly equal
  (including array order) to the builtin descriptors.
- `firmware/esp32-bridge/src/boards/board.h` (variant selector),
  `board_esp32s2.h`, `board_esp32s3.h`, `board_esp32c6.h`,
  `ledc_compat.h` (Arduino-ESP32 3.x LEDC shim).
- `firmware/INTEGRATION_NOTES.md` — this file.

Changed:

- `packages/core/src/boards/builtin.ts` — three descriptors plus generalized
  PWM channel bounds. Classic `esp32-devkit-v1` content is unmodified.
- `firmware/esp32-bridge/src/main.cpp` — variant-aware arrays, reserved-pin
  reads, LEDC shim calls, C3 servo/motor channel fix (section 5).
- `firmware/esp32-bridge/platformio.ini` — three opt-in envs.
- `firmware/esp32-bridge/README.md`,
  `firmware/micropython-bridge/{main.py,validate.js,README.md,board-descriptor.json}`
  — documented in their own folders.

Not touched: protocol wire format (v1), `esp32dev` behavior, the simulator,
existing tests, `.github/workflows/ci.yml`, `hardware/catalog.json`, `docs/**`.

## 2. Proposed `hardware/catalog.json` changes

The catalog gate (`scripts/docs-check.mjs`) only requires non-empty `target`,
`status` from the `statuses` list, and `testedHow`. The rows below satisfy it.

### 2a. Replace the `PLANNED` "ESP32-S2 / S3 / C6" row

Delete the current row (target `"ESP32-S2 / S3 / C6"`, `integration:
"planned family descriptors; current pin maps cover classic ESP32 only"`) and
insert three rows, keeping the existing JSON style:

```json
{
  "category": "embedded",
  "target": "ESP32-S2-DevKitC-1",
  "integration": "firmware/esp32-bridge env esp32s2-devkit + @pinout/core esp32-s2 board descriptor + static MCP",
  "status": "EXPERIMENTAL",
  "testedHow": "host-side only: board JSON/descriptor parity, pin-rule, ADC/PWM membership and channel-bound tests in packages/core; firmware compile pending",
  "notes": "Opt-in. PlatformIO 6.5.0 ships no DevKitC-1 definition, so the env builds with the ESP32-S2-Saola-1 definition (same S2 module family, 4 MB flash); the firmware pin table is the DevKitC-1 descriptor. UART0 on GPIO 43/44. Expected compile-clean by inspection; compile and HIL pending. Not certified."
},
{
  "category": "embedded",
  "target": "ESP32-S3-DevKitC-1",
  "integration": "firmware/esp32-bridge env esp32s3-devkit + @pinout/core esp32-s3 board descriptor + static MCP",
  "status": "EXPERIMENTAL",
  "testedHow": "host-side only: board JSON/descriptor parity, pin-rule, ADC/PWM membership and channel-bound tests in packages/core; firmware compile pending",
  "notes": "Opt-in. Same Arduino-ESP32 2.x core line as the classic esp32dev env. UART0 through the USB-to-UART bridge port. GPIO 26-32 (flash) and 33-37 (octal-PSRAM modules) stay reserved. Expected compile-clean by inspection; compile and HIL pending. The onboard addressable RGB LED (GPIO 38 v1.1 / 48 initial) is deliberately not exposed. Not certified."
},
{
  "category": "embedded",
  "target": "ESP32-C6-DevKitC-1",
  "integration": "firmware/esp32-bridge env esp32c6-devkit + @pinout/core esp32-c6 board descriptor + static MCP",
  "status": "EXPERIMENTAL",
  "testedHow": "host-side only: board JSON/descriptor parity, pin-rule, ADC/PWM membership and channel-bound tests in packages/core; firmware compile pending",
  "notes": "Opt-in. Requires the community pioarduino platform (Arduino-ESP32 3.x, pinned by release URL; first build needs network access). LEDC calls go through the src/boards/ledc_compat.h shim, the least-verified code in this workstream. Protocol transport is UART0 on GPIO 16/17 via the board's USB Type-C to UART port. Expected compile-clean by inspection; compile and HIL pending. Not certified."
}
```

### 2b. Refresh the MicroPython row (optional but recommended)

```json
{
  "category": "embedded",
  "target": "MicroPython / CircuitPython boards (generic)",
  "integration": "firmware/micropython-bridge",
  "status": "EXPERIMENTAL",
  "testedHow": "host-side three-part protocol matrix via `node validate.js` (no npm install): software mode, reserved-pin config, and fake-`machine` hardware-mode peripheral-call assertions",
  "notes": "No hardware verification. Runtime capability detection guards machine.* usage; unsupported capabilities fail with structured codes instead of fabricated values. Requires the MicroPython machine module; CircuitPython is not supported."
}
```

Status stays `EXPERIMENTAL`; the fake-`machine` stub is not hardware evidence.

## 3. Proposed CI changes (`.github/workflows/ci.yml`)

### 3a. Compile S2/S3 alongside classic now (low risk)

Both use `espressif32@6.5.0`, the platform the `firmware` job already installs
for `esp32dev`; no new downloads beyond board-variant metadata.

```yaml
      - name: Compile ESP32 firmware (classic + S2/S3, compile-only)
        working-directory: firmware/esp32-bridge
        # C3 and C6 stay opt-in; the release-candidate workflow compiles C3 explicitly.
        run: pio run -e esp32dev -e esp32s2-devkit -e esp32s3-devkit
```

If the S2/S3 artifacts should be kept, extend the upload step:

```yaml
          path: |
            firmware/esp32-bridge/.pio/build/esp32dev/firmware.bin
            firmware/esp32-bridge/.pio/build/esp32dev/firmware.elf
            firmware/esp32-bridge/.pio/build/esp32s2-devkit/firmware.bin
            firmware/esp32-bridge/.pio/build/esp32s2-devkit/firmware.elf
            firmware/esp32-bridge/.pio/build/esp32s3-devkit/firmware.bin
            firmware/esp32-bridge/.pio/build/esp32s3-devkit/firmware.elf
```

### 3b. C6 gate: add only after one successful manual compile

Do **not** add the C6 to CI first, because the pioarduino platform download is
large and the 3.x LEDC shim is the least-verified code. Recommended sequencing:
a maintainer runs `pio run -e esp32c6-devkit` locally, fixes anything the first
real compile surfaces, and only then adds a separate job:

```yaml
  firmware-c6:
    # Opt-in: downloads the community pioarduino platform zip on first run.
    if: >-
      github.event_name != 'pull_request' ||
      (github.event.action == 'labeled' && github.event.label.name == 'ci:run')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event_name == 'workflow_dispatch' && inputs.pr_number != '' && format('refs/pull/{0}/merge', inputs.pr_number) || github.sha }}
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - name: Install PlatformIO
        run: pip install platformio
      - name: Compile ESP32-C6 firmware (compile-only)
        working-directory: firmware/esp32-bridge
        run: pio run -e esp32c6-devkit
```

Artifacts: none until the gate is stable.

## 4. Proposed docs changes

### 4a. `docs/hardware-support.md`

Current closing line of the "Alpha Reference Target" section:

> ESP32-S2/S3/C6, Raspberry Pi, BLE, and industrial protocol integrations remain
> experimental, planned, or software-only as recorded in the catalog.

Proposed replacement:

> ESP32-S2-DevKitC-1, ESP32-S3-DevKitC-1, and ESP32-C6-DevKitC-1 now have
> opt-in experimental firmware environments (`esp32s2-devkit`, `esp32s3-devkit`,
> `esp32c6-devkit`) and validated pin maps under `firmware/boards/`. They have
> not been compiled or hardware-tested yet; the S2 env builds with the
> ESP32-S2-Saola-1 PlatformIO board definition but flashes the DevKitC-1 pin
> table. Raspberry Pi, BLE, and industrial protocol integrations remain
> experimental, planned, or software-only as recorded in the catalog.

### 4b. `docs/three-board-demo.md` (optional)

The demo is intentionally scoped to Uno/classic ESP32/C3, so no behavior change
is proposed while HIL is pending. If a pointer is wanted, add after the
`.venv/bin/pio run -d firmware/esp32-bridge -e esp32dev -e esp32-c3-supermini`
line:

> Experimental S2/S3/C6 environments also exist (`-e esp32s2-devkit`,
> `-e esp32s3-devkit`, `-e esp32c6-devkit`). They are expected compile-clean by
> inspection only and are out of scope for this demo until compile and HIL
> evidence exists.

Once a maintainer has compile (and later HIL) evidence, extend the LED wiring
table with the S2/S3/C6 `GPIO 4` rows and the upload list — the pin maps
already keep GPIO 4 usable and non-input-only on all three.

### 4c. `hardware/records/` (optional)

If the project wants a preparation record analogous to
`hardware/records/2026-09-08-three-board-preparation.md`, a
`2026-10-17-esp32-family-variants-preparation.md` entry could record: files
added, local host-side checks, and "compile + HIL pending". No HIL procedure
exists yet for these boards; `scripts/hil/esp32-classic.md` is the template.

## 5. Behavior changes in shared firmware code (review focus)

### 5a. C3 servo/motor LEDC channel bug fix (`main.cpp`)

- Before: `gpio.servo` hard-coded `8 + pin % 8` (channels 8-15) and
  `gpio.motor` used `pin % 8` (channels 0-7). On the C3 (6 LEDC channels)
  every servo and motor channel was out of range, so those capabilities could
  not work as advertised.
- Now: per-board `pwmChannels`, `motorChannels`, `servoChannelBase`:
  - servo channel = `servoChannelBase + pin % (pwmChannels - servoChannelBase)`
  - motor channel = `pin % motorChannels`
- Classic ESP32 (16/8/base 8): yields exactly the previous `8 + pin % 8` and
  `pin % 8`, so `esp32dev` behavior is unchanged. S2/S3 (8/4/base 4): servo
  4-7, motor 0-3. C3/C6 (6/3/base 3): servo 3-5, motor 0-2.
- `activePwmPins[]` is now sized `board::pwmChannels` and initialized to -1 in
  `setup()`; `gpio.pwm` rejects explicit channels `>= board::pwmChannels` with
  the existing `INVALID_PAYLOAD` shape; `gpio.stopAll` iterates the board's
  real channel count.
- Host core still defaults `pwm.write({pin})` to `channel = pin % 8`; on the
  C6 this means pin 6 → channel 6 is rejected by firmware (`INVALID_PAYLOAD`)
  rather than silently mapped. That is honest rejection, not a bug, but the
  host default and the C6's 6-channel window should be reconciled in a future
  core change if C6 is promoted beyond EXPERIMENTAL.

### 5b. Variant selector semantics (`src/boards/board.h`)

Exactly one `PINOUT_ESP32_*` flag may be defined; zero flags or multiple flags
hit `#error`, so a misconfigured build fails loudly instead of falling back to
classic behavior. `PINOUT_NATIVE_USB_SERIAL` is 1 only for the C3; S2/S3/C6
speak protocol v1 over UART0 at 115200 8N1 (S2/S3 through their USB-to-UART
bridge, C6 through the "USB Type-C to UART" port).

### 5c. LEDC compatibility shim (`ledc_compat.h`)

Core 2.x (classic/S2/S3) maps to `ledcSetup`/`ledcAttachPin`/`ledcWrite`/
`ledcDetachPin`. Core 3.x (C6) maps to `ledcAttachChannel`/`ledcWriteChannel`/
`ledcDetach` with the channel passed explicitly. Static inspection only — this
is the first thing a real C6 compile should exercise.

## 6. Known limitations and follow-ups

- **Compile/HIL:** none of the three new envs has been compiled or tested on
  hardware. The S2/S3/C6 core tests are host-side only.
- **S2 build board:** PlatformIO 6.5.0 has no `esp32-s2-devkitc-1`
  definition; the env uses `board = esp32-s2-saola-1`. If a future platform
  release adds a proper definition, switch the env and re-verify.
- **C6 toolchain:** pinned by release URL (pioarduino `55.03.312-1`, Arduino-
  ESP32 3.3.12). Network access required on first build; consider checksum
  pinning if the project wants it.
- **Omitted descriptor fields:** the three new board JSONs omit `usb` and
  `adcMax` (classic-only fields, S2/S3/C6 ADC attenuation ranges differ).
  Fill only from vendor-verified data; the parity test does not require them.
- **MicroPython v0.2.0:** requires the `machine` module; capability
  advertisement is guarded, structured error codes replace silent behavior
  (`INVALID_PIN`, `INVALID_PAYLOAD`, `UNSUPPORTED_CAPABILITY`, `BUS_ERROR`,
  `WATCH_TABLE_FULL`, `UNSUPPORTED_ACTION`, `ACTION_FAILED`), and
  `gpio.servo` (50 Hz) is advertised. CircuitPython explicitly unsupported.
  The `validate.js` fake-`machine` run logs peripheral calls but is not
  hardware evidence; status stays EXPERIMENTAL.
- **Protocol:** v1 wire format and `esp32dev` responses are untouched; no
  golden vector changes were needed.

## 7. Verification evidence gathered (and what is still pending)

Run locally in this workstream (all allowed: plain `node`/`python3`, no
installs, no builds):

- `node firmware/micropython-bridge/validate.js` → `PASS: software,
  reserved-pin and fake-hardware matrices match the v1 wire contract`, 59 `ok`
  checks + 2 cross-checks, exit 0.
- `python3 -m py_compile firmware/micropython-bridge/main.py` → pass.
- `python3 -m json.tool firmware/micropython-bridge/board-descriptor.json` →
  pass.
- `node --check firmware/micropython-bridge/validate.js` → pass.
- Board JSON ↔ builtin descriptor byte-level parity regenerated and compared
  with a temporary throwaway script (not committed) for all three new boards;
  classic descriptor and existing tests untouched.
- Formatting: no non-string JS/JSON line exceeds 100 columns in changed files
  (long lines are string literals, which prettier cannot wrap).

Recommended maintainer follow-up:

```bash
cd firmware/esp32-bridge
pio run -e esp32dev -e esp32s2-devkit -e esp32s3-devkit   # expected pass; record it
pio run -e esp32c6-devkit                                  # first real shim exercise; downloads platform
npx vitest run packages/core/tests/esp32FamilyBoards.test.ts packages/mcp/tests/threeBoards.test.ts
```

Pending by constraint: any `pio run`, any TypeScript build/test execution, and
any hardware-in-the-loop run. Until those happen, every claim about the three
new environments must stay at "expected compile-clean; compile + HIL pending".
