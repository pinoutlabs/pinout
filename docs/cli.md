# CLI reference

The `pinout` CLI provides two distinct operational modes:

1. **Governed Daemon Commands**: Interact with a running `pinoutd` execution daemon over HTTP to manage safety halts, multi-agent leases, operation tracking, and audit journals.
2. **Direct Developer Commands**: Talk directly to local serial hardware, simulators, or the local module registry for bring-up, testing, and module development without requiring a daemon.

```bash
npm run pinout -- <command> [options]
```

## Daemon options and environment

Daemon-routed commands connect to `pinoutd` using the following options and environment variables:

| Option | Env | Default | Description |
| --- | --- | --- | --- |
| `--url <url>` | `PINOUT_DAEMON_URL`, `PINOUT_URL` | `http://127.0.0.1:8787` | Pinout daemon base URL |
| — | `PINOUT_TOKEN` | — | Bearer authentication token |
| `--owner <owner>` | `PINOUT_OWNER` | `cli-lease` | Default principal name for lease management |

## Direct device options

Direct commands (`hello`, `exec`, `run`, `blink`, `gpio *`) bypass `pinoutd` to connect directly to a single device via serial or simulator:

| Option | Env | Default | Description |
| --- | --- | --- | --- |
| `--port <path>` | `PINOUT_PORT` | — | Serial port path |
| `--mock` | — | false | Simulated ESP32 |
| `--baud <rate>` | `PINOUT_BAUD` | 115200 | Serial baud rate |
| `--timeout <ms>` | `PINOUT_TIMEOUT` | 5000 | Request timeout |
| `--json` | — | false | Structured JSON output |

Provide either `--port` (or `PINOUT_PORT`) or `--mock`.

## Governed daemon commands

These commands route through `pinoutd` and enforce centralized safety, leases, and audit journals:

| Command | Description |
| --- | --- |
| `daemon status` | Show daemon health, safety state, and device count |
| `halt <reason>` | Request software halt: reject all new physical capability invocations |
| `resume` | Resume a halted daemon |
| `estop <reason>` | Request software emergency stop (sticky software latch; not certified hardware E-stop) |
| `estop-clear` | Clear emergency stop latch (runtime stays halted until `resume`) |
| `lease list` | List all active leases across devices and capabilities |
| `lease acquire <deviceId> [--owner <name>] [--ttl <ms>] [--shared]` | Acquire an exclusive or shared-read lease |
| `lease release <leaseId> [--owner <name>]` | Release an active lease |
| `arm <deviceId> [--owner <name>] [--timeout <ms>]` | Arm a registered device for actuation (daemon-routed) |
| `disarm <deviceId> [--owner <name>]` | Disarm a registered device (daemon-routed) |
| `operations [--device <id>]` | List tracked daemon operations and status |
| `logs [--device <id>] [--limit <n>]` | Inspect the append-only daemon control journal |

## Direct developer and registry commands

These commands run in-process for local module authoring, testing, and single-device bring-up:

| Command | Description |
| --- | --- |
| `devices` | List configured/active Pinout runtime devices from local config |
| `ports` | List discoverable serial ports on host |
| `doctor` | Staged diagnostic: environment, daemon, serial discovery, firmware identity, and registry checks |
| `pins` | ESP32 safe/forbidden pin table |
| `hello` | Connect and print capabilities (single device) |
| `exec <action>` | Invoke action on directly connected device (`--payload '{...}'`) |
| `invoke <deviceId> <capability>` | Invoke capability on local runtime device |
| `module create\|test\|install\|list\|inspect\|uninstall` | External module workflow |
| `device add\|remove\|list\|inspect` | Persistent device registry (~/.pinout/devices.json) |
| `runtime start` | Bootstrap runtime from `~/.pinout/devices.json` |
| `runtime inspect [deviceId]` | Inspect identity, health, backend mode, state, and capabilities |
| `runtime capabilities [deviceId]` | List capability schemas and physical-output classification |
| `runtime tools [deviceId]` | List the agent/MCP tool projection |
| `runtime emergency-stop [deviceId] --yes` | Best-effort advertised stop actions; not a certified E-stop |
| `run [file]` | NDJSON action script on one persistent connection |
| `blink` | Blink GPIO 2 (or `--pin`) with `--count` / `--delay` |
| `gpio write\|read\|mode\|toggle\|pulse\|pwm\|analog\|watch\|unwatch` | GPIO shortcuts |

Examples:

```bash
# Daemon operations
npm run pinout -- daemon status
npm run pinout -- halt "maintenance"
npm run pinout -- lease acquire relay-01 --owner agent-alpha
npm run pinout -- logs --limit 10

# Direct developer and module testing
npm run pinout -- hello --mock
npm run pinout -- exec gpio.write --payload '{"pin":2,"value":true}' --mock
npm run pinout -- module test ./examples/external-module/weird-sensor
npm run pinout -- module install ./examples/external-module/weird-sensor
npm run pinout -- device add sensor-01 --module weird-sensor/thermometer --simulated
npm run pinout -- devices
npm run pinout -- invoke sensor-01 temperature.read --payload '{}'
npm run pinout -- blink --mock --count 3

# Diagnostics and bring-up
npm run pinout -- doctor
npm run pinout -- doctor --port /dev/cu.usbserial-0001
npm run pinout -- doctor --no-daemon
npm run pinout -- doctor --json
```

## Simulator walkthrough

This short walkthrough stays local and uses the built-in simulated ESP32. It
does not open a serial port or verify a physical output. Build once, then use
two terminals.

Terminal A (leave the daemon running):

```bash
npm run build
node packages/daemon/dist/main.js --demo --token local-demo-token
```

Terminal B:

```bash
export PINOUT_TOKEN=local-demo-token
export PINOUT_OWNER=cli-docs

# Read-only discovery of serial/USB candidates.
npm run pinout -- discover --no-mdns

# Inspect the simulator's advertised capabilities through the direct CLI runtime.
npm run pinout -- --json runtime capabilities esp32-01

# Preview a daemon-routed actuation. The daemon validates policy but does not execute it.
curl -sS -X POST http://127.0.0.1:8787/v1/devices/esp32-01/invoke \
  -H "Authorization: Bearer $PINOUT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"capability":"gpio.write","args":{"pin":2,"value":true},"owner":"cli-docs","dryRun":true}'

# Invoke a read-only capability against the local simulator through the CLI.
npm run pinout -- --json invoke esp32-01 gpio.read --payload '{"pin":2}'

# Halt the daemon, inspect its shared safety state, then restore it.
npm run pinout -- halt "walkthrough complete"
npm run pinout -- --json daemon status
npm run pinout -- resume
```

The discovery command reports candidate ports, `runtime capabilities` lists
capability names and whether they have physical output, and the dry-run
response includes `dryRun: true` and `policy.allowed: true` without creating an
operation. The daemon status response shows its safety state and device count.
The CLI invocation above is a direct, in-process simulator command; daemon
governance, leases, and the HTTP dry-run route are described in the [daemon
guide](daemon.md). Read the [safety model](safety-model.md) before adapting
the sequence for hardware.

### Diagnostic doctor (`pinout doctor`)

`pinout doctor` executes a multi-stage, non-actuating diagnostic:

| Option | Default | Description |
| --- | --- | --- |
| `-p, --port <path>` | — | Serial port path to probe firmware identity |
| `-d, --device <id>` | — | Enrolled device id to probe firmware identity |
| `--mock` | false | Probe simulated ESP32 instead of serial hardware |
| `--no-daemon` | false | Skip daemon reachability check |
| `--url <url>` | `PINOUT_DAEMON_URL` or `http://127.0.0.1:8787` | Override daemon base URL |
| `--timeout <ms>` | 3000 | Handshake and discovery timeout |
| `--json` | false | Emit structured JSON output |

Stages evaluated:
- **Environment**: Node version ($\ge 20$), `~/.pinout` home directory presence and write permissions, and resolved `PINOUT_*` environment variables.
- **Daemon**: Reachability and health probe of `pinoutd`.
- **Serial Discovery**: Serial port enumeration with USB VID/PID matching against board descriptors in `firmware/boards/`. Unidentified boards generate a warning explaining that Pinout will never auto-flash.
- **Firmware Identity**: Bounded `sys.hello` handshake verifying firmware name, version, protocol version, and advertised watchdog/arming features (legacy firmware without watchdog/arming is warned).
- **Configuration**: Enrolled devices from `~/.pinout/devices.json` and verification of physical port presence.
- **Simulator**: Baseline software simulation verification.

The stop command invokes only stop capabilities advertised by each selected device, records unsupported devices and partial failures, and requires `--yes`. It cannot replace a hardware interlock or safety-rated emergency-stop circuit.

## Module ecosystem

See [build-a-module.md](build-a-module.md) for the full external module developer guide.

```bash
pinout module create my-sensor
pinout module test ./my-sensor
pinout module install ./my-sensor
pinout device add sensor-01 --module my-sensor/device --simulated
```

Local state lives in `~/.pinout/` (override with `PINOUT_HOME`). Device config path: `PINOUT_CONFIG` or `~/.pinout/devices.json`.

## MCP server

Use `@pinout/mcp` for agent integrations (no shell access):

```bash
PINOUT_MOCK=1 npm run mcp                              # single simulated ESP32
PINOUT_DEMO=heterogeneous npm run mcp                  # built-in demo runtime
PINOUT_CONFIG=~/.pinout/devices.json npm run mcp       # configured devices + external modules
```

Configure your MCP client to launch `pinout-mcp` after `npm run build`, with `PINOUT_PORT` or `PINOUT_MOCK=1`.
