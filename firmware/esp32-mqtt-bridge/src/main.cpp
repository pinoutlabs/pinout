/**
 * ESP32 Wi-Fi + MQTT bridge (local LAN).
 *
 * Speaks the same topic contract as `@pinout/protocols-mqtt` Esp32Mqtt* helpers:
 *   pinout/esp32/{deviceId}/cmd/{action}   ← host publishes JSON
 *   pinout/esp32/{deviceId}/state/armed
 *   pinout/esp32/{deviceId}/state/gpio/{pin}
 *   pinout/esp32/{deviceId}/evt/hello|error
 *
 * Evidence: source is intended for COMPILE_TESTED after `pio run -e esp32-mqtt`.
 * Physical Wi-Fi/broker HIL is NOT claimed. Pinout tools never auto-flash.
 */
#include <Arduino.h>
#include <ArduinoJson.h>
#include <PubSubClient.h>
#include <WiFi.h>

#include "pinout_mqtt_config.h"

constexpr const char* firmwareName = "esp32-mqtt-bridge";
constexpr const char* firmwareVersion = "0.0.1-alpha.1";
constexpr int protocolVersion = 1;

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

char topicPrefix[80];
char topicCmdArm[96];
char topicCmdDisarm[96];
char topicCmdWrite[96];
char topicCmdToggle[96];
char topicCmdRead[96];
char topicStateArmed[96];
char topicEvtHello[96];
char topicEvtError[96];

enum DeviceState { STATE_DISARMED = 0, STATE_ARMED = 1 };
DeviceState deviceState = STATE_DISARMED;
bool gpioLevels[40] = {};
bool gpioKnown[40] = {};

bool isFlashPin(int pin) { return pin >= 6 && pin <= 11; }
bool isInputOnlyPin(int pin) { return pin >= 34 && pin <= 39; }
bool isUart0Pin(int pin) { return pin == 1 || pin == 3; }
bool isStrapPin(int pin) { return pin == 12; }

bool isValidOutputPin(int pin) {
  if (pin < 0 || pin > 39) return false;
  if (isFlashPin(pin) || isInputOnlyPin(pin) || isUart0Pin(pin) || isStrapPin(pin)) return false;
  return true;
}

void publishRaw(const char* topic, const char* payload) {
  mqtt.publish(topic, payload, false);
}

void publishArmed() {
  publishRaw(topicStateArmed, deviceState == STATE_ARMED ? "armed" : "disarmed");
}

void publishGpio(int pin, bool value) {
  char topic[96];
  snprintf(topic, sizeof(topic), "%s/state/gpio/%d", topicPrefix, pin);
  publishRaw(topic, value ? "1" : "0");
}

void publishError(const char* code, const char* message) {
  JsonDocument doc;
  doc["code"] = code;
  doc["message"] = message;
  char buffer[192];
  serializeJson(doc, buffer, sizeof(buffer));
  publishRaw(topicEvtError, buffer);
}

void publishHello() {
  JsonDocument doc;
  doc["firmware"] = firmwareName;
  doc["version"] = firmwareVersion;
  doc["protocol"] = protocolVersion;
  doc["transport"] = "mqtt";
  doc["deviceId"] = PINOUT_MQTT_DEVICE_ID;
  doc["status"] = "COMPILE_TESTED";
  JsonArray caps = doc["capabilities"].to<JsonArray>();
  caps.add("sys.arm");
  caps.add("sys.disarm");
  caps.add("gpio.write");
  caps.add("gpio.toggle");
  caps.add("gpio.read");
  char buffer[384];
  serializeJson(doc, buffer, sizeof(buffer));
  publishRaw(topicEvtHello, buffer);
}

void applySafeState() {
  for (int pin = 0; pin < 40; pin++) {
    if (!gpioKnown[pin]) continue;
    gpioLevels[pin] = false;
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
    publishGpio(pin, false);
  }
}

void handleCommand(const char* action, JsonObjectConst args) {
  if (strcmp(action, "sys.arm") == 0) {
    deviceState = STATE_ARMED;
    publishArmed();
    return;
  }
  if (strcmp(action, "sys.disarm") == 0) {
    applySafeState();
    deviceState = STATE_DISARMED;
    publishArmed();
    return;
  }

  if (strcmp(action, "gpio.read") == 0) {
    if (!args["pin"].is<int>()) {
      publishError("INVALID_ARGUMENT", "gpio.read requires integer pin.");
      return;
    }
    int pin = args["pin"].as<int>();
    if (!isValidOutputPin(pin) && !(pin >= 0 && pin <= 39 && !isFlashPin(pin))) {
      publishError("INVALID_PIN", "Pin is not readable on this bridge.");
      return;
    }
    bool value = gpioKnown[pin] ? gpioLevels[pin] : digitalRead(pin) == HIGH;
    publishGpio(pin, value);
    return;
  }

  if (deviceState != STATE_ARMED) {
    publishError("NOT_ARMED", "Device is disarmed; call sys.arm first.");
    return;
  }

  if (!args["pin"].is<int>()) {
    publishError("INVALID_ARGUMENT", "GPIO commands require integer pin.");
    return;
  }
  int pin = args["pin"].as<int>();
  if (!isValidOutputPin(pin)) {
    publishError("INVALID_PIN", "Pin is reserved or input-only.");
    return;
  }

  if (strcmp(action, "gpio.write") == 0) {
    bool value = false;
    if (args["value"].is<bool>()) value = args["value"].as<bool>();
    else if (args["value"].is<int>()) value = args["value"].as<int>() != 0;
    else if (args["value"].is<const char*>()) {
      const char* text = args["value"].as<const char*>();
      value = strcmp(text, "1") == 0 || strcmp(text, "high") == 0 || strcmp(text, "true") == 0;
    } else {
      publishError("INVALID_ARGUMENT", "gpio.write requires value.");
      return;
    }
    pinMode(pin, OUTPUT);
    digitalWrite(pin, value ? HIGH : LOW);
    gpioLevels[pin] = value;
    gpioKnown[pin] = true;
    publishGpio(pin, value);
    return;
  }

  if (strcmp(action, "gpio.toggle") == 0) {
    bool next = !(gpioKnown[pin] ? gpioLevels[pin] : false);
    pinMode(pin, OUTPUT);
    digitalWrite(pin, next ? HIGH : LOW);
    gpioLevels[pin] = next;
    gpioKnown[pin] = true;
    publishGpio(pin, next);
    return;
  }

  publishError("UNKNOWN_ACTION", action);
}

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  char body[256];
  if (length >= sizeof(body)) {
    publishError("LINE_TOO_LONG", "MQTT payload too large.");
    return;
  }
  memcpy(body, payload, length);
  body[length] = '\0';

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, body);
  if (err && length > 0) {
    publishError("MQTT_PAYLOAD_NOT_JSON", "Command payload must be JSON object.");
    return;
  }
  JsonObjectConst args = doc.as<JsonObjectConst>();

  const char* prefixCmd = topicPrefix;
  size_t prefixLen = strlen(prefixCmd);
  // topic = {prefix}/cmd/{action}
  if (strncmp(topic, prefixCmd, prefixLen) != 0) return;
  if (strncmp(topic + prefixLen, "/cmd/", 5) != 0) return;
  const char* action = topic + prefixLen + 5;
  handleCommand(action, args);
}

void buildTopics() {
  snprintf(topicPrefix, sizeof(topicPrefix), "pinout/esp32/%s", PINOUT_MQTT_DEVICE_ID);
  snprintf(topicCmdArm, sizeof(topicCmdArm), "%s/cmd/sys.arm", topicPrefix);
  snprintf(topicCmdDisarm, sizeof(topicCmdDisarm), "%s/cmd/sys.disarm", topicPrefix);
  snprintf(topicCmdWrite, sizeof(topicCmdWrite), "%s/cmd/gpio.write", topicPrefix);
  snprintf(topicCmdToggle, sizeof(topicCmdToggle), "%s/cmd/gpio.toggle", topicPrefix);
  snprintf(topicCmdRead, sizeof(topicCmdRead), "%s/cmd/gpio.read", topicPrefix);
  snprintf(topicStateArmed, sizeof(topicStateArmed), "%s/state/armed", topicPrefix);
  snprintf(topicEvtHello, sizeof(topicEvtHello), "%s/evt/hello", topicPrefix);
  snprintf(topicEvtError, sizeof(topicEvtError), "%s/evt/error", topicPrefix);
}

bool connectWifi() {
  if (strcmp(PINOUT_WIFI_SSID, "pinout-unconfigured") == 0) {
    Serial.println("{\"event\":\"wifi.config\",\"status\":\"UNCONFIGURED\",\"hint\":\"set PINOUT_WIFI_SSID\"}");
    return false;
  }
  WiFi.mode(WIFI_STA);
  WiFi.begin(PINOUT_WIFI_SSID, PINOUT_WIFI_PASSWORD);
  const unsigned long deadline = millis() + 20000;
  while (WiFi.status() != WL_CONNECTED && millis() < deadline) {
    delay(250);
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("{\"event\":\"wifi.status\",\"status\":\"FAILED\"}");
    return false;
  }
  Serial.print("{\"event\":\"wifi.status\",\"status\":\"CONNECTED\",\"ip\":\"");
  Serial.print(WiFi.localIP());
  Serial.println("\"}");
  return true;
}

bool connectMqtt() {
  mqtt.setServer(PINOUT_MQTT_HOST, PINOUT_MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  if (!mqtt.connect(PINOUT_MQTT_CLIENT_ID)) {
    Serial.println("{\"event\":\"mqtt.status\",\"status\":\"FAILED\"}");
    return false;
  }
  mqtt.subscribe(topicCmdArm);
  mqtt.subscribe(topicCmdDisarm);
  mqtt.subscribe(topicCmdWrite);
  mqtt.subscribe(topicCmdToggle);
  mqtt.subscribe(topicCmdRead);
  publishArmed();
  publishHello();
  Serial.println("{\"event\":\"mqtt.status\",\"status\":\"CONNECTED\",\"evidence\":\"COMPILE_TESTED\"}");
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(200);
  buildTopics();
  Serial.println("{\"event\":\"ready\",\"firmware\":\"esp32-mqtt-bridge\",\"transport\":\"mqtt\",\"evidence\":\"COMPILE_TESTED\"}");
  if (!connectWifi()) {
    Serial.println("{\"event\":\"halt\",\"reason\":\"wifi_unconfigured_or_failed\"}");
    return;
  }
  connectMqtt();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    connectWifi();
    return;
  }
  if (!mqtt.connected()) {
    delay(1000);
    connectMqtt();
    return;
  }
  mqtt.loop();
}
