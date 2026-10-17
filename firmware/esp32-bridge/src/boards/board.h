#pragma once

#include <Arduino.h>

// Compile-time board selection for the Pinout ESP32 bridge.
//
// Exactly one variant may be selected with a build flag; with no flag the
// binary defaults to the classic ESP32 DevKit (the alpha reference target).
// Every pin policy below is written from the Espressif DevKitC-1 user guides
// and the matching chip datasheets: flash, strap, USB, UART0 and ADC rules are
// per-board data, never inferred.
//
//   -DPINOUT_ESP32=1      classic ESP32 DevKit (WROOM-32, default)
//   -DPINOUT_ESP32_S2=1   ESP32-S2-DevKitC-1
//   -DPINOUT_ESP32_S3=1   ESP32-S3-DevKitC-1
//   -DPINOUT_ESP32_C3=1   ESP32-C3 SuperMini / DevKitM-1
//   -DPINOUT_ESP32_C6=1   ESP32-C6-DevKitC-1 (Arduino core 3.x only)

#if (defined(PINOUT_ESP32) ? 1 : 0) + (defined(PINOUT_ESP32_S2) ? 1 : 0) +         \
        (defined(PINOUT_ESP32_S3) ? 1 : 0) + (defined(PINOUT_ESP32_C3) ? 1 : 0) +   \
        (defined(PINOUT_ESP32_C6) ? 1 : 0) >                                         \
    1
#error "Select at most one PINOUT_ESP32_* board flag."
#endif

#if defined(PINOUT_ESP32_S2)
#include "board_esp32s2.h"
#elif defined(PINOUT_ESP32_S3)
#include "board_esp32s3.h"
#elif defined(PINOUT_ESP32_C3)
#include "board_esp32c3.h"
#elif defined(PINOUT_ESP32_C6)
#include "board_esp32c6.h"
#else
#include "board_esp32.h"
#endif

// Native USB Serial/JTAG transports need the HWCDC stream and a short host
// open wait; hardware UART transports do not (see src/main.cpp setup).
#if defined(PINOUT_ESP32_C3)
#define PINOUT_NATIVE_USB_SERIAL 1
#else
#define PINOUT_NATIVE_USB_SERIAL 0
#endif
