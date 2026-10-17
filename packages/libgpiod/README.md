# @pinout/libgpiod

Linux SBC GPIO backend for Pinout, built entirely on the **libgpiod v2
command-line tools**. It turns the 40-pin header of a Raspberry Pi, Jetson,
Orange Pi, or any board with `/dev/gpiochip*` into a Pinout device with a
declared, safe-leveled line list — with **zero native dependencies** (no
`node-gyp`, no `libgpiod` bindings; only `gpiodetect`, `gpioinfo`, `gpioget`,
`gpioset`, `gpiomon` executed through a sealed command runner).

**Status: IMPLEMENTED.** The adapter is unit-tested end-to-end against a
scripted `CommandRunner`. It is **not** `HARDWARE_VERIFIED`: no real GPIO line
was driven while developing this package (see
[Uncertainties](#uncertainties)). Treat every claim here as software evidence
until a dated hardware record exists under `hardware/records/`.

## Prerequisites

- Linux host with a GPIO character device (`/dev/gpiochip*`).
- **libgpiod v2 tools** on `PATH`: Debian/Ubuntu `apt install gpiod`
  (Ubuntu 24.04+, Debian 13+), Fedora `dnf install libgpiod-utils`, Arch
  `pacman -S libgpiod`. libgpiod v1 `gpioset`/`gpiomon` use different flags and
  will fail loudly with `GPIO_OPERATION_FAILED` rather than misbehave.
- Read/write access to the chip device. Usually membership in group `gpio` is
  enough; root is not required.
- `--hold-period` (used for set-and-release writes) requires libgpiod **2.2**
  or newer. Everything else works on any v2 release.

## Architecture

```
pinout/linux-gpio (module.ts, defineModule)
        │
LibgpiodBackend (backend.ts)          ← DeviceBackend, kind 'protocol'
        │  capabilities: gpio.info, gpio.read, gpio.write,
        │                gpio.watch, gpio.unwatch, gpio.safeState
        ├── GpioTools (tools.ts)      ← typed wrappers, argv construction, parsing entry
        │        │
        │        └── CommandRunner (runner.ts)   ← the only place node:child_process appears
        │                 ├── NodeCommandRunner      (production: execFile/spawn, no shell)
        │                 └── FakeCommandRunner      (tests: scripted results, recorded argv)
        └── parser.ts                 ← pure, fixture-tested output parsers
```

- **One `gpioset` child per held line.** libgpiod holds a line until the
  requesting process exits, so a "held" output is a live child process owned by
  the backend. Releasing means terminating it; the kernel releasing lines on
  process death is what makes the safety story work at all.
- **No shell, ever.** Every tool is executed with an explicit argv array.
  Chip names, line names, and consumer names can never be interpreted by a
  shell.
- **One chip per device.** A device instance binds to one chip
  (`gpiochip0` by default) and only ever touches offsets declared in its
  configuration. Undeclared offsets or names are refused with
  `GPIO_LINE_NOT_FOUND`; there is no "any pin" escape hatch.
- **Discovery is non-actuating.** `proposeLibgpiodDevices` runs only
  `gpiodetect` + `gpioinfo` and proposes input-only configurations.

## Command-line tools used

| tool         | flags                                                              | purpose                        |
| ------------ | ------------------------------------------------------------------ | ------------------------------ |
| `gpiodetect` | —                                                                  | list chips (`gpio.info`)       |
| `gpioinfo`   | `--chip <chip>`                                                    | list lines (`gpio.info`)       |
| `gpioget`    | `--chip`, `--consumer pinout`, `--numeric`, `--as-is`, `[--bias]`  | read a level (`gpio.read`)     |
| `gpioset`    | `--chip`, `--consumer pinout`, `<offset>=<raw>...`                 | hold a level (`gpio.write`)    |
| `gpioset`    | plus `--hold-period <N>ms -t0`                                     | set once, release              |
| `gpiomon`    | `--chip`, `--consumer pinout`, `--format=%o %e %S`, `--edges both` | watch edges (`gpio.watch`)     |

Flags are pinned to libgpiod v2 semantics; `LC_ALL=C`/`LANG=C` are set so the
parsers see stable output. Debouncing is implemented in software per line
rather than via `gpiomon --debounce-period` — documented in
[INTEGRATION_NOTES.md](./INTEGRATION_NOTES.md).

## Safety model

- `polarity` (`active-high` / `active-low`) describes the **load wiring**, and
  `safeLevel` (`low` / `high` / `high-z` / `hold`) is validated against it: a
  configuration whose safe state would *energize* the load (active-high with
  `safeLevel: 'high'`, or active-low with `safeLevel: 'low'`) is rejected at
  validation time with `UNSUPPORTED_CONFIGURATION`.
- Inputs are read-only and cannot be assigned a driven safe level; outputs
  cannot specify an input bias. Inputs default to `safeLevel: 'high-z'`.
- `gpio.safeState` drives configured safe levels first (de-energization is the
  urgent part), then releases `high-z` lines, then leaves `hold` lines
  untouched — and cancels any pending pulse.
- Evidence is kept honest: a successful `gpioset` is *acknowledged*, never
  *observed*. Only `gpioget` reads and `gpiomon` events are recorded with
  source `gpio-readback`. If a holding child dies unexpectedly, the backend
  emits `gpio.holdLost` and clears the acknowledged value instead of pretending
  the old level still applies.
- **A host crash releases every line this process held.** Software safe state
  cannot protect against a crashed or powered-off host; physical fail-safes
  (pull-downs, relays, interlocks) remain mandatory. `gpio.safeState` is a
  best-effort command, not a certified safety function.

## Usage

```ts
import { PinoutRuntime } from '@pinout/core';
import { libgpiodModule, libgpiodModuleId } from '@pinout/libgpiod';

const runtime = new PinoutRuntime();
await runtime.registerModuleDevice(libgpiodModule, {
  id: 'bench-pi',
  // There is no simulated backend: this must be explicit, and the backend
  // options carry the real wiring description.
  simulated: false,
  backendOptions: {
    chip: 'gpiochip0',
    lines: [
      { offset: 17, name: 'status_led', direction: 'output' }, // default safeLevel 'low'
      { offset: 22, name: 'button', direction: 'input', bias: 'pull-up' },
      { offset: 23, name: 'relay', direction: 'output', polarity: 'active-low' }, // safeLevel 'high'
    ],
  },
});

const led = runtime.getDevice('bench-pi');
await led.invoke('gpio.write', { line: 'status_led', value: true }); // held
await led.invoke('gpio.write', { line: 'status_led', value: true, pulseMs: 250 });
await led.invoke('gpio.read', { line: 'button' });
await led.invoke('gpio.watch', { lines: ['button'], debounceMs: 20 });
await led.invoke('gpio.safeState', {});
```

Using the module directly (tests, tooling):

```ts
import { LibgpiodBackend, proposeLibgpiodDevices, NodeCommandRunner } from '@pinout/libgpiod';

const runner = new NodeCommandRunner();
const proposals = await proposeLibgpiodDevices(runner); // read-only scan
const backend = new LibgpiodBackend({ runner, chip: 'gpiochip0', lines: [...] });
```

## Events

| event                | meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `gpio.changed`       | a write/pulse phase completed, or a watch edge was observed    |
| `gpio.holdLost`      | a holding child died outside of a backend command              |
| `gpio.watchStopped`  | the `gpiomon` child exited unexpectedly                        |
| `safe_state.applied` | safe levels were applied (whole device or a single line)       |

## Error codes

| code                      | meaning                                                     |
| ------------------------- | ----------------------------------------------------------- |
| `PLATFORM_UNSUPPORTED`    | host is not Linux; no tool was invoked                      |
| `GPIOCHIP_NOT_FOUND`      | chip absent (pre-checked, or from tool stderr)              |
| `GPIO_LINE_NOT_FOUND`     | line not declared in the config, or tool stderr says so     |
| `GPIO_TOOL_MISSING`       | executable could not be started (ENOENT/EACCES)             |
| `GPIO_OPERATION_FAILED`   | tool failed or output could not be parsed; stderr preserved |
| `COMMAND_TIMEOUT`         | tool exceeded its timeout and was killed                    |
| `VALIDATION_ERROR`        | malformed payload/config value                              |
| `UNSUPPORTED_CONFIGURATION` | configuration is contradictory or unsafe (see safety)     |

## Uncertainties

Nothing below is hidden in code comments only; the full list lives in
[INTEGRATION_NOTES.md](./INTEGRATION_NOTES.md).

- Not verified against real hardware or a GPIO simulator. Real `gpioset`
  termination timing, `EBUSY` behavior when a second process requests a held
  line, and `gpiomon` buffering are modeled from the tool source and
  documentation, not observed.
- `gpioinfo` output formatting varies across libgpiod v2 releases; the parser
  accepts the documented v2 form and the common legacy quoted form, and counts
  anything else as `unparsedLines` instead of guessing.
- `gpiomon` timestamps are CLOCK_MONOTONIC seconds; only the adapter's
  `receivedAt`/`at` fields are wall-clock.

## Testing

```sh
npm test --workspace @pinout/libgpiod   # vitest run
```

Tests use `FakeCommandRunner` exclusively: scripted stdout/stderr, recorded
argv, fake child processes with push/exit/kill. No Linux machine and no
libgpiod installation are needed to run them — which is also why they prove
software behavior, not wire behavior.
