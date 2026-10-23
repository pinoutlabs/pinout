# Room Environment Sensor (BME280 / DHT)

**Status: `SIMULATED`**

External Pinout module for local makers reading room temperature, humidity, and
(for BME280) absolute pressure. The module lives under
[`examples/external-module/room-sensor`](../examples/external-module/room-sensor)
and intentionally stays **outside** `@pinout/core` so product-specific I2C/DHT
drivers are not baked into the core package.

| Claim | Evidence |
| --- | --- |
| Simulator capabilities + evidence contract | Unit tests in `examples/external-module/room-sensor/test` |
| Physical hardware | **Not claimed** |
| Firmware compile hooks for this sensor | **Not claimed** (generic ESP32 `i2c.*` primitives remain separately `COMPILE_TESTED`) |

## Capabilities

- `sensor.read` — structured sample (`temperatureC`, `humidityPercent`, `pressurePa`, observation metadata)
- `temperature.read` / `humidity.read` / `pressure.read` — focused reads (`pressure.read` is BME280-only)
- `status.read` — operational status plus physical-evidence fields

## Physical evidence contract

Sensor modules are read-only. On a successful read:

1. `observed` is updated with the sample (`source: 'simulated'` in this module).
2. `commanded` and `acknowledged` remain `{ value: null, at: null, source: 'none' }`.
3. `freshnessMs` / `stale` are computed against `observationMaxAgeMs`.

A successful invoke never implies that a prior write succeeded — there is no
write path, and status does not fabricate commanded/acknowledged state from
reads. See [state-evidence.md](state-evidence.md).

## Install & invoke

```bash
# From repo root (workspace provides @pinout/core)
npx tsc -p examples/external-module/room-sensor/tsconfig.json
npx vitest run examples/external-module/room-sensor/test
npm run pinout -- module test ./examples/external-module/room-sensor
npm run pinout -- module install ./examples/external-module/room-sensor
npm run pinout -- device add room-01 --module room-sensor/environment --simulated
npm run pinout -- invoke room-01 sensor.read '{}'
```

## Wiring notes (makers)

ESP32 classic defaults: BME280 on SDA **GPIO 21** / SCL **GPIO 22** (address
`0x76` or `0x77`); DHT data on **GPIO 4** with pull-up. Full pin tables and
MicroPython sketches live in the [module README](../examples/external-module/room-sensor/README.md).

These notes are for future hardware bring-up. Catalog status for this module
stays **`SIMULATED`** until a dated `hardware/records/` entry exists.
