# Awareness → connector demo (**SIMULATED**)

Product story (all fixtures — **Pinout has never run on real hardware** in this repository):

1. Boot discovery in mock-device mode.
2. A **known** serial ESP32 is auto-recognized (`IDENTIFIED` + `moduleId`).
3. An **unknown** BLE/GATT lamp-like device appears (`SEEN`, no module).
4. Generator builds a **quarantined**, read-only connector (evidence ≤ `COMPILE_TESTED`).
5. Read-only `lamp.status` works; physical `lamp.setBrightness` is **rejected** until approval.
6. Scripted **`HUMAN APPROVES`** step unlocks ranges (`percent` 0–80).
7. Install (still **not** auto-armed).
8. Out-of-range invoke rejected; in-range invoke OK (**SIMULATED**).
9. Scripted MCP agent loop → [`transcript.md`](./transcript.md) (labeled SIMULATED).

```bash
npm run demo:awareness
npm test -- examples/awareness-connector-demo/test/e2e.test.ts
```

## Layout

| Path | Role |
| --- | --- |
| `scenario.json` | Scripted scenario spec + expected codes |
| `fixtures/mock-devices.json` | Fake serial / BLE / MQTT devices for `--mock-devices` |
| `fixtures/unknown-ble-lamp.gatt.json` | SIMULATED GATT dump |
| `fixtures/mqtt-sensor-samples.json` | SIMULATED MQTT samples |
| `src/mockControlPlane.ts` | Local stub of `/v1/awareness*` + `/v1/connectors*` until PR1/PR4 merge |
| `src/mcpBridge.ts` | PR2 tool names against that control plane |
| `src/runDemo.ts` | Driver |
| `test/e2e.test.ts` | CI assertions |

## Upstream rebase

When PR1–PR4 merge, set `PINOUT_DAEMON_URL`, `PINOUT_TOKEN`, and `PINOUT_AWARENESS_DEMO_USE_UPSTREAM=1` to exercise real `pinoutd --discover --mock-devices`. Until then the demo **stub** is intentional and labeled in the run output.
