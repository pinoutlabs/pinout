# MQTT Lamp / Plug Backend (`@pinout/protocols-mqtt`)

The **MQTT Lamp Backend** provides commissioned, semantic control for smart
lamps and plugs on a **local home Wi-Fi LAN** (Tasmota, Shelly, and similar
MQTT firmware). It is the home-oriented counterpart to the industrial
[Modbus lamp backend](lamp-modbus.md).

Agents see only semantic tools (`lamp.arm`, `lamp.disarm`, `lamp.on`,
`lamp.off`, `lamp.set`, `lamp.status`) — never raw MQTT topics.

## Status: SIMULATED

All contracts, topic mapping, and multi-stage evidence states are verified
**in-process** using `MqttBrokerSimulator` and `@pinout/core` shared
conformance (`runLampConformance`).

**Not verified** against production brokers (Mosquitto, EMQX, HiveMQ) or
physical Tasmota/Shelly hardware in this tree. Treat LAN Mosquitto examples
below as configuration guidance only until a dated hardware record exists.

---

## Topic templates (declarative mapping)

The backend builds a declarative `MqttMapping` via `buildMqttLampMapping()`:

| Role | Mapping | Notes |
| :--- | :--- | :--- |
| Command | publish rule `lamp.power` → command topic, payload `{value}` | Semantic `lamp.on` / `off` / `set` encode ON/OFF after the arming gate |
| State | ingest rule → state field `on` | Populates **observed** evidence when `enableStateReadback` is true |

### Presets

| Preset | Command topic | State topic | On / Off payloads |
| :--- | :--- | :--- | :--- |
| `tasmota` (default) | `cmnd/{deviceId}/POWER` | `stat/{deviceId}/POWER` | `ON` / `OFF` |
| `shelly` | `shellies/{deviceId}/relay/0/command` | `shellies/{deviceId}/relay/0` | `on` / `off` |
| `custom` | required `commandTopic` + `stateTopic` | same | override `onPayload` / `offPayload` |

`{deviceId}` is interpolated from config. Topics without an explicit mapping
never become capabilities (same rule as the generic MQTT bridge).

---

## Semantic mapping & evidence

| Capability | MQTT effect | Evidence | Proves | Does **not** prove |
| :--- | :--- | :--- | :--- | :--- |
| `lamp.arm` | Host-side gate only | `armed: 'armed'` | Actuation permitted | Device is online |
| `lamp.disarm` | Publish safe (off) payload | `armed: 'disarmed'` | Off command sent to broker | Contacts opened |
| `lamp.on` / `set` | Publish on payload to command topic | `commanded` + `acknowledged` | Client publish completed (QoS 0: handed to broker; QoS 1: PUBACK) | Bulb/plug physically energized |
| `lamp.status` + state topic | Subscribe / last ingest | `observed` (`simulated` / `sensor`) | Last state-topic payload | State has not changed since `at` |

**Honesty rule:** a successful MQTT publish is **not** physical success. Only an
independent state topic (or other sensor) fills `observed`.

### Watchdog

Like Modbus, generic MQTT home firmware does not give Pinout a device-local
deadman. `requireWatchdog` defaults to `true` and arming fails with
`WATCHDOG_NOT_SUPPORTED` until you set `requireWatchdog: false` (acknowledge
host-loss risk on your LAN).

---

## Configuration

```typescript
import { createMqttLampBackend } from '@pinout/protocols-mqtt';

// In-process simulator (tests / demos)
const backend = await createMqttLampBackend({
  deviceId: 'desk_lamp',
  preset: 'tasmota',           // or 'shelly' | 'custom'
  polarity: 'active-high',
  safeLevel: 'low',
  requireWatchdog: false,      // required for MQTT home adapters
  enableStateReadback: true,   // subscribe to state topic
  provenance: 'simulated',
});

// Custom topics (e.g. Home Assistant discovery-style)
const custom = await createMqttLampBackend({
  deviceId: 'plug_1',
  preset: 'custom',
  commandTopic: 'home/{deviceId}/set',
  stateTopic: 'home/{deviceId}/state',
  onPayload: 'ON',
  offPayload: 'OFF',
  qos: 1,
  polarity: 'active-high',
  safeLevel: 'low',
  requireWatchdog: false,
});
```

### Pointing at a LAN Mosquitto (unverified)

```typescript
const lan = await createMqttLampBackend({
  deviceId: 'tasmota_ABCDEF',
  preset: 'tasmota',
  host: '192.168.1.10',
  port: 1883,
  // username / password if your broker requires them
  simulated: false,
  provenance: 'hardware',       // only after you verify on the bench
  polarity: 'active-high',
  safeLevel: 'low',
  requireWatchdog: false,
});
```

Typical Mosquitto listener (example only — not exercised in CI):

```conf
# mosquitto.conf (LAN lab)
listener 1883
allow_anonymous true
```

Tasmota: configure MQTT host to that broker; Full Topic `%prefix%/%topic%/`;
topic = your `deviceId`. Power commands then match the `tasmota` preset.

---

## Runtime module

Register `pinout/mqtt-lamp` for governed runtime use:

```typescript
import { PinoutRuntime, registerModule } from '@pinout/core';
import { mqttLampModule } from '@pinout/protocols-mqtt';

registerModule(mqttLampModule);
const runtime = new PinoutRuntime();
await runtime.registerFromModule('pinout/mqtt-lamp', {
  id: 'living-room-lamp',
  simulated: true,
  backendOptions: {
    deviceId: 'desk_lamp',
    requireWatchdog: false,
  },
});
```

---

## Example

```bash
npm run demo:lamp-mqtt
```

See [`examples/lamp-mqtt.ts`](../examples/lamp-mqtt.ts).
