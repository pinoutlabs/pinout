# Generator connectors

`@pinout/generator` turns awareness / discovery artifacts into **candidate** Pinout connectors. This document covers the connector-building path used by the daemon (`generateConnector`) — it complements [generator.md](generator.md) and [generator-safety.md](generator-safety.md).

## Non-negotiables

- Generation **never** installs, registers, or opens hardware connections.
- Output evidence uses core **`SupportLevel`** via `mapFromGeneratorLifecycle` (usually **`SIMULATED`**; at most **`COMPILE_TESTED`** after a local compile check — never **`HARDWARE_VERIFIED`** without a dated hardware record).
- Every inferred fact carries **evidence**, **confidence**, and explicit **uncertainties**.
- Missing limits yield **default-deny** policy stubs (`requiresApproval`) — never invented numeric bounds.

## Programmatic API

```ts
import { generateConnector } from '@pinout/generator';

const result = await generateConnector({
  source: 'sys.hello', // or gatt | mqtt | mdns | openapi | datasheet | ir | auto
  raw: helloPayload,
  inMemory: true, // daemon / PR4: get files without writing
  // outDir: '/tmp/connector', overwrite: true, // fresh-dir replace for install staging
});

// result.files — path → source text
// result.report — uncertainties, pendingApprovals, neverInstalls/neverRegisters
// result.evidenceLevel — SupportLevel capped at COMPILE_TESTED (typically SIMULATED)
// result.capabilities / result.safety / result.ir
```

PR4 (install pipeline) calls this API, then performs explicit human-gated install/register. Generation stops at files + report.

## Sources → IR

| Source | Ingestor | Interface kind(s) |
| --- | --- | --- |
| Live/simulated `sys.hello` capability list | `ingestSysHello` | `serial-bridge` |
| BLE GATT dump (services / characteristics / UUIDs / properties) | `ingestGattDump` | `ble-gatt` |
| Observed MQTT topic + payload samples | `ingestMqttObservations` | `mqtt` |
| mDNS advertisement + OpenAPI doc | `ingestMdnsOpenApi` | `mdns`, `http` |
| Datasheet / SDK directory (existing path) | `analyzeHardwareSource` | legacy + newly detected kinds |

IR interface kinds (back-compatible):

`tcp` · `serial` · `http` · `sdk` · `unknown` · **`ble-gatt`** · **`mqtt`** · **`mdns`** · **`serial-bridge`**

### Safety classification

| Observation | Classification |
| --- | --- |
| GATT `read` / MQTT subscribe / HTTP GET / `*.read` | `readOnly` |
| GATT `write`/`notify` / MQTT publish / HTTP mutations / `gpio.write` / arming | `physicalOutput` |
| Ambiguous | `unknown` (explicit uncertainty; `requiresApproval`) |

For `physicalOutput`:

1. Emit **strict** input schemas (`additionalProperties: false`, enums when observed, bounded numbers **only** when documented).
2. Emit **default-deny** policy stubs marked `requiresApproval` until a human supplies ranges.
3. Record reversibility notes — do not claim safe-state without evidence.

## Emitted layout (8-module pattern)

Deterministic templates (no LLM required for known protocols):

| Path | Role |
| --- | --- |
| `src/capabilities.ts` | Capability descriptors + strict schemas |
| `src/simulator.ts` | In-process simulator stub |
| `src/backend.ts` | Transport skeleton (refuses protocol connect by default) |
| `src/types.ts` | Config types + validator |
| `src/index.ts` | `defineModule` entry |
| `test/conformance.test.ts` | Lightweight conformance |
| `docs/connector.md` | Docs page draft |
| `catalog-entry.json` | Catalog draft (not published) |

Plus manifest, evidence report, `GENERATION_REPORT.md`, package/tsconfig.

LLM/http providers are used **only** to name/describe UNKNOWN devices when configured; failures fall back to deterministic `unknown-device` naming. Provider output is schema-validated; capabilities are never invented from the LLM.

## Fixtures

Under `fixtures/generator/`:

| Fixture | Purpose |
| --- | --- |
| `serial-hello/` | Enrolled bridge `sys.hello` list |
| `ble-gatt-lamp/` | GATT dump for a lamp-like device |
| `mqtt-sensor-relay/` | MQTT sensor + relay samples |
| `unknown-weird/` | Empty / ambiguous device (no invented caps) |

## Related

- [Generator overview](generator.md)
- [Generator safety](generator-safety.md)
- [Build a module](build-a-module.md)
