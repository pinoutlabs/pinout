#pragma once
// Placeholder defaults for compile checks. Operators must override SSID/broker
// via build_flags or a local copy of pinout_mqtt_config.h.example before use.
// Evidence: COMPILE_TESTED after `pio run -e esp32-mqtt`; never HARDWARE_VERIFIED
// from compile alone.

#ifndef PINOUT_WIFI_SSID
#define PINOUT_WIFI_SSID "pinout-unconfigured"
#endif

#ifndef PINOUT_WIFI_PASSWORD
#define PINOUT_WIFI_PASSWORD ""
#endif

#ifndef PINOUT_MQTT_HOST
#define PINOUT_MQTT_HOST "192.168.1.10"
#endif

#ifndef PINOUT_MQTT_PORT
#define PINOUT_MQTT_PORT 1883
#endif

#ifndef PINOUT_MQTT_DEVICE_ID
#define PINOUT_MQTT_DEVICE_ID "local"
#endif

#ifndef PINOUT_MQTT_CLIENT_ID
#define PINOUT_MQTT_CLIENT_ID "esp32-mqtt-bridge"
#endif
