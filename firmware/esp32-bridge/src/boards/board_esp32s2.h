#pragma once

// ESP32-S2-DevKitC-1 (matching firmware/boards/esp32-s2-devkitc-1.json).
//
// Sources: "ESP32-S2-DevKitC-1 user guide" (Espressif) and the ESP32-S2
// datasheet. Exposed 0-21, 33-42, 45, 46 plus UART0 43/44.
// Reserved: 0/45 (boot straps), 19/20 (USB OTG), 22-25 (not on the
// headers), 26-32 (flash), 43/44 (UART0). GPIO 46 is input-only, so it stays
// readable but is never driven (isWritablePin excludes it).

namespace board {
constexpr const char* boardId = "esp32-s2-devkitc-1";
constexpr int maxGpioPin = 46;
constexpr int pwmChannels = 8;
constexpr int motorChannels = 4;
constexpr int servoChannelBase = 4;
constexpr int i2cSda = 8;
constexpr int i2cScl = 9;
constexpr int spiSck = 12;
constexpr int spiMiso = 13;
constexpr int spiMosi = 11;
constexpr int spiCs = 10;

inline bool isFlashPin(int pin) { return pin >= 26 && pin <= 32; }
inline bool isInputOnlyPin(int pin) { return pin == 46; }
inline bool isUart0Pin(int pin) { return pin == 43 || pin == 44; }
inline bool isStrapPin(int pin) { return pin == 0 || pin == 45; }
inline bool isAdcPin(int pin) { return pin >= 1 && pin <= 10; }
inline bool isUsbPin(int pin) { return pin == 19 || pin == 20; }
inline bool isReservedPin(int pin) { return pin >= 22 && pin <= 25; }
}  // namespace board
