#pragma once

// ESP32-C3 SuperMini (native USB Serial/JTAG) on the DevKitM-1 build target.
// Existing opt-in experimental target: the predicates below keep the pin
// classes of the pre-variant bridge (matching firmware/boards/
// esp32-c3-supermini.json).

namespace board {
constexpr const char* boardId = "esp32-c3-supermini";
constexpr int maxGpioPin = 21;
constexpr int pwmChannels = 6;
constexpr int motorChannels = 3;
constexpr int servoChannelBase = 3;
constexpr int i2cSda = 4;
constexpr int i2cScl = 5;
constexpr int spiSck = 4;
constexpr int spiMiso = 5;
constexpr int spiMosi = 6;
constexpr int spiCs = 7;

inline bool isFlashPin(int pin) { return pin >= 11 && pin <= 17; }
inline bool isInputOnlyPin(int) { return false; }
inline bool isUart0Pin(int pin) { return pin == 20 || pin == 21; }
inline bool isStrapPin(int pin) { return pin == 2 || pin == 8 || pin == 9; }
inline bool isAdcPin(int pin) { return pin >= 0 && pin <= 4; }
inline bool isUsbPin(int pin) { return pin == 18 || pin == 19; }
inline bool isReservedPin(int) { return false; }
}  // namespace board
