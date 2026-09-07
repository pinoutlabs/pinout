# MCP quickstart

`pinout-mcp` connects to the local `pinoutd` authority at
`PINOUT_DAEMON_URL` (default `http://127.0.0.1:8787`) and uses
`PINOUT_TOKEN`. Set `PINOUT_OWNER` to a stable agent principal. Embedded mode
is limited to hardware-free development and requires
`PINOUT_MCP_EMBEDDED=1`.

The executable transcript is
`packages/mcp/tests/daemonE2E.test.ts`. Against the simulated relay it proves
this ordered flow:

1. `pinout__read_state({deviceId:"relay-mcp"})`
2. `pinout__acquire_lease({deviceId:"relay-mcp"})`
3. `pinout__dry_run({deviceId:"relay-mcp", capability:"relay.set", args:{on:true}})`
4. `relay_mcp__relay_set({on:true, _pinout:{idempotencyKey:"mcp-e2e-once", waitFor:"accepted"}})`
5. `pinout__operation_status({operationId})`, including terminal progress
6. `pinout__cancel_operation({operationId})`, which is idempotent after completion
7. After `/v1/halt`, another `relay_mcp__relay_set` is denied with
   `SAFETY_HALTED`.

Capability descriptions explicitly label physical side effects,
reversibility, and lease requirements. `_pinout.idempotencyKey` is the retry
boundary; never retry a physical action under a new key unless a fresh action
is intended.

`pinout__snapshot` returns safety plus every device's identity, health,
operational state, and `stateEvidence` in one call — prefer it over list + N
describe + N state. Tool results use compact JSON (`structuredContent` already
holds the object). Capability invokes parse the MCP tool name and POST
`/v1/devices/:id/invoke` without re-listing tools.

## Evidence-qualified state and the honesty rule

Tools returning device state (`pinout__describe_device` and `pinout__read_state`) expose structured `stateEvidence` alongside legacy `operationalState`/`state` dictionaries. State evidence breaks down state into:

- **`commanded`**: Host intent sent to the device.
- **`acknowledged`**: Firmware receipt acknowledgement.
- **`observed`**: Independent sensor reading, readback pin, or telemetry.
- **`freshnessMs`**: Dynamic age of the physical observation in milliseconds.
- **`stale`**: Whether the observation exceeds the configured maximum age threshold.
- **`provenance`**: `'hardware'` or `'simulated'`.

### The Honesty Rule

> **`observed` is the only field that reflects independent physical evidence; `commanded`/`acknowledged` do not prove physical effect.**

Agents acting over MCP must report available verification honestly:
1. Actuation writes (`relay.set`, `gpio.write`, etc.) set `commanded` and `acknowledged`. They do **not** update `observed` (`observed.source` remains `'none'`).
2. Only independent read capabilities or physical readback establish `observed` state with valid timestamps and freshness metrics.
3. Agents should inspect `observed` and its `freshnessMs`/`stale` attributes rather than asserting physical reality based merely on successful command dispatches.

See [Physical Evidence State Contract](state-evidence.md) for full contract definitions.

## Lifecycle

- **Session duration**: The stdio server stays connected across multiple sequential requests on the same session.
- **Process exit**: When the client closes stdin (EOF), `pinout-mcp` closes the server and runtime cleanly, exiting with status code 0 without hanging.
- **Signal handling**: `SIGINT` and `SIGTERM` trigger a graceful shutdown of the MCP server and any active runtime, exiting with code 0.
- **Daemon unreachability**: If `pinoutd` is unreachable at `PINOUT_DAEMON_URL`, the stdio transport remains open. Discovery succeeds with control-plane tools, and tool calls return a structured `DAEMON_UNAVAILABLE` error with diagnostic details rather than closing the connection unexpectedly.

