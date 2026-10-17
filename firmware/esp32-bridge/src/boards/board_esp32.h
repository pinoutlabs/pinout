#pragma once

// Classic ESP32 DevKit (WROOM-32, 30-pin). Alpha reference target.
//
// This header keeps the pre-variant bridge behavior byte-compatible: the
// predicates below are the same pin classes main.cpp used before variant
// support was added. Do not extend the usable range here without a hardware
// record (firmware/boards/esp32-devkit-v1.json).

namespace board {
constexpr const char* boardId = "esp32-devkit-v1";
constexpr int maxGpioPin = 39;
constexpr int pwmChannels = 16;
constexpr int motorChannels = 8;
constexpr int servoChannelBase = 8;
constexpr int i2cSda = 21;
constexpr int i2cScl = 22;
constexpr int spiSck = 18;
constexpr int spiMiso = 19;
constexpr int spiMosi = 23;
constexpr int spiCs = 5;

inline bool isFlashPin(int pin) { return pin >= 6 && pin <= 11; }
inline bool isInputOnlyPin(int pin) { return pin >= 34 && pin <= 39; }
inline bool isUart0Pin(int pin) { return pin == 1 || pin == 3; }
inline bool isStrapPin(int pin) { return pin == 12; }
inline bool isAdcPin(int pin) { return pin >= 32 && pin <= 39; }
inline bool isUsbPin(int) { return false; }
inline bool isReservedPin(int) { return false; }
}  // namespace board
