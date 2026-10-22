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
];

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
  if (board.family === 'esp32-c3' && typeof payload.channel === 'number' && payload.channel > 5)
    throw new ValidationError('ESP32-C3 supports PWM channels 0–5.');
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
