# Architecture

Pinout is a hardware abstraction layer. Applications and agents call typed actions. Drivers and firmware know how a particular board actually works.

```text
Application / CLI / MCP adapter
                │
                ▼
         PinoutRuntime (multi-device)
                │
       ┌────────┼────────┐
       ▼        ▼        ▼
   Device    Device    Device
  instance  instance  instance
       │        │        │
       ▼        ▼        ▼
  policy + schema validation
       │        │        │
       ▼        ▼        ▼
   backend  backend  backend
 (protocol) (sim arm) (sim chamber)
```

Single-device code paths still use `connect()` → `Device` → `Session` directly. The runtime wraps multiple devices behind one API.

**PinoutRuntime** — multi-device registry. Loads modules from built-ins + `~/.pinout/modules/`. Bootstraps devices from `devices.json` via `PinoutRuntime.fromConfig()`.

**Module SDK** — `defineModule()` validates and exports a `PinoutModuleDefinition`. External packages never import internal paths.

**Local registry** — `~/.pinout/` stores installed modules and device config. Not a cloud service.

See [docs/modules.md](modules.md), [docs/policies.md](policies.md), [docs/build-a-module.md](build-a-module.md), [docs/generator.md](generator.md).

## Packages

This repository is an npm workspace:

| Package | Role |
| --- | --- |
| `@pinout/core` | Abstractions, protocol, ESP32 pin rules, simulated device, Node serial transport. |
| `@pinout/cli` | Command line that calls the SDK. No independent hardware logic. |
| `@pinout/mcp` | Thin MCP stdio server: single-device or runtime-derived tools from all registered devices. |
| `@pinout/generator` | Documentation/SDK → Hardware IR → candidate external module (no AI deps in core). |

Firmware lives in `firmware/esp32-bridge` (USB serial) and
`firmware/esp32-mqtt-bridge` (local Wi-Fi/MQTT). Neither is an npm package.

## Generate pipeline (Sprint 4)

```text
Hardware docs / SDK
        │
        ▼
   @pinout/generator
   (ingest → IR → emit)
        │
        ▼
  Candidate module (GENERATED / UNVERIFIED)
        │
        ▼
  pinout module test → human review → install
```

See [docs/generator.md](generator.md) and [docs/generator-safety.md](generator-safety.md).

## Core concepts

**Transport** — opens, writes bytes, yields bytes, closes. Serial, TCP, the ESP32 simulator, and the BLE GATT path (SIMULATED in CI via `createSimulatedBleGattBridge`) all implement this. Additional transports can implement the same interface without changing `Device`. See [ble-gatt.md](ble-gatt.md).

**Session** — line-framing, request ids, timeouts, `ready` handshake. Sessions speak Pinout protocol v1. They do not know what GPIO 2 means.

**Device** — the object application code holds. It knows which actions the firmware advertised and validates inputs before sending them.

**Capability** — a named action with description, JSON Schema input/output, and a safety annotation. `gpio.write` is a capability, not a special core type. A motor or camera later is another capability on some device.

**Driver knowledge** — ESP32 flash pins, input-only pins, UART0, GPIO 12 strap, and ADC pins live under `drivers/esp32`. Firmware repeats the same checks.

**Composite backend** — routes one device's declared capabilities across multiple named drivers. Construction rejects missing routes, undeclared routes, duplicate capability names, missing drivers, and duplicate backend references. Events include their driver origin and operational state is aggregated by driver.

**Physical evidence state contract** — separates commanded intent, protocol acknowledgements, and independently observed physical evidence (sensors, readback pins). Software never infers physical success solely from a write acknowledgement. Capabilities can declare prerequisites with max-age freshness bounds; missing or stale prerequisites reject invocation before actuation. See [docs/state-evidence.md](state-evidence.md).

Capability contracts are enforced in both directions: inputs are validated before policy/backend execution, and backend results are validated against the declared output schema before returning to SDK, CLI, or MCP callers.

## Connection flow

1. Open the transport.
2. Ignore non-JSON lines (boot ROM noise on ESP32).
3. Wait for `event: ready`.
4. Send `sys.hello` and use that identity as source of truth.
5. Application calls `device.gpio.write(2, true)` or `device.invoke('gpio.write', { pin: 2, value: true })`.

## Simulation

`simulatedEsp32()` is a `Transport`. Internally it runs the same action handler the tests use to describe firmware behavior. The SDK does not take a shortcut around protocol encoding.

```text
SDK  →  protocol  →  simulated transport  →  ESP32 bridge handler
```

CI never needs a board.

## Safety

Software cannot guarantee physical safety. Pinout's job is to fail closed on inputs it can check:

- connection state
- timeouts
- malformed responses
- capability presence
- pin/range validation for known devices

Responsibility split:

| Layer | Responsible for |
| --- | --- |
| Application / agent | Whether this action should happen at all. Load, heat, people, mechanism. |
| SDK | Typed inputs, capability checks, timeouts, refusing known-bad ESP32 pins. |
| Firmware | Executing only supported actions, validating pins again, not crashing on bad JSON. |
| Hardware / operator | Wiring, voltage, mechanics, emergency stop. |

GPIO writes are marked `physicalOutput: true` in the capability descriptor because they change electrical state.

## Agents and MCP

The SDK does not depend on MCP.

`device.toAgentTools()` returns MCP-shaped tool descriptors from the same capability list:

- `name`
- `description`
- `inputSchema`
- `outputSchema`
- `annotations` (safety)

`@pinout/mcp` wraps `connect()` + `invoke()` and exposes those descriptors over stdio. It does not reimplement GPIO or serial, and it does not expose raw shell commands.

## Events

Firmware and the simulator may emit `{ v, event, payload }` lines. `ready` is the handshake. Other events (`gpio.changed`) are dispatched to `device.on()` / `once()` / `off()`.

## Access routes and governance

Pinout provides multiple client surfaces depending on the execution context. Production and AI agent access is routed through the daemon control plane (`pinoutd`), while low-level direct access to `@pinout/core` is intentionally retained for driver development, simulation, and single-process test harnesses.

| Route | Entry point | Goes through daemon? | Auth token | Leases / Ownership | Policy & Schema enforcement | Operation Journal & Idempotency | Halt & Safe-state | Audit / Events | Guarantees bypassed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **CLI (Daemon commands)** | `pinout daemon`, `pinout lease`, `pinout halt`, `pinout resume`, `pinout estop`, `pinout operations`, `pinout logs` | **Yes** (HTTP to `pinoutd`) | Bearer (`PINOUT_TOKEN`) | Enforced (`--owner`, `PINOUT_OWNER`) | Enforced by daemon | Enforced by daemon | Enforced by daemon | Enforced by daemon | None |
| **CLI (Direct commands)** | `pinout hello`, `pinout exec`, `pinout run`, `pinout blink`, `pinout gpio *`, `pinout invoke` | **No** (Direct in-process serial or `devices.json` runtime) | Bypassed | Ephemeral (`cli-direct`) | Schema + module policies enforced in-process | Bypassed (local stdout/stderr only) | Local in-process only; bypasses daemon halt | Bypassed (no daemon journal/SSE) | Centralized leases, multi-agent arbitration, daemon audit journal, daemon halt latch, SSE events |
| **Python SDK (Sync & Async)** | `from pinout import Pinout`, `AsyncPinout` | **Yes** (HTTP to `pinoutd`) | Bearer (`PINOUT_TOKEN`) | Enforced (`owner`, `PINOUT_OWNER`) | Enforced by daemon | Enforced by daemon (`Operation` handles, `idempotencyKey`) | Enforced by daemon (`halt`, `estop`, `clear_estop`, `resume`) | Enforced by daemon (`events()`, `journal()`) | None |
| **MCP (Daemon mode - default)** | `@pinout/mcp` stdio server (`createDaemonMcpServer`) | **Yes** (HTTP to `pinoutd`) | Bearer (`PINOUT_TOKEN`) | Enforced (`PINOUT_OWNER`, `pinout__acquire_lease`) | Enforced by daemon | Enforced by daemon (`_pinout` control block) | Enforced by daemon | Enforced by daemon | None |
| **MCP (Embedded / Demo modes)** | `PINOUT_MCP_EMBEDDED=1` or `PINOUT_DEMO=heterogeneous` | **No** (In-process `PinoutRuntime`) | Bypassed | Explicitly unavailable (`CONTROL_PLANE_UNAVAILABLE` on lease tools) | Schema + module policies enforced in-process | Unavailable (`CONTROL_PLANE_UNAVAILABLE` on operation tools) | In-process runtime halt only | In-process handlers only | Centralized leases, daemon audit journal, daemon E-stop latch, daemon SSE events |
| **Direct Core SDK (Node.js)** | `import { connect, PinoutRuntime } from '@pinout/core'` | **No** (Direct in-process `Device` / `PinoutRuntime`) | Bypassed | Bypassed unless custom in-process engine is wired | Schema + module policies enforced in-process | Bypassed | In-process only (if configured) | In-process only | Cross-process leases, daemon authentication, persistent journal, centralized halt latch, live event streams |

## Intentional low-level SDK access

Direct access to `@pinout/core` (via `connect()`, `new PinoutRuntime()`, or direct CLI hardware commands) is an intentional and supported developer surface for specific non-agent workflows:

1. **Driver and module authoring**: Developing, benchmarking, and debugging hardware modules with `defineModule()` and `pinout module test` without running a background service.
2. **Deterministic unit and integration testing**: Running fast, zero-dependency simulator tests (`simulatedEsp32()`, loopback transports) in isolated CI jobs.
3. **Single-process embedded demos**: Self-contained exploratory scripts and single-board utilities where multi-agent coordination is irrelevant.
4. **Hardware bring-up and flashing diagnostics**: Verifying serial wiring, baud rates, pin safety tables (`pinout pins`, `pinout doctor`), and boot ROM banners.

### What direct access bypasses

When code bypasses `pinoutd` and invokes `@pinout/core` directly:
- **No cross-process lease coordination**: Direct callers claim local device instances without checking or reserving leases in `pinoutd`. If an agent is running under a lease via `pinoutd`, a direct CLI or SDK invocation on the same serial port may cause serial port conflicts, packet collisions, or safety interlock violations.
- **No centralized audit journal**: Operations and raw events are logged to the local process only and will not appear in the daemon's persistent control journal (`/v1/journal`).
- **No shared halt or E-stop latch**: If `pinoutd` is placed into a `HALTED` or `ESTOP_REQUESTED` state by an operator or safety rule, direct `@pinout/core` callers maintain their own isolated halt state and will not observe the daemon-wide halt.
- **No operation deduplication**: Requests do not pass through the daemon's `OperationManager`, bypassing idempotency key caching, background progress polling, and cooperative cancellation.

**Rule of thumb**: All production deployments, LLM agents, and multi-client workflows must communicate with `pinoutd` (via MCP daemon mode, the Python SDK, or daemon HTTP/CLI routes). Direct `@pinout/core` access is reserved for driver authoring, offline testing, and hardware bring-up.

## Intentionally deferred

- CAN transports
- Physical BLE radio bindings for the GATT *transport* (host SIMULATED path + firmware sketch exist; advertisement-only BLE discovery plugin ships separately — never connects or writes GATT; no transport HIL)
- Cameras
- Flashing firmware from the CLI
- A published npm release
- ESP32-S3 native USB and RGB LEDs

See [docs/capabilities.md](capabilities.md) for the current action catalog.
