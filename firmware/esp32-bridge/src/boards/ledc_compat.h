#pragma once

#include <Arduino.h>

// Channel-oriented LEDC compatibility shim.
//
// The bridge was written against the Arduino-ESP32 2.x LEDC API, which
// separates channel setup (ledcSetup), pin attachment (ledcAttachPin), writes
// by channel (ledcWrite) and detach by pin (ledcDetachPin).
//
// Arduino-ESP32 3.x replaced that API with a pin-oriented one. This shim
// restores the 2.x call shape on top of ledcAttachChannel/ledcWriteChannel so
// main.cpp stays identical across cores.
//
// This shim is the least-verified part of the ESP32-C6 build: expected
// compile-clean, compile test pending. Classic/S2/S3/C3 stay on core 2.x and
// call the original API directly.

#if ESP_ARDUINO_VERSION_MAJOR >= 3

namespace pinoutLedc {
// Frequency/resolution chosen for a channel before the pin is attached.
inline uint32_t& frequencySlot(uint8_t channel) {
  static uint32_t frequencies[SOC_LEDC_CHANNEL_NUM] = {0};
  return frequencies[channel];
}
inline uint8_t& resolutionSlot(uint8_t channel) {
  static uint8_t resolutions[SOC_LEDC_CHANNEL_NUM] = {8};
  return resolutions[channel];
}
}  // namespace pinoutLedc

inline bool pinoutLedcSetup(uint8_t channel, uint32_t frequency, uint8_t resolution) {
  if (channel >= SOC_LEDC_CHANNEL_NUM) {
    return false;
  }
  pinoutLedc::frequencySlot(channel) = frequency;
  pinoutLedc::resolutionSlot(channel) = resolution;
  return true;
}

inline void pinoutLedcAttachPin(uint8_t pin, uint8_t channel) {
  const uint32_t frequency = pinoutLedc::frequencySlot(channel);
  ledcDetach(pin);
  ledcAttachChannel(pin, frequency > 0 ? frequency : 5000, pinoutLedc::resolutionSlot(channel),
                    channel);
}

inline void pinoutLedcWrite(uint8_t channel, uint32_t duty) {
  ledcWriteChannel(channel, duty);
}

inline void pinoutLedcDetachPin(uint8_t pin) { ledcDetach(pin); }

#else

inline bool pinoutLedcSetup(uint8_t channel, uint32_t frequency, uint8_t resolution) {
  return ledcSetup(channel, frequency, resolution) != 0;
}

inline void pinoutLedcAttachPin(uint8_t pin, uint8_t channel) { ledcAttachPin(pin, channel); }

inline void pinoutLedcWrite(uint8_t channel, uint32_t duty) { ledcWrite(channel, duty); }

inline void pinoutLedcDetachPin(uint8_t pin) { ledcDetachPin(pin); }

#endif
