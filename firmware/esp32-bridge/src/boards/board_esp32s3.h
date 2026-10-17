#pragma once

// ESP32-S3-DevKitC-1 (matching firmware/boards/esp32-s3-devkitc-1.json).
//
// Sources: "ESP32-S3-DevKitC-1 user guide" (Espressif) and the ESP32-S3
// datasheet. Exposed 0-21, 35-48 plus UART0 43/44.
// Reserved: 0/3/45/46 (boot straps), 19/20 (USB-JTAG), 22-25 (not on the
// headers), 26-37 (SPI flash, plus internal flash/PSRAM pins 33-37 that
// octal-PSRAM modules wire internally), 43/44 (UART0).

namespace board {
constexpr const char* boardId = "esp32-s3-devkitc-1";
constexpr int maxGpioPin = 48;
constexpr int pwmChannels = 8;
constexpr int motorChannels = 4;
constexpr int servoChannelBase = 4;
constexpr int i2cSda = 8;
constexpr int i2cScl = 9;
constexpr int spiSck = 12;
constexpr int spiMiso = 13;
constexpr int spiMosi = 11;
constexpr int spiCs = 10;

inline bool isFlashPin(int pin) { return pin >= 26 && pin <= 37; }
inline bool isInputOnlyPin(int) { return false; }
inline bool isUart0Pin(int pin) { return pin == 43 || pin == 44; }
inline bool isStrapPin(int pin) { return pin == 0 || pin == 3 || pin == 45 || pin == 46; }
inline bool isAdcPin(int pin) { return pin >= 1 && pin <= 10; }
inline bool isUsbPin(int pin) { return pin == 19 || pin == 20; }
inline bool isReservedPin(int pin) { return pin >= 22 && pin <= 25; }
}  // namespace board
