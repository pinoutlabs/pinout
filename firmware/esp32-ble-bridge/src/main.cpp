/**
 * Pinout ESP32 BLE GATT bridge (thin vertical slice).
 *
 * Carries Pinout protocol v1 NDJSON over a Nordic-UART-style duplex:
 *   service  6e700001-b5a3-f393-e0a9-e50e24dcca9e
 *   RX (W)   6e700002-b5a3-f393-e0a9-e50e24dcca9e  host → device
 *   TX (N)   6e700003-b5a3-f393-e0a9-e50e24dcca9e  device → host
 *
 * Transports move bytes; this sketch parses protocol lines the same way as
 * esp32-bridge, but only implements a desk-bring-up subset (sys.* + gpio
 * mode/write/read). Full serial-bridge parity remains on USB firmware.
 *
 * Evidence: host path is SIMULATED in CI. Firmware was COMPILE_TESTED with
 * `pio run -e esp32dev-ble` (no flash / no HIL). Do not claim
 * HARDWARE_VERIFIED without a dated hardware/records entry.
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

constexpr const char* serviceUuid = "6e700001-b5a3-f393-e0a9-e50e24dcca9e";
constexpr const char* rxUuid = "6e700002-b5a3-f393-e0a9-e50e24dcca9e";
constexpr const char* txUuid = "6e700003-b5a3-f393-e0a9-e50e24dcca9e";

constexpr size_t lineMax = 1024;
constexpr int protocolVersion = 1;
constexpr const char* firmwareName = "esp32-ble-bridge";
constexpr const char* firmwareVersion = "0.0.1-alpha.1";
constexpr size_t attPayloadBytes = 20;

char lineBuffer[lineMax];
size_t lineLength = 0;
bool lineOverflow = false;

BLECharacteristic* txCharacteristic = nullptr;
bool deviceConnected = false;
bool wasConnected = false;

enum DeviceState { STATE_DISARMED = 0, STATE_ARMED = 1 };
DeviceState deviceState = STATE_DISARMED;

bool pinModes[40] = {};
bool pinValues[40] = {};

void notifyChunked(const char* line) {
  if (!txCharacteristic || !deviceConnected) {
    return;
  }
  const size_t length = strlen(line);
  size_t offset = 0;
  while (offset < length) {
    const size_t chunk = min(attPayloadBytes, length - offset);
    txCharacteristic->setValue((uint8_t*)(line + offset), chunk);
    txCharacteristic->notify();
    offset += chunk;
  }
}

void sendLine(const JsonDocument& document) {
  String out;
  serializeJson(document, out);
  out += '\n';
  // USB debug mirror (optional desk bring-up). Host BLE path ignores this.
  Serial.print(out);
  notifyChunked(out.c_str());
}

void fillIdentity(JsonObject payload) {
  payload["firmware"] = firmwareName;
  payload["version"] = firmwareVersion;
  payload["protocol"] = protocolVersion;
  payload["boardId"] = "esp32-ble";
  JsonArray capabilities = payload["capabilities"].to<JsonArray>();
  capabilities.add("sys.hello");
  capabilities.add("sys.ping");
  capabilities.add("sys.info");
  capabilities.add("sys.arm");
  capabilities.add("sys.disarm");
  capabilities.add("gpio.mode");
  capabilities.add("gpio.write");
  capabilities.add("gpio.read");
}

void sendReady() {
  JsonDocument document;
  document["v"] = protocolVersion;
  document["event"] = "ready";
  JsonObject payload = document["payload"].to<JsonObject>();
  fillIdentity(payload);
  sendLine(document);
}

void sendOk(const char* id, const JsonDocument& result) {
  JsonDocument document;
  document["v"] = protocolVersion;
  document["id"] = id;
  document["ok"] = true;
  document["result"] = result;
  sendLine(document);
}

void sendErr(const char* id, const char* code, const char* message) {
  JsonDocument document;
  document["v"] = protocolVersion;
  document["id"] = id;
  document["ok"] = false;
  JsonObject error = document["error"].to<JsonObject>();
  error["code"] = code;
  error["message"] = message;
  sendLine(document);
}

bool pinAllowed(int pin) {
  if (pin < 0 || pin >= 40) {
    return false;
  }
  if (pin >= 6 && pin <= 11) {
    return false;
  }
  if (pin == 1 || pin == 3 || pin == 12) {
    return false;
  }
  return true;
}

void handleLine(const char* line) {
  if (line[0] != '{') {
    return;
  }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, line);
  if (err) {
    return;
  }
  if (!doc["id"].is<const char*>() || !doc["action"].is<const char*>()) {
    return;
  }
  const char* id = doc["id"];
  const char* action = doc["action"];
  JsonObjectConst payload =
      doc["payload"].is<JsonObjectConst>() ? doc["payload"].as<JsonObjectConst>() : JsonObjectConst();

  if (strcmp(action, "sys.hello") == 0 || strcmp(action, "sys.info") == 0) {
    JsonDocument result;
    fillIdentity(result.to<JsonObject>());
    sendOk(id, result);
    return;
  }

  if (strcmp(action, "sys.ping") == 0) {
    JsonDocument result;
    result["pong"] = true;
    sendOk(id, result);
    return;
  }

  if (strcmp(action, "sys.arm") == 0) {
    deviceState = STATE_ARMED;
    JsonDocument result;
    result["state"] = "armed";
    sendOk(id, result);
    return;
  }

  if (strcmp(action, "sys.disarm") == 0) {
    deviceState = STATE_DISARMED;
    JsonDocument result;
    result["state"] = "disarmed";
    sendOk(id, result);
    return;
  }

  if (strcmp(action, "gpio.mode") == 0) {
    int pin = payload["pin"] | -1;
    const char* mode = payload["mode"] | "";
    if (!pinAllowed(pin)) {
      sendErr(id, "INVALID_PIN", "Pin is not allowed on this bridge.");
      return;
    }
    pinMode(pin, strcmp(mode, "input") == 0 ? INPUT : OUTPUT);
    pinModes[pin] = true;
    JsonDocument result;
    result["pin"] = pin;
    result["mode"] = mode;
    sendOk(id, result);
    return;
  }

  if (strcmp(action, "gpio.write") == 0) {
    if (deviceState != STATE_ARMED) {
      sendErr(id, "NOT_ARMED", "Device must be armed before actuation.");
      return;
    }
    int pin = payload["pin"] | -1;
    bool value = payload["value"] | false;
    if (!pinAllowed(pin)) {
      sendErr(id, "INVALID_PIN", "Pin is not allowed on this bridge.");
      return;
    }
    pinMode(pin, OUTPUT);
    digitalWrite(pin, value ? HIGH : LOW);
    pinValues[pin] = value;
    pinModes[pin] = true;
    JsonDocument result;
    result["pin"] = pin;
    result["value"] = value;
    sendOk(id, result);
    return;
  }

  if (strcmp(action, "gpio.read") == 0) {
    int pin = payload["pin"] | -1;
    if (!pinAllowed(pin)) {
      sendErr(id, "INVALID_PIN", "Pin is not allowed on this bridge.");
      return;
    }
    bool value = digitalRead(pin) == HIGH;
    pinValues[pin] = value;
    JsonDocument result;
    result["pin"] = pin;
    result["value"] = value;
    sendOk(id, result);
    return;
  }

  sendErr(id, "UNSUPPORTED_CAPABILITY", action);
}

void feedByte(uint8_t byte) {
  if (byte == '\r') {
    return;
  }
  if (byte == '\n') {
    if (lineOverflow) {
      lineOverflow = false;
      lineLength = 0;
      return;
    }
    lineBuffer[lineLength] = '\0';
    handleLine(lineBuffer);
    lineLength = 0;
    return;
  }
  if (lineLength + 1 >= lineMax) {
    lineOverflow = true;
    return;
  }
  lineBuffer[lineLength++] = (char)byte;
}

class RxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    std::string value = characteristic->getValue();
    for (size_t i = 0; i < value.length(); i++) {
      feedByte((uint8_t)value[i]);
    }
  }
};

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* server) override {
    (void)server;
    deviceConnected = true;
  }

  void onDisconnect(BLEServer* server) override {
    (void)server;
    deviceConnected = false;
  }
};

void setupBle() {
  BLEDevice::init("Pinout-ESP32");
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService* service = server->createService(serviceUuid);
  BLECharacteristic* rx = service->createCharacteristic(
      rxUuid, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rx->setCallbacks(new RxCallbacks());

  txCharacteristic = service->createCharacteristic(txUuid, BLECharacteristic::PROPERTY_NOTIFY);
  txCharacteristic->addDescriptor(new BLE2902());

  service->start();
  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(serviceUuid);
  advertising->setScanResponse(true);
  advertising->start();
}

void setup() {
  Serial.begin(115200);
  delay(200);
  setupBle();
  sendReady();
}

void loop() {
  if (deviceConnected && !wasConnected) {
    wasConnected = true;
    sendReady();
  }
  if (!deviceConnected && wasConnected) {
    wasConnected = false;
    deviceState = STATE_DISARMED;
    BLEDevice::startAdvertising();
  }
  delay(20);
}
