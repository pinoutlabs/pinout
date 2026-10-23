# ESP32 BLE GATT bridge

Thin vertical slice: Pinout protocol v1 **NDJSON over BLE GATT**, as a USB-serial
alternative for local desks that should not need Wi-Fi credentials.

| Evidence | Status |
| --- | --- |
| Host transport + ATT-chunk simulator | **SIMULATED** (CI: `packages/core/tests/bleGattTransport.test.ts`) |
| Firmware sketch | **COMPILE_TESTED** — `pio run -e esp32dev-ble` succeeds (no upload) |
| Physical radio / HIL | **NOT RUN** — no `HARDWARE_VERIFIED` claim; no dated `hardware/records/` entry |

Transports move bytes. They do not parse GPIO commands on the host; Session still
owns framing. This sketch implements a **desk bring-up subset** of the serial
bridge (`sys.*`, `gpio.mode` / `gpio.write` / `gpio.read`) so makers can prove
the wireless path without pulling the full `esp32-bridge` surface onto BLE yet.

## GATT layout

Shared with `@pinout/core` (`pinoutBleGattUuids`):

| Role | UUID | Properties |
| --- | --- | --- |
| Service | `6e700001-b5a3-f393-e0a9-e50e24dcca9e` | Primary |
| RX (host → device) | `6e700002-b5a3-f393-e0a9-e50e24dcca9e` | Write, Write Without Response |
| TX (device → host) | `6e700003-b5a3-f393-e0a9-e50e24dcca9e` | Notify |

Advertised name: `Pinout-ESP32`. Notification payloads are chunked to 20-byte ATT
values by default (same conservative MTU assumption as the host simulator).

See [docs/ble-gatt.md](../../docs/ble-gatt.md).

## Build (operator-driven)

Pinout never auto-flashes. Compile without upload:

```bash
cd firmware/esp32-ble-bridge
pio run -e esp32dev-ble
```

Upload only after visual + USB identity confirmation:

```bash
pio run -e esp32dev-ble -t upload
pio device monitor
```

Classic ESP32 DevKit (`esp32dev`). Do not use flash pins (GPIO 6–11), UART0
(GPIO 1/3), or GPIO 12 as a driven strap.

## Host usage (simulator — CI)

```ts
import { connect, createSimulatedBleGattBridge } from '@pinout/core';

const bridge = createSimulatedBleGattBridge();
const device = await connect({ transport: bridge.transport });
// … arm / gpio via Session — no physical radio …
await device.close();
await bridge.close();
```

## Host usage (physical radio — not shipped)

`bleGattTransport({ session })` accepts any `BleGattSession` that writes the RX
characteristic and yields TX notifications. Wire Web Bluetooth or a Node BLE
stack yourself; no radio dependency is bundled in `@pinout/core` (keeps CI free
of flaky native BLE bindings). Advertisement-only discovery of nearby LE
devices lives in `@pinout/discovery` and never connects or writes GATT.

## Relation to `esp32-bridge`

| Path | Medium | Protocol surface |
| --- | --- | --- |
| `firmware/esp32-bridge` | USB serial 115200 | Full bridge |
| `firmware/esp32-ble-bridge` | BLE GATT | Bring-up subset |

Same NDJSON framing and arming gate for the actions this sketch advertises.
Merge full GPIO/I2C/SPI/watchdog parity onto BLE only with a follow-up that
keeps serial as the primary HIL path.
