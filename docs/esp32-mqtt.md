# ESP32 Wi-Fi / MQTT bridge (local LAN)

Local makers path: talk to an ESP32 over Wi-Fi and a LAN MQTT broker using the
same declarative topic↔capability style as `@pinout/protocols-mqtt`, without
USB serial.

## Evidence status (honest labels only)

| Surface | Status | Notes |
| --- | --- | --- |
| Host mapping + `Esp32MqttBackend` + device simulator | **SIMULATED** | In-process broker; CI-safe. |
| `firmware/esp32-mqtt-bridge` | **COMPILE_TESTED** after `pio run -e esp32-mqtt` | Compile is not HIL. |
| Physical board + Wi-Fi + Mosquitto/EMQX | **not claimed** | No dated hardware record. Never HARDWARE_VERIFIED here. |

Do not treat MQTT PUBACK or GPIO state echo as proof an LED illuminated.

## Packages and firmware

- Host: `@pinout/protocols-mqtt` — `createEsp32MqttMapping`, `Esp32MqttBackend`,
  `Esp32MqttDeviceSimulator`, module id `pinout/esp32-mqtt`.
- Firmware: [`firmware/esp32-mqtt-bridge`](../firmware/esp32-mqtt-bridge/README.md)
  (SSID / broker via `include/pinout_mqtt_config.h` or `-D` build flags).
- Serial USB bridge remains [`firmware/esp32-bridge`](../firmware/esp32-bridge/README.md).

## Quick simulator path

```ts
import { createEsp32MqttBackend, esp32MqttModule } from '@pinout/protocols-mqtt';
import { PinoutRuntime, registerModule } from '@pinout/core';

const backend = await createEsp32MqttBackend({ deviceId: 'local' });
await backend.invoke('sys.arm', {});
await backend.invoke('gpio.write', { pin: 2, value: true });
console.log(await backend.invoke('mqtt.status', {}));
// evidenceStatus: "SIMULATED"

registerModule(esp32MqttModule);
```

## Configure a board (manual flash only)

1. Set `PINOUT_WIFI_SSID`, `PINOUT_WIFI_PASSWORD`, `PINOUT_MQTT_HOST`,
   `PINOUT_MQTT_PORT`, and `PINOUT_MQTT_DEVICE_ID`.
2. Compile: `cd firmware/esp32-mqtt-bridge && pio run -e esp32-mqtt`.
3. Upload only after you positively identify the USB board — Pinout never
   auto-flashes.
4. Run a broker on the LAN (e.g. Mosquitto). Point the host `MqttClient` at it
   and use `Esp32MqttBackend.create({ client, simulated: false, deviceId })`.

See the [firmware README](../firmware/esp32-mqtt-bridge/README.md) for the full
topic table and flash commands.
