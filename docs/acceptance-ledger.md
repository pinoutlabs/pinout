# Pinout Acceptance Ledger (Phases 1–5)

**Baseline Commit:** `64d69cc`  
**Execution Scope:** Phases 1–5 implementation brief (`docs/PINOUT_REVIEW_AND_PLAN.md`)  
**Evaluated Date:** 2026-09-05 (firmware compile row refreshed 2026-09-09)

**Evidence Rules:**
- `PASSED`: Verified in full test suites, static analysis, and runtime verification tools.
- `PARTIAL`: Verified in software/simulation with honest limitations; physical verification or live operator trial pending.
- `BLOCKED`: Requires physical hardware, external instruments, human operator trials, or external robotics simulators unavailable in this environment.
- `NOT RUN`: Build/compile tooling (e.g. PlatformIO `pio`) was not available or not executed in this session.

---

## Phase 1 — Repair the Usable Agent Entrypoint

| Acceptance Item | Status | Evidence | Notes |
| :--- | :--- | :--- | :--- |
| MCP stdio subprocess full flow (daemon-backed) | **PASSED** | `packages/mcp/tests/stdioSubprocess.test.ts` (`runs full daemon-backed flow`), commit `309df1c` | Initializes, lists tools, describes device, acquires lease, invokes capability, reads state, and shuts down cleanly. |
| MCP session duration & persistent connection | **PASSED** | `packages/mcp/tests/stdioSubprocess.test.ts` (`stays connected across multiple sequential requests`), commit `309df1c` | Transport maintains session lifetime across multiple calls rather than exiting prematurely. |
| MCP clean process exit on stdin EOF / signals | **PASSED** | `packages/mcp/src/runStdio.ts`, `docs/mcp.md`, commits `309df1c`, `3309b4e` | Process exits with code 0 on EOF, `SIGINT`, and `SIGTERM` without hung event loops. |
| MCP embedded mode lifetime | **PASSED** | `packages/mcp/tests/stdioSubprocess.test.ts` (`embedded server runs and terminates cleanly on client close`), commit `309df1c` | Embedded server runs simulated runtime and exits cleanly on EOF. |
| MCP demo mode lifetime | **PASSED** | `packages/mcp/tests/stdioSubprocess.test.ts` (`demo server initializes heterogeneous devices and tools without hanging`), commit `309df1c` | Demo mode initializes dynamic tools and stays responsive. |
| MCP daemon-unavailable handling | **PASSED** | `packages/mcp/tests/stdioSubprocess.test.ts` (`handles daemon unavailable gracefully with structured error`), commit `309df1c` | Returns structured `DAEMON_UNAVAILABLE` error without unexpected transport crash. |
| Control plane governance audit & env alignment | **PASSED** | `docs/architecture.md`, `docs/adr/0006-daemon-governance-and-direct-access.md`, commits `89d7fcd`, `7813a29` | Documents `PINOUT_DAEMON_URL` / `PINOUT_URL`, `PINOUT_OWNER`, and explicit bypass semantics for direct `@pinout/core` SDK. |

---

## Phase 2 — Establish a Reliable ESP32 Reference Circuit

| Acceptance Item | Status | Evidence | Notes |
| :--- | :--- | :--- | :--- |
| ESP32 firmware build (`pio run -e esp32dev`) | **PASSED** | [2026-09-09 compile record](../hardware/records/2026-09-09-esp32-classic-compile.md), source `122a44e` | PlatformIO 6.2.0, GCC 8.4.0; exit 0; binary and ELF hashes recorded. Compile evidence only; no board was flashed or tested. |
| Negotiated deadman watchdog (`watchdog.kick`) | **PASSED** | `packages/core/tests/watchdogArmingSafeState.test.ts`, `firmware/esp32-bridge/src/main.cpp`, commits `6c18845`, `98c109e`, `a8a123f` | Firmware and simulator trip to safe state when heartbeat deadline expires. |
| Explicit & governed arming state machine | **PASSED** | `packages/core/tests/watchdogArmingSafeState.test.ts`, `packages/cli/tests/daemonCommands.test.ts`, commits `6c18845`, `db363ad`, `21268fb`, `2238e64` | Disarmed at boot/reconnect; actuation while disarmed/tripped is rejected; `pinout arm/disarm` and `sys.arm/sys.disarm` enforced; `autoArm` defaults to `false`. |
| Bounded command validity (`validityMs`) | **PASSED** | `packages/core/tests/watchdogArmingSafeState.test.ts` (`rejects expired commands`), commits `6c18845`, `98c109e` | Expired commands exceeding `validityMs` TTL are rejected with `COMMAND_EXPIRED`. |
| Circuit-aware per-output safe state | **PASSED** | `packages/core/tests/watchdogArmingSafeState.test.ts`, `firmware/esp32-bridge/src/main.cpp`, commits `6c18845`, `98c109e`, `a8a123f` | Output table configures safe levels (`low`, `high`, `high-z`, `hold`) and polarity (`active-high`, `active-low`). |
| 1024-byte protocol line limit & oversize rejection | **PASSED** | `packages/core/tests/lineReader.test.ts`, `protocol.test.ts`, commits `86c0814`, `1e73ba7` | Unified 1024-byte maximum line limit with oversized line detection and framing error rejection. |
| Reference circuit specification | **PASSED** | `hardware/reference/esp32-classic-led-sensor.md`, commit `5d5f86b` | Complete wiring, component values, polarity, and forbidden pin rules for LED + sensor fixture. |
| HIL test procedure & evidence matrix | **PASSED** | `scripts/hil/esp32-classic.md`, `hardware/records/2026-09-05-esp32-classic-reference-circuit-pending.md`, commit `632c039` | Documented test protocol with separate firmware acknowledgment vs physical observation columns. |
| Flashing policy: refusal to auto-flash | **PASSED** | `docs/hardware-support.md`, commit `4337839` | Explicit policy mandating positive board ID and operator confirmation; no auto-flashing. |
| Physical HIL: Identity handshake & `resetOnConnect: false` | **BLOCKED** | `hardware/records/2026-09-05-esp32-classic-reference-circuit-pending.md` | Requires physical ESP32 DevKit connected via USB. |
| Physical HIL: Output actuation & GPIO readback | **BLOCKED** | `hardware/records/2026-09-05-esp32-classic-reference-circuit-pending.md` | Requires physical breadboard LED circuit. |
| Physical HIL: Input sensor watch events (`gpio.changed`) | **BLOCKED** | `hardware/records/2026-09-05-esp32-classic-reference-circuit-pending.md` | Requires physical tactile pushbutton press. |
| Physical HIL: Invalid pin safety rejection | **BLOCKED** | `hardware/records/2026-09-05-esp32-classic-reference-circuit-pending.md` | Requires physical hardware pin test (pins 6–12, 34–39). |
| Physical HIL: Host ungraceful kill (`kill -9`) | **BLOCKED** | `hardware/records/2026-09-05-esp32-classic-reference-circuit-pending.md` | Requires physical hardware observing deadman timeout. |
| Physical HIL: USB cable unplug & reconnect | **BLOCKED** | `hardware/records/2026-09-05-esp32-classic-reference-circuit-pending.md` | Requires physical cable disconnect and reconnect. |
| Physical HIL: Watchdog expiry to safe state | **BLOCKED** | `hardware/records/2026-09-05-esp32-classic-reference-circuit-pending.md` | Requires physical measurement of pin output safe level. |
| Physical HIL: Configured-expiry-to-output timing | **BLOCKED** | `hardware/records/2026-09-05-esp32-classic-reference-circuit-pending.md` | Requires physical oscilloscope / logic analyzer timing measurement ($\le 1\text{ ms}$). |
| Physical HIL: Active-low fixture verification (GPIO 4) | **BLOCKED** | `hardware/records/2026-09-05-esp32-classic-reference-circuit-pending.md` | Requires physical active-low LED circuit observing HIGH safe state. |

---

## Phase 3 — Deliver the Actual Abstraction

| Acceptance Item | Status | Evidence | Notes |
| :--- | :--- | :--- | :--- |
| Commissioned `lamp` module over ESP32 path | **PASSED** | `packages/core/tests/lamp.test.ts`, `packages/core/src/modules/lampModule.ts`, commits `84000ad`, `c67d35a` | Semantic capabilities (`lamp.arm`, `lamp.disarm`, `lamp.on`, `lamp.off`, `lamp.set`, `lamp.status`); pin numbers encapsulated in configuration. |
| In-process `SimulatedLampBackend` & shared conformance | **PASSED** | `packages/core/tests/lampConformance.test.ts`, commits `f9395bb`, `7d8c839` | Standardized `runLampConformance` suite validates both simulated and protocol backends. |
| Evidence-qualified state model | **PASSED** | `packages/core/tests/evidenceState.test.ts`, `docs/state-evidence.md`, commits `2f70766`, `819c4bb`, `de5a2fc` | Distinguishes `commanded`, `acknowledged`, and `observed` states with dynamic `freshnessMs`, `stale`, and `provenance`. |
| No physical inference from writes ("Honesty Rule") | **PASSED** | `packages/core/tests/evidenceState.test.ts`, `protocolBackendEvidence.test.ts`, commits `819c4bb`, `82ee4a4` | Actuation writes set `commanded` and `acknowledged`; `observed` remains `null` with `source: 'none'` unless independently sensed. |
| Action prerequisite gating | **PASSED** | `packages/core/tests/evidenceState.test.ts` (`prerequisite enforcement`), commit `819c4bb` | Rejects invocation when required state prerequisite is missing or exceeds `maxAgeMs`. |
| Daemon & MCP state evidence exposure | **PASSED** | `packages/daemon/tests/evidenceApi.test.ts`, `packages/mcp/tests/mcp.test.ts`, commits `7cf478a`, `5e8e409`, `6670bc7` | `/v1/devices/:id/state`, SSE streams, and MCP `pinout__read_state` surface structured `stateEvidence`. |
| Doctor diagnostic workflow (`pinout doctor`) | **PASSED** | `packages/cli/tests/doctor.test.ts` (`never-actuates test`), `docs/setup.md`, commits `4c84923`, `bb85047` | Evaluates environment, configuration, daemon, serial discovery, and firmware without actuating hardware. |
| Documented setup guide for second testers | **PASSED** | `docs/setup.md`, commit `bb85047` | Step-by-step procedure for wiring, manual flashing, doctor diagnostics, and enrollment. |
| Agent MCP discovery & honest verification reporting (simulator) | **PARTIAL** | `packages/mcp/tests/stdioSubprocess.test.ts`, `mcp.test.ts`, commits `309df1c`, `5e8e409` | Agent tool discovery and operation proven over simulator; agent transcript on physical hardware remains pending. |
| Agent MCP discovery & operation on physical hardware | **BLOCKED** | `hardware/records/2026-09-05-esp32-classic-reference-circuit-pending.md` | Requires physical board, wired lamp fixture, and live agent transcript recording. |
| Second tester setup repeated in under 15 minutes | **BLOCKED** | `docs/setup.md` | Requires an independent second human tester timing the physical setup. |

---

## Phase 4 — Prove Recovery and Portability

| Acceptance Item | Status | Evidence | Notes |
| :--- | :--- | :--- | :--- |
| Operation persistence, idempotency & lease audit | **PASSED** | `docs/recovery-model.md`, `docs/adr/0007-reconciliation-required-for-uncertain-operations.md`, commit `d26dca2` | Architectural audit documenting journal lifecycle, idempotency key scoping, and volatile lease clearing. |
| Crash-window A recovery (before dispatch) | **PASSED** | `packages/core/tests/recoveryCrashWindows.test.ts` (`Window A`), commit `8bb76cf` | Operation transitions to `aborted` (`OPERATION_ABORTED_BEFORE_DISPATCH`); no automatic dispatch occurs. |
| Crash-window B recovery (after dispatch, before ack) | **PASSED** | `packages/core/tests/recoveryCrashWindows.test.ts` (`Window B`), `recoveryReconciliation.test.ts`, commit `8bb76cf` | Operation transitions to `requires_reconciliation`; silent retry blocked with `OPERATION_REQUIRES_RECONCILIATION`. |
| Crash-window C recovery (after completion, before receipt) | **PASSED** | `packages/core/tests/recoveryCrashWindows.test.ts` (`Window C`), commit `8bb76cf` | Completed result restored intact from journal without re-execution. |
| Explicit operator reconciliation API | **PASSED** | `packages/daemon/tests/recoveryApi.test.ts`, `packages/core/tests/recoveryReconciliation.test.ts`, commit `96fc5d7` | `POST /v1/operations/:id/reconcile` supports `observedComplete`, `observedNotDone`, and `abandoned`. |
| Cancellation vs confirmed stop distinction | **PASSED** | `packages/core/tests/recoveryCancelStop.test.ts`, commit `86d100c` | Confirmed stop transitions to `cancelled` (`stopConfirmed: true`); unconfirmed transition surfaces `stop_unconfirmed`. |
| Volatile lease restart invalidation | **PASSED** | `packages/core/tests/leaseRecovery.test.ts`, commit `4d7975b` | In-memory leases invalidated on restart; stale client sessions cannot actuate without fresh lease. |
| Competing owner lease conflict prevention | **PASSED** | `packages/core/tests/leaseRecovery.test.ts`, commit `4d7975b` | Competing callers cannot acquire overlapping exclusive lease or actuate leased resource. |
| Second physical backend: Modbus lamp backend | **PASSED (SIMULATED)** | `packages/protocols-modbus/tests/lampBackend.test.ts`, `docs/lamp-modbus.md`, commits `1f96f32`, `8f681c9`, `9b92f1f` | Coil actuation (acknowledged) and discrete input readback (observed); passes `runLampConformance` suite against `SimulatedModbusServer`. |
| Dated physical hardware test: ESP32 lamp backend | **BLOCKED** | `hardware/records/2026-09-05-esp32-classic-reference-circuit-pending.md` | Requires physical ESP32 DevKit and reference breadboard fixture. |
| Dated physical hardware test: Modbus lamp backend | **BLOCKED** | `hardware/records/2026-09-05-modbus-lamp-pending.md` | Requires physical Modbus TCP/RTU Remote I/O module or PLC. |

---

## Phase 5 — Robotics Integration (Sidecar Boundary)

| Acceptance Item | Status | Evidence | Notes |
| :--- | :--- | :--- | :--- |
| Narrow ROS 2 sidecar package (`@pinout/ros2-sidecar`) | **PASSED** | `packages/ros2-sidecar/src/sidecar.ts`, `docs/adr/0008-ros2-sidecar-boundary.md`, commits `7040743`, `750ac4f` | Maps ONE bounded Cartesian positioning action (`arm.move_to_pose`) and stop (`arm.stop`); no generic pass-through. |
| Zero-dependency transport abstraction & fake server | **PASSED** | `packages/ros2-sidecar/src/transport.ts`, `fakeRosActionServer.ts`, `packages/ros2-sidecar/tests/transport.test.ts`, commit `750ac4f` | Minimal `RosActionTransport` interface tested against in-process `FakeRosActionServer`. |
| Frame tree validation | **PASSED** | `packages/ros2-sidecar/tests/sidecar.test.ts` (`rejects goal referencing missing coordinate frame`), commit `750ac4f` | Rejects undeclared frame IDs immediately with `FRAME_MISSING`. |
| Transform freshness enforcement | **PASSED** | `packages/ros2-sidecar/tests/sidecar.test.ts` (`rejects goal with stale transform timestamp`), commit `750ac4f` | Rejects transforms exceeding `maxTransformAgeMs` with `TRANSFORM_STALE`. |
| High-rate telemetry isolation to StreamBus | **PASSED** | `packages/ros2-sidecar/tests/sidecar.test.ts` (`routes intermediate feedback to StreamBus`), commit `750ac4f` | High-frequency joint and pose feedback streams to `StreamBus` (`ros2-arm-01:feedback`), keeping it off MCP and journal. |
| Controller loss mid-goal handling | **PASSED** | `packages/ros2-sidecar/tests/sidecar.test.ts` (`handles controller loss during execution`), commit `750ac4f` | Controller disconnect transitions operation to `requires_reconciliation`. |
| Cancellation & confirmed stop distinction | **PASSED** | `packages/ros2-sidecar/tests/sidecar.test.ts` (`cancels goal successfully`, `handles unconfirmed stop`), commit `750ac4f` | Confirmed cancel yields `cancelled` (`stopConfirmed: true`); rejected/dropped cancel yields `stop_unconfirmed`. |
| In-process benchmark against pre-declared limits | **PASSED** | `packages/ros2-sidecar/tests/benchmark.test.ts`, `docs/ros2-sidecar.md`, commit `fd542f0` | 30/30 iterations passed: command overhead p99 ≈1.0 ms vs 15.0 ms limit; stop response p99 ≈1.0 ms vs 30.0 ms limit. |
| External robotics simulator acceptance (Gazebo/Isaac) | **BLOCKED** | `docs/ros2-sidecar.md` | Requires external ROS 2 / Gazebo simulation environment. |
| Physical robotic manipulator platform acceptance | **BLOCKED** | `docs/ros2-sidecar.md` | Requires physical robot arm controller hardware. |

---

## Known Integration Notes

1. **Commit `b5bc947` Intermediate Test Dependency:**
   Commit `b5bc947` staged MCP test assertions (`stateEvidence` validation in `packages/mcp/tests/mcp.test.ts`) that rely on the daemon route implementation landed in `7cf478a` and `5e8e409`. The git history between those commits is not strictly bisect-clean in isolation, but all tests pass cleanly at `HEAD`.
2. **Firmware Compilation Status in this Session:**
   PlatformIO (`pio`) was not installed in the execution environment. ESP32 bridge firmware changes (`firmware/esp32-bridge/src/main.cpp`) were verified via host protocol parsers, line framing tests, and the simulated bridge transport (`simulatedEsp32()`). Catalog entries remain `COMPILE_TESTED` at best, and hardware records explicitly document that physical compilation and flashing were not performed in this session.
3. **Hardware Verification Rule:**
   No catalog entry or document in this repository claims `HARDWARE_VERIFIED` status without an operator-observed, dated record under `hardware/records/`. All physical HIL records are tracked as `NOT RUN / PENDING`.

---

## Acceptance Summary by Phase

| Phase | Description | Total Items | PASSED | PARTIAL | BLOCKED | NOT RUN |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Phase 1** | Repair Usable Agent Entrypoint | 7 | 7 | 0 | 0 | 0 |
| **Phase 2** | Reliable ESP32 Reference Circuit | 18 | 9 | 0 | 9 | 0 |
| **Phase 3** | Deliver the Actual Abstraction | 11 | 8 | 1 | 2 | 0 |
| **Phase 4** | Prove Recovery and Portability | 11 | 9 | 0 | 2 | 0 |
| **Phase 5** | Robotics Integration (Sidecar Boundary) | 10 | 8 | 0 | 2 | 0 |
| **Total** | **Phases 1–5 Combined** | **57** | **41** | **1** | **15** | **0** |
