# BLE GATT transport

**Status: SIMULATED on the host (CI). Firmware sketch COMPILE_TESTED with `pio run -e esp32dev-ble` (no flash). No physical HIL / HARDWARE_VERIFIED claim.**

Local makers can talk to an ESP32 without Wi-Fi credentials by carrying Pinout
protocol v1 NDJSON over a small custom GATT service. This is a USB-serial
alternative for desks — not a fleet mesh. Nearby advertisement scanning is a
separate `@pinout/discovery` plugin (never connects or writes GATT).

## Design

```text
Session / Device  →  BleGattTransport  →  BleGattSession  →  radio or simulator
                           │
                    bytes only (no GPIO parse)
```

| Piece | Location | Role |
| --- | --- | --- |
| UUID constants | `packages/core/src/transports/bleGattUuids.ts` | Shared layout |
| `BleGattSession` | `packages/core/src/transports/bleGattSession.ts` | Injected radio adapter |
| `bleGattTransport` | `packages/core/src/transports/bleGattTransport.ts` | `Transport` implementation |
| Simulator | `createSimulatedBleGattBridge()` | In-process RX/TX + ATT chunking → `simulatedEsp32` |
| Firmware | `firmware/esp32-ble-bridge` | ESP32 GATT server (bring-up action subset) |

CONTRIBUTING rule: transports move bytes; they do not parse GPIO commands. The
simulator proves the byte path; Session still owns line framing and request IDs.

## GATT UUIDs

| Role | UUID |
| --- | --- |
| Service | `6e700001-b5a3-f393-e0a9-e50e24dcca9e` |
| RX (host → device, Write / Write NR) | `6e700002-b5a3-f393-e0a9-e50e24dcca9e` |
| TX (device → host, Notify) | `6e700003-b5a3-f393-e0a9-e50e24dcca9e` |

Nordic-UART-style duplex, Pinout-owned UUIDs (not Nordic NUS).

## CI / simulator

```ts
import { connect, createSimulatedBleGattBridge } from '@pinout/core';

const bridge = createSimulatedBleGattBridge();
const device = await connect({ transport: bridge.transport, timeoutMs: 2000 });
await device.arm();
await device.gpio.write(2, true);
await device.close();
await bridge.close();
```

Factory config type: `simulated-ble-gatt` (treated as a simulated backend).

Tests: `packages/core/tests/bleGattTransport.test.ts`.

## Physical radio

`bleGattTransport({ session })` does not bundle noble / Web Bluetooth. Inject a
`BleGattSession` that:

1. Connects to a peripheral advertising the Pinout service UUID.
2. Writes host Session bytes to RX.
3. Yields TX notification payloads on `txNotifications`.

`@pinout/discovery` provides advertisement-only BLE scanning (confidence ≤ 0.5;
CI uses `simulatedBleScan`). Discovery never opens this GATT transport.

## Firmware

See [firmware/esp32-ble-bridge/README.md](../firmware/esp32-ble-bridge/README.md).
Compile with PlatformIO (`pio run -e esp32dev-ble`). Pinout never auto-flashes.
