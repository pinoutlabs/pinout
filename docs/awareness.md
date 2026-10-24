# Device awareness

**Status: SIMULATED** (`SupportLevel` from `@pinout/core`) unless a dated
`hardware/records/` entry justifies a higher level. Awareness never auto-flashes
firmware and never auto-enrolls without operator approval.

Device awareness is the daemon’s read-only observation layer. It answers
“what have we ever seen?” while discovery still answers “what might be out
there right now?”. Discovery candidates are **never** stored; awareness
persists derived `AwarenessRecord`s in `~/.pinout/awareness.json` (mode
`0600`, atomic writes).

## Package

`@pinout/awareness` owns:

| Piece | Role |
| --- | --- |
| `AwarenessRegistry` | Persistent store + state machine + event fan-out |
| `AwarenessClient` | Typed HTTP/SSE client (`list`, `get`, `subscribe`, `enroll`) |
| Mock devices | `demo` preset or JSON file for hardware-free demos |

The daemon wires a per-transport discovery scheduler (`serial`, `usb`, `ble`,
`mdns`; `network-probe` **opt-in only**) and mirrors presence onto core
`DeviceGraph` (health / support / transport).

## States

```
SEEN → IDENTIFIED → PENDING_ENROLL → ONLINE → STALE → OFFLINE
```

| State | Meaning |
| --- | --- |
| `SEEN` | Observed; little or no identity signal |
| `IDENTIFIED` | Identity/module guess present (including `unknown/*`) |
| `PENDING_ENROLL` | Known module match; waiting for operator enroll |
| `ONLINE` | Enrolled (or re-observed enrolled) and currently present |
| `STALE` | Missed recent discovery polls (configurable) |
| `OFFLINE` | Absent longer than the offline timeout |

Default timeouts: stale after 30s, offline after 120s.

## Honesty

- `evidenceLevel` is core [`SupportLevel`](evidence-levels.md)
  (`UNKNOWN` | `SIMULATED` | `COMPILE_TESTED` | `HARDWARE_VERIFIED`). Default
  is `SIMULATED`; `HARDWARE_VERIFIED` requires a dated hardware record via
  `applyEvidenceRules`.
- Mock devices (`--mock-devices`) are always `SIMULATED` and tagged `mock: true`.
- Enrollment writes `~/.pinout/devices.json` through the existing registration
  path. It **never** arms, actuates, or flashes.
- UNKNOWN devices (`unknown/*` module) cannot be enrolled until a real module
  id is supplied by a later connector-builder flow (PR3+).

## Daemon flags

```bash
# Read-only awareness over live discovery plugins
pinoutd --discover

# Hardware-free demo (serial + BLE + mDNS + MQTT + UNKNOWN)
pinoutd --discover --mock-devices demo

# Custom fixture file
pinoutd --discover --mock-devices ./fixtures/awareness/demo-devices.json

# Opt-in bounded network probe (never a subnet scan)
pinoutd --discover --network-probe 127.0.0.1:8787
```

## HTTP API

All routes follow existing daemon auth conventions (bearer token required on
`/v1/*` when configured; `GET /v1/health` stays open).

| Method | Path | Body / notes |
| --- | --- | --- |
| `GET` | `/v1/awareness` | `{ devices: AwarenessRecord[] }` |
| `GET` | `/v1/awareness/:id` | `AwarenessRecord` |
| `GET` | `/v1/awareness/events` | SSE `{ type, record, at }` where `type` is `seen` \| `identified` \| `state_changed` \| `online` \| `offline` |
| `POST` | `/v1/awareness/:id/enroll` | Optional `{ moduleId?, deviceId? }` → `{ enrolled: true, record, device }` |

## TypeScript client

```ts
import { AwarenessClient } from '@pinout/awareness';

const client = new AwarenessClient({
  baseUrl: process.env.PINOUT_DAEMON_URL ?? 'http://127.0.0.1:8787',
  token: process.env.PINOUT_TOKEN,
});

const devices = await client.list();
const stop = client.subscribe((event) => {
  console.log(event.type, event.record.id, event.record.state);
});
await client.enroll(devices[0]!.id, { deviceId: 'desk-esp' });
stop();
```

MCP (PR2) and e2e demos (PR5) should import `@pinout/awareness` rather than
re-declaring these shapes.

## Record shape

```ts
type AwarenessRecord = {
  id: string;
  transport: 'serial' | 'usb' | 'ble' | 'mdns' | 'mqtt';
  identity: {
    vid?: string;
    pid?: string;
    firmware?: string;
    version?: string;
    advertisedName?: string;
    uuids?: string[];
    macHash?: string; // hashed — raw MACs are not stored
    vendor?: string;
    model?: string;
    endpoint?: string;
    guessedModuleId?: string;
    deviceClass?: string;
  };
  state: 'SEEN' | 'IDENTIFIED' | 'PENDING_ENROLL' | 'ONLINE' | 'STALE' | 'OFFLINE';
  firstSeen: number;
  lastSeen: number;
  health: { status; lifecycle; message?; lastUpdated };
  capabilities?: string[];
  moduleId?: string;
  evidenceLevel: SupportLevel; // UNKNOWN | SIMULATED | COMPILE_TESTED | HARDWARE_VERIFIED
  connector?: { status: 'none' | 'available' | 'pending' | 'installed' | 'failed' };
  confidence?: number;
  mock?: boolean;
};
```

## Related

- [Discovery package](../packages/discovery/README.md) — read-only plugins
- [Daemon](daemon.md) — HTTP surface and security model
- [Setup](setup.md) — manual enroll / flash workflow
- [Hardware support](hardware-support.md) — evidence vocabulary
