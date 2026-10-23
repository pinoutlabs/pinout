import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadBoardDescriptors,
  pinRole,
  validateBoardDescriptor,
} from '../src/boards/descriptors.js';
import { builtinBoards, validateBoardAction } from '../src/boards/builtin.js';
import {
  assertFamilyAdcPin,
  assertFamilyReadPin,
  assertFamilyWritePin,
  pinRulesForBoard,
  pinRulesForFamily,
} from '../src/drivers/esp32/pins.js';
import { ValidationError } from '../src/errors.js';

const boardsDir = join(process.cwd(), 'firmware', 'boards');
const loaded = loadBoardDescriptors(boardsDir);

describe('board descriptors', () => {
  it.each([[2, 2], [2, -1], [2, 1.5], ['2'], '2', null])(
    'rejects malformed GPIO lists: %j',
    (gpioPins) => {
      expect(() => validateBoardDescriptor({ ...loaded.boards[0], gpioPins })).toThrow();
    },
  );
  it('loads the committed descriptors without errors', () => {
    expect(loaded.errors).toEqual([]);
    const ids = loaded.boards.map((board) => board.boardId);
    expect(ids).toContain('esp32-devkit-v1');
    expect(ids).toContain('esp32-s3-devkitc-1');
    expect(ids).toContain('esp32-c3-supermini');
    expect(ids).toContain('raspberry-pi-pico');
    expect(ids).toContain('arduino-uno');
  });

  it('covers the esp32 family variants as data, not code', () => {
    const families = new Set(loaded.boards.map((board) => board.family));
    expect(families.has('esp32')).toBe(true);
    expect(families.has('esp32-s3')).toBe(true);
    expect(families.has('esp32-c3')).toBe(true);
  });

  it('reserved pins never overlap usable pins (flash/strap safety)', () => {
    for (const board of loaded.boards) {
      const usable = new Set(board.gpioPins);
      for (const reserved of board.reservedPins) {
        expect(usable.has(reserved), `${board.boardId} pin ${reserved}`).toBe(false);
      }
    }
  });

  it('esp32 classic reserves the flash pins 6-11', () => {
    const esp32 = loaded.boards.find((board) => board.boardId === 'esp32-devkit-v1')!;
    expect(esp32.reservedPins).toEqual(expect.arrayContaining([6, 7, 8, 9, 10, 11]));
    expect(pinRole(esp32, 6)).toBe('reserved');
    expect(pinRole(esp32, 2)).toBe('usable');
    expect(pinRole(esp32, 36)).toBe('input-only'); // safest role wins: no output
    expect(pinRole(esp32, 34)).toBe('input-only');
    // An unknown pin is never actuable.
    expect(pinRole(esp32, 99)).toBe('unknown');
  });

  it('esp32-c3 and esp32-s3 board JSON match firmwareTarget and COMPILE_TESTED status', () => {
    const c3 = loaded.boards.find((board) => board.boardId === 'esp32-c3-supermini')!;
    const s3 = loaded.boards.find((board) => board.boardId === 'esp32-s3-devkitc-1')!;
    expect(c3.firmwareTarget).toBe('esp32-c3-supermini');
    expect(s3.firmwareTarget).toBe('esp32-s3-devkitc-1');
    expect(c3.support).toBe('COMPILE_TESTED');
    expect(s3.support).toBe('COMPILE_TESTED');
    expect(c3.i2cDefaults).toEqual({ sda: 4, scl: 5 });
    expect(s3.i2cDefaults).toEqual({ sda: 8, scl: 9 });
    expect(pinRole(c3, 8)).toBe('reserved');
    expect(pinRole(c3, 4)).toBe('adc');
    expect(pinRole(s3, 26)).toBe('reserved');
    expect(pinRole(s3, 19)).toBe('reserved');
    expect(pinRole(s3, 2)).toBe('adc');
    expect(pinRole(s3, 18)).toBe('usable');
  });

  it('keeps builtin board tables identical to firmware/boards JSON', () => {
    for (const board of builtinBoards) {
      const fromDisk = loaded.boards.find((entry) => entry.boardId === board.boardId);
      expect(fromDisk, board.boardId).toEqual(board);
    }
    expect(builtinBoards.map((board) => board.boardId)).toEqual(
      expect.arrayContaining(['esp32-c3-supermini', 'esp32-s3-devkitc-1', 'esp32-devkit-v1']),
    );
  });

  it('family pin rules refuse flash/USB/UART/strap pins for C3 and S3', () => {
    const c3 = pinRulesForFamily('esp32-c3');
    const s3 = pinRulesForFamily('esp32-s3');
    expect(() => assertFamilyWritePin(c3, 11)).toThrow(ValidationError);
    expect(() => assertFamilyWritePin(c3, 18)).toThrow(/USB/);
    expect(() => assertFamilyWritePin(c3, 2)).toThrow(/strap/);
    expect(() => assertFamilyWritePin(c3, 4)).not.toThrow();
    expect(() => assertFamilyAdcPin(c3, 4)).not.toThrow();
    expect(() => assertFamilyAdcPin(c3, 5)).toThrow(/ADC/);
    expect(() => assertFamilyWritePin(s3, 26)).toThrow(/flash/);
    expect(() => assertFamilyReadPin(s3, 19)).toThrow(/USB/);
    expect(() => assertFamilyWritePin(s3, 45)).toThrow(/strap/);
    expect(() => assertFamilyWritePin(s3, 4)).not.toThrow();
    expect(() => assertFamilyAdcPin(s3, 1)).not.toThrow();
    expect(pinRulesForBoard(loaded.boards.find((b) => b.boardId === 'esp32-s3-devkitc-1')!).family)
      .toBe('esp32-s3');
  });

  it('validateBoardAction enforces C3/S3 PWM channel limits and usable pins', () => {
    const c3 = loaded.boards.find((board) => board.boardId === 'esp32-c3-supermini')!;
    const s3 = loaded.boards.find((board) => board.boardId === 'esp32-s3-devkitc-1')!;
    expect(() => validateBoardAction(c3, 'gpio.write', { pin: 8, value: true })).toThrow(
      /unavailable/,
    );
    expect(() => validateBoardAction(c3, 'gpio.write', { pin: 4, value: true })).not.toThrow();
    expect(() =>
      validateBoardAction(c3, 'gpio.pwm', { pin: 4, channel: 6, duty: 0.5, frequency: 1000 }),
    ).toThrow(/0–5/);
    expect(() =>
      validateBoardAction(s3, 'gpio.pwm', { pin: 4, channel: 8, duty: 0.5, frequency: 1000 }),
    ).toThrow(/0–7/);
    expect(() => validateBoardAction(s3, 'gpio.write', { pin: 19, value: true })).toThrow(
      /unavailable/,
    );
  });

  it('rejects descriptors with overlapping reserved/usable pins', () => {
    expect(() =>
      validateBoardDescriptor({
        schemaVersion: '1',
        boardId: 'bad-board',
        family: 'esp32',
        mcu: 'x',
        gpioPins: [2, 6],
        reservedPins: [6],
        voltage: { logic: 3.3 },
        support: 'PLANNED',
      }),
    ).toThrowError(/never guessed/);
  });

  it('rejects descriptors with out-of-range pin roles', () => {
    expect(() =>
      validateBoardDescriptor({
        schemaVersion: '1',
        boardId: 'bad-adc',
        family: 'esp32',
        mcu: 'x',
        gpioPins: [2],
        reservedPins: [],
        adcPins: [99],
        voltage: { logic: 3.3 },
        support: 'PLANNED',
      }),
    ).toThrowError(/not a usable GPIO/);
  });

  it('rejects unknown schema versions and families', () => {
    expect(() =>
      validateBoardDescriptor({
        schemaVersion: '9',
        boardId: 'x',
        family: 'esp32',
        mcu: 'x',
        gpioPins: [2],
        reservedPins: [],
        voltage: { logic: 3.3 },
        support: 'PLANNED',
      }),
    ).toThrowError(/schemaVersion/);
    expect(() =>
      validateBoardDescriptor({
        schemaVersion: '1',
        boardId: 'x',
        family: 'toaster',
        mcu: 'x',
        gpioPins: [2],
        reservedPins: [],
        voltage: { logic: 3.3 },
        support: 'PLANNED',
      }),
    ).toThrowError(/family/);
  });
});
