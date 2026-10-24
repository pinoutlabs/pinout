# MCP device awareness and connector tools

Daemon-backed `pinout-mcp` exposes nearby-device awareness and automatic
connector-building tools. Awareness HTTP/SSE traffic goes through the typed
[`AwarenessClient`](awareness.md) from `@pinout/awareness` (PR1): `list`,
`get`, `subscribe`, and `enroll`.

These tools are for **discovery and candidacy**. Physical-output enablement
remains a **human step** (connector approve/install). Agents must not treat a
successful tool call as permission to actuate hardware.

## Honesty rules

- Surface `evidenceLevel` as core [`SupportLevel`](evidence-levels.md):
  `UNKNOWN` | `SIMULATED` | `COMPILE_TESTED` | `HARDWARE_VERIFIED`.
- Missing or invalid evidence collapses to **`SIMULATED`** (never invent
  hardware).
- **Never claim hardware** from `UNKNOWN`, `SIMULATED`, or `COMPILE_TESTED`.
- `HARDWARE_VERIFIED` still does not turn command ACK into physical proof;
  inspect `stateEvidence.observed` after enrollment.

## Quarantined connectors

Generated connectors (PR4 routes) start as `CANDIDATE` / `QUARANTINED`:

| Capability class | While `QUARANTINED` / `CANDIDATE` | After human `approve` + `install` |
| --- | --- | --- |
| Read-only | May be usable | Usable under normal lease/arm rules |
| Physical-output | **Blocked** until human approval | Usable under normal lease/arm/safety rules |

`pinout__request_enroll` calls `AwarenessClient.enroll` (daemon registration
into `devices.json`). It does **not** approve physical-output capabilities;
connector approve/install stays a separate human step.

Awareness `record.connector.status` uses the PR1 vocabulary
(`none` | `available` | `pending` | `installed` | `failed`) and is distinct
from generated-connector lifecycle statuses.

## Tools

| Tool | Client / route(s) | Notes |
| --- | --- | --- |
| `pinout__nearby_devices` | `AwarenessClient.list` → `GET /v1/awareness` | Optional filters: `state`, `transport`, `evidenceLevel`, `moduleId`, `hasConnector`. |
| `pinout__describe_nearby` | `AwarenessClient.get` → `GET /v1/awareness/:id` | One awareness record + honesty/guidance annotations. |
| `pinout__awareness_events` | In-process buffer from `AwarenessClient.subscribe` | Bounded recent `seen` / `identified` / `state_changed` / `online` / `offline`. |
| `pinout__request_enroll` | `AwarenessClient.enroll` → `POST /v1/awareness/:id/enroll` | Registers presence; physical-output still human-gated. |
| `pinout__generate_connector` | `POST /v1/connectors/generate` | Creates a quarantined candidate (PR4). |
| `pinout__connector_status` | `GET /v1/connectors/:id` | Status, capabilities, safety flags, report, `evidenceLevel`. |
| `pinout__list_connectors` | `GET /v1/connectors` | Optional generated-status filter. |

## Resources and notifications

When the MCP SDK session supports it, the daemon MCP server advertises:

- `tools.listChanged`
- `resources.listChanged` + `resources.subscribe`

Resources:

- `pinout://awareness/devices` — awareness snapshot
- `pinout://awareness/events` — recent buffered events
- `pinout://awareness/device/{id}` — one record

On awareness SSE reporting a new device (`seen` / `identified` / `online`),
the server emits resource list-changed / resource updated notifications where
supported, and a tools list-changed hint.

On a connector install event on the daemon `/v1/events` bus (or awareness
`connector.status=installed`), the MCP client **invalidates** the cached
`GET /v1/tools` catalog (TTL otherwise 2s) and emits
`notifications/tools/list_changed` so newly installed connector capabilities
appear **without restarting** `pinout-mcp`.

Disable the watchers in tests with `awarenessWatch: false`.

## Example agent flow

1. `pinout__nearby_devices({})` — discover what is nearby; read `evidenceLevel`.
2. `pinout__describe_nearby({id})` — inspect identity/capabilities/connector.
3. `pinout__request_enroll({id})` — enroll presence via AwarenessClient; stop
   before assuming actuation is allowed.
4. `pinout__generate_connector({awarenessId})` — create a quarantined candidate.
5. `pinout__connector_status({id})` — confirm status stays `QUARANTINED` until a
   human runs approve/install on the daemon.
6. After human install, re-list tools (or wait for list-changed) and use
   read-only capabilities first; physical-output still needs lease + arm.

## Related docs

- [Device awareness](awareness.md)
- [MCP quickstart](mcp.md)
- [Evidence levels / SupportLevel](evidence-levels.md)
- [State evidence / honesty rule](state-evidence.md)
- [Safety model](safety-model.md)
- [Generator safety](generator-safety.md)
