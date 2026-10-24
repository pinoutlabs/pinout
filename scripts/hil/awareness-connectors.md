# HIL checklist: device awareness + automatic connectors

**Status: NOT RUN / not verified.** The CI demo (`npm run demo:awareness`) and e2e test are **SIMULATED** fixtures only. Pinout has never run this path on real hardware in this repository. Do not raise evidence above `COMPILE_TESTED` without a dated `hardware/records/` entry.

Cross-links: [docs/awareness-and-connectors.md](../../docs/awareness-and-connectors.md), [esp32-classic.md](./esp32-classic.md) Phase 9, [modbus-lamp.md](./modbus-lamp.md).

## Checklist (all PENDING)

- [ ] Known USB/serial (or BLE with Pinout firmware) appears as `IDENTIFIED` with correct `moduleId` — no auto-flash, no auto-arm
- [ ] Unknown BLE advertisement / GATT device appears as `SEEN` without a module match
- [ ] Unknown MQTT sensor topics appear as `SEEN` without a module match
- [ ] `generateConnector` produces quarantine **read-only**; evidence ≤ `COMPILE_TESTED`
- [ ] Physical-output invoke before approval is rejected; instruments show no actuation
- [ ] Explicit **HUMAN APPROVES** unlocks only declared ranges; install leaves device **disarmed**
- [ ] Out-of-range rejected; in-range independently observed
- [ ] MCP tools (`pinout__nearby_devices`, `pinout__generate_connector`, …) against live `pinoutd` with operator supervision
- [ ] Dated record filed under `hardware/records/` before any `HARDWARE_VERIFIED` claim
