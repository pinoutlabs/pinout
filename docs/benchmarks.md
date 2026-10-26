# Benchmarks

This page is the reproduce guide for every benchmark that actually exists in this
repository. Numbers below were measured on a Linux VM at git SHA
`707152522cebc1c54bdd40752df28550c7759e5f` (current `main` at recording time).

**Evidence vocabulary:** every automated host benchmark here is `SIMULATED`
(host-only, in-process or loopback). None of these runs are `COMPILE_TESTED` or
`HARDWARE_VERIFIED`. See [evidence-levels.md](evidence-levels.md).

**No LLM-agent task-time benchmark is included yet.** This repository does not
contain a measured comparison of LLM-agent task time versus Pinout task time
(for example claims like "minutes versus seconds"). Do not invent or imply one
from these host/simulator numbers.

Raw JSON reports live under [`benchmarks/`](../benchmarks/). Dated files are
committed for reference; `benchmarks/results/` is gitignored and rewritten by
local runs.

## Prerequisites (all simulator benches)

| Requirement | Value |
| --- | --- |
| Node.js | `>=20` (repo `.nvmrc` is `20`; recorded run used Node `v22.23.4`) |
| OS | Linux or macOS (scripts record `os.platform()` / release / arch / CPU) |
| Install | From repo root: `npm ci` (or `npm install`) |
| Build | Each `npm run bench*` script runs `npm run build --silent` first |

No board, no PlatformIO flash, and no model-provider API key are required for
`bench`, `bench:mcp`, `bench:watchdog`, or `bench:journal`.

```bash
git clone https://github.com/pinoutlabs/pinout.git
cd pinout
git checkout 707152522cebc1c54bdd40752df28550c7759e5f   # optional: pin the recorded SHA
npm ci
```

## Environment recorded on 2026-10-26 (this page)

| Field | Value |
| --- | --- |
| git SHA | `707152522cebc1c54bdd40752df28550c7759e5f` |
| OS | Linux `6.12.94+` (Ubuntu 24.04 guest), `x64` |
| CPU | Intel(R) Xeon(R) Processor, 4 logical CPUs |
| Node | `v22.23.4` |
| Evidence | `SIMULATED` for all four runners below |

Previously recorded Apple M1 results (2026-09-09) are listed separately at the
bottom of each section and remain in:

- [`benchmarks/host-simulator-2026-09-09.json`](../benchmarks/host-simulator-2026-09-09.json)
- [`benchmarks/mcp-http-2026-09-09.json`](../benchmarks/mcp-http-2026-09-09.json)
- [`benchmarks/watchdog-2026-09-09.json`](../benchmarks/watchdog-2026-09-09.json)
- [`benchmarks/journal-2026-09-09.json`](../benchmarks/journal-2026-09-09.json)

---

## 1. `npm run bench` (host / simulator micro-benchmarks)

**Script:** [`scripts/benchmark.ts`](../scripts/benchmark.ts)

**Command:**

```bash
npm run bench
```

**Writes:** `benchmarks/host-simulator-YYYY-MM-DD.json` and
`benchmarks/results/benchmarks.json` (gitignored).

### What it measures

In-process host overhead for policy evaluation, journal append/redaction,
idempotency store, stream publish, simulated `runtime.invoke` on a relay module,
and operation begin→complete. The invoke path reports p50 / p95 / p99.

### What it does NOT measure

USB, GPIO, firmware, physical board latency, MCP, daemon HTTP, LLMs, or agent
task completion time. Evidence: `SIMULATED` only.

### Results (Linux VM, 2026-10-26)

Source: [`benchmarks/host-simulator-2026-10-26.json`](../benchmarks/host-simulator-2026-10-26.json)

| Metric | Iterations | Mean | Throughput / percentiles |
| --- | ---: | ---: | --- |
| policy.evaluate (2 rules) | 100000 | 0.06 µs/op | 16,797,669 ops/s |
| journal.append (redacted payload) | 50000 | 0.83 µs/op | 1,205,620 ops/s |
| journal.redactPayload (20 keys) | 50000 | 5.19 µs/op | 192,516 ops/s |
| idempotency.record+lookup | 100000 | 0.50 µs/op | 2,018,099 ops/s |
| stream.publish (64-byte frames, 1 subscriber) | 50000 | 0.20 µs/op | 4,918,837 ops/s |
| runtime.invoke round-trip (simulated relay) | 2000 | 14.18 µs/op | p50 0.011 ms, p95 0.015 ms, p99 0.039 ms |
| operation.begin→complete (await result) | 2000 | 17.88 µs/op | 55,944 ops/s |

Script-declared engineering limit (not a product SLA): runtime invoke p99
`< 50 ms` (contributor-laptop ceiling from issue #27). This run: **pass**
(p99 0.039 ms).

### Prior Apple M1 record (2026-09-09)

darwin / arm64 / Apple M1 / 8 logical CPUs / Node v25.9.0 /
SHA `122a44e96acbd04a5b256dc66347658245ccb25c`.
runtime.invoke p50 0.007 ms, p95 0.013 ms, p99 0.024 ms.

---

## 2. `npm run bench:mcp` (MCP stdio vs daemon HTTP)

**Script:** [`scripts/benchmark-mcp.ts`](../scripts/benchmark-mcp.ts)

**Command:**

```bash
npm run bench:mcp
```

**Writes:** `benchmarks/mcp-http-YYYY-MM-DD.json`

**Note:** Default daemon-backed MCP uses a static catalog (`pinout__invoke`),
not per-capability tool names. The runner calls
`pinout__invoke({ deviceId, capability: 'relay.set', args })` against a real
`packages/mcp` stdio child and compares loopback `pinoutd` HTTP. N = 30 samples
after warmup.

### What it measures

Host round-trip latency for MCP initialize (fresh stdio child each sample),
`listTools`, `pinout__invoke` (relay.set), `pinout__read_state`, and the matching
daemon HTTP invoke / state endpoints on a simulated relay device.

### What it does NOT measure

USB serial, physical GPIO timing, LLM token latency, agent planning time, or
end-to-end hardware tasks. Evidence: `SIMULATED` only.

### Results (Linux VM, 2026-10-26)

Source: [`benchmarks/mcp-http-2026-10-26.json`](../benchmarks/mcp-http-2026-10-26.json)

| Path | p50 (ms) | p95 (ms) | p99 (ms) |
| --- | ---: | ---: | ---: |
| mcpInitialize | 205.229 | 232.561 | 233.932 |
| mcpListTools | 3.414 | 5.473 | 6.368 |
| mcpInvoke (`pinout__invoke` / relay.set) | 1.781 | 32.356 | 58.206 |
| mcpReadState | 1.352 | 2.217 | 2.308 |
| httpInvoke | 0.799 | 1.396 | 4.276 |
| httpReadState | 0.584 | 1.085 | 1.438 |

Script-declared limit: mcpInvoke p99 `< 50 ms` (generous contributor-laptop
ceiling). This run recorded **pass: false** (p99 58.206 ms). Steady-state
samples after the first two were typically about 1-3 ms; the elevated p99 comes from
early samples in the N=30 set. Treat the limit as an engineering check, not a
hardware claim.

### Prior Apple M1 record (2026-09-09)

darwin / Apple M1 / Node v25.9.0 / SHA `6224c0a5f723a8277de56d5393dd3dfae093c74e`.
mcpInitialize p50 227.655 ms p99 303.867 ms; mcpInvoke p50 1.566 ms p99 5.796 ms
(pass); httpInvoke p50 0.469 ms p99 3.822 ms. That run used the older
per-capability MCP tool naming; default catalog is now static `pinout__invoke`.

---

## 3. `npm run bench:watchdog` (protocol heartbeat jitter)

**Script:** [`scripts/benchmark-watchdog.ts`](../scripts/benchmark-watchdog.ts)

**Command:**

```bash
npm run bench:watchdog
```

**Writes:** `benchmarks/watchdog-YYYY-MM-DD.json`

Configured timeout 200 ms, heartbeat interval 25 ms, ~5 s load with eight
concurrent `gpio.read` workers against `simulatedEsp32`.

### What it measures

Host-side `ProtocolDeviceBackend` watchdog kick cadence and interval error under
simulated protocol load (whether kicks stay inside the configured timeout).

### What it does NOT measure

MCU watchdog hardware, USB cable jitter, oscilloscope-observed GPIO fail-safe
timing, or physical disarm latency. Evidence: `SIMULATED` only. For physical
watchdog/fail-safe procedure see
[`scripts/hil/esp32-classic.md`](../scripts/hil/esp32-classic.md)
(`HARDWARE_VERIFIED` only with a dated `hardware/records/` entry).

### Results (Linux VM, 2026-10-26)

Source: [`benchmarks/watchdog-2026-10-26.json`](../benchmarks/watchdog-2026-10-26.json)

| Observation | Value |
| --- | ---: |
| kickCount | 190 |
| loadRequests | 474104 |
| maxIntervalMs | 33.642 |
| timeoutMarginMs | 166.358 |
| withinTimeout | yes |
| interval error p50 / p95 / p99 (ms) | 0.893 / 4.869 / 6.171 |

### Prior Apple M1 record (2026-09-09)

darwin / Apple M1 / Node v25.9.0 / SHA `fcf727b0efe21da0239ea4af27bb44f63e0038d9`.
interval error p50 2.101 ms, p95 4.281 ms, p99 6.321 ms; max interval 41.361 ms;
withinTimeout yes.

---

## 4. `npm run bench:journal` (FileJournalStorage hydrate + list)

**Script:** [`scripts/benchmark-journal.ts`](../scripts/benchmark-journal.ts)

**Command:**

```bash
npm run bench:journal
```

**Writes:** `benchmarks/journal-YYYY-MM-DD.json`

Fixtures: 100 / 1000 / 5000 completed operations via daemon HTTP invoke, each
with a unique `idempotencyKey` (required so auto-generated physical-output keys
do not collapse the fixture). Then 10 restart/hydrate + `GET /v1/operations`
samples per count against temporary JSONL (deleted after the run).

### What it measures

Host daemon restart cost to hydrate `FileJournalStorage` and list operations
over HTTP for large simulated journals.

### What it does NOT measure

Disk durability on production fleets, exactly-once physical actuation, USB, or
LLM workloads. Evidence: `SIMULATED` only. No exactly-once physical claim.

### Results (Linux VM, 2026-10-26)

Source: [`benchmarks/journal-2026-10-26.json`](../benchmarks/journal-2026-10-26.json)

| Operations | Hydrate p50 (ms) | Hydrate p95 (ms) | List p50 (ms) | List p95 (ms) |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 3.088 | 3.515 | 1.531 | 2.252 |
| 1000 | 18.474 | 24.698 | 4.270 | 5.966 |
| 5000 | 109.836 | 142.022 | 18.082 | 24.999 |

### Prior Apple M1 record (2026-09-09)

darwin / Apple M1 / Node v25.9.0 / SHA `6288bea6b044cd2ff00d847fb5a928af7564ea2a`.
hydrate p50 1.772 / 14.684 / 71.913 ms (100 / 1000 / 5000); list p50
0.852 / 2.881 / 9.995 ms.

---

## 5. Real hardware paths (not run in the VM recording above)

These are part of the repo's verification surface. They need a flashed board and
an operator. They are **not** the simulator benches above and do not produce the
JSON files under `benchmarks/` unless you add your own dated
`hardware/records/` entry.

### `npm run hardware:smoke`

**Script:** [`scripts/hardware-smoke.mjs`](../scripts/hardware-smoke.mjs)

**Command (example):**

```bash
npm run hardware:smoke -- --device <discovered-id> --pin <number|A1> --yes
```

Requires a connected, discovered device with a supported board identity, MCP
stdio to a live daemon path, lease + `sys.arm`, then active-high GPIO on/off
with readback. The script prints JSON and leaves
`physicalObservation: 'PENDING: operator must confirm LED visibly on then off.'`
Support level stays below `HARDWARE_VERIFIED` until a dated record under
`hardware/records/` documents operator-observed light. See also
[three-board-demo.md](three-board-demo.md).

### Manual HIL checklists (`scripts/hil/*.md`)

| Checklist | Path |
| --- | --- |
| ESP32 classic reference HIL | [`scripts/hil/esp32-classic.md`](../scripts/hil/esp32-classic.md) |
| ESP32-C3 experimental | [`scripts/hil/esp32-c3-experimental.md`](../scripts/hil/esp32-c3-experimental.md) |
| ESP32-S3 experimental | [`scripts/hil/esp32-s3-experimental.md`](../scripts/hil/esp32-s3-experimental.md) |
| Modbus lamp | [`scripts/hil/modbus-lamp.md`](../scripts/hil/modbus-lamp.md) |
| Crash-window B lamp | [`scripts/hil/crash-window-b-lamp.md`](../scripts/hil/crash-window-b-lamp.md) |
| Awareness + connectors | [`scripts/hil/awareness-connectors.md`](../scripts/hil/awareness-connectors.md) |

These are operator procedures (oscilloscope / DMM / visual LED checks). Firmware
ACK is not physical proof. Do not upgrade catalog rows to `HARDWARE_VERIFIED`
without a matching dated record.

---

## Not yet included

- **End-to-end agent task-time comparison on real ESP32 / Pico hardware.** That
  would require a flashed board, a model provider key, and a defined task suite.
  No such benchmark exists in this repository yet, so this page includes no
  LLM-versus-Pinout task-time numbers and does not imply any.

---

## Honesty summary

| Runner | Evidence | LLM? | Physical timing? |
| --- | --- | --- | --- |
| `npm run bench` | `SIMULATED` | no | no |
| `npm run bench:mcp` | `SIMULATED` | no | no |
| `npm run bench:watchdog` | `SIMULATED` | no | no |
| `npm run bench:journal` | `SIMULATED` | no | no |
| `npm run hardware:smoke` | needs operator + dated record for `HARDWARE_VERIFIED` | no | yes (manual) |
| `scripts/hil/*.md` | manual HIL; `HARDWARE_VERIFIED` only with dated record | no | yes (manual) |
