# ESP32 classic compile record — 2026-09-09

Evidence level: **COMPILE_TESTED**. This is a host build, not a physical HIL result.
Tracking issue: [#14](https://github.com/pinoutlabs/pinout/issues/14).

## Source and tools

- Source commit: `122a44e96acbd04a5b256dc66347658245ccb25c` (upstream `main`). Firmware sources and configuration were unchanged for this run.
- Host: macOS 27.0 (26A5406e), arm64.
- PlatformIO Core: 6.2.0, invoked through `uvx --from platformio`.
- Environment: `esp32dev`; platform `espressif32@6.5.0`; board `esp32dev`.
- Framework: Arduino-ESP32 2.0.14 (`framework-arduinoespressif32` 3.20014.231204).
- Compiler: `xtensa-esp32-elf-g++` 8.4.0, crosstool-NG esp-2021r2-patch5.
- Libraries: ArduinoJson 7.4.3, SPI 2.0.0, Wire 2.0.0.

## Command and result

From `firmware/esp32-bridge`:

```sh
uvx --from platformio pio run -e esp32dev
```

This executes the same `pio run -e esp32dev` compile used by the selected CI firmware job.
Exit status: **0**. Environment result: **SUCCESS**, 14.395 seconds.

```text
RAM:     7.3% (23904 bytes of 327680)
Flash:  24.9% (325745 bytes of 1310720)
Successfully created esp32 image.
esp32dev       SUCCESS   00:00:14.395
```

Build emitted deprecation warnings from the ArduinoJson compatibility API; they did not prevent compilation.

## Artifacts and advertised identity

The build produced these local artifacts; binaries are not checked into Git:

| Artifact | SHA-256 |
| --- | --- |
| `.pio/build/esp32dev/firmware.bin` | `18a16e94bca7ea12bff459e8e080db59468f6685eb9fe6f4e11c60bc857433a1` |
| `.pio/build/esp32dev/firmware.elf` | `3460f793695cd21c273af84c45a2655932a4423b2f1445642d4470f593abc01d` |

Identity constants compiled from `src/main.cpp`, used by the `sys.hello` response:

```json
{"firmware":"esp32-bridge","version":"0.0.1-alpha.1","protocol":1}
```

These fields were read from source, not from a connected board. No upload, serial handshake, GPIO action, or physical observation was performed. Catalog status remains unchanged. Physical acceptance items remain pending.
