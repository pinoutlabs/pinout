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

## Tool and error shapes

Daemon-backed MCP exposes the control-plane tools below alongside
device-specific capability tools. The examples use the simulated `relay-mcp`
device from the test transcript and contain no credentials or hardware
assumptions.

| Role | Tool and example | What to expect |
| --- | --- | --- |
| Read-only state | `pinout__read_state({deviceId:"relay-mcp"})` | A result with `deviceId`, `state`, and `stateEvidence`; it does not require a lease or change the device. |
| Lease-gated actuation | First call `pinout__acquire_lease({deviceId:"relay-mcp",mode:"exclusive"})`, then `relay_mcp__relay_set({on:true,_pinout:{idempotencyKey:"relay-on-1",waitFor:"accepted"}})` | The lease call returns a lease. The capability call returns an operation handle. A missing or conflicting lease is reported as `SAFETY_LEASE_REQUIRED` or `LEASE_CONFLICT`. |
| Operation inspection | `pinout__operation_status({operationId:"op_..."})` | A read-only operation snapshot, including status, progress, and (when complete) the result. Use the returned operation id; do not invent a replacement key when retrying. |

Structured failures are returned with `isError: true`. Their text content is
JSON with the stable `code`, human-readable `message`, and `retryable` fields;
daemon-backed failures may also include `details` containing the underlying
`category` (`VALIDATION`, `SAFETY`, `LEASE`, `OPERATION`, `TRANSPORT`, and so
on). Branch on `code`, never on English prose. Common codes include
`SAFETY_LEASE_REQUIRED` for a missing lease, `SAFETY_HALTED` when the daemon is
halted, `UNSUPPORTED_CAPABILITY` for an unavailable device capability,
`OPERATION_REQUIRES_RECONCILIATION` for an uncertain operation, and
`DAEMON_UNAVAILABLE` when the daemon cannot be reached. A daemon-unavailable
response leaves the MCP session open so the caller can retry discovery or
status later.

Embedded and daemon-backed modes have different control-plane behavior:

- **Daemon-backed (default):** `pinout-mcp` talks to `PINOUT_DAEMON_URL` and
  sends `PINOUT_TOKEN` when configured. Leases, dry runs, operations, halt
  state, and the journal belong to the single `pinoutd` process.
- **Embedded development:** set `PINOUT_MCP_EMBEDDED=1` and `PINOUT_MOCK=1`.
  The runtime and simulated ESP32 live in the MCP process; read-only tools and
  device capabilities work, while lease, dry-run, and operation-manager tools
  return `CONTROL_PLANE_UNAVAILABLE` because no daemon manager is present.
  This mode is for hardware-free development.

See the [safety model](safety-model.md) and [security model](security-model.md)
for lease, halt, authentication, and direct-access boundaries.

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
