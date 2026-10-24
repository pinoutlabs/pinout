# Awareness → connector demo (**SIMULATED**)

Product story (fixtures only — **Pinout has never run on real hardware**):

1. Boot **real** `pinoutd` awareness with `--mock-devices` (PR1).
2. A **known** serial ESP32 is observed (`PENDING_ENROLL` + `pinout/esp32`) — never auto-enrolled.
3. An **unknown** BLE lamp appears (`identity.guessedModuleId: unknown/ble-lamp`).
4. **PR3** `generateConnector` builds a quarantined connector from `fixtures/generator/ble-gatt-lamp` via **PR4** `POST /v1/connectors/generate`.
5. Read-only GATT read works; physical write is **rejected** until approval.
6. Scripted **`HUMAN APPROVES`** unlocks notify ranges (`value` 0–80) via `POST /v1/connectors/:id/approve`.
7. Install via `POST /v1/connectors/:id/install` — still **not** auto-armed.
8. Out-of-range rejected; in-range OK (**SIMULATED** device invoke).
9. Scripted agent loop via **real** `createDaemonMcpServer` (PR2) → [`transcript.md`](./transcript.md).

```bash
npm run demo:awareness
npm test -- examples/awareness-connector-demo/test/e2e.test.ts
```

## Layout

| Path | Role |
| --- | --- |
| `fixtures/mock-devices.json` | PR1 `--mock-devices` schema |
| `fixtures/connector-evidence.json` | Maps awareness ids → PR3 generator fixtures |
| `src/startDemoStack.ts` | Single pinoutd: awareness + connectors + devices |
| `src/fixtureGenerate.ts` | `generateConnectorFn` override → GATT/MQTT fixtures |
| `src/connectorApi.ts` | Client for `/v1/connectors*` + SIMULATED capability exercise |
| `src/agentLoop.ts` | Scripted MCP session using real PR2 tools |
| `test/e2e.test.ts` | CI assertions |

## Layers

| Layer | Status in this demo |
| --- | --- |
| PR0 `SupportLevel` | Live |
| PR1 awareness / `--mock-devices` | Live |
| PR2 MCP tools | Live (`createDaemonMcpServer` → pinoutd) |
| PR3 `generateConnector` + fixtures | Live |
| PR4 `/v1/connectors*` on pinoutd | Live |
