# Pinout documentation

Pinout is an alpha hardware-control platform. Read the [README](../README.md) for the short, evidence-labelled overview.

## Platform & Architecture

- [Architecture](architecture.md) — the runtime, module, and daemon boundaries.
- [Hardware support](hardware-support.md) — statuses generated from `hardware/catalog.json`.
- [Acceptance ledger](acceptance-ledger.md) — phase-by-phase implementation and verification status matrix.
- [Setup guide](setup.md) — breadboard reference wiring, manual firmware flashing, and 15-minute diagnostic verification.
- [Safety model](safety-model.md) and [security model](security-model.md).
- [State evidence contract](state-evidence.md) — commanded vs acknowledged vs independently observed physical state.
- [Recovery and reconciliation model](recovery-model.md) — operation persistence, crash recovery windows, and mandatory reconciliation.

## Modules, Protocols & Robotics

- [Modules](modules.md) and [build a module](build-a-module.md).
- [Lamp module](lamp.md) — commissioned semantic lamp actuator with explicit arming and evidence model.
- [Modbus lamp backend](lamp-modbus.md) — coil actuation and discrete input readback over Modbus TCP/RTU.
- [ROS 2 sidecar](ros2-sidecar.md) — narrow robot manipulation action bridge, transport abstraction, and simulator.
- [ESP32 reference circuit](../hardware/reference/esp32-classic-led-sensor.md) — low-voltage LED and sensor test fixture.

## Interfaces & Operations

- [CLI reference](cli.md), [Python quickstart](../sdk/python/README.md), and [troubleshooting](troubleshooting.md).
- [MCP integration](mcp.md) and [coffee machine example](coffee-machine.md).
- [Contributing](../CONTRIBUTING.md) — simulator, firmware, and HIL contribution paths.
- [Releasing](releasing.md) — dry-run release engineering and the alpha gate.
- [Maintainer guide](maintainers.md) — review, triage, and the intentionally gated CI workflow.

## Architecture Decision Records (ADRs)

- [ADR 0001](adr/0001-governed-runtime.md) — Governed runtime architecture.
- [ADR 0002](adr/0002-control-plane-topology.md) — Control plane topology and daemon role.
- [ADR 0003](adr/0003-serial-reset-and-handshake.md) — Serial reset lines and handshake protocol.
- [ADR 0004](adr/0004-versioning-reset.md) — Package versioning reset.
- [ADR 0005](adr/0005-python-package-name.md) — Python package naming.
- [ADR 0006](adr/0006-daemon-governance-and-direct-access.md) — Boundaries between daemon governance and direct SDK access.
- [ADR 0007](adr/0007-reconciliation-required-for-uncertain-operations.md) — Mandatory reconciliation for uncertain operations across crash windows.
- [ADR 0008](adr/0008-ros2-sidecar-boundary.md) — ROS 2 sidecar boundary and transport abstraction.

---

Simulation and compile tests are not hardware evidence. A catalog row may only claim hardware verification when it links to a dated record under `hardware/records/`.
