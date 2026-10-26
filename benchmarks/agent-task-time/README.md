# Agent task-time benchmark (raw vs Pinout)

Honest wall-clock comparison of an LLM agent completing the **same** hardware
tasks in two arms. Results are produced **only** by running the harness. Nothing
in this directory is pre-filled with timings or success rates.

| Arm | What the agent gets |
| --- | --- |
| **A `raw`** | No Pinout. Datasheet, workspace files, compile/flash tools, serial. On `--device real`, flash uses real toolchains (`arduino-cli` / `esptool` / `mpremote` / `picotool`) and talks to the attached serial port. |
| **B `pinout`** | Compact Pinout MCP/SDK-shaped tool set: `list` / `describe` / `read_state` plus task-relevant capabilities (`sys.arm`, `gpio.write`, `gpio.servo`, `gpio.analogRead`, ...). On `--device real`, tools call a running `pinoutd` (warm connection). |

Tool budgets are intentionally similar in size. The Pinout arm does **not** receive
the entire capability catalog. The raw arm does **not** receive Pinout shortcuts.

Tasks (automatic checkers use device journal/state, never the model claim):

1. `blinkLed`
2. `servoSweep`
3. `readSensor`

Profiles: `esp32`, `pico`, `uno`.

## Evidence labels

- **SIMULATED** (default `--device simulated`): in-process simulators. Not hardware.
- **REAL_HARDWARE** (`--device real`): physical board path. Marked **UNTESTED on
  physical hardware in this repository until a dated hardware record exists.**
- **HARNESS_TEST_NOT_LLM** (`--dry-run` / `--scripted-agent`): harness self-test only.
  Not an LLM result.

## Prerequisites

- Node.js 22 (also works on Node `>=20`)
- From repo root: `npm install` and `npm run build`
- LLM API key for a real model run (`OPENAI_API_KEY`, etc.)

### Real-board extras

- A wired board (see Wiring)
- Profile toolchain on `PATH`:
  - ESP32: `esptool.py` or `esptool`, and/or `arduino-cli`
  - Pico: `mpremote` and/or `picotool`
  - Uno: `arduino-cli`
- For Arm B: a running `pinoutd` already connected to the board
- Serial port path (`--serial-port` / `PINOUT_PORT`)

Preflight detects ports, toolchains, and `pinoutd`, and fails with a clear error
if anything required is missing.

## Exact commands

### Simulated LLM run (no board)

```bash
npm install
npm run build
PINOUT_BENCH_PROVIDER=openai PINOUT_BENCH_MODEL=gpt-6.1-sol OPENAI_API_KEY=... \
  npm run bench:agent -- --runs 5
```

Optional spend guards:

```bash
PINOUT_BENCH_PROVIDER=openai PINOUT_BENCH_MODEL=gpt-6.1-sol OPENAI_API_KEY=... \
  npm run bench:agent -- --runs 5 --budget-usd 5 --max-tokens 500000
```

### Real board (ESP32 DevKit example)

```bash
# Terminal A: start pinoutd against the board (warm connection for Arm B)
PINOUT_PORT=/dev/ttyUSB0 npm run pinout -- daemon start
# or: node packages/daemon/dist/main.js  (with PINOUT_PORT set)

# Terminal B: run the bench
PINOUT_BENCH_PROVIDER=openai PINOUT_BENCH_MODEL=gpt-6.1-sol OPENAI_API_KEY=... \
  npm run bench:agent -- \
    --device real \
    --profiles esp32 \
    --serial-port /dev/ttyUSB0 \
    --runs 5 \
    --confirm-physical
```

### Real board (Pico)

```bash
PINOUT_BENCH_PROVIDER=openai PINOUT_BENCH_MODEL=gpt-6.1-sol OPENAI_API_KEY=... \
  npm run bench:agent -- \
    --device real \
    --profiles pico \
    --serial-port /dev/ttyACM0 \
    --runs 5 \
    --confirm-physical
```

### Real board (Uno)

```bash
PINOUT_BENCH_PROVIDER=openai PINOUT_BENCH_MODEL=gpt-6.1-sol OPENAI_API_KEY=... \
  npm run bench:agent -- \
    --device real \
    --profiles uno \
    --serial-port /dev/ttyUSB0 \
    --runs 5 \
    --confirm-physical
```

`--confirm-physical` prompts yes/no after each run so an operator can confirm LED
or servo motion. Journal/state checks still run independently; the prompt is
recorded as yes/no/skipped.

Outputs are written only by the run under
`benchmarks/agent-task-time/results/<date>/` (created at runtime; not checked in):

- `runs/*.json` and `*.transcript.jsonl`
- `summary.json`
- `RESULTS.md`
- `config.redacted.json` (API keys removed)

Regenerate markdown from an existing summary:

```bash
npm run bench:agent:markdown -- benchmarks/agent-task-time/results/<date>/summary.json
```

## Wiring

Use the profile LED / servo / ADC pins from the datasheets under
`fixtures/datasheets/`. Typical desk wiring:

### ESP32 DevKit V1

- LED (+ resistor) on **GPIO 2** (or the onboard LED if present)
- Servo signal on **GPIO 18**, servo power from a suitable supply (not the ESP 3V3 rail for large servos)
- Analog sensor on **GPIO 34** (input-only ADC)
- USB serial to the host (`/dev/ttyUSB0` or similar)

### Raspberry Pi Pico

- Onboard LED on **GPIO 25** (non-W)
- Servo signal on **GPIO 15**
- ADC on **GPIO 26**
- USB CDC serial (`/dev/ttyACM0` or similar)

### Arduino Uno

- Onboard LED on **GPIO 13**
- Servo signal on **GPIO 9**
- Analog on **A0** / **GPIO 14**
- USB serial (`/dev/ttyUSB0` or similar)

## What each arm gets (fairness)

**Raw**

- Datasheet-style board + JSON-line protocol text in the workspace
- `list_workspace` / `read_file` / `write_file`
- Simulated: `compile_flash` + `serial_request`
- Real: `list_serial_ports`, `compile_firmware`, `flash_firmware`, `serial_request`
  using the real toolchains above (no Pinout APIs)

**Pinout**

- Short system prompt (same length class as raw)
- `pinout__list_devices`, `pinout__describe_device`, `pinout__read_state`
- Task-relevant capabilities only: `sys.arm`, `sys.disarm`, watchdog helpers,
  `gpio.write`, `gpio.read`, `gpio.servo`, `gpio.analogRead`
- Real: those tools call `pinoutd` over HTTP (warm daemon connection)

Arms are interleaved. Between real runs the harness best-effort resets the board
and clears the local journal. Cold vs warm notes record whether `pinoutd` was
already running and first-flash duration when observed.

## Temperature honesty

Models such as `gpt-6.1-sol` reject a `temperature` field. The OpenAI path uses
the Responses API for first-party OpenAI, omits temperature for those models, and
records `model default` in config/results instead of claiming `0`.

## How to add a model

1. Set `PINOUT_BENCH_PROVIDER` and `PINOUT_BENCH_MODEL`
2. Set the API key env var
3. Optionally set `PINOUT_BENCH_API_BASE_URL` for OpenAI-compatible proxies
4. Run `npm run bench:agent -- --runs N`
5. Commit only generated `results/<date>/` from a real measurement you performed
   (never hand-edit numbers)

## Interpreting results

- Compare median and p90 wall-clock per arm × task × profile
- Always read success rate; failures and timeouts are kept
- `llmTimeMs` vs `toolTimeMs` separates model time from tool/device time
- No relative-speed claims are hard-coded anywhere in this harness

## Harness self-test (not a result)

```bash
npm run bench:agent -- --dry-run --runs 1 --profiles esp32 --tasks blinkLed
```

## Tests

```bash
npm run test -- benchmarks/agent-task-time/tests
npm run typecheck:bench
```

## Results table

Results are produced only by running the script. Do not hand-author numbers here.
After a measured run, include or link the generated `results/<date>/RESULTS.md`.
