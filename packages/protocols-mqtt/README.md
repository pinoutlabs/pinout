# @pinout/protocols-mqtt

Zero-dependency MQTT 3.1.1 client plus declarative topic↔capability mapping
for Pinout. Runs over any Pinout `Transport` (TCP today; loopback simulator
for tests).

## Status

- MQTT 3.1.1 client / mapping / `pinout/mqtt-bridge`: **IMPLEMENTED** against the
  in-process broker simulator (connect, subscribe, QoS-0/1 publish, PUBACK,
  ping). Not verified against a production broker (Mosquitto/EMQX) yet.
- Home lamp / plug (`MqttLampBackend`, module `pinout/mqtt-lamp`): **SIMULATED**.
  Passes shared `runLampConformance` against the in-process broker. **Not
  verified** against Mosquitto/EMQX or physical Tasmota/Shelly devices.
- ESP32 Wi-Fi path (`createEsp32MqttMapping`, `Esp32MqttBackend`,
  `Esp32MqttDeviceSimulator`, module `pinout/esp32-mqtt`): **SIMULATED**.
  Firmware tree `firmware/esp32-mqtt-bridge` is **COMPILE_TESTED** after
  `pio run -e esp32-mqtt`. Never HARDWARE_VERIFIED from these tests.

`pinout/mqtt-lamp` (semantic home lamp) and `pinout/esp32-mqtt` (raw
GPIO/arming bridge) are separate modules and coexist in this package.

## What's implemented

- CONNECT/CONNACK with clean session; username/password fields.
- SUBSCRIBE/SUBACK with `+` and `#` wildcard matching helpers.
- PUBLISH QoS 0 and QoS 1 (waits for PUBACK), incoming PUBLISH delivery.
- PINGREQ/PINGRESP keepalive, DISCONNECT.
- Automatic keepalive, broker refusal handling, separate handlers per topic filter,
  full 16-bit packet identifiers, and propagation of transport write failures.
- Declarative mapping: `topic → state field/event` ingestion with
  number/text/json codecs, and `capability → publish` rules where the payload
  template interpolates invoke arguments **or** `codec: 'json'` publishes
  `JSON.stringify(args)`. Topics without a mapping never become capabilities;
  publishes require explicit rules.
- **Home lamp / plug** (`MqttLampBackend`, module `pinout/mqtt-lamp`): semantic
  arm/disarm/on/off/set/status over Tasmota/Shelly topic presets. See
  [`docs/lamp-mqtt.md`](../../docs/lamp-mqtt.md).
- **ESP32 LAN bridge** under `pinout/esp32/{deviceId}/cmd|state|evt/...`
  with a CI-safe device simulator that mirrors
  [`firmware/esp32-mqtt-bridge`](../../firmware/esp32-mqtt-bridge/README.md).

The client bounds buffered data to 1 MiB and closes a session after a request
timeout; create a new client to reconnect. QoS 1 waits for acknowledgement but
does not persist or retransmit messages across disconnected sessions.
Interoperability regression vectors follow the
[OASIS MQTT 3.1.1 specification](https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html).

## Not implemented

- QoS 2 (exactly-once), retained-message requests from the client, TLS
  (bring a TLS transport), MQTT 5 properties, last-will.
