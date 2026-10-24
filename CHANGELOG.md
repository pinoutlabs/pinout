# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Connector pipeline (PR4)** (`@pinout/daemon`, `@pinout/cli`): human-gated
  generate → conformance quarantine → approve → install path for generated
  modules. Daemon routes `POST/GET /v1/connectors…` match MCP PR2
  `GeneratedConnectorRecord` shapes (`safetyFlags`, capability `safety`,
  `{ connector }` / `{ connectors }`); SSE emits `connector.installed` and
  `connector_installed` for tool-cache invalidation. Storage under
  `~/.pinout/connectors/`, integrity-checked install into `~/.pinout/modules`
  with hot `runtimeModules` registration and `connector.*` journal events.
  CLI: `pinout connector list|show|generate|approve|install|reject`. Malicious
  or failing conformance stays `CANDIDATE`; tampering fails install closed.
  Evidence capped via `SupportLevel` (never auto-flash / auto-approve /
  auto-actuate). Docs: [docs/connectors.md](docs/connectors.md); updates
  [docs/generator-safety.md](docs/generator-safety.md).
- **Generator connectors (`@pinout/generator`)**: Extended Hardware Interface IR kinds with `ble-gatt`, `mqtt`, `mdns`, and `serial-bridge` (legacy kinds unchanged). New ingestors for `sys.hello`, GATT dumps, MQTT topic samples, and mDNS/OpenAPI; safety inference classifies read-only vs `physicalOutput` with strict schemas and default-deny `requiresApproval` policy stubs. Deterministic 8-file connector templates plus programmatic `generateConnector({ source, ir|raw, outDir|inMemory })` for the daemon/install pipeline (uses core `SupportLevel` / `mapFromGeneratorLifecycle`, evidence capped at `COMPILE_TESTED`; never auto-install/register). Fixtures under `fixtures/generator/{serial-hello,ble-gatt-lamp,mqtt-sensor-relay,unknown-weird}`. Docs: [docs/generator-connectors.md](docs/generator-connectors.md).
- **Canonical SupportLevel evidence ladder** (`@pinout/core`, PR0 foundation):
  `UNKNOWN` | `SIMULATED` | `COMPILE_TESTED` | `HARDWARE_VERIFIED` with mappers from
  module-manifest status, spec `SupportStatus`, `hardware/catalog.json` statuses,
  conformance L0–L5, and generator lifecycle. Generated/auto-built artifacts cannot
  exceed `COMPILE_TESTED` without a dated `hardware/records/` entry. Docs:
  [docs/evidence-levels.md](docs/evidence-levels.md).
- **pinoutd board discovery Pico path**: USB VID `2e8a` allowlisted; accepts
  `micropython-bridge` firmware identity (SIMULATED serial tests; never auto-flash).
- **Device awareness** (`@pinout/awareness` + `pinoutd --discover`, **SIMULATED** by default):
  - Persistent `AwarenessRegistry` at `~/.pinout/awareness.json` (mode `0600`, atomic writes) with explicit state machine (`SEEN` → `IDENTIFIED` → `PENDING_ENROLL` → `ONLINE` → `STALE` → `OFFLINE`) and configurable staleness timeouts.
  - Daemon runs read-only discovery plugins on a per-transport schedule; network probing stays opt-in (`--network-probe host:port`). Presence/health/support/transport mirrored onto core `DeviceGraph`.
  - HTTP API: `GET /v1/awareness`, `GET /v1/awareness/:id`, `GET /v1/awareness/events` (SSE), `POST /v1/awareness/:id/enroll` (auth like other mutating routes; never arms/actuates; never auto-enrolls).
  - Typed `AwarenessClient` (`list` / `get` / `subscribe` / `enroll`) for MCP and e2e consumers.
  - `evidenceLevel` uses core `SupportLevel` (PR0). Docs: [docs/awareness.md](docs/awareness.md).
  - `pinoutd --discover --mock-devices <file|preset>` injects simulated serial/BLE/mDNS/MQTT plus an UNKNOWN device (no matching module).
- **MCP awareness + connector surface** (`@pinout/mcp`): daemon-backed tools
  `pinout__nearby_devices`, `pinout__awareness_events`, `pinout__describe_nearby`,
  `pinout__request_enroll`, `pinout__generate_connector`, `pinout__connector_status`,
  and `pinout__list_connectors`. Awareness tools use `@pinout/awareness`
  `AwarenessClient` + record types against live `/v1/awareness*`. Enrollment
  returns a pending human-approval handle (never silently approves
  physical-output). Quarantined connectors: read-only may be usable;
  physical-output blocked until human approve/install. `evidenceLevel` is core
  `SupportLevel` (defaults to `SIMULATED`). SSE watchers emit MCP
  tools/resources list-changed updates and invalidate the `/v1/tools` cache on
  connector install. Docs: [docs/mcp-awareness.md](docs/mcp-awareness.md).
- **ESP32 BLE GATT transport** (`@pinout/core`, **SIMULATED**): `bleGattTransport` + injectable `BleGattSession` carrying Pinout NDJSON over a fixed RX-write / TX-notify GATT layout (`pinoutBleGattUuids`). In-process `createSimulatedBleGattBridge()` pairs the host path with `simulatedEsp32` and ATT-sized TX chunking for CI without a radio. Factory type `simulated-ble-gatt`. Docs: [docs/ble-gatt.md](docs/ble-gatt.md).
- **ESP32 BLE bridge sketch** (`firmware/esp32-ble-bridge`, **COMPILE_TESTED** via `pio run -e esp32dev-ble`; **not** HARDWARE_VERIFIED): minimal GATT server advertising the same UUIDs with a desk bring-up protocol subset (`sys.*`, `gpio.mode` / `write` / `read`). No flash/HIL record. Advertisement-only BLE discovery lives separately in `@pinout/discovery` (never connects or writes GATT).
- **Raspberry Pi Pico MicroPython path** (`firmware/micropython-bridge`):
  - Pico board profile (`boards/raspberry-pi-pico/config.py`) with USB CDC transport (`TRANSPORT=usb`), onboard LED on GPIO 25, I2C/SPI/ADC defaults aligned to `firmware/boards/raspberry-pi-pico.json`.
  - Bridge 0.2.0: `ready` boot event, `boardId` / `ledPin` in `sys.hello`, reserved/allowed pin checks mapped to shared `INVALID_PIN` (plus `UNSUPPORTED_ACTION` / `ACTION_FAILED`).
  - Host simulator stub `sim/machine.py` and `validate-pico.js` so CI exercises blink, reserved pins, ADC/I2C/SPI hooks without hardware (**SIMULATED** only).
  - First-time setup guide [`docs/raspberry-pi-pico.md`](docs/raspberry-pi-pico.md); catalog + README statuses updated honestly (`SIMULATED`, not HARDWARE_VERIFIED / not COMPILE_TESTED).
- **Desk pan-tilt module (`pinout/pan-tilt`)**: Commissioned local 1–2 hobby-servo mount with `panTilt.arm`, `panTilt.disarm`, `panTilt.setAngles`, `panTilt.setAngle`, and `panTilt.status`. Simulator and ESP32 backends share the same interfaces; ESP32 path uses existing firmware `gpio.servo` (COMPILE_TESTED only — no HIL claim). Disarm drives commissioned safe angles within per-axis limits. Does not expand the ROS 2 sidecar or robot-arm core. See [docs/capabilities.md](docs/capabilities.md) and [docs/modules.md](docs/modules.md).
- **Room Environment Sensor external module (`room-sensor/environment`, SIMULATED)**:
  - Maker-facing BME280 / DHT11 / DHT22 module under `examples/external-module/room-sensor` using `defineModule` + `sensorRead` (kept outside `@pinout/core`).
  - Capabilities: `sensor.read`, `temperature.read`, `humidity.read`, `pressure.read` (BME280-only), `status.read`.
  - Simulator returns plausible structured readings; `status.read` / `getOperationalStateEvidence()` follow the physical evidence contract (reads update `observed` only; `commanded`/`acknowledged` stay null).
  - Docs: [docs/room-sensor.md](docs/room-sensor.md), module README with ESP32/MicroPython wiring notes; catalog entry stays honest `SIMULATED` (no HIL / no sensor-specific firmware hooks).
- **BLE discovery plugin** (`@pinout/discovery`): advertisement-only nearby BLE
  enumeration with evidence-backed candidates and confidence capped at the
  weak-heuristic limit (≤ 0.5). Never connects, pairs, or writes GATT.
  Linux uses BlueZ `bluetoothctl` when present; macOS/Windows/missing tooling
  return empty rather than guessing (same honesty pattern as Windows USB).
  CI uses `simulatedBleScan([...])` — no radio and no fake HIL claims.
  Wired into `pinout discover` (disable with `--no-ble`) and `pinout doctor`
  discovery stage.
- **MQTT home lamp / plug backend (`@pinout/protocols-mqtt`, SIMULATED)**:
  - Commissioned semantic lamp contract (`lamp.arm` / `disarm` / `on` / `off` / `set` / `status`) over declarative Tasmota/Shelly-style topic templates.
  - Presets (`tasmota`, `shelly`, `custom`), in-process `MqttBrokerSimulator` path, module `pinout/mqtt-lamp`, and shared `runLampConformance()` coverage.
  - Docs: [`docs/lamp-mqtt.md`](docs/lamp-mqtt.md) (LAN Mosquitto notes marked unverified); example `examples/lamp-mqtt.ts` (`npm run demo:lamp-mqtt`).
- **ESP32 Wi-Fi / MQTT local bridge** (`@pinout/protocols-mqtt`, **SIMULATED**):
  Declarative `createEsp32MqttMapping` / `Esp32MqttBackend` / `Esp32MqttDeviceSimulator`
  and runtime module `pinout/esp32-mqtt` mapping Pinout arming + GPIO capabilities
  onto `pinout/esp32/{deviceId}/cmd|state|evt/...` topics. Publish rules gain
  optional `codec: 'json'`. CI exercises the device-side simulator against the
  in-process broker — not a production Mosquitto/EMQX or physical HIL path.
  Coexists with `pinout/mqtt-lamp` (semantic home lamp); this path is the raw GPIO/arming bridge.
- **Firmware** `firmware/esp32-mqtt-bridge`: classic ESP32 sketch (PubSubClient)
  with SSID/broker config via `include/pinout_mqtt_config.h` or `-D` flags.
  Status after a successful `pio run -e esp32-mqtt` is **COMPILE_TESTED** only;
  never auto-flash; never HARDWARE_VERIFIED from compile. Docs:
  [docs/esp32-mqtt.md](docs/esp32-mqtt.md), firmware README, catalog + board
  `wireless.mqttBridge` notes.
- **ESP32-C3 / ESP32-S3 first-class bridge targets** (`firmware/esp32-bridge`): PlatformIO envs `esp32-c3-supermini` and `esp32-s3-devkitc-1` build with pin maps, I2C/SPI defaults, and `boardId` values aligned to `firmware/boards/*.json`. Classic `esp32dev` remains the default CI compile gate. C3/S3 stay out of that gate and are compiled by the release-candidate workflow. Status remains honest `COMPILE_TESTED` (no physical HIL; never auto-flash). Host simulator/family pin rules and board-descriptor tests cover reserved flash/USB/UART/strap pins; `builtinBoards` includes S3.

### Added (Phases 1–5 sprint)

- **MCP Stdio Lifecycle & Governance Fix** (`packages/mcp`): Repaired process lifecycle in `runStdio.ts` so the stdio transport maintains session lifetime across sequential calls, exits cleanly on stdin EOF and `SIGINT`/`SIGTERM`, and returns structured `DAEMON_UNAVAILABLE` errors without transport crashes when `pinoutd` is offline.
- **Control Plane Governance Alignment**: Standardized daemon URL environment variables (`PINOUT_DAEMON_URL` with fallback to `PINOUT_URL`) and `PINOUT_OWNER` across CLI, MCP, and Python SDK; documented intentional direct `@pinout/core` SDK bypass semantics in [ADR 0006](docs/adr/0006-daemon-governance-and-direct-access.md) and [docs/architecture.md](docs/architecture.md).
- **Protocol v1 Safety Additions**:
  - Negotiated deadman command watchdog (`watchdog.configure`, `watchdog.kick`) with autonomous microcontroller timeout tripping.
  - Circuit-aware per-output safe-state configuration (`gpio.configSafeState`) specifying fail-safe levels (`low`, `high`, `high-z`, `hold`) and load polarity (`active-high`, `active-low`).
  - Bounded command validity (`validityMs` TTL / `COMMAND_EXPIRED`).
  - Strict 1024-byte protocol line limit unified across firmware and host line readers.
  - New structured error codes: `NOT_ARMED`, `WATCHDOG_TRIPPED`, `WATCHDOG_NOT_SUPPORTED`, `COMMAND_EXPIRED`, `UNSUPPORTED_CONFIGURATION`, `LINE_TOO_LONG`, `FRAME_MISSING`, `TRANSFORM_STALE`.
- **Governed Arming State Machine & CLI Commands**:
  - Enforced explicit arming gate (`sys.arm` / `sys.disarm`): devices initialize disarmed at boot, reconnect, or reset; actuation while disarmed/tripped is strictly rejected.
  - Added daemon-routed `pinout arm <deviceId>` and `pinout disarm <deviceId>` CLI commands with timeout options.
  - `autoArm` option in simulator backends defaults to `false` and is strictly scoped to demo/testing with logged runtime warnings.
- **Commissioned Lamp Module (`pinout/lamp`)**:
  - First-party semantic actuator module exposing `lamp.arm`, `lamp.disarm`, `lamp.on`, `lamp.off`, `lamp.set`, and `lamp.status` without exposing raw GPIOs to agents.
  - Built-in `Esp32LampBackend` and in-process `SimulatedLampBackend` with shared conformance suite `runLampConformance()`.
- **Modbus Lamp Backend (`@pinout/protocols-modbus`, SIMULATED)**:
  - Second physical backend implementing the semantic lamp contract over Modbus TCP/RTU coils with independent discrete input readback.
  - Passes shared `runLampConformance()` suite against `SimulatedModbusServer`.
- **Evidence-Qualified State & Prerequisite Enforcement**:
  - Multi-stage state contract (`commanded`, `acknowledged`, `observed`, `freshnessMs`, `stale`, `provenance`) in `packages/core/src/spec/evidence.ts`.
  - The "Honesty Rule": write operations record `commanded` and `acknowledged` without inferring `observed` physical effect unless independently sensed.
  - Action prerequisite gating: rejects invocation prior to actuation when required state prerequisites are missing or stale.
  - Exposed via `/v1/devices/:id/state`, SSE event stream envelopes, MCP `pinout__describe_device`/`pinout__read_state`, and Python SDK.
- **Recovery & Mandatory Reconciliation Model**:
  - Hardened operation lifecycle across crash windows: Window A (pre-dispatch → `aborted`), Window B (dispatched/unacked → `requires_reconciliation`), Window C (completed → restored intact).
  - Explicit reconciliation endpoint `POST /v1/operations/:id/reconcile` and SDK `reconcile()` supporting `observedComplete`, `observedNotDone`, and `abandoned` ([ADR 0007](docs/adr/0007-reconciliation-required-for-uncertain-operations.md)).
  - Distinguishes cooperative cancellation requested (`cancelling`) from confirmed stop (`cancelled`/`stopped`) and unconfirmed stop (`stop_unconfirmed`).
  - Volatile lease clearing across daemon restart to prevent stale sessions from resuming actuation.
- **Doctor Diagnostic Workflow & Setup Guide**:
  - Added non-actuating `pinout doctor` command (`packages/cli/src/doctor/`) diagnosing environment, daemon, configuration, ports, and firmware identity.
  - Added step-by-step setup guide ([docs/setup.md](docs/setup.md)) with a 15-minute second-tester target and reference circuit breadboard guide ([hardware/reference/esp32-classic-led-sensor.md](hardware/reference/esp32-classic-led-sensor.md)).
- **ROS 2 Sidecar Boundary (`@pinout/ros2-sidecar`, SIMULATED)**:
  - Narrow sidecar module mapping single bounded Cartesian manipulation action (`arm.move_to_pose`) and stop (`arm.stop`) into Pinout runtime ([ADR 0008](docs/adr/0008-ros2-sidecar-boundary.md)).
  - Minimal `RosActionTransport` abstraction and `FakeRosActionServer`.
  - Frame tree validation (`FRAME_MISSING`) and transform freshness gating (`TRANSFORM_STALE`).
  - High-rate feedback isolation to `StreamBus` (`ros2-arm:feedback`), keeping high-rate streams off MCP and operation journals.
  - Controller loss mid-motion surfaces as `requires_reconciliation`.
  - In-process benchmark suite (`packages/ros2-sidecar/tests/benchmark.test.ts`) validating declared task limits (overhead p99 <= 15 ms, stop response p99 <= 30 ms).
- **Acceptance Ledger**: Comprehensive verification status matrix across all Phases 1–5 acceptance criteria in [docs/acceptance-ledger.md](docs/acceptance-ledger.md).

### Breaking Changes (Phases 1–5 sprint)

- **Explicit Arming Required for Actuation**: Calling actuation capabilities (`gpio.write`, `gpio.toggle`, `gpio.pulse`, `gpio.pwm`, `gpio.servo`, `gpio.motor`, `lamp.on`, etc.) on un-armed devices is now rejected with `NOT_ARMED` or `WATCHDOG_TRIPPED`. Callers must explicitly issue `sys.arm` or `lamp.arm` before actuating.

### Added (platform v1 sprint)

- **Spec v1 layer** (`packages/core/src/spec`): canonical versioned contracts — device identity/health/descriptors, capability kinds with danger levels and units, operations, leases, frames/poses, safety constraints with provenance, module manifest shape, support statuses. Deterministic unit conversions that refuse ambiguous conversions. Documented under `docs/spec/`.
- **Long-running operations** (`OperationManager`): queued/running/completed/failed/cancelled/timed_out/rejected lifecycle, idempotency keys that permanently dedupe client retries, deadlines, cooperative cancellation that only reports cancelled when the run acknowledges it, progress reporting with per-operation snapshots and `AsyncIterable` streams.
- **Resource leases** (`LeaseManager`): exclusive and shared-read modes, device- and capability-scoped leases, TTL/renew/release/expiry so crashed agents cannot hold hardware.
- **Safety engine v2** (`SafetyEngine`): rate, interlock, sequence, approval, lease, deadman, and resource-budget policies on top of the legacy range/state/workspace rules, with structured `SAFETY_*` codes and `mergeModuleAndDeploymentRules` that only lets deployments tighten module baselines (widening/contradictions become conflicts for human review).
- **Halt/E-stop coordinator** (`HaltCoordinator`): `NORMAL | RESTRICTED | HALTED | ESTOP_REQUESTED | FAULTED` with sticky estop (clear then resume), audited state transitions, and honest non-certification documentation.
- **DeviceGraph**: composition with parent/child links, cycle rejection, dotted addressing across vendors (`robot-cell-01.arm.motion.move_to`), and queries by class/capability/module/tag/parent/simulation.
- **Control journal** (`Journal`): append-only record of invocations, policy rejections, operations, faults, safety transitions, and lease activity; secret-shaped keys redacted, oversized payloads truncated; memory + JSONL storage, replay loading, and sequence hydration after restart.
- **Stream bus** (`StreamBus`): data-plane frame fan-out with `drop-oldest` / `drop-latest` / `latest-only` backpressure, snapshots, stream registration and close semantics.
- **`pinoutd` daemon** (`packages/daemon`): loopback-only local execution service with HTTP API (devices, invoke with dry-run and idempotency, operations, leases, halt/estop, SSE events, stream metadata, journal), bearer-token auth, refusal to bind non-loopback without explicit remote opt-in plus token.
- **Python SDK** (`sdk/python`): stdlib-only sync client plus asyncio client (httpx extra) with typed errors, operations with progress/cancel, leases, safety controls, SSE event streams; tested against an in-process mock daemon.
- **Modbus adapter** (`packages/protocols-modbus`): zero-dependency Modbus TCP (MBAP) and RTU (CRC16) clients, exception mapping to stable codes, and declarative register maps where unknown/read-only registers never become writable.
- **SCPI layer** (`packages/protocols-scpi`): SCPI parser with mnemonic abbreviation and channel syntax, sequential-queue client over any transport with error-queue draining, and reference instrument classes (power supply, DMM, function generator, conservative oscilloscope) with an explicit-opt-in raw escape hatch.
- **UDP and WebSocket transports** in core, with datagram exchange, idle close, reconnect with exponential backoff (never on explicit close), and structured logging.
- **MicroPython bridge** (`firmware/micropython-bridge`): board-agnostic NDJSON bridge with runtime capability detection, software pin-state shadow, UART (hardware) and stdio (host) modes, host-side protocol validation (`validate.js`), and a data-driven board descriptor.
- **CLI daemon commands**: `daemon status`, `halt`, `resume`, `estop`, `estop-clear`, `lease acquire/list/release`, `operations`, `logs`, plus a global `--url` flag talking to `pinoutd`.
- **Protocol-neutral tool export** (`runtimeToToolDefinitions`): every capability as a tool definition with derived danger classification for any AI vendor's function-call format.
- **Runtime integration**: `DeviceInstance.invoke` now runs the halt gate, v2 safety rules, and lease checks, and supports `dryRun` and `owner` options.
- **CI**: OS (Linux/macOS/Windows) × Node (20/22) matrix, Python SDK job (3.10/3.12), and MicroPython bridge protocol validation.
- Spec docs live in `docs/spec/`; the daemon guide is `docs/daemon.md`.

### Changed (platform v1 sprint)

- License changed from MIT to Apache-2.0; repository metadata points at `pinoutlabs/pinout`; NOTICE, Code of Conduct, and Support documents added.
- README updated to describe the full platform surface with an honest hardware support catalog; support statuses never conflate simulated, implemented, and hardware-verified.


### Added (hardware intelligence platform)

- Multi-driver composite devices with explicit capability routing, driver-attributed events, aggregated operational state, and fail-closed route validation.
- First-party simulated semantic modules for relays, proportional valves, pumps, and programmable power supplies.
- ESP32 bridge firmware 0.3.0 with validated `gpio.batchWrite`, best-effort `gpio.stopAll`, and non-blocking cancellable pulses.
- Runtime MCP discovery tools for device inventory and capability/state inspection.
- Operator CLI commands: `runtime inspect`, `runtime capabilities`, `runtime tools`, and confirmation-gated `runtime emergency-stop`.
- Capability output-schema enforcement and concurrency-aware device lifecycle reporting.
- Module entrypoint and registry-path containment checks, including symlink and tampered-index regression coverage.
- Company, product, production-architecture, security, demo, and roadmap documents.

### Changed

- MCP marks every physical-output tool as destructive, never infers idempotency from reversibility, and fails closed on normalized tool-name collisions.
- The robotics demo explicitly identifies every device as simulated and reports the discovered agent surface.

### Added (Sprint 5 — robotics parts)

- First-party actuator modules: `pinout/dc-motor`, `pinout/servo`, `pinout/stepper`.
- Semantic families `motor.*`, `servo.*`, `stepper.*` with speed/angle/step policies.
- Generator maps vendor motor/servo/stepper symbols onto those families.
- ESP32 bridge firmware 0.2.0: `i2c.begin|write|read|scan` and `spi.begin|transfer`.
- SDK/simulator pin rules for I2C/SPI buses (defaults SDA 21 / SCL 22, HSPI pins).
- ESP32 `gpio.servo` and `gpio.motor` pin-level actuator driving (distinct from standalone modules).
- First-party sensor modules: `pinout/distance`, `pinout/imu`, `pinout/encoder`, `pinout/limit-switch`, `pinout/force`.
- First-party mobile base (`pinout/mobile-base`) with `drive.set_velocity` / `drive.stop` and velocity policies.
- `createRoboticsWorkbench()` registers the lab set plus actuators, sensors, and a differential-drive base.
- `npm run demo:robotics` canonical robotics-parts demo.

### Added (Sprint 4 — module generator)

- `@pinout/generator` package: documentation/SDK → Hardware Interface IR → candidate module.
- Hardware Interface IR with evidence, confidence, uncertainties, and safety extraction.
- Source ingestion for text, Markdown, source code, JSON/YAML, and directories.
- Semantic capability mapper (`temperature.*`, `motion.*`, `gripper.*`, …).
- LLM provider abstraction: deterministic `mock` (CI) and OpenAI-compatible `http`.
- CLI: `pinout generate <source>` with `--plan`, `--output`, `--provider`, `--model`, `--test`.
- Generated module layout: manifest, backend, simulator, tests, `GENERATION_REPORT.md`, provenance.
- Fixture vendor SDKs and evaluation harness under `fixtures/generator/`.
- Documentation: [generator.md](docs/generator.md), [generator-safety.md](docs/generator-safety.md).

### Added (Sprint 3 — module ecosystem)

- Public Module SDK: `defineModule`, `action`, `sensorRead`, declarative policies.
- `pinout.module.json` manifest format with schema and Pinout version compatibility.
- Local module registry (`~/.pinout/modules/`) with install/list/inspect/uninstall.
- Persistent device configuration (`~/.pinout/devices.json`) and `PinoutRuntime.fromConfig()`.
- Module conformance kit: `pinout module test`.
- CLI: `module create|test|install|list|inspect`, `device add|remove|list|inspect`.
- CLI: `pinout devices` (runtime devices), `pinout ports` (serial discovery), `pinout invoke`.
- Reference external module: [examples/external-module/weird-sensor](examples/external-module/weird-sensor).
- MCP bootstrap via `PINOUT_CONFIG` without `@pinout/mcp` changes.
- Documentation: [build-a-module.md](docs/build-a-module.md).

### Changed (Sprint 3)

- Single-device invoke renamed to `pinout exec <action>` (runtime uses `pinout invoke`).

### Added (Sprint 2 — heterogeneous runtime)

- `PinoutRuntime` multi-device registry with unified events.
- Module abstraction: ESP32 refactored as `pinout/esp32` module.
- Simulated robot manipulator (`motion.*`, `gripper.*`, `pose.*`).
- Simulated environmental chamber (`temperature.*`, `door.*`, `experiment.*`).
- Generic policy engine (`POLICY_CONSTRAINT_VIOLATION`, `POLICY_PRECONDITION_FAILED`).
- Dynamic MCP tools from runtime (`PINOUT_DEMO=heterogeneous`).
- CLI `runtime devices` and `runtime invoke`.
- `npm run demo:heterogeneous` canonical demo.
- Documentation: [modules.md](docs/modules.md), [policies.md](docs/policies.md).

### Added (Sprint 1 — v0 foundation)
- Device event API (`on` / `off` / `once`) including `gpio.changed`.
- GPIO family: mode, toggle, pulse, PWM, analogRead, watch/unwatch.
- Loopback and TCP transports; CLI `doctor`, `invoke`, `pins`, `run`, `blink`.
- ESP32 GPIO 12 strap pin refused in SDK and firmware.
- Shared protocol codecs: `encodeResponse`, `encodeEvent`, `maxProtocolLineBytes`.
- Documentation: capability catalog, CLI reference, testing guide.
- `npm run test:coverage` with Vitest v8 coverage for `@pinout/core`.
- `npm run mcp` script for local MCP server development (simulator by default).
- CI firmware compile job via PlatformIO (compile-only, no upload).
- CI `format:check` gate.

### Fixed

- Serial port `error` events now propagate through the session to in-flight requests.

## [0.1.0] — 2026-01-01

### Added

- `@pinout/core` — Device API, protocol v1 NDJSON, ESP32 pin rules, simulated transport.
- `@pinout/cli` — `devices`, `hello`, `gpio write`, `gpio read`.
- ESP32 bridge firmware speaking protocol v1 over UART.
- `examples/blink.ts` sample.

[Unreleased]: https://github.com/IMisbahk/pinout/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/IMisbahk/pinout/releases/tag/v0.1.0
