#include <Arduino.h>
#if defined(PINOUT_ESP32_C3)
// Arduino-ESP32 2.x exposes the native USB CDC stream from HWCDC.h when
// ARDUINO_USB_MODE=1; Arduino.h alone does not declare the global Serial.
#include <HWCDC.h>
#endif
#include <ArduinoJson.h>
#include <SPI.h>
#include <Wire.h>

constexpr uint32_t baudRate = 115200;
// Maximum protocol frame size in bytes (1024).
// Accommodates comprehensive capability advertisements, features, and batch commands
// while easily fitting within ESP32 SRAM (520 KB) with minimal buffer pressure.
constexpr size_t lineMax = 1024;
constexpr int protocolVersion = 1;
constexpr const char* firmwareName = "esp32-bridge";
constexpr const char* firmwareVersion = "0.0.1-alpha.1";
constexpr size_t maxBusPayloadBytes = 32;

char lineBuffer[lineMax];
size_t lineLength = 0;
bool lineOverflow = false;
unsigned long bootMillis = 0;

enum DeviceState {
  STATE_DISARMED = 0,
  STATE_ARMED = 1,
  STATE_TRIPPED = 2
};

enum SafeLevel {
  SAFE_LEVEL_LOW = 0,
  SAFE_LEVEL_HIGH = 1,
  SAFE_LEVEL_HIGH_Z = 2,
  SAFE_LEVEL_HOLD = 3
};

enum Polarity {
  POLARITY_ACTIVE_HIGH = 0,
  POLARITY_ACTIVE_LOW = 1
};

struct PinSafeConfig {
  SafeLevel safeLevel = SAFE_LEVEL_LOW;
  Polarity polarity = POLARITY_ACTIVE_HIGH;
  bool configured = false;
};

DeviceState deviceState = STATE_DISARMED;
const char* tripReason = nullptr;
unsigned long watchdogTimeoutMs = 1000;
unsigned long watchdogDeadline = 0;
bool watchdogEnabled = true;
PinSafeConfig pinSafeConfigs[40];

struct WatchState {
  int pin = -1;
  bool lastValue = false;
  bool active = false;
};

struct PulseState {
  int pin = -1;
  unsigned long until = 0;
  bool previousValue = false;
  bool active = false;
};

WatchState watches[8];
size_t watchCount = 0;
PulseState pulses[8];

#if defined(PINOUT_ESP32_C3)
int i2cSda = 4;
int i2cScl = 5;
#else
int i2cSda = 21;
int i2cScl = 22;
#endif
uint32_t i2cFrequency = 100000;
bool i2cStarted = false;

#if defined(PINOUT_ESP32_C3)
int spiSck = 4;
int spiMiso = 5;
int spiMosi = 6;
int spiCs = 7;
#else
int spiSck = 18;
int spiMiso = 19;
int spiMosi = 23;
int spiCs = 5;
#endif
uint32_t spiFrequency = 1000000;
bool spiStarted = false;
bool activeOutputs[40] = {};
int activePwmPins[16] = {-1, -1, -1, -1, -1, -1, -1, -1,
                         -1, -1, -1, -1, -1, -1, -1, -1};

void cancelPulseForPin(int pin) {
  for (size_t i = 0; i < 8; i++) {
    if (pulses[i].active && pulses[i].pin == pin) {
      pulses[i].active = false;
    }
  }
}

#if defined(PINOUT_ESP32_C3)
bool isFlashPin(int pin) { return pin >= 11 && pin <= 17; }
bool isInputOnlyPin(int) { return false; }
bool isUart0Pin(int pin) { return pin == 20 || pin == 21; }
bool isStrapPin(int pin) { return pin == 2 || pin == 8 || pin == 9; }
bool isAdcPin(int pin) { return pin >= 0 && pin <= 4; }
bool isUsbPin(int pin) { return pin == 18 || pin == 19; }
#else
bool isFlashPin(int pin) { return pin >= 6 && pin <= 11; }
bool isInputOnlyPin(int pin) { return pin >= 34 && pin <= 39; }
bool isUart0Pin(int pin) { return pin == 1 || pin == 3; }
bool isStrapPin(int pin) { return pin == 12; }
bool isAdcPin(int pin) { return pin >= 32 && pin <= 39; }
bool isUsbPin(int) { return false; }
#endif

int maxGpioPin() {
#if defined(PINOUT_ESP32_C3)
  return 21;
#else
  return 39;
#endif
}

bool isReadablePin(int pin) {
  return pin >= 0 && pin <= maxGpioPin() && !isFlashPin(pin) && !isUart0Pin(pin) && !isStrapPin(pin) && !isUsbPin(pin);
}

bool isWritablePin(int pin) {
  return isReadablePin(pin) && !isInputOnlyPin(pin);
}

void ensureI2c() {
  if (!i2cStarted) {
    Wire.begin(i2cSda, i2cScl);
    Wire.setClock(i2cFrequency);
    i2cStarted = true;
  }
}

void ensureSpi() {
  if (!spiStarted) {
    pinMode(spiCs, OUTPUT);
    digitalWrite(spiCs, HIGH);
    SPI.begin(spiSck, spiMiso, spiMosi, spiCs);
    spiStarted = true;
  }
}

void sendLine(const JsonDocument& document) {
  serializeJson(document, Serial);
  Serial.write('\n');
}

void sendError(const char* id, const char* code, const char* message) {
  JsonDocument document;
  document["v"] = protocolVersion;
  document["id"] = id;
  document["ok"] = false;
  JsonObject error = document["error"].to<JsonObject>();
  error["code"] = code;
  error["message"] = message;
  sendLine(document);
}

void sendSuccess(const char* id, const JsonDocument& result) {
  JsonDocument document;
  document["v"] = protocolVersion;
  document["id"] = id;
  document["ok"] = true;
  document["result"] = result;
  sendLine(document);
}

void sendEvent(const char* event, const JsonDocument& payload) {
  JsonDocument document;
  document["v"] = protocolVersion;
  document["event"] = event;
  document["payload"] = payload;
  sendLine(document);
}

void emitGpioChanged(int pin, bool value) {
  JsonDocument payload;
  payload["pin"] = pin;
  payload["value"] = value;
  sendEvent("gpio.changed", payload);
}

void fillIdentity(JsonObject payload) {
  #if defined(PINOUT_ESP32_C3)
  payload["boardId"] = "esp32-c3-supermini";
#else
  payload["boardId"] = "esp32-devkit-v1";
#endif
  payload["firmware"] = firmwareName;
  payload["version"] = firmwareVersion;
  payload["protocol"] = protocolVersion;
  JsonArray capabilities = payload["capabilities"].to<JsonArray>();
  capabilities.add("sys.hello");
  capabilities.add("sys.ping");
  capabilities.add("sys.info");
  capabilities.add("sys.arm");
  capabilities.add("sys.disarm");
  capabilities.add("watchdog.configure");
  capabilities.add("watchdog.kick");
  capabilities.add("gpio.mode");
  capabilities.add("gpio.configSafeState");
  capabilities.add("gpio.write");
  capabilities.add("gpio.batchWrite");
  capabilities.add("gpio.stopAll");
  capabilities.add("gpio.read");
  capabilities.add("gpio.toggle");
  capabilities.add("gpio.pulse");
  capabilities.add("gpio.pwm");
  capabilities.add("gpio.analogRead");
  capabilities.add("gpio.watch");
  capabilities.add("gpio.unwatch");
  capabilities.add("i2c.begin");
  capabilities.add("i2c.write");
  capabilities.add("i2c.read");
  capabilities.add("i2c.scan");
  capabilities.add("spi.begin");
  capabilities.add("spi.transfer");
  capabilities.add("gpio.servo");
  capabilities.add("gpio.motor");

  JsonArray features = payload["features"].to<JsonArray>();
  features.add("watchdog");
  features.add("arming");
  features.add("safe-state");
  features.add("command-validity");
}

void sendReady() {
  JsonDocument document;
  document["v"] = protocolVersion;
  document["event"] = "ready";
  fillIdentity(document["payload"].to<JsonObject>());
  sendLine(document);
}

void touchWatchdog() {
  if (deviceState == STATE_ARMED && watchdogEnabled && watchdogTimeoutMs > 0) {
    watchdogDeadline = millis() + watchdogTimeoutMs;
  }
}

void applySafeState(JsonArray* stoppedPins = nullptr) {
  for (int pin = 0; pin <= maxGpioPin(); pin++) {
    if (activeOutputs[pin] || pinSafeConfigs[pin].configured) {
      const SafeLevel level = pinSafeConfigs[pin].safeLevel;
      if (level == SAFE_LEVEL_HIGH) {
        pinMode(pin, OUTPUT);
        digitalWrite(pin, HIGH);
        activeOutputs[pin] = true;
      } else if (level == SAFE_LEVEL_HIGH_Z) {
        pinMode(pin, INPUT);
        activeOutputs[pin] = false;
      } else if (level == SAFE_LEVEL_HOLD) {
        // Keep current output level
      } else {
        // SAFE_LEVEL_LOW (default)
        pinMode(pin, OUTPUT);
        digitalWrite(pin, LOW);
        activeOutputs[pin] = false;
      }
      if (stoppedPins) {
        stoppedPins->add(pin);
      }
    }
  }
  for (int channel = 0; channel < 16; channel++) {
    ledcWrite(channel, 0);
    if (activePwmPins[channel] >= 0) {
      ledcDetachPin(activePwmPins[channel]);
      activePwmPins[channel] = -1;
    }
  }
  for (size_t i = 0; i < 8; i++) {
    pulses[i].active = false;
  }
}

void tripWatchdog(const char* reason = "WATCHDOG_EXPIRED") {
  deviceState = STATE_TRIPPED;
  tripReason = reason;
  JsonDocument eventDoc;
  JsonObject eventPayload = eventDoc.to<JsonObject>();
  eventPayload["reason"] = reason;
  eventPayload["message"] = "Watchdog timeout elapsed without heartbeat.";
  JsonArray stopped = eventPayload["stoppedPins"].to<JsonArray>();
  applySafeState(&stopped);
  sendEvent("device.tripped", eventDoc);
}

void checkWatchdog() {
  if (deviceState == STATE_ARMED && watchdogEnabled && watchdogTimeoutMs > 0) {
    if (static_cast<long>(millis() - watchdogDeadline) >= 0) {
      tripWatchdog("WATCHDOG_EXPIRED");
    }
  }
}

void handleHello(const char* id) {
  JsonDocument result;
  fillIdentity(result.to<JsonObject>());
  sendSuccess(id, result);
}

void handlePing(const char* id) {
  JsonDocument result;
  result["pong"] = true;
  sendSuccess(id, result);
}

void handleInfo(const char* id) {
  JsonDocument result;
  result["uptimeMs"] = millis() - bootMillis;
  result["freeHeap"] = ESP.getFreeHeap();
  sendSuccess(id, result);
}

void handleArm(const char* id, const JsonVariantConst& payload) {
  if (payload.is<JsonObjectConst>() && payload["timeoutMs"].is<int>()) {
    const int timeout = payload["timeoutMs"].as<int>();
    if (timeout < 0) {
      sendError(id, "INVALID_PAYLOAD", "timeoutMs must be non-negative.");
      return;
    }
    watchdogTimeoutMs = static_cast<unsigned long>(timeout);
    watchdogEnabled = timeout > 0;
  }
  deviceState = STATE_ARMED;
  tripReason = nullptr;
  touchWatchdog();
  JsonDocument result;
  result["armed"] = true;
  result["state"] = "armed";
  result["timeoutMs"] = watchdogTimeoutMs;
  sendSuccess(id, result);
}

void handleDisarm(const char* id) {
  deviceState = STATE_DISARMED;
  tripReason = nullptr;
  applySafeState();
  JsonDocument result;
  result["armed"] = false;
  result["state"] = "disarmed";
  sendSuccess(id, result);
}

void handleWatchdogConfigure(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["timeoutMs"].is<int>()) {
    sendError(id, "INVALID_PAYLOAD", "watchdog.configure requires integer timeoutMs.");
    return;
  }
  const int timeout = payload["timeoutMs"].as<int>();
  if (timeout < 0) {
    sendError(id, "INVALID_PAYLOAD", "timeoutMs must be non-negative.");
    return;
  }
  watchdogTimeoutMs = static_cast<unsigned long>(timeout);
  watchdogEnabled = timeout > 0;
  if (deviceState == STATE_ARMED) {
    touchWatchdog();
  }
  JsonDocument result;
  result["timeoutMs"] = watchdogTimeoutMs;
  result["enabled"] = watchdogEnabled;
  sendSuccess(id, result);
}

void handleWatchdogKick(const char* id, const JsonVariantConst& payload) {
  if (payload.is<JsonObjectConst>() && payload["validityMs"].is<int>()) {
    if (payload["validityMs"].as<int>() <= 0) {
      sendError(id, "COMMAND_EXPIRED", "Command validity window expired.");
      return;
    }
  }
  if (deviceState != STATE_ARMED) {
    sendError(id, deviceState == STATE_TRIPPED ? "WATCHDOG_TRIPPED" : "NOT_ARMED", "Explicitly arm before heartbeat.");
    return;
  }
  touchWatchdog();
  JsonDocument result;
  result["kicked"] = true;
  result["timeoutMs"] = watchdogTimeoutMs;
  sendSuccess(id, result);
}

void handleConfigSafeState(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["pin"].is<int>()) {
    sendError(id, "INVALID_PAYLOAD", "gpio.configSafeState requires integer pin.");
    return;
  }
  const int pin = payload["pin"].as<int>();
  if (!isWritablePin(pin)) {
    sendError(id, "INVALID_PIN", "Pin is not a valid ESP32 output GPIO.");
    return;
  }
  SafeLevel safeLevel = SAFE_LEVEL_LOW;
  Polarity polarity = POLARITY_ACTIVE_HIGH;
  if (payload["safeLevel"].is<const char*>()) {
    const char* lvl = payload["safeLevel"].as<const char*>();
    if (strcmp(lvl, "low") == 0) safeLevel = SAFE_LEVEL_LOW;
    else if (strcmp(lvl, "high") == 0) safeLevel = SAFE_LEVEL_HIGH;
    else if (strcmp(lvl, "high-z") == 0) safeLevel = SAFE_LEVEL_HIGH_Z;
    else if (strcmp(lvl, "hold") == 0) safeLevel = SAFE_LEVEL_HOLD;
    else {
      sendError(id, "INVALID_PAYLOAD", "safeLevel must be low, high, high-z, or hold.");
      return;
    }
  }
  if (payload["polarity"].is<const char*>()) {
    const char* pol = payload["polarity"].as<const char*>();
    if (strcmp(pol, "active-high") == 0) polarity = POLARITY_ACTIVE_HIGH;
    else if (strcmp(pol, "active-low") == 0) polarity = POLARITY_ACTIVE_LOW;
    else {
      sendError(id, "INVALID_PAYLOAD", "polarity must be active-high or active-low.");
      return;
    }
  }
  pinSafeConfigs[pin].safeLevel = safeLevel;
  pinSafeConfigs[pin].polarity = polarity;
  pinSafeConfigs[pin].configured = true;

  JsonDocument result;
  result["pin"] = pin;
  result["safeLevel"] = safeLevel == SAFE_LEVEL_HIGH ? "high" : safeLevel == SAFE_LEVEL_HIGH_Z ? "high-z" : safeLevel == SAFE_LEVEL_HOLD ? "hold" : "low";
  result["polarity"] = polarity == POLARITY_ACTIVE_LOW ? "active-low" : "active-high";
  sendSuccess(id, result);
}

bool checkActuationPrerequisites(const char* id, const JsonVariantConst& payload) {
  if (payload.is<JsonObjectConst>() && payload["validityMs"].is<int>()) {
    if (payload["validityMs"].as<int>() <= 0) {
      sendError(id, "COMMAND_EXPIRED", "Command validity window expired.");
      return false;
    }
  }
  if (deviceState == STATE_DISARMED) {
    sendError(id, "NOT_ARMED", "Device is disarmed. Explicit arming (sys.arm) is required before actuation.");
    return false;
  }
  if (deviceState == STATE_TRIPPED) {
    sendError(id, "WATCHDOG_TRIPPED", "Watchdog tripped (WATCHDOG_EXPIRED). Explicit re-arming (sys.arm) is required.");
    return false;
  }
  touchWatchdog();
  return true;
}

void applyPinMode(int pin, const char* mode) {
  if (strcmp(mode, "output") == 0) {
    pinMode(pin, OUTPUT);
  } else if (strcmp(mode, "pullup") == 0) {
    pinMode(pin, INPUT_PULLUP);
  } else if (strcmp(mode, "pulldown") == 0) {
    pinMode(pin, INPUT_PULLDOWN);
  } else {
    pinMode(pin, INPUT);
  }
}

void handleGpioMode(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["pin"].is<int>() || !payload["mode"].is<const char*>()) {
    sendError(id, "INVALID_PAYLOAD", "gpio.mode requires integer pin and mode string.");
    return;
  }
  const int pin = payload["pin"].as<int>();
  const char* mode = payload["mode"];
  if (!isReadablePin(pin) || (strcmp(mode, "output") == 0 && !isWritablePin(pin))) {
    sendError(id, "INVALID_PIN", "Pin is not a valid ESP32 GPIO for this mode.");
    return;
  }
  if (strcmp(mode,"input") && strcmp(mode,"output") && strcmp(mode,"pullup") && strcmp(mode,"pulldown")) {
    sendError(id,"INVALID_PAYLOAD","Unknown GPIO mode."); return;
  }
  if (payload["safeLevel"].is<const char*>()) {
    const char* level=payload["safeLevel"];
    if (strcmp(level,"low") && strcmp(level,"high") && strcmp(level,"high-z") && strcmp(level,"hold")) { sendError(id,"INVALID_PAYLOAD","Invalid safe level."); return; }
  }
  if (payload["polarity"].is<const char*>()) {
    const char* pol=payload["polarity"];
    if (strcmp(pol,"active-high") && strcmp(pol,"active-low")) { sendError(id,"INVALID_PAYLOAD","Invalid polarity."); return; }
  }

  if (payload["safeLevel"].is<const char*>()) {
    const char* lvl = payload["safeLevel"].as<const char*>();
    if (strcmp(lvl, "low") == 0) pinSafeConfigs[pin].safeLevel = SAFE_LEVEL_LOW;
    else if (strcmp(lvl, "high") == 0) pinSafeConfigs[pin].safeLevel = SAFE_LEVEL_HIGH;
    else if (strcmp(lvl, "high-z") == 0) pinSafeConfigs[pin].safeLevel = SAFE_LEVEL_HIGH_Z;
    else if (strcmp(lvl, "hold") == 0) pinSafeConfigs[pin].safeLevel = SAFE_LEVEL_HOLD;
    else {
      sendError(id, "INVALID_PAYLOAD", "safeLevel must be low, high, high-z, or hold.");
      return;
    }
    pinSafeConfigs[pin].configured = true;
  }
  if (payload["polarity"].is<const char*>()) {
    const char* pol = payload["polarity"].as<const char*>();
    if (strcmp(pol, "active-high") == 0) pinSafeConfigs[pin].polarity = POLARITY_ACTIVE_HIGH;
    else if (strcmp(pol, "active-low") == 0) pinSafeConfigs[pin].polarity = POLARITY_ACTIVE_LOW;
    else {
      sendError(id, "INVALID_PAYLOAD", "polarity must be active-high or active-low.");
      return;
    }
    pinSafeConfigs[pin].configured = true;
  }

  JsonDocument result;
  result["pin"] = pin;
  cancelPulseForPin(pin);
  if (strcmp(mode,"output") == 0) digitalWrite(pin, pinSafeConfigs[pin].safeLevel == SAFE_LEVEL_HIGH ? HIGH : LOW);
  applyPinMode(pin, mode);
  activeOutputs[pin] = strcmp(mode,"input") != 0;
  result["mode"] = mode;
  sendSuccess(id, result);
}

void handleGpioWrite(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["pin"].is<int>() || !payload["value"].is<bool>()) {
    sendError(id, "INVALID_PAYLOAD", "gpio.write requires integer pin and boolean value.");
    return;
  }
  const int pin = payload["pin"].as<int>();
  const bool value = payload["value"].as<bool>();
  if (!isWritablePin(pin)) {
    sendError(id, "INVALID_PIN", "Pin is not a valid ESP32 output GPIO.");
    return;
  }
  digitalWrite(pin, value ? HIGH : LOW);
  pinMode(pin, OUTPUT);
  cancelPulseForPin(pin);
  activeOutputs[pin] = true;
  JsonDocument result;
  result["pin"] = pin;
  result["value"] = value;
  sendSuccess(id, result);
}

void handleGpioBatchWrite(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["writes"].is<JsonArrayConst>()) {
    sendError(id, "INVALID_PAYLOAD", "gpio.batchWrite requires a writes array.");
    return;
  }
  JsonArrayConst writes = payload["writes"].as<JsonArrayConst>();
  if (writes.size() < 1 || writes.size() > 16) {
    sendError(id, "INVALID_PAYLOAD", "gpio.batchWrite requires 1–16 writes.");
    return;
  }
  // Validate the complete batch before touching hardware.
  for (JsonObjectConst write : writes) {
    if (!write["pin"].is<int>() || !write["value"].is<bool>()) {
      sendError(id, "INVALID_PAYLOAD", "Each batch write requires integer pin and boolean value.");
      return;
    }
    if (!isWritablePin(write["pin"].as<int>())) {
      sendError(id, "INVALID_PIN", "Batch contains a pin that cannot be driven.");
      return;
    }
  }
  JsonDocument result;
  JsonArray applied = result["writes"].to<JsonArray>();
  for (JsonObjectConst write : writes) {
    const int pin = write["pin"].as<int>();
    const bool value = write["value"].as<bool>();
    cancelPulseForPin(pin);
    pinMode(pin, OUTPUT);
    activeOutputs[pin] = true;
    digitalWrite(pin, value ? HIGH : LOW);
    JsonObject item = applied.add<JsonObject>();
    item["pin"] = pin;
    item["value"] = value;
  }
  sendSuccess(id, result);
}

void handleGpioStopAll(const char* id) {
  JsonDocument result;
  JsonArray stopped = result["stoppedPins"].to<JsonArray>();
  applySafeState(&stopped);
  sendSuccess(id, result);
}

void handleGpioRead(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["pin"].is<int>()) {
    sendError(id, "INVALID_PAYLOAD", "gpio.read requires integer pin.");
    return;
  }
  const int pin = payload["pin"].as<int>();
  if (!isReadablePin(pin)) {
    sendError(id, "INVALID_PIN", "Pin is not a valid ESP32 GPIO.");
    return;
  }
  JsonDocument result;
  result["pin"] = pin;
  result["value"] = digitalRead(pin) == HIGH;
  sendSuccess(id, result);
}

void handleGpioToggle(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["pin"].is<int>()) {
    sendError(id, "INVALID_PAYLOAD", "gpio.toggle requires integer pin.");
    return;
  }
  const int pin = payload["pin"].as<int>();
  if (!isWritablePin(pin)) {
    sendError(id, "INVALID_PIN", "Pin is not a valid ESP32 output GPIO.");
    return;
  }
  pinMode(pin, OUTPUT);
  cancelPulseForPin(pin);
  activeOutputs[pin] = true;
  const bool value = digitalRead(pin) != HIGH;
  digitalWrite(pin, value ? HIGH : LOW);
  JsonDocument result;
  result["pin"] = pin;
  result["value"] = value;
  sendSuccess(id, result);
}

void handleGpioPulse(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["pin"].is<int>() || !payload["value"].is<bool>() ||
      !payload["durationMs"].is<int>()) {
    sendError(id, "INVALID_PAYLOAD", "gpio.pulse requires pin, value, and durationMs.");
    return;
  }
  const int pin = payload["pin"].as<int>();
  const bool value = payload["value"].as<bool>();
  const int durationMs = payload["durationMs"].as<int>();
  if (durationMs <= 0 || !isWritablePin(pin)) {
    sendError(id, "INVALID_PIN", "Pin is not a valid ESP32 output GPIO.");
    return;
  }
  size_t slot = 8;
  for (size_t i = 0; i < 8; i++) {
    if (pulses[i].active && pulses[i].pin == pin) { slot = i; break; }
    if (!pulses[i].active && slot == 8) slot = i;
  }
  if (slot == 8) {
    sendError(id, "BUSY", "Pulse queue is full.");
    return;
  }
  const bool previousValue = pulses[slot].active
    ? pulses[slot].previousValue
    : digitalRead(pin) == HIGH;
  pinMode(pin, OUTPUT);
  activeOutputs[pin] = true;
  digitalWrite(pin, value ? HIGH : LOW);
  pulses[slot].pin = pin;
  pulses[slot].until = millis() + static_cast<unsigned long>(durationMs);
  pulses[slot].previousValue = previousValue;
  pulses[slot].active = true;
  JsonDocument result;
  result["pin"] = pin;
  result["value"] = value;
  result["durationMs"] = durationMs;
  result["previousValue"] = previousValue;
  sendSuccess(id, result);
}

void pollPulses() {
  const unsigned long now = millis();
  for (size_t i = 0; i < 8; i++) {
    if (pulses[i].active && static_cast<long>(now - pulses[i].until) >= 0) {
      digitalWrite(pulses[i].pin, pulses[i].previousValue ? HIGH : LOW);
      pulses[i].active = false;
    }
  }
}

void handleGpioPwm(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["pin"].is<int>() || !payload["duty"].is<float>() ||
      !payload["channel"].is<int>() || !payload["frequency"].is<int>()) {
    sendError(id, "INVALID_PAYLOAD", "gpio.pwm requires pin, channel, duty, and frequency.");
    return;
  }
  const int pin = payload["pin"].as<int>();
  const int channel = payload["channel"].as<int>();
  const float duty = payload["duty"].as<float>();
  const int frequency = payload["frequency"].as<int>();
  if (!isWritablePin(pin) || channel < 0 || channel >=
#if defined(PINOUT_ESP32_C3)
      6
#else
      16
#endif
      || duty < 0 || duty > 1 || frequency <= 0) {
    sendError(id, "INVALID_PIN", "Invalid PWM pin or parameters.");
    return;
  }
  ledcSetup(channel, frequency, 8);
  cancelPulseForPin(pin);
  activeOutputs[pin] = true;
  if (activePwmPins[channel] >= 0 && activePwmPins[channel] != pin) {
    ledcDetachPin(activePwmPins[channel]);
  }
  ledcAttachPin(pin, channel);
  activePwmPins[channel] = pin;
  ledcWrite(channel, static_cast<uint32_t>(duty * 255));
  JsonDocument result;
  result["pin"] = pin;
  result["channel"] = channel;
  result["duty"] = duty;
  result["frequency"] = frequency;
  sendSuccess(id, result);
}

void handleGpioAnalogRead(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["pin"].is<int>()) {
    sendError(id, "INVALID_PAYLOAD", "gpio.analogRead requires integer pin.");
    return;
  }
  const int pin = payload["pin"].as<int>();
  if (!isAdcPin(pin) || !isReadablePin(pin)) {
    sendError(id, "INVALID_PIN", "Pin is not a valid ESP32 ADC GPIO.");
    return;
  }
  JsonDocument result;
  result["pin"] = pin;
  result["value"] = analogRead(pin);
  sendSuccess(id, result);
}

void handleGpioWatch(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["pin"].is<int>()) {
    sendError(id, "INVALID_PAYLOAD", "gpio.watch requires integer pin.");
    return;
  }
  const int pin = payload["pin"].as<int>();
  if (!isReadablePin(pin)) {
    sendError(id, "INVALID_PIN", "Pin is not a valid ESP32 GPIO.");
    return;
  }
  for (size_t i = 0; i < watchCount; i++) {
    if (watches[i].active && watches[i].pin == pin) {
      JsonDocument result;
      result["pin"] = pin;
      result["watching"] = true;
      sendSuccess(id, result);
      return;
    }
  }
  size_t slot = watchCount;
  for (size_t i = 0; i < watchCount; i++) {
    if (!watches[i].active) { slot = i; break; }
  }
  if (slot >= 8) {
    sendError(id, "WATCH_TABLE_FULL", "No watch slots are available.");
    return;
  }
  watches[slot].pin = pin;
  watches[slot].lastValue = digitalRead(pin) == HIGH;
  watches[slot].active = true;
  if (slot == watchCount) watchCount++;
  JsonDocument result;
  result["pin"] = pin;
  result["watching"] = true;
  sendSuccess(id, result);
}

void handleGpioUnwatch(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["pin"].is<int>()) {
    sendError(id, "INVALID_PAYLOAD", "gpio.unwatch requires integer pin.");
    return;
  }
  const int pin = payload["pin"].as<int>();
  for (size_t i = 0; i < watchCount; i++) {
    if (watches[i].pin == pin) {
      watches[i].active = false;
    }
  }
  JsonDocument result;
  result["pin"] = pin;
  result["watching"] = false;
  sendSuccess(id, result);
}

void handleI2cBegin(const char* id, const JsonVariantConst& payload) {
  if (payload.is<JsonObjectConst>()) {
    if (payload["sda"].is<int>()) {
      const int pin = payload["sda"].as<int>();
      if (!isWritablePin(pin)) {
        sendError(id, "INVALID_PIN", "I2C SDA pin is not a valid ESP32 output GPIO.");
        return;
      }
      i2cSda = pin;
    }
    if (payload["scl"].is<int>()) {
      const int pin = payload["scl"].as<int>();
      if (!isWritablePin(pin)) {
        sendError(id, "INVALID_PIN", "I2C SCL pin is not a valid ESP32 output GPIO.");
        return;
      }
      i2cScl = pin;
    }
    if (payload["frequency"].is<int>()) {
      const int frequency = payload["frequency"].as<int>();
      if (frequency <= 0) {
        sendError(id, "INVALID_PAYLOAD", "I2C frequency must be a positive integer.");
        return;
      }
      i2cFrequency = static_cast<uint32_t>(frequency);
    }
  }
  cancelPulseForPin(i2cSda);
  cancelPulseForPin(i2cScl);
  i2cStarted = false;
  ensureI2c();
  JsonDocument result;
  result["sda"] = i2cSda;
  result["scl"] = i2cScl;
  result["frequency"] = i2cFrequency;
  sendSuccess(id, result);
}

void handleI2cWrite(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["address"].is<int>() || !payload["data"].is<JsonArrayConst>()) {
    sendError(id, "INVALID_PAYLOAD", "i2c.write requires address and data array.");
    return;
  }
  const int address = payload["address"].as<int>();
  JsonArrayConst data = payload["data"].as<JsonArrayConst>();
  if (address < 0 || address > 127 || data.size() < 1 || data.size() > maxBusPayloadBytes) {
    sendError(id, "INVALID_PAYLOAD", "I2C address must be 0–127 and data 1–32 bytes.");
    return;
  }
  ensureI2c();
  Wire.beginTransmission(static_cast<uint8_t>(address));
  for (JsonVariantConst byteValue : data) {
    if (!byteValue.is<int>()) {
      sendError(id, "INVALID_PAYLOAD", "I2C data must be integers 0–255.");
      return;
    }
    const int value = byteValue.as<int>();
    if (value < 0 || value > 255) {
      sendError(id, "INVALID_PAYLOAD", "I2C data must be integers 0–255.");
      return;
    }
    Wire.write(static_cast<uint8_t>(value));
  }
  const uint8_t err = Wire.endTransmission();
  if (err != 0) {
    sendError(id, "BUS_ERROR", "I2C write failed (NACK or bus error).");
    return;
  }
  JsonDocument result;
  result["address"] = address;
  result["bytesWritten"] = static_cast<int>(data.size());
  sendSuccess(id, result);
}

void handleI2cRead(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["address"].is<int>() || !payload["length"].is<int>()) {
    sendError(id, "INVALID_PAYLOAD", "i2c.read requires address and length.");
    return;
  }
  const int address = payload["address"].as<int>();
  const int length = payload["length"].as<int>();
  if (address < 0 || address > 127 || length < 1 || length > static_cast<int>(maxBusPayloadBytes)) {
    sendError(id, "INVALID_PAYLOAD", "I2C address must be 0–127 and length 1–32.");
    return;
  }
  ensureI2c();
  const uint8_t received = Wire.requestFrom(static_cast<uint8_t>(address), static_cast<uint8_t>(length));
  JsonDocument result;
  result["address"] = address;
  JsonArray data = result["data"].to<JsonArray>();
  for (size_t i = 0; i < received; i++) {
    data.add(Wire.read());
  }
  while (static_cast<int>(data.size()) < length) {
    data.add(0);
  }
  sendSuccess(id, result);
}

void handleI2cScan(const char* id) {
  ensureI2c();
  JsonDocument result;
  JsonArray addresses = result["addresses"].to<JsonArray>();
  for (int address = 1; address < 127; address++) {
    Wire.beginTransmission(static_cast<uint8_t>(address));
    if (Wire.endTransmission() == 0) {
      addresses.add(address);
    }
  }
  sendSuccess(id, result);
}

void handleSpiBegin(const char* id, const JsonVariantConst& payload) {
  if (payload.is<JsonObjectConst>()) {
    if (payload["sck"].is<int>()) {
      const int pin = payload["sck"].as<int>();
      if (!isWritablePin(pin)) {
        sendError(id, "INVALID_PIN", "SPI SCK pin is not a valid ESP32 output GPIO.");
        return;
      }
      spiSck = pin;
    }
    if (payload["miso"].is<int>()) {
      const int pin = payload["miso"].as<int>();
      if (!isReadablePin(pin)) {
        sendError(id, "INVALID_PIN", "SPI MISO pin is not a valid ESP32 GPIO.");
        return;
      }
      spiMiso = pin;
    }
    if (payload["mosi"].is<int>()) {
      const int pin = payload["mosi"].as<int>();
      if (!isWritablePin(pin)) {
        sendError(id, "INVALID_PIN", "SPI MOSI pin is not a valid ESP32 output GPIO.");
        return;
      }
      spiMosi = pin;
    }
    if (payload["chipSelect"].is<int>()) {
      const int pin = payload["chipSelect"].as<int>();
      if (!isWritablePin(pin)) {
        sendError(id, "INVALID_PIN", "SPI chip-select pin is not a valid ESP32 output GPIO.");
        return;
      }
      spiCs = pin;
    }
    if (payload["frequency"].is<int>()) {
      const int frequency = payload["frequency"].as<int>();
      if (frequency <= 0) {
        sendError(id, "INVALID_PAYLOAD", "SPI frequency must be a positive integer.");
        return;
      }
      spiFrequency = static_cast<uint32_t>(frequency);
    }
  }
  cancelPulseForPin(spiSck);
  cancelPulseForPin(spiMosi);
  cancelPulseForPin(spiCs);
  spiStarted = false;
  ensureSpi();
  JsonDocument result;
  result["sck"] = spiSck;
  result["miso"] = spiMiso;
  result["mosi"] = spiMosi;
  result["chipSelect"] = spiCs;
  result["frequency"] = spiFrequency;
  sendSuccess(id, result);
}

void handleSpiTransfer(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["data"].is<JsonArrayConst>()) {
    sendError(id, "INVALID_PAYLOAD", "spi.transfer requires a data array.");
    return;
  }
  JsonArrayConst data = payload["data"].as<JsonArrayConst>();
  if (data.size() < 1 || data.size() > maxBusPayloadBytes) {
    sendError(id, "INVALID_PAYLOAD", "SPI data must be 1–32 bytes.");
    return;
  }
  int chipSelect = spiCs;
  if (payload["chipSelect"].is<int>()) {
    chipSelect = payload["chipSelect"].as<int>();
    if (!isWritablePin(chipSelect)) {
      sendError(id, "INVALID_PIN", "SPI chip-select pin is not a valid ESP32 output GPIO.");
      return;
    }
  }
  ensureSpi();
  pinMode(chipSelect, OUTPUT);
  SPI.beginTransaction(SPISettings(spiFrequency, MSBFIRST, SPI_MODE0));
  digitalWrite(chipSelect, LOW);
  JsonDocument result;
  result["chipSelect"] = chipSelect;
  JsonArray response = result["data"].to<JsonArray>();
  for (JsonVariantConst byteValue : data) {
    if (!byteValue.is<int>()) {
      digitalWrite(chipSelect, HIGH);
      SPI.endTransaction();
      sendError(id, "INVALID_PAYLOAD", "SPI data must be integers 0–255.");
      return;
    }
    const int value = byteValue.as<int>();
    if (value < 0 || value > 255) {
      digitalWrite(chipSelect, HIGH);
      SPI.endTransaction();
      sendError(id, "INVALID_PAYLOAD", "SPI data must be integers 0–255.");
      return;
    }
    response.add(SPI.transfer(static_cast<uint8_t>(value)));
  }
  digitalWrite(chipSelect, HIGH);
  SPI.endTransaction();
  sendSuccess(id, result);
}

void handleGpioServo(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["pin"].is<int>() ||
      !(payload["angle"].is<int>() || payload["angle"].is<float>())) {
    sendError(id, "INVALID_PAYLOAD", "gpio.servo requires pin and angle.");
    return;
  }
  const int pin = payload["pin"].as<int>();
  const float angle = payload["angle"].as<float>();
  if (!isWritablePin(pin)) {
    sendError(id, "INVALID_PIN", "Pin is not a valid ESP32 output GPIO.");
    return;
  }
  if (angle < 0 || angle > 180) {
    sendError(id, "INVALID_PAYLOAD", "Servo angle must be between 0 and 180.");
    return;
  }
  const int channel = 8 + (pin % 8);
  cancelPulseForPin(pin);
  ledcSetup(channel, 50, 16);
  activeOutputs[pin] = true;
  if (activePwmPins[channel] >= 0 && activePwmPins[channel] != pin) {
    ledcDetachPin(activePwmPins[channel]);
  }
  ledcAttachPin(pin, channel);
  activePwmPins[channel] = pin;
  const uint32_t pulseUs = 1000 + static_cast<uint32_t>((angle / 180.0f) * 1000.0f);
  ledcWrite(channel, pulseUs * 65535UL / 20000UL);
  JsonDocument result;
  result["pin"] = pin;
  result["angle"] = angle;
  sendSuccess(id, result);
}

void handleGpioMotor(const char* id, const JsonVariantConst& payload) {
  if (!payload.is<JsonObjectConst>() || !payload["pwmPin"].is<int>() ||
      !(payload["speed"].is<int>() || payload["speed"].is<float>())) {
    sendError(id, "INVALID_PAYLOAD", "gpio.motor requires pwmPin and speed.");
    return;
  }
  const int pwmPin = payload["pwmPin"].as<int>();
  const float speed = payload["speed"].as<float>();
  if (!isWritablePin(pwmPin)) {
    sendError(id, "INVALID_PIN", "PWM pin is not a valid ESP32 output GPIO.");
    return;
  }
  int dirPin = -1;
  if (payload["dirPin"].is<int>()) {
    dirPin = payload["dirPin"].as<int>();
    if (!isWritablePin(dirPin)) {
      sendError(id, "INVALID_PIN", "Direction pin is not a valid ESP32 output GPIO.");
      return;
    }
  }
  if (dirPin < 0 && (speed < 0 || speed > 1)) {
    sendError(id, "INVALID_PAYLOAD", "Motor speed must be between 0 and 1 unless a direction pin is provided.");
    return;
  }
  if (dirPin >= 0 && (speed < -1 || speed > 1)) {
    sendError(id, "INVALID_PAYLOAD", "Motor speed must be between -1 and 1 when a direction pin is set.");
    return;
  }
  const int channel = pwmPin % 8;
  const float duty = speed < 0 ? -speed : speed;
  cancelPulseForPin(pwmPin);
  if (dirPin >= 0) {
    cancelPulseForPin(dirPin);
  }
  ledcSetup(channel, 1000, 8);
  activeOutputs[pwmPin] = true;
  if (activePwmPins[channel] >= 0 && activePwmPins[channel] != pwmPin) {
    ledcDetachPin(activePwmPins[channel]);
  }
  ledcAttachPin(pwmPin, channel);
  activePwmPins[channel] = pwmPin;
  ledcWrite(channel, static_cast<uint32_t>(duty * 255));
  if (dirPin >= 0) {
    pinMode(dirPin, OUTPUT);
    activeOutputs[dirPin] = true;
    digitalWrite(dirPin, speed >= 0 ? HIGH : LOW);
  }
  JsonDocument result;
  result["pwmPin"] = pwmPin;
  result["speed"] = speed;
  if (dirPin >= 0) {
    result["dirPin"] = dirPin;
  }
  sendSuccess(id, result);
}

void pollWatches() {
  for (size_t i = 0; i < watchCount; i++) {
    if (!watches[i].active || watches[i].pin < 0) {
      continue;
    }
    const bool value = digitalRead(watches[i].pin) == HIGH;
    if (value != watches[i].lastValue) {
      watches[i].lastValue = value;
      emitGpioChanged(watches[i].pin, value);
    }
  }
}

void handleRequest(JsonDocument& document) {
  if (!document["id"].is<const char*>() || !document["action"].is<const char*>()) {
    sendError("invalid", "INVALID_MESSAGE", "Request must include string id and action.");
    return;
  }

  const char* id = document["id"];
  const char* action = document["action"];
  const JsonVariantConst payload = document["payload"];

  if (strcmp(action, "sys.hello") == 0) {
    handleHello(id);
    return;
  }
  if (strcmp(action, "sys.ping") == 0) {
    handlePing(id);
    return;
  }
  if (strcmp(action, "sys.info") == 0) {
    handleInfo(id);
    return;
  }
  if (strcmp(action, "sys.arm") == 0) {
    handleArm(id, payload);
    return;
  }
  if (strcmp(action, "sys.disarm") == 0) {
    handleDisarm(id);
    return;
  }
  if (strcmp(action, "watchdog.configure") == 0) {
    handleWatchdogConfigure(id, payload);
    return;
  }
  if (strcmp(action, "watchdog.kick") == 0) {
    handleWatchdogKick(id, payload);
    return;
  }
  if (strcmp(action, "gpio.configSafeState") == 0) {
    handleConfigSafeState(id, payload);
    return;
  }
  if (strcmp(action, "gpio.mode") == 0) {
    if (!checkActuationPrerequisites(id, payload)) return;
    handleGpioMode(id, payload);
    return;
  }
  if (strcmp(action, "gpio.stopAll") == 0) {
    handleGpioStopAll(id);
    return;
  }
  if (strcmp(action, "gpio.read") == 0) {
    handleGpioRead(id, payload);
    return;
  }
  if (strcmp(action, "gpio.analogRead") == 0) {
    handleGpioAnalogRead(id, payload);
    return;
  }
  if (strcmp(action, "gpio.watch") == 0) {
    handleGpioWatch(id, payload);
    return;
  }
  if (strcmp(action, "gpio.unwatch") == 0) {
    handleGpioUnwatch(id, payload);
    return;
  }
  if (strcmp(action, "i2c.begin") == 0) {
    handleI2cBegin(id, payload);
    return;
  }
  if (strcmp(action, "i2c.read") == 0) {
    handleI2cRead(id, payload);
    return;
  }
  if (strcmp(action, "i2c.scan") == 0) {
    handleI2cScan(id);
    return;
  }
  if (strcmp(action, "spi.begin") == 0) {
    handleSpiBegin(id, payload);
    return;
  }

  // Actuation actions require arming and validity check
  if (strcmp(action, "gpio.write") == 0) {
    if (!checkActuationPrerequisites(id, payload)) return;
    handleGpioWrite(id, payload);
    return;
  }
  if (strcmp(action, "gpio.batchWrite") == 0) {
    if (!checkActuationPrerequisites(id, payload)) return;
    handleGpioBatchWrite(id, payload);
    return;
  }
  if (strcmp(action, "gpio.toggle") == 0) {
    if (!checkActuationPrerequisites(id, payload)) return;
    handleGpioToggle(id, payload);
    return;
  }
  if (strcmp(action, "gpio.pulse") == 0) {
    if (!checkActuationPrerequisites(id, payload)) return;
    handleGpioPulse(id, payload);
    return;
  }
  if (strcmp(action, "gpio.pwm") == 0) {
    if (!checkActuationPrerequisites(id, payload)) return;
    handleGpioPwm(id, payload);
    return;
  }
  if (strcmp(action, "i2c.write") == 0) {
    if (!checkActuationPrerequisites(id, payload)) return;
    handleI2cWrite(id, payload);
    return;
  }
  if (strcmp(action, "spi.transfer") == 0) {
    if (!checkActuationPrerequisites(id, payload)) return;
    handleSpiTransfer(id, payload);
    return;
  }
  if (strcmp(action, "gpio.servo") == 0) {
    if (!checkActuationPrerequisites(id, payload)) return;
    handleGpioServo(id, payload);
    return;
  }
  if (strcmp(action, "gpio.motor") == 0) {
    if (!checkActuationPrerequisites(id, payload)) return;
    handleGpioMotor(id, payload);
    return;
  }

  sendError(id, "UNKNOWN_ACTION", "Unknown action.");
}

void handleLine(char* line) {
  while (*line == ' ' || *line == '\r') {
    line++;
  }
  if (line[0] != '{') {
    return;
  }

  JsonDocument document;
  const DeserializationError error = deserializeJson(document, line);
  if (error) {
    sendError("invalid", "INVALID_JSON", "Request is not valid JSON.");
    return;
  }

  if (document["v"].as<int>() != protocolVersion) {
    sendError("invalid", "INVALID_MESSAGE", "Unsupported protocol version.");
    return;
  }

  handleRequest(document);
}

void setup() {
  Serial.setRxBufferSize(2048);
  Serial.begin(baudRate);
  bootMillis = millis();
  // Native USB Serial/JTAG boards (such as the ESP32-C3 SuperMini) can boot
  // before macOS has opened the USB endpoint. Wait briefly so `ready` is not
  // lost before the host begins the Pinout handshake. Hardware UARTs report
  // ready immediately and are unaffected.
  const unsigned long usbHostWaitDeadline = millis() + 3000;
  while (!Serial && millis() < usbHostWaitDeadline) {
    delay(10);
  }
  while (Serial.available() > 0) {
    Serial.read();
  }
  sendReady();
}

void loop() {
  checkWatchdog();
  pollWatches();
  pollPulses();
  while (Serial.available() > 0) {
    checkWatchdog();
    const char next = static_cast<char>(Serial.read());
    if (next == '\n') {
      lineBuffer[lineLength] = '\0';
      lineLength = 0;
      if (!lineOverflow) handleLine(lineBuffer);
      lineOverflow = false;
      checkWatchdog();
      continue;
    }
    if (lineOverflow) continue;
    if (lineLength >= lineMax - 1) {
      lineOverflow = true;
      lineLength = 0;
      sendError("invalid", "INVALID_MESSAGE", "Request line is too long.");
      continue;
    }
    if (next != '\r') {
      lineBuffer[lineLength++] = next;
    }
  }
}
