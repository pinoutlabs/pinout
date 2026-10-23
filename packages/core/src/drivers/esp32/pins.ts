import { ValidationError } from '../../errors.js';
import type { BoardDescriptor } from '../../boards/descriptors.js';

export const esp32FlashPins = [6, 7, 8, 9, 10, 11] as const;
export const esp32InputOnlyPins = [34, 35, 36, 37, 38, 39] as const;
export const esp32Uart0Pins = [1, 3] as const;
export const esp32StrapPins = [12] as const;
export const esp32AdcPins = [32, 33, 34, 35, 36, 37, 38, 39] as const;
export const esp32DefaultLedPin = 2;

/** C3 SuperMini rules mirrored from firmware/boards/esp32-c3-supermini.json. */
export const esp32C3FlashPins = [11, 12, 13, 14, 15, 16, 17] as const;
export const esp32C3UsbPins = [18, 19] as const;
export const esp32C3Uart0Pins = [20, 21] as const;
export const esp32C3StrapPins = [2, 8, 9] as const;
export const esp32C3AdcPins = [0, 1, 3, 4] as const;
export const esp32C3DefaultI2c = { sda: 4, scl: 5, frequency: 100_000 } as const;
export const esp32C3DefaultSpi = {
  sck: 4,
  miso: 5,
  mosi: 6,
  chipSelect: 7,
  frequency: 1_000_000,
} as const;

/** S3 DevKitC-1 rules mirrored from firmware/boards/esp32-s3-devkitc-1.json. */
export const esp32S3FlashPins = [
  22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
] as const;
export const esp32S3UsbPins = [19, 20] as const;
export const esp32S3Uart0Pins = [43, 44] as const;
export const esp32S3StrapPins = [45, 46] as const;
export const esp32S3AdcPins = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const esp32S3DefaultI2c = { sda: 8, scl: 9, frequency: 100_000 } as const;
export const esp32S3DefaultSpi = {
  sck: 12,
  miso: 13,
  mosi: 11,
  chipSelect: 10,
  frequency: 1_000_000,
} as const;

export const esp32DevKitPins = {
  led: 2,
} as const;

export const esp32DefaultI2c = {
  sda: 21,
  scl: 22,
  frequency: 100_000,
} as const;

export const esp32DefaultSpi = {
  sck: 18,
  miso: 19,
  mosi: 23,
  chipSelect: 5,
  frequency: 1_000_000,
} as const;

export const maxEsp32BusPayloadBytes = 32;

export type Esp32PinFamily = 'esp32' | 'esp32-c3' | 'esp32-s3';

export interface Esp32FamilyPinRules {
  family: Esp32PinFamily;
  maxPin: number;
  pwmChannelCount: number;
  flashPins: readonly number[];
  usbPins: readonly number[];
  uart0Pins: readonly number[];
  strapPins: readonly number[];
  adcPins: readonly number[];
  inputOnlyPins: readonly number[];
  defaultI2c: { sda: number; scl: number; frequency: number };
  defaultSpi: {
    sck: number;
    miso: number;
    mosi: number;
    chipSelect: number;
    frequency: number;
  };
}

export const esp32ClassicPinRules: Esp32FamilyPinRules = {
  family: 'esp32',
  maxPin: 39,
  pwmChannelCount: 16,
  flashPins: esp32FlashPins,
  usbPins: [],
  uart0Pins: esp32Uart0Pins,
  strapPins: esp32StrapPins,
  adcPins: esp32AdcPins,
  inputOnlyPins: esp32InputOnlyPins,
  defaultI2c: esp32DefaultI2c,
  defaultSpi: esp32DefaultSpi,
};

export const esp32C3PinRules: Esp32FamilyPinRules = {
  family: 'esp32-c3',
  maxPin: 21,
  pwmChannelCount: 6,
  flashPins: esp32C3FlashPins,
  usbPins: esp32C3UsbPins,
  uart0Pins: esp32C3Uart0Pins,
  strapPins: esp32C3StrapPins,
  adcPins: esp32C3AdcPins,
  inputOnlyPins: [],
  defaultI2c: esp32C3DefaultI2c,
  defaultSpi: esp32C3DefaultSpi,
};

export const esp32S3PinRules: Esp32FamilyPinRules = {
  family: 'esp32-s3',
  maxPin: 48,
  pwmChannelCount: 8,
  flashPins: esp32S3FlashPins,
  usbPins: esp32S3UsbPins,
  uart0Pins: esp32S3Uart0Pins,
  strapPins: esp32S3StrapPins,
  adcPins: esp32S3AdcPins,
  inputOnlyPins: [],
  defaultI2c: esp32S3DefaultI2c,
  defaultSpi: esp32S3DefaultSpi,
};

export function pinRulesForFamily(family: string): Esp32FamilyPinRules {
  if (family === 'esp32-c3') return esp32C3PinRules;
  if (family === 'esp32-s3') return esp32S3PinRules;
  return esp32ClassicPinRules;
}

export function pinRulesForBoard(board: BoardDescriptor): Esp32FamilyPinRules {
  return pinRulesForFamily(board.family);
}

/** Simulator/host helpers: refuse reserved roles for a family the same way firmware does. */
export function assertFamilyWritePin(rules: Esp32FamilyPinRules, pin: number): void {
  if (
    pin < 0 ||
    pin > rules.maxPin ||
    rules.flashPins.includes(pin) ||
    rules.usbPins.includes(pin) ||
    rules.uart0Pins.includes(pin) ||
    rules.strapPins.includes(pin) ||
    rules.inputOnlyPins.includes(pin)
  ) {
    throw new ValidationError(familyPinMessage(rules, pin, 'write'));
  }
}

export function assertFamilyReadPin(rules: Esp32FamilyPinRules, pin: number): void {
  if (
    pin < 0 ||
    pin > rules.maxPin ||
    rules.flashPins.includes(pin) ||
    rules.usbPins.includes(pin) ||
    rules.uart0Pins.includes(pin) ||
    rules.strapPins.includes(pin)
  ) {
    throw new ValidationError(familyPinMessage(rules, pin, 'read'));
  }
}

export function assertFamilyAdcPin(rules: Esp32FamilyPinRules, pin: number): void {
  if (!rules.adcPins.includes(pin)) {
    throw new ValidationError(
      `GPIO ${pin} is not an ADC pin on ${rules.family}. Allowed: ${rules.adcPins.join(', ')}.`,
    );
  }
  assertFamilyReadPin(rules, pin);
}

function familyPinMessage(
  rules: Esp32FamilyPinRules,
  pin: number,
  operation: 'read' | 'write',
): string {
  if (rules.strapPins.includes(pin)) {
    return `GPIO ${pin} is a boot strap pin on ${rules.family}. ${operation} is refused because it can prevent boot.`;
  }
  if (rules.flashPins.includes(pin)) {
    return `GPIO ${pin} is wired to SPI flash on ${rules.family}. ${operation} is refused.`;
  }
  if (rules.usbPins.includes(pin)) {
    return `GPIO ${pin} is native USB on ${rules.family}. ${operation} is refused while using this transport.`;
  }
  if (rules.uart0Pins.includes(pin)) {
    return `GPIO ${pin} is UART0 on ${rules.family}. ${operation} is refused while using this transport.`;
  }
  if (operation === 'write' && rules.inputOnlyPins.includes(pin)) {
    return `GPIO ${pin} is input-only on ${rules.family} and cannot be driven.`;
  }
  return `GPIO ${pin} is not a valid ${rules.family} pin for ${operation}.`;
}

export type GpioModeName = 'input' | 'output' | 'pullup' | 'pulldown';
export type GpioPinMode = GpioModeName;
export type GpioSafeLevel = 'low' | 'high' | 'high-z' | 'hold';
export type GpioPolarity = 'active-high' | 'active-low';

export function assertSafeLevel(level: unknown): GpioSafeLevel {
  if (level !== 'low' && level !== 'high' && level !== 'high-z' && level !== 'hold') {
    throw new ValidationError(
      `Safe level must be low, high, high-z, or hold, received ${String(level)}.`,
    );
  }
  return level;
}

export function assertPolarity(polarity: unknown): GpioPolarity {
  if (polarity !== 'active-high' && polarity !== 'active-low') {
    throw new ValidationError(
      `Polarity must be active-high or active-low, received ${String(polarity)}.`,
    );
  }
  return polarity;
}

export function assertNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(
      `${field} must be a non-negative integer, received ${String(value)}.`,
    );
  }
  return value;
}

export function assertGpioPin(pin: unknown): number {
  if (typeof pin !== 'number' || !Number.isInteger(pin) || pin < 0) {
    throw new ValidationError(`GPIO pin must be a non-negative integer, received ${String(pin)}.`);
  }
  return pin;
}

export function assertGpioValue(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`GPIO value must be a boolean, received ${String(value)}.`);
  }
  return value;
}

export function assertGpioMode(mode: unknown): GpioModeName {
  if (mode !== 'input' && mode !== 'output' && mode !== 'pullup' && mode !== 'pulldown') {
    throw new ValidationError(
      `GPIO mode must be input, output, pullup, or pulldown, received ${String(mode)}.`,
    );
  }
  return mode;
}

export function isEsp32FlashPin(pin: number): boolean {
  return pin >= 6 && pin <= 11;
}

export function isEsp32InputOnlyPin(pin: number): boolean {
  return pin >= 34 && pin <= 39;
}

export function isEsp32Uart0Pin(pin: number): boolean {
  return pin === 1 || pin === 3;
}

export function isEsp32StrapPin(pin: number): boolean {
  return pin === 12;
}

export function isEsp32AdcPin(pin: number): boolean {
  return pin >= 32 && pin <= 39;
}

export function assertEsp32ReadPin(pin: number): void {
  if (pin > 39 || isEsp32FlashPin(pin) || isEsp32Uart0Pin(pin) || isEsp32StrapPin(pin)) {
    throw new ValidationError(esp32PinMessage(pin, 'read'));
  }
}

export function assertEsp32WritePin(pin: number): void {
  if (
    pin > 39 ||
    isEsp32FlashPin(pin) ||
    isEsp32InputOnlyPin(pin) ||
    isEsp32Uart0Pin(pin) ||
    isEsp32StrapPin(pin)
  ) {
    throw new ValidationError(esp32PinMessage(pin, 'write'));
  }
}

export function assertEsp32ModePin(pin: number): void {
  if (pin > 39 || isEsp32FlashPin(pin) || isEsp32Uart0Pin(pin) || isEsp32StrapPin(pin)) {
    throw new ValidationError(esp32PinMessage(pin, 'configure'));
  }
}

export function assertEsp32PwmPin(pin: number): void {
  assertEsp32WritePin(pin);
}

export function assertEsp32AnalogPin(pin: number): void {
  if (!isEsp32AdcPin(pin)) {
    throw new ValidationError(
      `GPIO ${pin} is not an ESP32 ADC pin. Use GPIO 32–39 for analogRead.`,
    );
  }
  assertEsp32ReadPin(pin);
}

export const assertEsp32AdcPin = assertEsp32AnalogPin;

export function assertEsp32BusPin(pin: number, role: string): void {
  try {
    assertEsp32WritePin(pin);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(`ESP32 ${role} pin is invalid: ${error.message}`);
    }
    throw error;
  }
}

export function assertI2cAddress(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 127) {
    throw new ValidationError(
      `I2C address must be an integer from 0 to 127, received ${String(value)}.`,
    );
  }
  return value;
}

export function assertBusBytes(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxEsp32BusPayloadBytes) {
    throw new ValidationError(`${field} must be an array of 1–${maxEsp32BusPayloadBytes} bytes.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > 255) {
      throw new ValidationError(`${field}[${index}] must be an integer from 0 to 255.`);
    }
    return entry;
  });
}

export function assertBusLength(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > maxEsp32BusPayloadBytes
  ) {
    throw new ValidationError(
      `length must be an integer from 1 to ${maxEsp32BusPayloadBytes}, received ${String(value)}.`,
    );
  }
  return value;
}

export function assertServoAngle(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 180) {
    throw new ValidationError(
      `Servo angle must be a number from 0 to 180, received ${String(value)}.`,
    );
  }
  return value;
}

export function assertMotorSpeed(value: unknown, allowReverse: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`Motor speed must be a finite number, received ${String(value)}.`);
  }
  const min = allowReverse ? -1 : 0;
  if (value < min || value > 1) {
    throw new ValidationError(
      allowReverse
        ? 'Motor speed must be between -1 and 1 when a direction pin is set.'
        : 'Motor speed must be between 0 and 1 unless a direction pin is provided.',
    );
  }
  return value;
}

export function resolveEsp32BoardPin(name: string): number {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'led') {
    return esp32DevKitPins.led;
  }
  throw new ValidationError(`Unknown board pin '${name}'. Known names: led.`);
}

function esp32PinMessage(pin: number, operation: 'read' | 'write' | 'configure'): string {
  if (isEsp32StrapPin(pin)) {
    return `GPIO ${pin} is a boot strap pin on ESP32. ${operation} is refused because it can prevent boot.`;
  }
  if (isEsp32FlashPin(pin)) {
    return `GPIO ${pin} is wired to SPI flash on ESP32. ${operation} is refused.`;
  }
  if (isEsp32Uart0Pin(pin)) {
    return `GPIO ${pin} is UART0 (USB serial). ${operation} is refused while using this transport.`;
  }
  if (operation === 'write' && isEsp32InputOnlyPin(pin)) {
    return `GPIO ${pin} is input-only on ESP32 and cannot be driven.`;
  }
  return `GPIO ${pin} is not a valid ESP32 pin for ${operation}.`;
}
