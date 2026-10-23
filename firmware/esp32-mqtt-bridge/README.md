# ESP32 Wi-Fi MQTT bridge

Local-LAN firmware that maps Pinout GPIO/arming capabilities onto MQTT topics.
Pairs with `@pinout/protocols-mqtt` (`createEsp32MqttMapping`, `Esp32MqttBackend`,
module `pinout/esp32-mqtt`).

## Evidence status

| Layer | Status | Meaning |
| --- | --- | --- |
| Host simulator (`Esp32MqttDeviceSimulator`) | **SIMULATED** | CI exercises the same topic contract in-process. |
| This firmware tree | **COMPILE_TESTED** after `pio run -e esp32-mqtt` | Build proves the sketch compiles. |
| Physical Wi-Fi + broker + GPIO | **not claimed** | No dated `hardware/records/` entry. Never HARDWARE_VERIFIED from compile or simulator tests. |

Pinout tooling **never auto-flashes**. Identify the board, set Wi-Fi/broker
config, then upload manually.

## Topic contract

Prefix: `pinout/esp32/{deviceId}/` (default `deviceId=local`).

| Direction | Topic | Payload |
| --- | --- | --- |
| Host → board | `.../cmd/sys.arm` | `{}` |
| Host → board | `.../cmd/sys.disarm` | `{}` |
| Host → board | `.../cmd/gpio.write` | `{"pin":2,"value":true}` |
| Host → board | `.../cmd/gpio.toggle` | `{"pin":2}` |
| Host → board | `.../cmd/gpio.read` | `{"pin":2}` |
| Board → host | `.../state/armed` | `armed` \| `disarmed` |
| Board → host | `.../state/gpio/{pin}` | `0` \| `1` |
| Board → host | `.../evt/hello` | identity JSON (`status` is honest) |
| Board → host | `.../evt/error` | `{"code","message"}` |

Actuation while disarmed publishes `NOT_ARMED` on `evt/error`. Flash pins 6–11,
UART0 1/3, strap 12, and input-only 34–39 are rejected.

## Configure SSID and broker

Defaults in `include/pinout_mqtt_config.h` are placeholders
(`PINOUT_WIFI_SSID=pinout-unconfigured`) and will not join a network.

Either edit that header, copy `pinout_mqtt_config.h.example`, or pass flags:

```bash
cd firmware/esp32-mqtt-bridge
pio run -e esp32-mqtt --build-flags \
  '-DPINOUT_WIFI_SSID=\"myssid\"' \
  '-DPINOUT_WIFI_PASSWORD=\"secret\"' \
  '-DPINOUT_MQTT_HOST=\"192.168.1.10\"' \
  '-DPINOUT_MQTT_PORT=1883' \
  '-DPINOUT_MQTT_DEVICE_ID=\"local\"'
```

## Compile (no upload)

```bash
cd firmware/esp32-mqtt-bridge
pio run -e esp32-mqtt
```

## Manual flash (operator only)

```bash
pio run -e esp32-mqtt -t upload --upload-port /dev/ttyUSB0
pio device monitor
```

Serial logs JSON status lines (`wifi.status`, `mqtt.status`) with
`evidence":"COMPILE_TESTED"` — not hardware verification.

## Host usage (simulator)

```ts
import { createEsp32MqttBackend } from '@pinout/protocols-mqtt';

const backend = await createEsp32MqttBackend({ deviceId: 'local' });
await backend.invoke('sys.arm', {});
await backend.invoke('gpio.write', { pin: 2, value: true });
```

Against a real Mosquitto/EMQX broker, construct an `MqttClient` over TCP to the
broker and pass it to `Esp32MqttBackend.create({ client, simulated: false })`.
That path is **IMPLEMENTED** at the client layer only; board HIL remains unset.
