# Room Sensor — BME280 / DHT External Pinout Module

**Status: `SIMULATED`**

Local maker module for room temperature, humidity, and (BME280) pressure. Lives
**outside** `@pinout/core` so product-specific sensor drivers stay out of the
core package. Follows the [physical evidence contract](../../../docs/state-evidence.md):
sensor reads update `observed` only; `commanded` / `acknowledged` stay null.

No physical HIL and no compile-tested firmware hooks are claimed in this module.

## Quick start

From the Pinout repository root:

```bash
# From repo root (workspace provides @pinout/core)
npx tsc -p examples/external-module/room-sensor/tsconfig.json
npx vitest run examples/external-module/room-sensor/test

# Validate conformance
npm run pinout -- module test ./examples/external-module/room-sensor

# Install into local Pinout registry (~/.pinout)
npm run pinout -- module install ./examples/external-module/room-sensor

# Register a simulated device
npm run pinout -- device add room-01 --module room-sensor/environment --simulated

# Invoke
npm run pinout -- invoke room-01 sensor.read '{}'
npm run pinout -- invoke room-01 status.read '{}'
```

## Capabilities

| Capability | Purpose |
| --- | --- |
| `sensor.read` | Combined temperature / humidity / pressure sample with observation metadata |
| `temperature.read` | Temperature °C |
| `humidity.read` | Relative humidity % |
| `pressure.read` | Absolute pressure Pa (BME280 only; DHT rejects) |
| `status.read` | Evidence bundle + wiring config (`commanded` / `acknowledged` / `observed` / freshness) |

## Configuration

Device backend options (in `devices.json`):

```json
{
  "config": {
    "simulated": true,
    "sensorFamily": "bme280",
    "i2cAddress": 118,
    "sdaPin": 21,
    "sclPin": 22,
    "dhtPin": 4,
    "observationMaxAgeMs": 5000,
    "seedTemperatureC": 22.4,
    "seedHumidityPercent": 47.5,
    "seedPressurePa": 101325
  }
}
```

`sensorFamily`: `bme280` | `dht11` | `dht22` (default `bme280`).

## Wiring notes (ESP32 / MicroPython) — not claimed as verified

These notes are for local makers bringing up hardware later. The module itself
remains **SIMULATED** until a dated hardware record exists under `hardware/records/`.

### BME280 (I2C)

| Signal | ESP32 classic DevKit | Notes |
| --- | --- | --- |
| VIN / VCC | 3V3 | 3.3 V logic |
| GND | GND | |
| SDA | GPIO 21 (default) | Match `sdaPin` |
| SCL | GPIO 22 (default) | Match `sclPin` |
| ADDR | GND → `0x76`, 3V3 → `0x77` | Match `i2cAddress` |

Host bridge already exposes generic `i2c.begin` / `i2c.read` / `i2c.write` /
`i2c.scan` on the ESP32 firmware path (`COMPILE_TESTED` for the bus primitives,
not for this sensor module).

MicroPython sketch outline (bring-up only):

```python
from machine import I2C, Pin
i2c = I2C(0, sda=Pin(21), scl=Pin(22), freq=100000)
print(i2c.scan())  # expect 0x76 or 0x77
```

### DHT11 / DHT22 (1-wire data)

| Signal | ESP32 classic | Notes |
| --- | --- | --- |
| VCC | 3V3 | |
| GND | GND | |
| DATA | GPIO 4 (default) | Match `dhtPin`; 4.7k–10k pull-up to 3V3 |

```python
# MicroPython: use a DHT driver (e.g. dht.DHT22) — not wired into this module yet.
import dht
from machine import Pin
sensor = dht.DHT22(Pin(4))
sensor.measure()
print(sensor.temperature(), sensor.humidity())
```

## Security

Pinout modules are **executable local code**. Only install modules you trust.

## See also

- [docs/room-sensor.md](../../../docs/room-sensor.md)
- [docs/state-evidence.md](../../../docs/state-evidence.md)
- [docs/build-a-module.md](../../../docs/build-a-module.md)
- Reference external module: [weird-sensor](../weird-sensor/README.md)
