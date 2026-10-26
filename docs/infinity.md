# Using Pinout MCP with AWS Infinity (RAP)

**SIMULATED / software-only.** Nothing in this document claims physical hardware
actuation. All verification below uses `pinoutd --demo` or mock/simulated
devices.

[Infinity](https://github.com/hydro-project/infinity) is AWS’s agent runtime that
speaks the RAP async protocol: the agent **pauses while a tool call is in
flight**, bridges MCP over stdio or Streamable HTTP, and exposes each MCP server
as `{name}_list_tools` / `{name}_invoke_tool` with **serialized calls per
server**. That pause is exactly when a hardware control plane can go stale —
leases expire, deadman heartbeats age out, and naïve retries can double-actuate.

Pinout’s MCP + daemon changes on this branch exist so Infinity (and similar
runtimes) can pause safely.

## Safety model while the agent is paused

| Hazard | Pinout behavior |
| --- | --- |
| `pinout__invoke` waits forever | Bounded wait (default **10s**, `PINOUT_MCP_INVOKE_WAIT_MS` / `invokeWaitMs`). Returns **`OPERATION_PENDING`** with `operationId` plus poll (`pinout__operation_status`) / cancel (`pinout__cancel_operation`) instructions — not `DAEMON_UNAVAILABLE`. |
| Retry after pause re-actuates | Physical outputs always get an **idempotency key** (caller-supplied or deterministic auto-generated). Daemon dedupes by key; the key is returned on the result. |
| Lease TTL elapses during pause | Daemon **reaps leases on a timer** (not only on touch). With `failSafeOnAuthorityLoss` (default **ON**), expiry **disarms** (when supported) and applies **safeState**, then journals `lease.expired` + `fail_safe.applied`. |
| Deadman heartbeat goes stale | Same fail-safe path (`deadman.stale`). Keep calling `pinout__heartbeat` / renew leases via `pinout__renew_lease` from a side loop if the agent may pause longer than the TTL. |
| Arm without a lease | `sys.arm` requires an **active lease** when `requireLeases` is on (default). |
| Firmware watchdog | Host fail-safe is **complementary**. If the host freezes or the link drops, the **device firmware watchdog** still trips locally and applies device-local safe state. Host-side disarm/safeState runs when the daemon process is still alive but authority (lease/heartbeat) is lost. |

`pinout__invoke` is annotated `destructiveHint: true`, `idempotentHint: false`.

### Per-thread owner

Pass `owner` or `threadId` on MCP tool args (or set `PINOUT_OWNER`). When
`threadId` is set, the effective owner becomes `<defaultOwner>:<threadId>` so
concurrent Infinity threads do not share one lease principal.

## Local mode (recommended)

Run `pinoutd` locally and attach Pinout MCP over **stdio** (default). Infinity’s
`infinity-mcp-bridge` exposes each MCP server as `{name}_list_tools` /
`{name}_invoke_tool` and **serializes calls per server** while the agent yields.

### 1. Start the daemon (SIMULATED)

```bash
# From the Pinout repo root after build:
node packages/daemon/dist/main.js --demo --port 8787
```

Demo devices are simulated. Keep the process on loopback (default).

### 2a. Infinity Runtime — `McpToolSet::stdio` (Rust)

From [Connecting RAP & MCP](https://infinity.hydro.run/docs/infinity-runtime/quickstart/connecting-rap-and-mcp):

```rust
use std::collections::HashMap;
use infinity_mcp_bridge::McpToolSet;

let mut env = HashMap::new();
env.insert("PINOUT_DAEMON_URL".into(), "http://127.0.0.1:8787".into());
env.insert("PINOUT_TOKEN".into(), token); // from ~/.pinout/pinoutd.json
env.insert("PINOUT_OWNER".into(), "infinity-local".into());
env.insert("PINOUT_MCP_INVOKE_WAIT_MS".into(), "10000".into());

let pinout = McpToolSet::stdio(
    "pinout",
    vec![
        "node".into(),
        "/absolute/path/to/pinout/packages/mcp/dist/index.js".into(),
    ],
    env,
);
// Register pinout.tools() on AgentSystemBuilder / thread_builder.
// Model sees: pinout_list_tools, pinout_invoke_tool
```

### 2b. Infinity Code — `rap.json` MCP entry (next to pinoutd)

Infinity Code’s local daemon proxy reads MCP servers from `rap.json` (see
[Configuring MCP](https://infinity.hydro.run/docs/infinity-code/configuring-mcp)):

```jsonc
{
  "mcpServers": {
    "pinout": {
      "command": ["node", "/absolute/path/to/pinout/packages/mcp/dist/index.js"],
      "env": {
        "PINOUT_DAEMON_URL": "http://127.0.0.1:8787",
        "PINOUT_TOKEN": "<from ~/.pinout/pinoutd.json>",
        "PINOUT_OWNER": "infinity-local",
        "PINOUT_MCP_INVOKE_WAIT_MS": "10000"
      }
    }
  }
}
```

Stdio is the **default** `pinout-mcp` transport.

### 3. Suggested agent flow

1. `pinout__list_devices` / `pinout__snapshot`
2. `pinout__acquire_lease` with a TTL longer than expected tool pauses, or renew
   periodically with `pinout__renew_lease`
3. `pinout__dry_run` then `pinout__invoke` (or dynamic capability tools)
4. On `OPERATION_PENDING`, poll `pinout__operation_status` or cancel
5. `pinout__heartbeat` while armed on devices that use the deadman
6. Release the lease when done

## Optional Streamable HTTP MCP

```bash
PINOUT_MCP_HTTP=1 PINOUT_MCP_HOST=127.0.0.1 PINOUT_MCP_PORT=8790 \
  node packages/mcp/dist/index.js
# or: node packages/mcp/dist/index.js --http
```

- Loopback bind by default.
- Non-loopback requires `PINOUT_MCP_TOKEN` (bearer on every request).
- Stdio remains the default when `PINOUT_MCP_HTTP` is unset.

## Lambda / remote Infinity mode — not supported for pinoutd

Infinity Lambda (or any remote) mode typically:

- starts a **fresh process per tool call**,
- enforces **45–60s** platform timeouts,
- cannot reach a **loopback-only** `pinoutd` on your lab machine.

`pinoutd` refuses non-loopback binds without explicit remote auth, and physical
control must stay local. **Do not** point a remote Infinity worker at a lab
daemon. Use **local Infinity + local pinoutd + stdio MCP**. A separate RAP
adapter package (out of scope here) may later bridge differently; this doc
covers the stock MCP server only.

## Verification transcript (SIMULATED)

### Attempt: run hydro-project/infinity in this VM

```text
date: 2026-10-26
clone: SUCCESS — git clone --depth 1 https://github.com/hydro-project/infinity.git → /tmp/infinity
rustc/cargo: present (1.83.0)
what worked:
  - Confirmed MCP bridge API: McpToolSet::stdio / ::http in crates/infinity-mcp-bridge
  - Confirmed Infinity Code rap.json MCP command/env shape in docs
  - Confirmed {name}_list_tools / {name}_invoke_tool + per-server serialization docs
what failed / not completed:
  - Full local AgentSystemBuilder run was NOT executed end-to-end: it needs a
    model provider (Bedrock / mock harness inside Infinity’s mdtests), AWS or
    mock credentials, and a longer compile of the Infinity workspace than this
    change’s verification budget. Prefer the scripted MCP client below, which
    asserts the same pause/lease/idempotency contracts Infinity hits over stdio.
    For a **native RAP** tool server (no MCP bridge), see [RAP adapter](rap.md).
```

To finish the Infinity bring-up on a laptop:

```bash
git clone https://github.com/hydro-project/infinity.git
# Follow Infinity Runtime quickstart + Connecting RAP & MCP; point McpToolSet::stdio
# at packages/mcp/dist/index.js with PINOUT_* env while pinoutd --demo runs.
```

### Scripted MCP client (pause > lease TTL) — what we verified

Executable tests (SIMULATED mock devices only):

- `packages/mcp/tests/infinityAsyncSafety.test.ts`
- `packages/daemon/tests/failSafeLease.test.ts`

Asserted:

1. **Long op → `OPERATION_PENDING`** with `operationId`, poll, and cancel hints
   when `invokeWaitMs` is shorter than a slow capability.
2. **Lease expiry → fail-safe**: after TTL + timer reap, relay `safeState` is
   off (`on: false`); journal contains `lease.expired` and `fail_safe.applied`.
3. **Same idempotency key does not double-actuate**: retry after pause returns
   the original operation id (`deduped`) and does not re-run physical work.
4. **Auto idempotency keys** generated for physical outputs when omitted.
5. **`pinout__renew_lease` / `pinout__heartbeat`** tools present and callable.
6. **Per-thread owner**: `threadId` scopes lease owner to `mcp-infinity:t-1`.
7. **Max lease TTL** clamped by daemon `maxLeaseTtlMs`.

## Native RAP alternative

If Infinity is configured with a `toolset_server` instead of an MCP bridge,
use [`@pinout/rap`](rap.md): same daemon fail-safe / `OPERATION_PENDING` /
idempotency / renew+heartbeat contracts, spoken as RAP
(`/.well-known/rap-toolset`, `/invoke`, `/cancel_tool_call`, `/close_thread`).

## Related docs

- [RAP / Infinity adapter](rap.md)
- [MCP quickstart](mcp.md)
- [Daemon API](daemon.md)
- [Safety model](safety-model.md) (arming, watchdog, safe state)
