#pragma once

// ESP32-C6-DevKitC-1 v1.2 (matching firmware/boards/esp32-c6-devkitc-1.json).
// This is the only target that requires Arduino core 3.x, so it is also the
// only target that goes through the LEDC shim in ledc_compat.h.
//
// Sources: "ESP32-C6-DevKitC-1 user guide" (Espressif, v1.2) and the ESP32-C6
// datasheet. Exposed 0-23 plus UART0 16/17.
// Reserved: 8/9/15 (boot straps, 8 also the onboard RGB LED), 12/13
// (USB-Serial/JTAG), 14 (not led out), 16/17 (UART0), 24-30 (flash).
// GPIO 4 (MTMS) is sampled at reset but otherwise usable; ADC1 is 0-6 only.
// LEDC has 6 channels; the bridge keeps 3 for motors and 3 for servos.

namespace board {
constexpr const char* boardId = "esp32-c6-devkitc-1";
constexpr int maxGpioPin = 23;
constexpr int pwmChannels = 6;
constexpr int motorChannels = 3;
constexpr int servoChannelBase = 3;
constexpr int i2cSda = 6;
constexpr int i2cScl = 7;
constexpr int spiSck = 10;
constexpr int spiMiso = 2;
constexpr int spiMosi = 3;
constexpr int spiCs = 11;

inline bool isFlashPin(int pin) { return pin >= 24 && pin <= 30; }
inline bool isInputOnlyPin(int) { return false; }
inline bool isUart0Pin(int pin) { return pin == 16 || pin == 17; }
inline bool isStrapPin(int pin) { return pin == 8 || pin == 9 || pin == 15; }
inline bool isAdcPin(int pin) { return pin >= 0 && pin <= 6; }
inline bool isUsbPin(int pin) { return pin == 12 || pin == 13; }
inline bool isReservedPin(int pin) { return pin == 14; }
}  // namespace board
