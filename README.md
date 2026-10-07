<div align="center">

# pinout

### Building intelligence for the physical world.

**A universal runtime for software, AI agents, and physical hardware.**

[Documentation](./docs/index.md) · [Build a Module](./docs/build-a-module.md) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md) · [Research](#research)

<br />

[![CI](https://github.com/pinoutlabs/pinout/actions/workflows/ci.yml/badge.svg)](https://github.com/pinoutlabs/pinout/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![Hardware](https://img.shields.io/badge/hardware-ESP32%20%2B%20simulators-black)
![MCP](https://img.shields.io/badge/MCP-compatible-purple)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)

</div>

---

AI can reason about software.

Physical machines are still fragmented behind vendor SDKs, serial protocols, GPIO libraries, industrial buses, proprietary APIs, and hundreds of incompatible control surfaces.

**Pinout is building the layer between intelligence and machines.**

Pinout is an early, open-source platform. This repository contains a working TypeScript runtime and SDK, CLI, MCP adapter, `pinoutd` daemon, a Python SDK, ESP32 firmware and a MicroPython bridge, Modbus and SCPI protocol adapters, multi-device runtime with simulators, an external-module SDK, and a documentation-to-module generator. It is not a claim that a complete industrial fleet product or a catalog of shipped hardware already exists.

```text
                         AI / Software
                              │
                              ▼
                    ┌─────────────────┐
                    │     Pinout      │
                    │                 │
                    │  capabilities   │
                    │  state          │
                    │  safety         │
                    │  policies       │
                    │  events         │
                    │  execution      │
                    └────────┬────────┘
                             │
             ┌───────────────┼───────────────┐
             │               │               │
             ▼               ▼               ▼
          ESP32          Robot Arm       Lab Hardware
           │                 │               │
         Serial            SDK / ROS       TCP / SDK
           │                 │               │
             └───────────────┼───────────────┘
                             │
                             ▼
                     Physical World
```

Pinout gives hardware a common, machine-readable interface based around **capabilities**.

Instead of teaching an agent about GPIO registers, vendor APIs, packet formats, or SDK quirks, hardware exposes actions such as:

```text
gpio.write
motion.move_to
gripper.close
temperature.set
experiment.start
```

The underlying implementation can be completely different.

The interface stays predictable.

---

## Why Pinout exists

Modern AI systems already have increasingly standardized ways to interact with software.

The physical world does not.

A robot arm, environmental chamber, microcontroller, microscope, CNC machine, sensor array, and PLC may all expose completely different programming models.

Pinout sits above that fragmentation.

```text
Vendor SDK      ─┐
Serial           │
TCP              │
Modbus           ├────► Pinout Module ────► Pinout Runtime
ROS              │
GPIO             │
Proprietary API ─┘
```

Applications and agents interact with **Pinout capabilities**, not the underlying transport.

---

## What the platform does

- **Capability semantics (spec v1):** every capability declares its schema, units, danger level, duration class, idempotency, and permissions. See [docs/spec/](docs/spec/overview.md).
- **Long-running operations:** physical actions return operation handles with progress streams, deadlines, cooperative cancellation, and idempotency keys that prevent duplicate physical side effects on retry.
- **Resource leases:** concurrent agents share a machine deterministically — exclusive or shared-read, device- or capability-scoped, with TTLs so a crashed agent cannot hold hardware forever.
- **Safety engine:** rate, interlock, sequence, approval, lease, deadman, resource-budget, range, and state policies enforced in deterministic runtime code. Deployment policies can only tighten module baselines; conflicts require human review.
- **Halt / E-stop coordination:** `NORMAL → RESTRICTED → HALTED → ESTOP_REQUESTED → FAULTED` states with audited transitions. Software coordination only — never a substitute for hardware safeguards.
- **Device composition:** a robot cell addresses `robot-cell-01.arm.motion.move_to` across components from different vendors via the DeviceGraph.
- **Control journal:** append-only, redacted record of invocations, policy decisions, operations, faults, and safety transitions — inspectable and replayable.
- **Data plane:** a stream bus for high-rate frames with backpressure policies, kept off the control plane and away from MCP.
- **`pinoutd` daemon:** local execution service bound to loopback only; HTTP API + SSE events; remote access requires explicit opt-in *and* auth. Dry-run mode resolves and policy-checks invocations without physical side effects.
- **Python SDK:** sync (stdlib-only) and asyncio clients with typed errors — robotics and scientific ecosystems are Python-first.
- **Protocol adapters:** Modbus TCP/RTU with declarative register maps (writes require explicit configuration), SCPI instrument layer (power supplies, DMMs, function generators), zero external dependencies.
- **Transport layer:** serial, TCP, UDP, WebSocket (with reconnect), loopback — each with timeouts and structured error classification.
- **Agent interfaces:** MCP tools derived dynamically from runtime capabilities; a protocol-neutral `runtimeToToolDefinitions()` export for any AI vendor's function-call format.

## Hardware support catalog

| Target | Status |
| --- | --- |
| ESP32 classic DevKit/WROOM (bridge firmware: GPIO, PWM, ADC, I2C, SPI, servo/motor) | `COMPILE_TESTED` reference path (simulator and transport-tested; physical HIL pending) |
| MicroPython / CircuitPython boards (generic bridge) | `EXPERIMENTAL` — host-validated protocol only |
| Modbus Lamp (Coil + Discrete Input Readback) | `SIMULATED` (`@pinout/protocols-modbus` backend tested against simulator; physical HIL pending) |
| ROS 2 Sidecar (`@pinout/ros2-sidecar`) | `SIMULATED` (narrow Cartesian action mapped to fake ROS action server; physical platform pending) |
| Simulated devices (lamp, arm, mobile base, chamber, coffee machine, motors, sensors, …) | `SIMULATED` |
| Modbus TCP/RTU, SCPI instruments, MQTT | `IMPLEMENTED` adapter packages (scripted/in-process tests; not physical-equipment verified or automatically registered as runtime devices) |
| Universal Robots, OPC UA, MAVLink | `PLANNED` |

The architecture is deliberately transport- and module-agnostic; the matrix describes evidence for each concrete adapter, not a platform limit. Never blur these statuses: `SIMULATED` is not hardware-verified, and a mocked test proves nothing about hardware.

---

# Capabilities

Devices expose typed capabilities with JSON Schema inputs and outputs.

Example:

```ts
{
  id: "temperature.set",

  inputSchema: {
    type: "object",
    properties: {
      temperature: {
        type: "number"
      }
    },
    required: ["temperature"]
  }
}
```

An agent does not need to know how the physical machine implements `temperature.set`.

It only needs to know:

```text
what the capability does
what arguments it accepts
what it returns
what constraints apply
```

---

# Safety is outside the model

Pinout does **not** trust an AI model to enforce physical safety.

Requests pass through deterministic validation and policy enforcement before reaching hardware.

```text
Agent
  │
  ▼
Capability Request
  │
  ▼
Schema Validation
  │
  ▼
State Preconditions
  │
  ▼
Policy Engine
  │
  ├──── DENIED
  │
  ▼
Device Backend
  │
  ▼
Hardware
```

Example:

```text
temperature.set(200)
```

can return:

```text
POLICY_CONSTRAINT_VIOLATION
```

before the device backend ever receives the command.

Policies currently support:

- numeric limits
- physical workspace boundaries
- device-state preconditions
- module safety defaults
- deployment-level restrictions
- hardware-specific constraints

Deployment policies may make limits **stricter**, but cannot silently widen module-level safety boundaries.

---

# Modules

Hardware support is implemented through **Pinout Modules**.

A module describes:

```text
device identity
device class
capabilities
policies
backend implementation
simulation
metadata
```

Example:

```ts
import {
  defineModule,
  action,
  sensorRead,
} from "@pinout/core";

export default defineModule({
  id: "acme/temperature-sensor",
  version: "0.1.0",

  device: {
    class: "sensor.temperature",
    vendor: "Acme",
    model: "T100",
  },

  capabilities: [
    sensorRead({
      id: "temperature.read",
      // ...
    }),
  ],

  createBackend(config) {
    return new AcmeBackend(config);
  },
});
```

Modules live outside Pinout Core.

That means supporting new hardware does **not** require modifying the runtime itself.

---

# Build your own hardware module

Create one:

```bash
pinout module create my-device
```

Test it:

```bash
pinout module test ./my-device
```

Install it:

```bash
pinout module install ./my-device
```

Register hardware:

```bash
pinout device add sensor-01 \
  --module my-device \
  --simulated
```

Inspect devices:

```bash
pinout devices
```

Invoke a capability:

```bash
pinout invoke sensor-01 temperature.read \
  --payload '{}'
```

Once registered, the same capabilities can automatically become available to MCP-compatible agents.

No MCP-specific code is required inside the hardware module.

See [`docs/build-a-module.md`](./docs/build-a-module.md).

---

# AI hardware module compiler

Pinout can also begin translating existing hardware documentation into Pinout modules.

```bash
pinout generate ./vendor-sdk
```

The generator processes source material into an intermediate representation:

```text
Hardware Documentation
        │
        ▼
Source Ingestion
        │
        ▼
Interface Extraction
        │
        ▼
Hardware IR
        │
        ├── capabilities
        ├── interfaces
        ├── state
        ├── safety
        ├── evidence
        └── uncertainties
        │
        ▼
Candidate Pinout Module
```

Generate a plan first:

```bash
pinout generate ./vendor-sdk --plan
```

Example:

```text
Device
  Acme HeatBox 400

Suggested class
  lab.environmental_chamber

Capabilities
  HIGH    temperature.read
  HIGH    temperature.set
  HIGH    door.open
  HIGH    door.close
  MEDIUM  experiment.start

Safety
  HIGH    temperature range: 10–80°C

Unknown
  ? experiment.start timing semantics
  ? connection timeout is undocumented
```

Then generate a candidate module:

```bash
pinout generate ./vendor-sdk \
  --output ./generated/acme-heatbox
```

Generated modules contain:

```text
acme-heatbox/
├── pinout.module.json
├── package.json
├── src/
│   ├── index.ts
│   ├── backend.ts
│   └── generated.ts
├── test/
├── evidence/
│   └── report.json
├── GENERATION_REPORT.md
└── README.md
```

Generated hardware integrations are always:

```text
GENERATED
UNVERIFIED
```

They are **never automatically installed or connected to physical hardware**.

---

# Evidence over hallucination

Physical hardware is not a place where guessing is acceptable.

Every generated inference can carry:

- source evidence
- confidence
- uncertainty
- implementation status

For example:

```json
{
  "capability": "temperature.set",
  "confidence": 0.98,
  "evidence": [
    "manual.md:124-131"
  ]
}
```

Documented safety boundaries may become hard policies.

Inferred ones do not.

If Pinout cannot establish something safely, it should say:

```text
UNKNOWN
```

instead of inventing an answer.

---

# MCP

The default daemon-backed MCP catalog is static: `pinout__list_devices`, `pinout__describe_device`, and `pinout__invoke({deviceId, capability, args})` plus governance tools. Board changes require no MCP configuration changes. See the [Uno / ESP32 / C3 LED demo](docs/three-board-demo.md).

The optional compatibility catalog exposes registered hardware capabilities dynamically through MCP.

```text
Claude / Agent
      │
      ▼
     MCP
      │
      ▼
Pinout Runtime
      │
      ├── esp32-01
      ├── arm-sim-01
      └── chamber-sim-01
```

Tools are generated from runtime capabilities.

Example:

```text
esp32_01__gpio_write
arm_sim_01__motion_home
chamber_sim_01__temperature_set
```

MCP remains an **adapter**.

It is not Pinout's internal hardware model.

---

## Quick start

Node 20+ is required.

```bash
git clone https://github.com/pinoutlabs/pinout.git
cd pinout
npm install
npm test
npm run pinout -- doctor
npm run pinout -- hello --mock
npm run demo:lamp
npm run demo:robotics
```

No board is needed: `--mock`, `demo:lamp`, and `demo:robotics` run locally over simulators. Simulators share the real device contracts, but their readings and policy denials are integration aids, not evidence of physical performance. See [`docs/setup.md`](docs/setup.md) for the 15-minute hardware setup guide.

Use the SDK directly (explicit arming required for actuation):

```ts
import { connect, simulatedEsp32 } from '@pinout/core';

const board = await connect({ transport: simulatedEsp32() });
await board.invoke('sys.arm', {});
await board.gpio.write(2, true);
await board.close();
```

Run the daemon:

```bash
node packages/daemon/dist/main.js --demo --journal ./session.pinout-journal
# then: GET http://127.0.0.1:8787/v1/devices
```

Use Python:

```python
from pinout import Pinout

p = Pinout()                     # talks to pinoutd
arm = p.device("arm-01")
p.arm("arm-01")                  # explicit arming gate
op = arm.invoke("motion.home")
print(op.result())
```

## Real hardware path

For automatic detection and the static MCP LED demo on Uno R3, ESP32 classic, and ESP32-C3 SuperMini, follow [the three-board guide](docs/three-board-demo.md). All three firmware targets compile; physical validation remains pending.

The first hardware target is a classic ESP32 DevKit (WROOM / 30-pin) running [`firmware/esp32-bridge`](firmware/esp32-bridge). A board-agnostic [`firmware/micropython-bridge`](firmware/micropython-bridge) extends coverage to MicroPython/CircuitPython boards (experimental).

```bash
npm run pinout -- ports
npm run pinout -- doctor --port /dev/cu.usbserial-10
npm run pinout -- hello --port /dev/cu.usbserial-10
npm run pinout -- arm esp32-01 --port /dev/cu.usbserial-10
npm run example:blink -- --port /dev/cu.usbserial-10
```

This path exercises the SDK, protocol framing, ready handshake, explicit arming gate, host-side validation, serial transport, and firmware. It does not make Pinout responsible for wiring, voltage, mechanics, emergency stops, or the behavior of an attached load.

## Try the heterogeneous runtime

```bash
npm run demo:heterogeneous
```

This runs simulated ESP32, robot arm, and environmental chamber devices through one runtime, including successful operations and policy rejections.

---

# Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                    AI / APPLICATIONS                        │
│                                                             │
│          Agents · CLI · SDK · Automation · Research         │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       ADAPTERS                              │
│                                                             │
│                      MCP · APIs                             │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    PINOUT RUNTIME                           │
│                                                             │
│   Device Registry       Capability Model      Event Bus     │
│   State                 Policy Engine         Execution     │
│   Health                Validation            Logging       │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      MODULE SDK                             │
│                                                             │
│   Device Metadata · Capabilities · Policies · Backend       │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       TRANSPORTS                            │
│                                                             │
│              Serial · TCP · SDK · Simulation               │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    PHYSICAL HARDWARE                        │
│                                                             │
│   Microcontrollers · Robots · Sensors · Lab Equipment       │
│   Industrial Systems · Machines · Future Pinout Hardware    │
└─────────────────────────────────────────────────────────────┘
```

More detail: [`docs/architecture.md`](./docs/architecture.md)

---

## Repository map

| Area | What it contains |
| --- | --- |
| `packages/core` | Runtime, spec types, operations, leases, safety engine, halt coordinator, DeviceGraph, journal, stream bus, transports, ESP32 driver, simulators |
| `packages/daemon` | `pinoutd` — local execution service, HTTP API, SSE |
| `packages/cli` | `pinout` commands over the SDK |
| `packages/mcp` | MCP stdio adapter; no separate hardware logic |
| `packages/generator` | Vendor docs/SDK → candidate module pipeline |
| `packages/protocols-modbus` | Modbus TCP/RTU adapter + register maps |
| `sdk/python` | Python SDK (sync + asyncio) |
| `firmware/esp32-bridge` | Protocol v1 ESP32 firmware |
| `firmware/micropython-bridge` | Generic MicroPython/CircuitPython bridge |
| `examples` | SDK, MCP, heterogeneous, and robotics narratives |
| `docs` | Spec v1, product, architecture, modules, safety, generator guidance |

## Safety model, in one paragraph

Policies, leases, and halt states are enforced by deterministic runtime logic below any model. Capabilities carry descriptive danger levels; enforcement is policy-based. A prompt — however persuasive — cannot override a range check, an interlock, or an estop. Software halt/estop coordinates runtime behavior; it is not a certified emergency-stop system, and machinery deployments always require independent hardware safeguards.

---

# Design principles

### Hardware is stateful

Physical machines are not stateless REST endpoints.

Pinout models:

```text
actions
sensors
events
state
health
policies
```

as first-class concepts.

### Models reason. Controllers execute.

Pinout does not put an LLM inside a real-time motor-control loop.

Models should make higher-level decisions such as:

```text
motion.move_to(...)
```

while deterministic controllers handle timing-critical execution.

### Safety does not depend on prompting

Safety constraints live below the intelligence layer.

### Simulation and reality share an interface

A simulated backend and a physical backend implement the same Pinout device contract.

### Protocols are implementation details

Serial, TCP, ROS, CAN, SDKs, and future transports should not leak into the semantic capability layer.

### Unknown is better than wrong

Especially when software can move something.

---

## Status

Experimental and changing. Protocol, package layout, and APIs may evolve. The repository prioritizes a working, reviewable foundation over unverified claims about customers, benchmarks, certifications, production fleets, or shipped Pinout hardware.

## Read next

- [Spec v1 overview](docs/spec/overview.md) — device, capability, operations, leases, safety, errors, journal contracts
- [pinoutd daemon](docs/daemon.md)
- [Company and product](docs/company.md) · [Architecture](docs/architecture.md) · [Production architecture](docs/production-architecture.md)
- [Safety and policies](docs/policies.md)
- [Modules](docs/modules.md) and [build a module](docs/build-a-module.md)
- [Generator](docs/generator.md) and [generator safety](docs/generator-safety.md)
- [Roadmap](ROADMAP.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

---

# Where this is going

Pinout begins as software infrastructure.

The longer-term research direction is much larger:

```text
Hardware Interfaces
        ↓
Physical Runtime
        ↓
Agent ↔ Machine Infrastructure
        ↓
Simulation + Safety
        ↓
Physical Intelligence
        ↓
Robotics Research
        ↓
Intelligent Machines
```

The goal is not merely to make hardware easier to program.

**The goal is to build the systems required for intelligence to operate in the physical world.**

---

# Research

Areas we are interested in include:

- agent-controlled physical systems
- machine-readable hardware capabilities
- physical-world safety and permission models
- hardware interface generation
- simulation and sim-to-real validation
- embodied intelligence
- world models
- autonomous manipulation
- robot learning
- cross-embodiment systems

Research notes and experiments will live alongside the software as Pinout develops.

---

# Contributing

Pinout needs weird hardware.

Especially hardware with:

- terrible SDKs
- strange serial protocols
- old vendor libraries
- incomplete documentation
- proprietary control surfaces
- unusual physical constraints

If you have something painful to integrate, we want to hear about it.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

---

<div align="center">

### Give us your worst hardware.

We are trying to make the physical world programmable by intelligence.

<br />

**pinout**

*Building intelligence for the physical world.*

</div>
