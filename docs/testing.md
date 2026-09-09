# Testing

Pinout uses [Vitest](https://vitest.dev/) for unit and integration tests. No physical hardware is required for CI — the simulated ESP32 transport implements the same protocol as firmware.

## Running tests

```bash
npm test              # run all tests once
npm run test:watch    # watch mode
npm run test:coverage # coverage report (core package)
```

Quality gates used before merging:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

## Test layout

Tests live next to each package under `packages/<name>/tests/`:

| Package | Focus |
| --- | --- |
| `@pinout/core` | Protocol, runtime, **module SDK**, policy, local registry |
| `@pinout/cli` | Commander parsing, **module/device/generate commands** |
| `@pinout/mcp` | MCP tool listing; **dynamic runtime tools** (no per-device code) |
| `@pinout/generator` | Source ingestion, Hardware IR, candidate module emission |

Core Sprint 3 test files:

| File | Focus |
| --- | --- |
| `moduleEcosystem.test.ts` | defineModule, install/load, fromConfig, policy merge, conformance |
| `pinoutHome.test.ts` | CLI module install, device add, invoke |

| File | Focus |
| --- | --- |
| `policy.test.ts` | Numeric range, state preconditions, workspace bounds, rejection format |
| `runtime.test.ts` | Registration, duplicate IDs, invoke routing, event multiplexing, policy denials |
| `simulators.test.ts` | Robot arm movement/gripper/events; chamber temperature/door/experiment |

### Generator (Sprint 4)

```bash
npm run eval:generator          # deterministic fixture evaluation (CI)
npm run demo:generate             # plan output for heatbox fixture
npm run eval:generator:live       # optional live HTTP provider (not in CI)
```

Fixture SDKs: `fixtures/generator/heatbox-sdk`, `actuator-sdk`, `ambiguous-sdk`.

Golden IR expectations and metrics (precision/recall, false safety constraints) live in `packages/generator/tests/`.

Prefer real protocol round-trips over mocking internal functions. Mock transports are fine when testing error propagation or MCP wiring.

## Local benchmarks

Benchmark runners record dated JSON reports under `benchmarks/`. Every result is host/simulator only (`SIMULATED`): no USB, GPIO, or physical exactly-once claim.

```bash
npm run bench          # #27 host/simulator command overhead; p50/p95/p99
npm run bench:mcp      # #28 MCP stdio vs daemon HTTP; N=30, in-process/simulator only
npm run bench:watchdog # #29 watchdog kick jitter under protocol load; simulator only
```

#27 (2026-09-09, host/simulator only): `benchmarks/host-simulator-2026-09-09.json` on darwin/27.0.0 arm64 Apple M1, Node v25.9.0, SHA 122a44e — runtime.invoke p50 0.007 ms p95 0.013 ms p99 0.024 ms.

#28 (2026-09-09, in-process/simulator only): `benchmarks/mcp-http-2026-09-09.json` N=30, limit declared before run invoke p99 < 50 ms (generous contributor-laptop ceiling; typical in-process invoke ~1-2 ms, not USB) — mcpInitialize p50 227.655 ms p99 303.867 ms, mcpListTools p50 3.794 ms p99 8.473 ms, mcpInvoke p50 1.566 ms p99 5.796 ms pass, mcpReadState p50 0.728 ms p99 1.837 ms, httpInvoke p50 0.469 ms p99 3.822 ms.

#29 (2026-09-09, simulator only): `benchmarks/watchdog-2026-09-09.json` timeout 200 ms interval 25 ms, 8x gpio.read load — kick interval error p50 2.101 ms p95 4.281 ms p99 6.321 ms, max interval 41.361 ms margin 158.639 ms, host heartbeat stays inside timeout: yes.

### Heterogeneous demo

```bash
npm run demo:heterogeneous   # ESP32 + robot arm + chamber simulators
npm run demo:robotics        # full first-party robotics parts workbench
pinout module test ./examples/external-module/weird-sensor
PINOUT_CONFIG=~/.pinout/devices.json npm run mcp
```

## Simulator vs hardware

CI runs against `simulatedEsp32()` only. To verify on a board:

1. Flash [firmware/esp32-bridge](../firmware/esp32-bridge/README.md).
2. Run `npm run pinout -- hello --port <path>`.
3. Run GPIO write/read against a safe pin (typically GPIO 2 on DevKit boards).

Hardware tests are manual; do not gate CI on attached devices.

## Firmware compile (optional)

CI includes a PlatformIO compile job when the toolchain is available. Locally:

```bash
cd firmware/esp32-bridge
pio run
```

If PlatformIO is not installed, skip this step — Node tests and the simulator remain sufficient for SDK changes. Install via [platformio.org](https://platformio.org/) or `pip install platformio`.

## Coverage

`npm run test:coverage` reports line/branch coverage for `packages/core/src`. Thresholds are configured in [vitest.config.ts](../vitest.config.ts). Coverage is a development aid, not a publish gate.
