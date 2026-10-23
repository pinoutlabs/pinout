# @pinout/protocols-mqtt

Zero-dependency MQTT 3.1.1 client plus declarative topic↔capability mapping
for Pinout. Runs over any Pinout `Transport` (TCP today; loopback simulator
for tests).

## Status

`IMPLEMENTED` (client + bridge) / `SIMULATED` (home lamp/plug) — wire-codec
vectors and full client flows tested against an in-process broker simulator
(connect, subscribe, QoS-0/1 publish, PUBACK, ping). Home lamp/plug backend
passes shared `runLampConformance` against the same simulator. **Not verified**
against a production broker (Mosquitto/EMQX) or physical Tasmota/Shelly devices.

## What's implemented

- CONNECT/CONNACK with clean session; username/password fields.
- SUBSCRIBE/SUBACK with `+` and `#` wildcard matching helpers.
- PUBLISH QoS 0 and QoS 1 (waits for PUBACK), incoming PUBLISH delivery.
- PINGREQ/PINGRESP keepalive, DISCONNECT.
- Automatic keepalive, broker refusal handling, separate handlers per topic filter,
  full 16-bit packet identifiers, and propagation of transport write failures.
- Declarative mapping: `topic → state field/event` ingestion with
  number/text/json codecs, and `capability → publish` rules where the payload
  template interpolates invoke arguments. Topics without a mapping never
  become capabilities; publishes require explicit rules.
- **Home lamp / plug** (`MqttLampBackend`, module `pinout/mqtt-lamp`): semantic
  arm/disarm/on/off/set/status over Tasmota/Shelly topic presets. See
  [`docs/lamp-mqtt.md`](../../docs/lamp-mqtt.md).

The client bounds buffered data to 1 MiB and closes a session after a request
timeout; create a new client to reconnect. QoS 1 waits for acknowledgement but
does not persist or retransmit messages across disconnected sessions.
Interoperability regression vectors follow the
[OASIS MQTT 3.1.1 specification](https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html).

## Not implemented

- QoS 2 (exactly-once), retained-message requests from the client, TLS
  (bring a TLS transport), MQTT 5 properties, last-will.
