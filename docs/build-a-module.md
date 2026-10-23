# Build a Pinout Module

Pinout modules are **executable local packages** that teach the runtime how to talk to a class of physical hardware. This guide walks through creating, testing, installing, and registering an external module without modifying `@pinout/core`.

## Security

Third-party modules run as ordinary Node.js code in your process. Installing a module grants it the same permissions as the Pinout CLI/MCP server. Only install modules you trust. Pinout does **not** sandbox modules in Sprint 3.

## Module anatomy

```
my-sensor/
├── pinout.module.json   # portable manifest (required)
├── package.json
├── src/
│   ├── index.ts         # exports default defineModule(...)
│   └── backend.ts       # DeviceBackend implementation
├── dist/                # built entrypoint
└── test/
    └── module.test.ts
```

### Manifest (`pinout.module.json`)

```json
{
  "schemaVersion": 1,
  "id": "acme/thermometer",
  "version": "0.1.0",
  "deviceClass": "sensor.temperature",
  "entrypoint": "./dist/index.js",
  "name": "Acme T100",
  "vendor": "Acme",
  "model": "T100",
  "pinout": {
    "minimumVersion": "0.0.1-alpha.1"
  }
}
```

Fields:

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Manifest format version (currently `1`) |
| `id` | Stable module id (`vendor/name`, lowercase) |
| `version` | Module semver |
| `deviceClass` | Semantic device class string |
| `entrypoint` | Compiled JS default export |
| `pinout.minimumVersion` | Minimum compatible Pinout SDK version |

## Author with the public SDK

```typescript
import { defineModule, action, sensorRead } from '@pinout/core';
import { AcmeBackend } from './backend.js';

export default defineModule({
  id: 'acme/thermometer',
  version: '0.1.0',
  device: {
    class: 'sensor.temperature',
    vendor: 'Acme',
    model: 'T100',
  },
  capabilities: [
    sensorRead('temperature.read', 'Read temperature °C', {
      type: 'object',
      properties: { temperature: { type: 'number' }, unit: { type: 'string' } },
      required: ['temperature'],
    }),
  ],
  policies: {
    'temperature.set': {
      constraints: { value: { min: 0, max: 80 } },
    },
  },
  createBackend(config) {
    return new AcmeBackend(config);
  },
});
```

### Capability helpers

- `action({ id, description, input, output })` — general capability
- `sensorRead(id, description, outputSchema)` — no-input sensor read

Schemas are standard [JSON Schema](https://json-schema.org/) objects — helpers generate them; they are not a proprietary DSL.

### Backend contract

Implement `DeviceBackend`:

```typescript
interface DeviceBackend {
  readonly kind: 'simulated' | 'protocol';
  invoke(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
  subscribe(handler: (event: string, payload: Record<string, unknown>) => void): () => void;
  getOperationalState?(): Record<string, unknown>;
}
```

`createBackend(config)` receives device configuration from `devices.json` plus `simulated: true|false`.

## Policy precedence

Modules may ship default policies (declarative or `PolicyRule[]`). Deployments may add **stricter** overrides in `devices.json`:

```json
{
  "policies": {
    "temperature.set": {
      "constraints": { "value": { "max": 60 } }
    }
  }
}
```

When both module and deployment define limits:

- **minimum** → higher value wins (tighter floor)
- **maximum** → lower value wins (tighter ceiling)

Deployment overrides **cannot widen** module safety limits.

## Workflow

```bash
# Scaffold
pinout module create my-sensor
cd my-sensor && npm install && npm run build

# Conformance
pinout module test .

# Install locally (~/.pinout/modules/)
pinout module install .

# Register device
pinout device add sensor-01 --module my-sensor/device --simulated

# Verify
pinout devices
pinout invoke sensor-01 temperature.read '{}'
```

## MCP (no adapter changes)

When `~/.pinout/devices.json` exists (or `PINOUT_CONFIG` is set), `npm run mcp` bootstraps the runtime and exposes tools automatically — e.g. `sensor_01__temperature_read`.

## Reference module

See [examples/external-module/weird-sensor](../examples/external-module/weird-sensor/README.md) for a complete working external module, and [examples/external-module/room-sensor](../examples/external-module/room-sensor/README.md) for a BME280/DHT environment sensor with physical-evidence status (`SIMULATED`).

## Conformance kit

`pinout module test .` validates:

- manifest and Pinout version compatibility
- capability uniqueness and schemas
- backend lifecycle and unknown-action rejection
- policy references

This is the foundation for future **Pinout Verified** certification.

## Generated modules (Sprint 4)

Pinout can compile documentation/SDK material into candidate modules:

```bash
pinout generate ./vendor-sdk --plan
pinout generate ./vendor-sdk --output ./generated/acme-device
pinout module test ./generated/acme-device
```

Generated modules start at status **GENERATED / UNVERIFIED**. They use the same `defineModule` SDK as hand-written modules but require human review before installation. See [generator.md](generator.md) and [generator-safety.md](generator-safety.md).

## Local registry layout

```
~/.pinout/
  modules.json          # installed module index
  modules/              # copied module packages
  devices.json          # persistent device configuration
  config.json           # optional future settings
```

Built-in modules (`pinout/esp32`, `pinout/robot-arm`, `pinout/environmental-chamber`, `pinout/dc-motor`, `pinout/servo`, `pinout/stepper`, `pinout/distance`, `pinout/imu`, `pinout/encoder`, `pinout/limit-switch`, `pinout/force`, `pinout/mobile-base`) are always available and listed alongside installed modules.
