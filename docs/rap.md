# RAP adapter (`@pinout/rap`)

Pinout's [Reactive Agent Protocol](https://infinity.hydro.run/docs/rap/what-is-rap) adapter exposes `pinoutd` to Infinity (and any RAP runtime) as an asynchronous HTTP tool server. The adapter owns **only** the RAP surface: it calls the existing daemon HTTP API (`/v1/devices/.../invoke` with `waitFor: "accepted"`, `/v1/operations`, `/v1/leases`, heartbeats, `/v1/events` or poll) and never embeds a second runtime.

Prefer this package when Infinity talks **native RAP** (`toolset_server`). Prefer [MCP + Infinity](infinity.md) when Infinity bridges Pinout over stdio/Streamable HTTP MCP. Both paths share the same daemon safety features from #62 (fail-safe on lease/deadman loss, max lease TTL, auto idempotency, `OPERATION_PENDING`).

Evidence level for local demos in this package: **SIMULATED** (mock devices via `pinoutd --demo`). No hardware claims.

## Architecture

```text
Infinity / RAP runtime
    │  GET  /.well-known/rap-toolset
    │  POST /invoke  (callback_url, group_id, id)  → HTTP 200 ack
    │  POST /cancel_tool_call                      → best effort
    │  POST /close_thread                          → best effort
    ▼
@pinout/rap  (packages/rap)
    │  durable pending journal under ~/.pinout/rap/
    │  owner = group_id (per-thread); idempotencyKey = group_id:id
    │  renew_lease + heartbeat while the agent is paused
    ▼
pinoutd  HTTP API  (packages/daemon)
    └── devices / leases / operations / fail-safe / safety
```

| RAP concern | Pinout mapping |
| --- | --- |
| Toolset discovery | Static catalog derived from the Pinout control-plane + invoke surface |
| `group_id` | Per-thread lease / invoke `owner` (Infinity conversation thread) |
| Optional `owner` / `threadId` args | MCP-compatible override; `threadId` scopes as `<group_id>:<threadId>` |
| `group_id:id` | Default daemon `idempotencyKey` for `pinout__invoke` (caller may override) |
| Ack-then-callback | HTTP 200 on `/invoke`, then POST `tool_result` to `callback_url` |
| Bounded wait | After accept, poll up to ~10s (`invokeWaitMs`); then **`OPERATION_PENDING`** with `operationId` + poll/cancel hints |
| Progress | Optional `view_update` (`pinout.operation_progress`) while polling an operation |
| Cancel | Map to `POST /v1/operations/:id/cancel` when known; ignore unknown / late / duplicate |
| Thread close | Release leases owned by the thread owner, cancel in-flight RAP ops, disarm / safeState devices the thread touched |
| Restart | Journaled pending callbacks in `~/.pinout/rap/`; recovery redelivers or resumes watches |
| Agent pause | Call `pinout__renew_lease` and `pinout__heartbeat` from a side loop so fail-safe does not disarm mid-pause |

Safety aborts stay inside Pinout: on `cancel_tool_call`, `close_thread`, or exhausted callback retries, the adapter cancels operations, releases thread leases, and attempts `sys.disarm` / safe-state capabilities on devices the thread used. Daemon-side fail-safe (lease expiry / stale deadman) remains authoritative — see [Infinity + MCP](infinity.md) and [safety model](safety-model.md).

## Tools (read-only vs physical-output)

Annotations use `x-pinout-side-effect`: `read-only`, `physical-output`, or `control-plane`.

| Tool | Side effect | Daemon API |
| --- | --- | --- |
| `pinout__list_devices` | read-only | `GET /v1/devices` |
| `pinout__describe_device` | read-only | `GET /v1/devices/:id` |
| `pinout__read_state` | read-only | `GET /v1/devices/:id/state` |
| `pinout__snapshot` | read-only | `GET /v1/snapshot` |
| `pinout__safety_status` | read-only | `GET /v1/safety` |
| `pinout__dry_run` | read-only | `POST .../invoke` with `dryRun: true` |
| `pinout__operation_status` | read-only | `GET /v1/operations/:id` |
| `pinout__invoke` | physical-output | `POST .../invoke` with `waitFor: "accepted"`, poll; may return `OPERATION_PENDING` |
| `pinout__cancel_operation` | physical-output | `POST /v1/operations/:id/cancel` |
| `pinout__acquire_lease` | control-plane | `POST /v1/leases` (TTL clamped by `maxLeaseTtlMs`) |
| `pinout__renew_lease` | control-plane | `POST /v1/leases/:id/renew` |
| `pinout__heartbeat` | control-plane | `POST /v1/devices/:id/heartbeat` |
| `pinout__release_lease` | control-plane | `DELETE /v1/leases/:id` |

## Security

- **Loopback by default.** Binding a non-loopback host requires `PINOUT_RAP_ALLOW_REMOTE=1` **and** a bearer token (`PINOUT_RAP_TOKEN` or `PINOUT_TOKEN`).
- **Bearer auth** when a token is configured: required on `/.well-known/rap-toolset`, `/invoke`, `/cancel_tool_call`, and `/close_thread`.
- **SigV4 / mTLS** are documented as future auth modes for production Infinity-on-Lambda deployments; this adapter implements bearer tokens first (RAP leaves the scheme to implementors).
- Do not expose the RAP adapter or `pinoutd` to untrusted networks. Physical actuation is gated by Pinout leases and halt state inside the daemon.

## Run locally (SIMULATED)

```bash
# Terminal 1 — demo devices (no hardware)
node packages/daemon/dist/main.js --demo --port 8787

# Terminal 2 — RAP adapter
PINOUT_DAEMON_URL=http://127.0.0.1:8787 \
  PINOUT_TOKEN="$(python3 -c "import json;print(json.load(open('$HOME/.pinout/pinoutd.json'))['token'])")" \
  node packages/rap/dist/main.js
# listens on http://127.0.0.1:8791 by default
```

Environment:

| Variable | Meaning |
| --- | --- |
| `PINOUT_DAEMON_URL` / `PINOUT_URL` | pinoutd base URL |
| `PINOUT_TOKEN` | Bearer for pinoutd (and optional RAP token fallback) |
| `PINOUT_RAP_HOST` / `PINOUT_RAP_PORT` | Adapter bind address |
| `PINOUT_RAP_TOKEN` | Bearer for RAP endpoints |
| `PINOUT_RAP_PUBLIC_URL` | Advertised toolset base URL |
| `PINOUT_RAP_ALLOW_REMOTE` | Opt-in non-loopback bind |
| `PINOUT_HOME` | Durable journal root (default `~/.pinout`) |

## Register in Infinity (`rap.json`)

Point Infinity Code / Infinity Runtime at the running adapter. Project-level `.infinity/rap.json` or user-level `~/.infinity/rap.json`:

```json
{
  "tool_sets": [
    {
      "type": "toolset_server",
      "server_url": "http://127.0.0.1:8791"
    }
  ]
}
```

Infinity fetches `http://127.0.0.1:8791/.well-known/rap-toolset` and POSTs invocations to the advertised `endpoint` (`.../invoke`). See [RAP Servers](https://infinity.hydro.run/docs/infinity-code/rap-servers) and [Building a RAP Server](https://infinity.hydro.run/docs/rap/using-rap/building-a-rap-tool).

For MCP-bridged Infinity instead of native RAP, see [Infinity + MCP](infinity.md).

## SIMULATED local transcript

An honest demo transcript (no Infinity binary, no hardware) lives in
[rap-simulated-transcript.md](rap-simulated-transcript.md). It was produced by
`node packages/rap/tests/simulatedTranscript.mjs` against `pinoutd --demo`.

## Tests

`packages/rap/tests/rapAdapter.test.ts` drives a **mock RAP runtime** (callback server) against `pinoutd` with a simulated relay:

- ack-then-callback
- duplicate / late `cancel_tool_call`
- restart recovery from the pending journal
- `close_thread` lease cleanup
- bearer auth
- `OPERATION_PENDING` when invoke wait budget elapses
- `pinout__heartbeat` / renew-lease path

```bash
npx vitest run packages/rap/tests/rapAdapter.test.ts
```

## Related docs

- [Infinity + MCP async safety](infinity.md)
- [MCP quickstart](mcp.md)
- [Daemon API](daemon.md)
- [Safety model](safety-model.md)

## Spec references

- [RAP overview](https://infinity.hydro.run/docs/rap/spec/overview)
- [Tool invocation](https://infinity.hydro.run/docs/rap/spec/basic/tool-invocation)
- [Tool result](https://infinity.hydro.run/docs/rap/spec/basic/tool-result)
- [Toolsets](https://infinity.hydro.run/docs/rap/spec/basic/toolsets)
- [Tool cancellation](https://infinity.hydro.run/docs/rap/spec/basic/tool-cancellation)
- [Thread closure](https://infinity.hydro.run/docs/rap/spec/basic/thread-closure)
- [MCP compatibility](https://infinity.hydro.run/docs/rap/about/mcp-compatibility)
