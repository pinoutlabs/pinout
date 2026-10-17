import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boardForInfo, builtinBoards, validateBoardAction } from '../src/boards/builtin.js';
import {
  pinRole,
  validateBoardDescriptor,
  type BoardDescriptor,
} from '../src/boards/descriptors.js';

const variantIds = ['esp32-s2-devkitc-1', 'esp32-s3-devkitc-1', 'esp32-c6-devkitc-1'] as const;

function board(boardId: string): BoardDescriptor {
  const found = builtinBoards.find((entry) => entry.boardId === boardId);
  if (!found) throw new Error(`builtinBoards is missing '${boardId}'`);
  return found;
}

function pinLists(entry: BoardDescriptor): Array<[string, number[]]> {
  return [
    ['gpioPins', entry.gpioPins],
    ['adcPins', entry.adcPins ?? []],
    ['pwmPins', entry.pwmPins ?? []],
    ['reservedPins', entry.reservedPins],
    ['inputOnlyPins', entry.inputOnlyPins ?? []],
  ];
}

const variants = variantIds.map((id) => board(id));
const classic = board('esp32-devkit-v1');
const s2 = board('esp32-s2-devkitc-1');
const s3 = board('esp32-s3-devkitc-1');
const c6 = board('esp32-c6-devkitc-1');

describe('ESP32 family variant boards', () => {
  it('gates every variant as EXPERIMENTAL until compile and HIL evidence exists', () => {
    for (const variant of variants) {
      expect(variant.support).toBe('EXPERIMENTAL');
      expect(variant.warnings?.length ?? 0).toBeGreaterThan(0);
      expect(() => validateBoardDescriptor(variant)).not.toThrow();
    }
  });

  it('publishes a firmware/boards JSON that matches each builtin descriptor', () => {
    for (const variant of variants) {
      const json = JSON.parse(
        readFileSync(join(process.cwd(), 'firmware', 'boards', `${variant.boardId}.json`), 'utf8'),
      ) as unknown;
      expect(variant).toEqual(json);
    }
  });

  it('resolves every variant identity and still rejects unknown boards', () => {
    for (const id of variantIds)
      expect(boardForInfo({ boardId: id, firmware: 'esp32-bridge' })?.boardId).toBe(id);
    expect(() => boardForInfo({ boardId: 'esp32-nope', firmware: 'esp32-bridge' })).toThrow(
      /Unknown board identity/,
    );
  });

  it('maps each variant to a distinct firmware target', () => {
    expect(variants.map((variant) => variant.firmwareTarget)).toEqual([
      'esp32s2-devkit', 'esp32s3-devkit', 'esp32c6-devkit',
    ]);
  });

  it('keeps every reserved pin out of the usable list, including the first reserved pin', () => {
    for (const variant of variants) {
      const reserved = variant.reservedPins[0]!;
      expect(variant.gpioPins).not.toContain(reserved);
      expect(() => validateBoardAction(variant, 'gpio.write', { pin: reserved })).toThrow(
        /unavailable or input-only/,
      );
      expect(() => validateBoardAction(variant, 'gpio.read', { pin: reserved })).toThrow(
        /unavailable or input-only/,
      );
      expect(() => validateBoardAction(variant, 'gpio.write', { pin: 4 })).not.toThrow();
      expect(() => validateBoardAction(variant, 'gpio.read', { pin: 4 })).not.toThrow();
    }
  });

  it('keeps reserved and usable pin lists disjoint on every builtin board', () => {
    for (const entry of builtinBoards) {
      const usable = new Set(entry.gpioPins);
      for (const reserved of entry.reservedPins)
        expect(usable.has(reserved), `${entry.boardId} pin ${reserved}`).toBe(false);
    }
  });

  it('rejects writes to input-only pins but still allows reads', () => {
    expect(pinRole(s2, 46)).toBe('input-only');
    expect(() => validateBoardAction(s2, 'gpio.read', { pin: 46 })).not.toThrow();
    expect(() => validateBoardAction(s2, 'gpio.write', { pin: 46 })).toThrow(/input-only/);
    expect(() => validateBoardAction(s2, 'gpio.pwm', { pin: 46, channel: 0 })).toThrow();
    for (const variant of variants) {
      for (const pin of variant.inputOnlyPins ?? []) {
        expect(pinRole(variant, pin)).toBe('input-only');
      }
    }
  });

  it('advertises only real ADC1 pins per variant', () => {
    expect(s2.adcPins).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s3.adcPins).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(c6.adcPins).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(Math.max(...(c6.adcPins ?? []))).toBeLessThanOrEqual(6);
    for (const variant of variants) {
      for (const pin of variant.adcPins ?? []) {
        expect(variant.gpioPins).toContain(pin);
        expect(() => validateBoardAction(variant, 'gpio.analogRead', { pin })).not.toThrow();
      }
    }
    expect(() => validateBoardAction(s2, 'gpio.analogRead', { pin: 11 })).toThrow(/ADC/);
    expect(() => validateBoardAction(s3, 'gpio.analogRead', { pin: 21 })).toThrow(/ADC/);
    expect(() => validateBoardAction(c6, 'gpio.analogRead', { pin: 7 })).toThrow(/ADC/);
  });

  it('bounds PWM channels per family, keeping the C3 error message equivalent', () => {
    const c3 = board('esp32-c3-supermini');
    expect(() => validateBoardAction(classic, 'gpio.pwm', { pin: 4, channel: 15 })).not.toThrow();
    expect(() => validateBoardAction(classic, 'gpio.pwm', { pin: 4, channel: 16 })).toThrow(
      /ESP32 supports PWM channels 0–15/,
    );
    expect(() => validateBoardAction(s2, 'gpio.pwm', { pin: 4, channel: 7 })).not.toThrow();
    expect(() => validateBoardAction(s2, 'gpio.pwm', { pin: 4, channel: 8 })).toThrow(
      /ESP32-S2 supports PWM channels 0–7/,
    );
    expect(() => validateBoardAction(s3, 'gpio.pwm', { pin: 4, channel: 8 })).toThrow(
      /ESP32-S3 supports PWM channels 0–7/,
    );
    expect(() => validateBoardAction(c6, 'gpio.pwm', { pin: 4, channel: 5 })).not.toThrow();
    expect(() => validateBoardAction(c6, 'gpio.pwm', { pin: 4, channel: 6 })).toThrow(
      /ESP32-C6 supports PWM channels 0–5/,
    );
    expect(() => validateBoardAction(c3, 'gpio.pwm', { pin: 4, channel: 5 })).not.toThrow();
    expect(() => validateBoardAction(c3, 'gpio.pwm', { pin: 4, channel: 6 })).toThrow(
      /ESP32-C3 supports PWM channels 0–5/,
    );
  });

  it('exposes more usable GPIOs on the S3 DevKitC-1 than on the C6', () => {
    expect(s3.gpioPins.length).toBeGreaterThan(c6.gpioPins.length);
  });

  it('documents the C6 MTMS strap without reserving GPIO 4', () => {
    expect(c6.gpioPins).toContain(4);
    expect((c6.warnings ?? []).some((warning) => warning.includes('MTMS'))).toBe(true);
  });

  it('keeps bus defaults on usable pins and UART0 out of the GPIO list', () => {
    for (const variant of variants) {
      expect(variant.i2cDefaults).toBeDefined();
      expect(variant.spiDefaults).toBeDefined();
      expect(variant.gpioPins).toContain(variant.i2cDefaults?.sda);
      expect(variant.gpioPins).toContain(variant.i2cDefaults?.scl);
      expect(variant.gpioPins).toContain(variant.spiDefaults?.sck);
      expect(variant.gpioPins).toContain(variant.spiDefaults?.mosi);
      expect(variant.gpioPins).toContain(variant.spiDefaults?.miso);
      for (const uart of variant.uartPins ?? []) {
        expect(variant.gpioPins).not.toContain(uart.tx);
        expect(variant.gpioPins).not.toContain(uart.rx);
      }
    }
  });

  it('has no duplicate pins in any descriptor list and no duplicate firmware targets', () => {
    for (const entry of builtinBoards) {
      for (const [name, pins] of pinLists(entry)) {
        expect(new Set(pins).size, `${entry.boardId}.${name}`).toBe(pins.length);
      }
    }
    const targets = builtinBoards.map((entry) => entry.firmwareTarget);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('keeps the classic esp32-devkit-v1 descriptor unchanged for the esp32dev env', () => {
    expect(classic.family).toBe('esp32');
    expect(classic.firmwareTarget).toBe('esp32dev');
    expect(classic.support).toBe('IMPLEMENTED');
    expect(classic.gpioPins).toHaveLength(23);
    expect(classic.gpioPins).toContain(4);
    expect(classic.reservedPins).toEqual([1, 3, 6, 7, 8, 9, 10, 11, 12]);
    expect(classic.inputOnlyPins).toEqual([34, 35, 36, 39]);
  });
});
