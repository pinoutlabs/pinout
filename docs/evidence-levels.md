# Evidence levels

Pinout uses one canonical **SupportLevel** so agents and humans do not confuse
catalog rows, module manifests, conformance ladders, and generator provenance:

| SupportLevel | Meaning |
| --- | --- |
| `UNKNOWN` | Spec, plan, experimental, or candidate — not yet simulated or compiled as evidence. |
| `SIMULATED` | Contract exercised against a fake / in-process backend. |
| `COMPILE_TESTED` | Firmware or package builds (or integration tests) succeed in CI; **not** physical HIL. |
| `HARDWARE_VERIFIED` | Operator-observed physical test with a **dated** file under `hardware/records/`. |

Source of truth for the type and mappers: `packages/core/src/spec/supportLevel.ts`
(exported from `@pinout/core`). Existing vocabularies are **not** deleted; they
map into SupportLevel:

- Module manifest `CANDIDATE` / `REVIEWED` / `TESTED`
- Spec `SupportStatus` (`IMPLEMENTED`, `SIMULATED`, …)
- `hardware/catalog.json` statuses (eight values)
- Conformance `L0`–`L5` (L5 → `HARDWARE_VERIFIED` only with a dated record)
- Generator lifecycle `GENERATED` … `HARDWARE_TESTED`

## Honesty rules

1. **Nothing in this repository is HARDWARE_VERIFIED** until a dated
   `hardware/records/` entry exists. Compile success and simulators never
   inflate to hardware verification.
2. **Generated / auto-built modules never exceed `COMPILE_TESTED`** without that
   dated record (`applyEvidenceRules` / `mapFromGeneratorLifecycle`).
3. **Pinout never auto-flashes** unidentified hardware. Discovery and enrollment
   are read-only / handshake-only.

See also [hardware-support.md](hardware-support.md) and
[`hardware/catalog.json`](../hardware/catalog.json).

## ESP32-S3 firmware target names

The S3 board descriptor (`firmware/boards/esp32-s3-devkitc-1.json`) sets
`firmwareTarget` to **`esp32-s3-devkitc-1`**, matching the release PlatformIO
environment used for `COMPILE_TESTED` evidence. The local alias
`esp32s3-devkit` in `firmware/esp32-bridge/platformio.ini` builds the same
board profile; prefer the release env name in docs and descriptors.
