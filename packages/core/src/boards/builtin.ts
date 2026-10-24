// Kept in sync with firmware/boards by the board conformance test.
import type { BoardDescriptor } from './descriptors.js';
import { ValidationError } from '../errors.js';
export const builtinBoards: BoardDescriptor[] = [
  {
    schemaVersion: '1',
    boardId: 'arduino-uno',
    family: 'avr',
    mcu: 'ATmega328P',
    gpioPins: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    adcPins: [14, 15, 16, 17, 18, 19],
    pwmPins: [3, 5, 6, 9, 10, 11],
    reservedPins: [0, 1],
    inputOnlyPins: [],
    uartPins: [
      {
        id: 0,
        tx: 1,
        rx: 0,
      },
    ],
    i2cDefaults: {
      sda: 18,
      scl: 19,
    },
    spiDefaults: {
      sck: 13,
      miso: 12,
      mosi: 11,
      cs: 10,
    },
    voltage: {
      logic: 5,
      adcMax: 5,
    },
    usb: {
      vendorId: '2341',
      productId: '0043',
    },
    firmwareTarget: 'uno',
    warnings: [
      'Pins 0/1 are the USB-serial UART: avoid driving them while connected.',
      'Pins 14-19 map to analog pins A0-A5.',
      '5 V logic: never connect 3.3 V-only peripherals without level shifting.',
    ],
    support: 'COMPILE_TESTED',
  },
  {
    schemaVersion: '1',
    boardId: 'esp32-devkit-v1',
    family: 'esp32',
    mcu: 'ESP32-D0WD',
    gpioPins: [
      0, 2, 4, 5, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39,
    ],
    adcPins: [32, 33, 34, 35, 36, 39],
    inputOnlyPins: [34, 35, 36, 39],
    pwmPins: [0, 2, 4, 5, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33],
    reservedPins: [1, 3, 6, 7, 8, 9, 10, 11, 12],
    uartPins: [
      {
        id: 0,
        tx: 1,
        rx: 3,
      },
    ],
    i2cDefaults: {
      sda: 21,
      scl: 22,
    },
    spiDefaults: {
      sck: 18,
      miso: 19,
      mosi: 23,
      cs: 5,
    },
    voltage: {
      logic: 3.3,
      adcMax: 3.3,
    },
    usb: {
      vendorId: '10c4',
      productId: 'ea60',
    },
    firmwareTarget: 'esp32dev',
    warnings: [
      'Pins 6-11 are wired to integrated flash: never drive them.',
      'Pins 34-39 are input-only and have no pull-ups.',
      'Pin 12 (MTDI) straps the flash voltage at boot.',
    ],
    wireless: {
      mqttBridge: {
        firmware: 'firmware/esp32-mqtt-bridge',
        support: 'SIMULATED',
        compileTarget: 'esp32-mqtt',
        compileStatus: 'COMPILE_TESTED',
        config: [
          'PINOUT_WIFI_SSID',
          'PINOUT_WIFI_PASSWORD',
          'PINOUT_MQTT_HOST',
          'PINOUT_MQTT_PORT',
          'PINOUT_MQTT_DEVICE_ID',
        ],
        notes:
          'Host simulator is SIMULATED. Firmware pio run -e esp32-mqtt is COMPILE_TESTED (2026-10-23); no physical Wi-Fi HIL claimed.',
      },
    },
    support: 'IMPLEMENTED',
  },
  {
    schemaVersion: '1',
    boardId: 'esp32-c3-supermini',
    family: 'esp32-c3',
    mcu: 'ESP32-C3',
    gpioPins: [0, 1, 3, 4, 5, 6, 7, 10],
    adcPins: [0, 1, 3, 4],
    pwmPins: [0, 1, 3, 4, 5, 6, 7, 10],
    reservedPins: [2, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
    inputOnlyPins: [],
    uartPins: [
      {
        id: 0,
        tx: 21,
        rx: 20,
      },
    ],
    i2cDefaults: {
      sda: 4,
      scl: 5,
    },
    spiDefaults: {
      sck: 4,
      miso: 5,
      mosi: 6,
      cs: 7,
    },
    voltage: {
      logic: 3.3,
      adcMax: 2.5,
    },
    usb: {
      vendorId: '303a',
      productId: '1001',
    },
    firmwareTarget: 'esp32-c3-supermini',
    warnings: [
      'GPIO 2, 8, 9 are reserved boot straps; onboard LED on 8 is intentionally unavailable.',
      'GPIO 11-17 are flash, 18/19 USB, 20/21 UART; use an external LED on GPIO 4.',
    ],
    support: 'COMPILE_TESTED',
  },
  // ESP32-S2-DevKitC-1 pin map per the Espressif DevKitC-1 user guide and the
  // ESP32-S2 datasheet (GPIO 46 is input-only; 26-32 flash; 22-25 unexposed).
  {
    schemaVersion: '1',
    boardId: 'esp32-s2-devkitc-1',
    family: 'esp32-s2',
    mcu: 'ESP32-S2',
    gpioPins: [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 33, 34, 35, 36, 37, 38, 39,
      40, 41, 42, 46,
    ],
    adcPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    pwmPins: [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 33, 34, 35, 36, 37, 38, 39,
      40, 41, 42,
    ],
    reservedPins: [0, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 43, 44, 45],
    inputOnlyPins: [46],
    uartPins: [
      {
        id: 0,
        tx: 43,
        rx: 44,
      },
    ],
    i2cDefaults: {
      sda: 8,
      scl: 9,
    },
    spiDefaults: {
      sck: 12,
      miso: 13,
      mosi: 11,
      cs: 10,
    },
    voltage: {
      logic: 3.3,
    },
    firmwareTarget: 'esp32s2-devkit',
    warnings: [
      'GPIO 26-32 are wired to SPI flash: never drive them.',
      'GPIO 0, 45, 46 are boot straps; GPIO 46 is input-only and is never driven.',
      'GPIO 19/20 are USB OTG; 43/44 UART0; GPIO 22-25 are not on the DevKitC-1 headers.',
      'The bridge transports protocol v1 over UART0 at 115200 baud.',
    ],
    support: 'EXPERIMENTAL',
  },
  // ESP32-S3-DevKitC-1 pin map per the Espressif DevKitC-1 user guide and the
  // ESP32-S3 datasheet (26-37 flash/PSRAM; 33-37 reserved for octal modules).
  {
    schemaVersion: '1',
    boardId: 'esp32-s3-devkitc-1',
    family: 'esp32-s3',
    mcu: 'ESP32-S3',
    gpioPins: [
      1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 38, 39, 40, 41, 42, 47, 48,
    ],
    adcPins: [1, 2, 4, 5, 6, 7, 8, 9, 10],
    pwmPins: [
      1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 38, 39, 40, 41, 42, 47, 48,
    ],
    reservedPins: [
      0, 3, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 43, 44, 45, 46,
    ],
    inputOnlyPins: [],
    uartPins: [
      {
        id: 0,
        tx: 43,
        rx: 44,
      },
    ],
    i2cDefaults: {
      sda: 8,
      scl: 9,
    },
    spiDefaults: {
      sck: 12,
      miso: 13,
      mosi: 11,
      cs: 10,
    },
    voltage: {
      logic: 3.3,
      adcMax: 3.3,
    },
    usb: {
      vendorId: '303a',
      productId: '1001',
    },
    firmwareTarget: 'esp32-s3-devkitc-1',
    warnings: [
      'GPIO 26-32 are wired to SPI flash: never drive them.',
      'GPIO 33-37 are internal flash/PSRAM pins on octal-PSRAM modules and stay reserved.',
      'GPIO 0/3/45/46 are boot straps; 19/20 USB-JTAG; 43/44 UART0; GPIO 22-25 are not on the DevKitC-1 headers.',
      'The onboard addressable RGB LED is GPIO 38 (v1.1) or GPIO 48 (initial revision).',
      'The bridge transports protocol v1 over UART0 at 115200 baud.',
      'firmwareTarget matches PlatformIO env esp32-s3-devkitc-1 (COMPILE_TESTED). Local alias esp32s3-devkit builds the same profile.',
    ],
    support: 'COMPILE_TESTED',
  },
  // ESP32-C6-DevKitC-1 (v1.2) pin map per the Espressif DevKitC-1 user guide
  // and the ESP32-C6 datasheet (ADC1 on 0-6 only; 24-30 flash; GPIO 4 MTMS).
  {
    schemaVersion: '1',
    boardId: 'esp32-c6-devkitc-1',
    family: 'esp32-c6',
    mcu: 'ESP32-C6',
    gpioPins: [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 18, 19, 20, 21, 22, 23],
    adcPins: [0, 1, 2, 3, 4, 5, 6],
    pwmPins: [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 18, 19, 20, 21, 22, 23],
    reservedPins: [8, 9, 12, 13, 14, 15, 16, 17, 24, 25, 26, 27, 28, 29, 30],
    inputOnlyPins: [],
    uartPins: [
      {
        id: 0,
        tx: 16,
        rx: 17,
      },
    ],
    i2cDefaults: {
      sda: 6,
      scl: 7,
    },
    spiDefaults: {
      sck: 10,
      miso: 2,
      mosi: 3,
      cs: 11,
    },
    voltage: {
      logic: 3.3,
    },
    firmwareTarget: 'esp32c6-devkit',
    warnings: [
      'GPIO 24-30 are wired to SPI flash: never drive them.',
      'GPIO 8/9/15 are boot straps; GPIO 8 also drives the onboard RGB LED.',
      'GPIO 12/13 are USB-Serial/JTAG and 16/17 UART0; GPIO 14 is not led out and is unavailable.',
      'GPIO 4 (MTMS) is sampled at reset: usable, but do not drive it low during boot.',
      'ADC1 covers GPIO 0-6 only; ESP32-C6 has no ADC2.',
    ],
    support: 'EXPERIMENTAL',
  },
  {
    schemaVersion: '1',
    boardId: 'raspberry-pi-pico',
    family: 'rp2040',
    mcu: 'RP2040',
    gpioPins: [
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 25, 26, 27,
      28,
    ],
    adcPins: [26, 27, 28],
    pwmPins: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 25],
    reservedPins: [23, 24, 29],
    inputOnlyPins: [],
    uartPins: [
      {
        id: 0,
        tx: 0,
        rx: 1,
      },
      {
        id: 1,
        tx: 4,
        rx: 5,
      },
    ],
    i2cDefaults: {
      sda: 4,
      scl: 5,
    },
    spiDefaults: {
      sck: 18,
      miso: 16,
      mosi: 19,
      cs: 17,
    },
    voltage: {
      logic: 3.3,
      adcMax: 3.3,
    },
    usb: {
      vendorId: '2e8a',
      productId: '0005',
    },
    firmwareTarget: 'pico',
    warnings: [
      'GPIO 25 is the onboard LED on the non-W Pico (use for blink demos). Pico W uses a different LED path.',
      'Pins 23 (SMPS power-save), 24 (VBUS sense), and 29 (ADC VREF / VSYS sense) are reserved — never drive them.',
      'USB VID 2e8a:0005 is MicroPython CDC; 2e8a:0003 is the UF2 bootloader (BOOTSEL).',
      'Desk path uses USB CDC via firmware/micropython-bridge (TRANSPORT=usb). No factory protocols.',
    ],
    support: 'SIMULATED',
  },
];

// LEDC channel counts: classic ESP32 16, S2/S3 8, C3/C6 6 (Espressif datasheets).
const pwmChannelLimits: Partial<Record<BoardDescriptor['family'], { label: string; max: number }>> =
  {
    esp32: { label: 'ESP32', max: 16 },
    'esp32-s2': { label: 'ESP32-S2', max: 8 },
    'esp32-s3': { label: 'ESP32-S3', max: 8 },
    'esp32-c3': { label: 'ESP32-C3', max: 6 },
    'esp32-c6': { label: 'ESP32-C6', max: 6 },
  };

export function boardForInfo(info: {
  boardId?: string;
  firmware: string;
}): BoardDescriptor | undefined {
  const id = info.boardId ?? (info.firmware === 'esp32-bridge' ? 'esp32-devkit-v1' : undefined);
  const board = builtinBoards.find((b) => b.boardId === id);
  if (id && !board)
    throw new ValidationError(`Unknown board identity '${id}'. Update Pinout before operating it.`);
  return board;
}
export function validateBoardAction(
  board: BoardDescriptor,
  action: string,
  payload: Record<string, unknown>,
): void {
  const channelLimit = pwmChannelLimits[board.family];
  if (
    channelLimit !== undefined &&
    typeof payload.channel === 'number' &&
    payload.channel > channelLimit.max - 1
  )
    throw new ValidationError(
      `${channelLimit.label} supports PWM channels 0–${channelLimit.max - 1}.`,
    );
  const read =
    ['gpio.read', 'gpio.watch', 'gpio.unwatch', 'gpio.analogRead'].includes(action) ||
    (action === 'gpio.mode' && payload.mode === 'input');
  const pin = (value: unknown, output = !read): void => {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      !board.gpioPins.includes(value) ||
      (output && board.inputOnlyPins?.includes(value))
    ) {
      throw new ValidationError(
        `${board.boardId}: GPIO ${String(value)} is unavailable or input-only and cannot be driven for ${action}. Consult the device board pin map.`,
      );
    }
  };
  for (const key of [
    'pin',
    'pwmPin',
    'dirPin',
    'sda',
    'scl',
    'sck',
    'miso',
    'mosi',
    'chipSelect',
  ]) {
    if (payload[key] !== undefined) pin(payload[key], key === 'miso' ? false : !read);
  }
  if (Array.isArray(payload.writes))
    for (const w of payload.writes) pin((w as { pin: unknown }).pin);
  if (action === 'gpio.analogRead' && !board.adcPins?.includes(payload.pin as number))
    throw new ValidationError('Pin does not support ADC.');
  if (
    ['gpio.pwm', 'gpio.servo'].includes(action) &&
    !board.pwmPins?.includes(payload.pin as number)
  )
    throw new ValidationError('Pin does not support PWM.');
  if (board.family === 'avr' && payload.mode === 'pulldown')
    throw new ValidationError('Uno has no internal pulldown; use an external resistor.');
}
