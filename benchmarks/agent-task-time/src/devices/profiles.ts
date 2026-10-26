import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBenchRoot } from '../config.js';
import type { ProfileId } from '../types.js';

export interface BoardProfile {
  id: ProfileId;
  displayName: string;
  boardId: string;
  mcu: string;
  logicVoltage: number;
  ledPin: number;
  servoPin: number;
  adcPin: number;
  /** Seeded analog reading used by the sensor task (SIMULATED). */
  seededAnalogValue: number;
  adcMax: number;
  gpioPins: number[];
  adcPins: number[];
  pwmPins: number[];
  reservedPins: number[];
  warnings: string[];
  datasheetPath: string;
}

const profiles: Record<ProfileId, BoardProfile> = {
  esp32: {
    id: 'esp32',
    displayName: 'ESP32 DevKit V1',
    boardId: 'esp32-devkit-v1',
    mcu: 'ESP32-D0WD',
    logicVoltage: 3.3,
    ledPin: 2,
    servoPin: 18,
    adcPin: 34,
    seededAnalogValue: 2048,
    adcMax: 4095,
    gpioPins: [
      0, 2, 4, 5, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39,
    ],
    adcPins: [32, 33, 34, 35, 36, 39],
    pwmPins: [0, 2, 4, 5, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33],
    reservedPins: [1, 3, 6, 7, 8, 9, 10, 11, 12],
    warnings: [
      'Pins 6-11 are wired to integrated flash: never drive them.',
      'Pins 34-39 are input-only.',
    ],
    datasheetPath: join(getBenchRoot(), 'fixtures/datasheets/esp32-devkit-v1.md'),
  },
  pico: {
    id: 'pico',
    displayName: 'Raspberry Pi Pico (RP2040)',
    boardId: 'raspberry-pi-pico',
    mcu: 'RP2040',
    logicVoltage: 3.3,
    ledPin: 25,
    servoPin: 15,
    adcPin: 26,
    seededAnalogValue: 32768,
    adcMax: 65535,
    gpioPins: [
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 25, 26, 27,
      28,
    ],
    adcPins: [26, 27, 28],
    pwmPins: [
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 25,
    ],
    reservedPins: [23, 24, 29],
    warnings: [
      'GPIO 25 is the onboard LED on the non-W Pico.',
      'Pins 23, 24, and 29 are reserved.',
    ],
    datasheetPath: join(getBenchRoot(), 'fixtures/datasheets/raspberry-pi-pico.md'),
  },
  uno: {
    id: 'uno',
    displayName: 'Arduino Uno (ATmega328P)',
    boardId: 'arduino-uno',
    mcu: 'ATmega328P',
    logicVoltage: 5,
    ledPin: 13,
    servoPin: 9,
    adcPin: 14,
    seededAnalogValue: 512,
    adcMax: 1023,
    gpioPins: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    adcPins: [14, 15, 16, 17, 18, 19],
    pwmPins: [3, 5, 6, 9, 10, 11],
    reservedPins: [0, 1],
    warnings: [
      'Pins 0/1 are the USB-serial UART.',
      'Pins 14-19 map to analog pins A0-A5.',
      '5 V logic: do not connect 3.3 V-only peripherals without level shifting.',
    ],
    datasheetPath: join(getBenchRoot(), 'fixtures/datasheets/arduino-uno.md'),
  },
};

export function getProfile(profileId: ProfileId): BoardProfile {
  return profiles[profileId];
}

export function listProfiles(): BoardProfile[] {
  return Object.values(profiles);
}

export function loadDatasheet(profileId: ProfileId): string {
  const profile = getProfile(profileId);
  return readFileSync(profile.datasheetPath, 'utf8');
}

export function assertUsableGpio(profile: BoardProfile, pin: number): void {
  if (profile.reservedPins.includes(pin)) {
    throw new Error(`GPIO ${pin} is reserved on ${profile.displayName}.`);
  }
  if (!profile.gpioPins.includes(pin)) {
    throw new Error(`GPIO ${pin} is not available on ${profile.displayName}.`);
  }
}

export function assertPwmPin(profile: BoardProfile, pin: number): void {
  assertUsableGpio(profile, pin);
  if (!profile.pwmPins.includes(pin)) {
    throw new Error(`GPIO ${pin} is not a PWM/servo pin on ${profile.displayName}.`);
  }
}

export function assertAdcPin(profile: BoardProfile, pin: number): void {
  if (!profile.adcPins.includes(pin)) {
    throw new Error(`GPIO ${pin} is not an ADC pin on ${profile.displayName}.`);
  }
}
