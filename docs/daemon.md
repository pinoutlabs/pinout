# pinoutd — the local execution daemon

`pinoutd` (`packages/daemon`) is the local physical execution service. It
hosts the runtime, devices, and module backends; enforces leases, policies,
and the halt coordinator; manages long-running operations; journals activity;
and exposes a local HTTP API.

## Running

```bash
# From the repo root (demo devices for exploration):
node packages/daemon/dist/main.js --demo

# Options:
#   --port 8787        TCP port (default 8787)
#   --host 127.0.0.1   bind host — loopback ONLY unless remote access is
#                      explicitly enabled (see below)
#   --token <t>        require a bearer token on all /v1 routes except health
#   --journal <path>   persist the control journal to a JSONL file
```

## Environment variables

Clients interacting with `pinoutd` (CLI daemon commands, Python SDK, MCP adapter) configure connectivity through standard environment variables:

| Variable | Description | Default |
| --- | --- | --- |
| `PINOUT_DAEMON_URL` | Base URL of the running `pinoutd` instance | `http://127.0.0.1:8787` |
| `PINOUT_URL` | Fallback alias for `PINOUT_DAEMON_URL` | `http://127.0.0.1:8787` |
| `PINOUT_TOKEN` | Shared bearer token for authenticated routes | None (unauthenticated on loopback) |
| `PINOUT_OWNER` | Default client / agent principal for leases and invocations | `cli-lease`, `mcp-stdio`, or caller-specified |

## Security model

- **Loopback by default.** The daemon refuses to bind a non-loopback host
  unless `allowRemote` is set **and** a token is configured. There is no
  configuration that exposes physical control to a network unauthenticated.
- **Bearer auth** when a token is set; `GET /v1/health` stays open for
  readiness probes.
- Secrets belong in environment variables or OS keychains — never in
  `devices.yaml`, never in source control.

## API (v1)

| Route | Purpose |
| --- | --- |
| `GET /v1/health` | Readiness, safety state, device count |
| `GET /v1/snapshot` | One-shot health + safety + per-device state (capabilities, evidence, health) |
| `GET /v1/tools` | MCP-ready capability tools for every registered device |
| `GET /v1/devices` | Device summaries (`?include=capabilities` adds `capabilityDescriptors`) |
| `GET /v1/devices/:id` | Device detail: capabilities + operational state |
| `GET /v1/devices/:id/state` | Operational state + health |
| `POST /v1/devices/:id/invoke` | Invoke a capability (see below) |
| `GET /v1/operations`, `GET /v1/operations/:id` | Operation inspection |
| `POST /v1/operations/:id/cancel` | Cooperative cancellation |
| `POST /v1/operations/:id/reconcile` | Reconcile uncertain operation outcome (`observedComplete`, `observedNotDone`, `abandoned`) |
| `GET/POST /v1/leases`, `POST /v1/leases/:id/renew`, `DELETE /v1/leases/:id` | Lease management |
| `GET /v1/safety`, `POST /v1/halt`, `POST /v1/resume`, `POST /v1/estop`, `POST /v1/estop/clear` | Safety state |
| `GET /v1/events` | Server-Sent Events stream of runtime/operation/safety events |
| `POST /v1/approvals` | Record policy approval token for privileged capabilities |
| `POST /v1/devices/:id/heartbeat` | Safety deadman switch heartbeat |
| `GET /v1/modules` | List active device module identifiers |
| `GET /v1/streams`, `GET /v1/streams/:id/snapshot` | Stream metadata and latest-frame snapshots |
| `WS /v1/streams/:id/frames` | Authenticated stream frames with bounded buffering |
| `GET /v1/journal` | Journal inspection |

### Invocation

```jsonc
POST /v1/devices/relay-01/invoke
{
  "capability": "relay.set",
  "args": { "on": true },
  "waitFor": "result",        // or omitted → 202 with an operation handle
  "idempotencyKey": "retry-42",
  "owner": "agent-a",         // lease owner for lease-gated capabilities
  "timeoutMs": 30000,
  "dryRun": false
}
```

`dryRun: true` returns the resolved arguments and policy verdict **without
executing** — allowed even while halted (planning is safe, execution is not).
It checks device and daemon policies without consuming approvals, rate slots,
or resource budgets. Idempotency keys are scoped to device, capability and
caller; retries return the original operation without executing policy charges
again. The caller name is supplied by the client, not an authenticated user
identity: the daemon still uses a shared bearer token.

### Operation reconciliation

Operations in `requires_reconciliation`, `uncertain`, or `stop_unconfirmed` (e.g. following process restart while an actuation command was in flight) require explicit operator resolution via `POST /v1/operations/:id/reconcile`:

```jsonc
POST /v1/operations/op_1_abc123/reconcile
{
  "resolution": "observedComplete", // "observedComplete" | "observedNotDone" | "abandoned"
  "note": "Visual inspection confirmed valve closed",
  "actor": "operator-alice"
}
```

- `observedComplete`: Confirms physical completion; transitions snapshot to `completed` with `{ reconciled: true, resolution: 'observedComplete' }`. Retries with the original idempotency key observe completion without re-actuating.
- `observedNotDone`: Confirms physical action never took place or was rolled back; transitions snapshot to `cancelled` with `OPERATION_RECONCILED_NOT_DONE`.
- `abandoned`: Marks operation indeterminate; transitions snapshot to `failed` with code `OPERATION_ABANDONED`.

### Evidence-qualified state

Device state responses and stream events distinguish **commanded**, **acknowledged**, and **independently observed** physical state as defined in the [Physical Evidence State Contract](state-evidence.md).

- In `GET /v1/devices`, summaries include `stateEvidence` alongside legacy properties:

```jsonc
GET /v1/devices
[
  {
    "id": "esp32-01",
    "deviceClass": "microcontroller",
    "moduleId": "pinout/esp32",
    "lifecycle": "ready",
    "simulated": true,
    "stateEvidence": {
      "gpio.2": {
        "commanded": { "value": true, "at": "2026-09-05T17:18:20.100Z", "source": "commanded" },
        "acknowledged": { "value": true, "at": "2026-09-05T17:18:20.105Z", "source": "acknowledged" },
        "observed": { "value": true, "at": "2026-09-05T17:18:20.110Z", "source": "gpio-readback" },
        "freshnessMs": 15,
        "stale": false,
        "provenance": "simulated"
      }
    }
  }
]
```

- In `GET /v1/devices/:id`, device detail responses include `stateEvidence` alongside `operationalState`.
- In `GET /v1/devices/:id/state`, legacy callers continue reading `state` without breaking changes while evidence-aware clients inspect structured `stateEvidence` (timestamps, sources, staleness, provenance).
- In `GET /v1/events` (SSE), `runtime.event` payloads contain the device `stateEvidence` mapping in their event envelopes.

### Stream frames

Connect a WebSocket client to `/v1/streams/<encoded-stream-id>/frames`, with
`Authorization: Bearer <token>` when configured. Tokens are not accepted in URLs.
The endpoint is read-only; publishing remains an in-process `StreamBus` operation.

Binary messages contain a four-byte unsigned big-endian JSON-header length,
the UTF-8 JSON header (`streamId`, `sequence`, `at`, optional `sourceAt` and
`metadata`, and `encoding: "binary"`), followed by the original frame bytes.
Object and numeric frames use text messages containing the JSON `StreamFrame`.

Each connection retains at most one queued frame and one send in progress;
slow consumers receive the latest frame and may observe sequence gaps. Messages
over 8 MiB are rejected, stalled sends are disconnected after five seconds,
and subscribers are released on disconnect or daemon shutdown.

## Not a safety system

`POST /v1/estop` coordinates the runtime's software response. It is not a
certified emergency-stop system and does not replace hardware safeguards.
