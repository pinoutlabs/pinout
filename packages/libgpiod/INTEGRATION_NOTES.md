# Integration notes — `@pinout/libgpiod`

This package is self-contained: everything added by this change lives under
`packages/libgpiod/`. It is **not** wired into the root build, the catalog, or
the discovery pipeline yet. This file lists the shared-file changes an
integrator must make, and the decisions/uncertainties behind the package so
none of them live only in code comments.

Status of the package: **IMPLEMENTED, fake-runner-tested, Linux-only.**
It is **not** `HARDWARE_VERIFIED` — no physical GPIO line was driven during
development, and no Linux host was available to run the tools against even a
`gpio-sim` virtual chip.

## 1. Shared files that need changes (do not copy blindly; review each)

### 1.1 Root `tsconfig.json` — add the project reference

```json
    {
      "path": "packages/libgpiod"
    },
```

Place it alongside the other `packages/protocols-*` entries. Without this the
package is not type-checked by `tsc -b`.

No other build wiring is needed: the root `vitest.config.ts` already includes
`packages/*/tests/**/*.test.ts`, and the package's `@pinout/core` import is
already aliased to `packages/core/src/index.ts`. Coverage thresholds in the
root config only measure `packages/core/src/**` and are unaffected.

### 1.2 `hardware/catalog.json` — flip the "Linux SBC GPIO (libgpiod)" row

Current row (kept verbatim here so it keeps matching):

```json
{
  "category": "embedded",
  "target": "Linux SBC GPIO (libgpiod)",
  "integration": "planned",
  "status": "PLANNED",
  "testedHow": "none",
  "notes": "libgpiod-first design; sysfs only as documented fallback."
}
```

Suggested replacement:

```json
{
  "category": "embedded",
  "target": "Linux SBC GPIO (libgpiod)",
  "integration": "@pinout/libgpiod (module pinout/linux-gpio)",
  "status": "IMPLEMENTED",
  "testedHow": "scripted-runner unit tests for argv construction, output parsing, evidence, and safe state; not verified against real hardware",
  "notes": "libgpiod v2 CLI only (never sysfs); Linux-only; not HARDWARE_VERIFIED."
}
```

`IMPLEMENTED` (not `SIMULATED`) is the honest label: the code drives real
tools on Linux, and the tests substitute only the process-spawn seam.

### 1.3 `docs/hardware-support.md` — suggested blurb

Add next to the other backend sections:

```markdown
## Linux SBC GPIO (`pinout/linux-gpio`)

Linux boards with `/dev/gpiochip*` are supported through the libgpiod v2
command-line tools (`@pinout/libgpiod`):

- **Catalog Status:** `IMPLEMENTED` (scripted-runner unit tests; libgpiod v2
  tool output parsers fixture-tested).
- **Physical Verification:** **PENDING** — requires a dated operator-observed
  record under `hardware/records/` (and a `gpio-sim`-based integration run
  would be welcome before that).
- **Prerequisites:** libgpiod v2 tools on `PATH`; `--hold-period` (set-once
  writes) needs libgpiod ≥ 2.2.
```

## 2. Registration contract (runtime behavior to be aware of)

- `PinoutRuntime.registerModuleDevice` computes
  `simulated = options.simulated ?? !options.transport`. Since this module has
  **no transport**, omitting `simulated` silently selects the simulated path —
  and `createBackend` throws a clear error for `simulated: true`. Always
  register with `{ simulated: false, backendOptions: { chip, lines, ... } }`
  from `runtime.registerModuleDevice`, or `runtime.registerFromModule(
  'pinout/linux-gpio', ...)` with the same options.
- There is intentionally **no simulated backend**: a fake GPIO level would
  misreport physical lines. If Pinout later wants a `pinout/linux-gpio`
  simulator for UI demos, it should be a separate module (for example wrapping
  `gpio-sim` or exposing a clearly-labeled virtual chip), not a silent
  fallback inside this one.
- `supportedTransportKinds: ['host']` is a synthetic kind: this device has no
  `Transport` object at all. When registered without a transport,
  `activeTransportKind` falls back to `backend.kind` (`'protocol'`). If a
  stricter catalog check ever validates `supportedTransportKinds` against
  `Transport.kind`, `'host'` is the value to add to that allow-list for
  host-local devices (the same applies to any future native backend).

## 3. Discovery wiring (optional follow-up)

`proposeLibgpiodDevices(runner)` returns one proposal per chip with an
input-only `suggestedConfig`, `readOnly: true`, and notes. Proposed device ids
are `linux-gpio-<chip>` (e.g. `linux-gpio-gpiochip0`).

A future `packages/discovery` plugin could run it on Linux hosts and map the
proposals to `DiscoveredCandidate`s. Keep two properties if that happens:

1. **Non-actuating**: only `gpiodetect` + `gpioinfo` may be invoked. The unit
   tests assert that no other tool ever reaches the runner.
2. **Never auto-enroll outputs**: proposals contain inputs only, and notes say
   outputs must be added by a human with an explicit `safeLevel`/`polarity`.

On non-Linux hosts the discovery function throws `PLATFORM_UNSUPPORTED`, so a
plugin should check `isLinux()` (exported from the package) before calling, or
treat that code as "not applicable".

## 4. Design decisions worth knowing

- **libgpiod v2 only.** v1 flags are rejected loudly at runtime. A v1 host
  fails with `GPIO_OPERATION_FAILED` and the raw stderr preserved.
- **`--hold-period <N>ms -t0` for set-once writes.** This is the documented v2
  "set then exit" pattern. `--hold-period` was added in libgpiod 2.2, so the
  README states 2.2 as the practical floor; on 2.0/2.1 only held writes are
  available and `hold: false`/pulses will fail loudly.
- **Software debounce.** `gpiomon` has its own `--debounce-period` flag, but
  using it would make the produced event stream depend on kernel/libgpiod
  version behavior and would be untestable without a kernel. The adapter
  filters in-process instead (`gpio.watch.debounceMs`, bounded at 60 000 ms);
  the flag remains a documented alternative if kernel-side debounce is ever
  required.
- **One `gpioset` child per held line.** Chips and lines are cheap; the
  per-line process makes replacement and release independent, and the kernel
  releases a line when its requesting process dies — which is what makes
  `close()`/timeouts deterministic.
- **Evidence discipline.** A live holder is *acknowledged*, never *observed*.
  Only `gpioget` reads and `gpiomon` events carry source `gpio-readback`.
  `gpio.holdLost` clears the acknowledged value.
- **Safe state order.** Driven safe levels first, in configuration declaration
  order; then `high-z` releases; then `hold` lines and inputs are left alone.
- **`gpio.write` defaults to hold** (`hold: true`); `hold: false` maps to the
  tool's set-once pattern and the result reports `releasedOnExit: true`.
- **Error classification is best-effort.** `GPIOCHIP_NOT_FOUND` /
  `GPIO_LINE_NOT_FOUND` are inferred from documented stderr phrases; raw stderr
  always travels in `details.stderr`.

## 5. Uncertainties (not verifiable without hardware / a Linux host)

None of these are hidden: they are commented in the code where relevant and
listed here for the record.

1. **`gpioset -t0` + `--hold-period` semantics.** Verified against the libgpiod
   v2.2.4 `tools/gpioset.c` source and the v2.2.5 man page: a single toggle
   period of `0` makes the toggle sequence return without toggling, the hold
   period is slept out, and the process exits (rather than waiting forever).
   It has still never been *executed* here. If a release changed that logic,
   `hold: false` writes could exit earlier than the nominal hold window. Needs
   one real (or `gpio-sim`) run to confirm.
2. **`gpioinfo`/`gpiomon` output variants.** The `gpioinfo` parser accepts
   the exact v2.2.4 form (`line   2:\t"PWR_LED_OFF"\toutput active-low
   consumer="led1"`) and the common legacy quoted form (`line  17: "GPIO17"
   "led" output active-high [used]`); verified against the v2.2.4 tool source.
   For `gpiomon`, if a release does not support a `%S`/`%e` specifier it
   prints the specifier literally (per source `default:` branch), which makes
   every line fail to parse and get counted in `stats.unrecognizedLines` —
   never invented into an event. Unknown tokens/lines are always counted,
   never guessed.
3. **`EBUSY` on reading a held line.** `gpioget` against a line another process
   (including our own holder) requests may fail. The adapter surfaces the raw
   tool error rather than serving a cached value; the exact stderr and whether
   `--as-is` changes the outcome were not observed.
4. **Device-tree `active-low` lines.** The adapter never passes the kernel
   `-l`/active-low flag: the kernel's own line flag stays authoritative, and
   the package's `polarity` is a *logical* translation only. If a DT line is
   active-low and a user also declares `polarity: 'active-low'`, the logical
   value is inverted twice relative to the physical load. `gpio.info` reports
   the flag and discovery propagates it into `suggestedConfig`, but a human
   must still review output wiring.
5. **`%S` timestamps** are CLOCK_MONOTONIC seconds per documentation, not wall
   clock. Events carry `deviceTimestampSeconds` plus the adapter's own
   wall-clock `receivedAt`/`at`; only the latter should be compared with
   journal timestamps.
6. **Holder/watch startup grace.** A process that survives the grace window
   (default 50 ms) is treated as established. On a slow board, a real failure
   could theoretically arrive after the grace; the follow-up `gpio.holdLost` /
   `gpio.watchStopped` events are the safety net.
7. **No hardware verification.** No oscilloscope or loopback test has been
   run. `tests/` prove argv construction, parsing, evidence bookkeeping, and
   lifecycle logic against the scripted runner — nothing more.

## 6. Test coverage summary

- `tests/tools.test.ts` — parsers (gpiodetect/gpioinfo/gpioget/gpiomon,
  fixture text), argv construction and locale pinning, validation, timeout,
  ENOENT, tool-stderr classification, platform gate, holder lifecycle
  (spawn/SIGTERM/SIGKILL escalation), watch events, debounce, unrecognized
  output accounting.
- `tests/backend.test.ts` — config validation (defaults, safe-level/polarity
  energize rejection, malformed input), polarity translation, held writes,
  holder replacement, active-low raw levels, set-once writes, pulses and pulse
  cancellation, input/undeclared-line refusal, `gpio.holdLost`, reads with
  bias and `gpio-readback` evidence, watch edge translation, `watchStopped`,
  safe-state ordering/actions (driven/released/kept/skipped),
  `gpio.info` + `GPIOCHIP_NOT_FOUND`, operational-state evidence, platform
  gating, idempotent `close()`, `DISCONNECTED`/`UNKNOWN_ACTION`, and a
  hand-written runner object proving the seam is an interface.
- `tests/discovery.test.ts` — proposal shape, input-only `suggestedConfig`,
  used/output exclusion notes, no actuating tools (explicit assertion on
  `gpioset`/`gpioget`/`gpiomon`), chip filter, absent chip, platform gate,
  name sanitization/deduplication, unparsed-line accounting.

## 7. Suggested follow-up work (not done here)

- A `gpio-sim`-based integration test (Linux CI job) that creates a virtual
  chip and exercises the real `NodeCommandRunner`.
- CLI surface: `pinout gpio info|read|write|watch` commands mapped to these
  capabilities.
- Natural overlay: a Raspberry Pi SBC board descriptor could constrain
  `gpio.info` output (40-pin header labels) once descriptors grow GPIO roles.
