# @pinout/discovery

Device discovery for Pinout. Answers "what might be out there?" with
evidence and honest confidence — and **never actuates hardware**.

## The never-actuate rule

- The `DiscoveryPlugin` interface has **no write path**.
- Serial ports are enumerated, never opened (some adapters reset their target
  on open).
- USB devices are enumerated via OS metadata (VID/PID), never claimed.
- BLE devices are observed from **advertisements only** — never connect, pair,
  bond, or write GATT characteristics.
- mDNS sends one bounded query packet and listens.
- Network probing is **opt-in** (`--network --probe host:port`), bounded to
  explicitly supplied endpoints, and sends only a read-only `GET /v1/health`.
  There is no subnet scanning — deliberately.

## Honesty rules (enforced by `validateCandidate`)

- Confidence is capped at **0.95**; only a device-confirmed handshake (a
  health check that answered `{ok:true}`) justifies ≥ 0.9.
- A single weak heuristic (manufacturer string, VID/PID, open port, BLE local
  name, advertised service UUID) caps at **0.5**. A device identity is never
  claimed on one weak signal.
- BLE advertisement metadata alone is always treated as a weak heuristic
  (confidence ≤ 0.5). Names and UUIDs are spoofable; discovery will not invent
  a Pinout handshake from them.
- Every candidate must carry evidence; candidates without evidence are
  rejected, not silently shipped.

## Plugins

| Plugin | Platform | Notes |
| --- | --- | --- |
| `serial` | all | manufacturer-string matching against a small table |
| `usb` | macOS (`system_profiler`), Linux (`/sys/bus/usb`) | Windows returns empty rather than guessing |
| `ble` | Linux with BlueZ `bluetoothctl` | Advertisement-only; macOS/Windows/missing tooling return empty rather than guessing |
| `mdns` | all (multicast permitting) | zero-dependency DNS-SD query + minimal response parse |
| `network-probe` | all | opt-in; explicit endpoints only |

### BLE OS requirements

- **Linux**: BlueZ userland (`bluetoothctl` on `PATH`). The plugin runs a
  bounded `bluetoothctl --timeout N scan on` and parses device lines. It never
  issues `connect`, `pair`, or GATT write commands.
- **macOS / Windows**: no zero-dependency nearby LE scanner in this package.
  The default plugin returns `[]` (same honesty pattern as Windows USB). Use
  `simulatedBleScan([...])` in tests, or inject a custom `BleScan`.
- **CI / no radio**: always inject `simulatedBleScan` — do not claim HIL
  evidence from fixtures.

```ts
import { bleDiscoveryPlugin, simulatedBleScan, runDiscovery } from '@pinout/discovery';

const run = await runDiscovery({
  plugins: [
    bleDiscoveryPlugin(
      simulatedBleScan([
        { address: 'aa:bb:cc:dd:ee:ff', localName: 'ESP32-Test', rssi: -55 },
      ]),
    ),
  ],
});
```

Protocol bytes over GATT are a separate concern: see `@pinout/core`
`bleGattTransport` / [docs/ble-gatt.md](../../docs/ble-gatt.md) (SIMULATED host
path). Discovery never opens that transport.

## Output

```
FOUND 2 CANDIDATE DEVICES

/dev/cu.usbserial-1420
  possible: Espressif pinout/esp32
  confidence: 0.50
  evidence: usb-manufacturer — /dev/cu.usbserial-1420: manufacturer 'Silicon Labs'
  interfaces: serial
```
