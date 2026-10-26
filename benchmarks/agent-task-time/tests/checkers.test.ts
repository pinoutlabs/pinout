import { describe, expect, it } from 'vitest';
import { BenchDevice } from '../src/devices/benchDevice.js';
import {
  checkBlinkLed,
  checkReadSensor,
  checkServoSweep,
} from '../src/tasks/definitions.js';

describe('automatic success checkers', () => {
  it('passes blink when LED goes high then low on esp32', () => {
    const bench = new BenchDevice('esp32');
    bench.applyAction('sys.arm', { timeoutMs: 5000 });
    bench.applyAction('gpio.write', { pin: 2, value: true });
    bench.applyAction('gpio.write', { pin: 2, value: false });
    const result = checkBlinkLed(bench.snapshot(), 'esp32');
    expect(result.success).toBe(true);
  });

  it('fails blink when LED only goes high', () => {
    const bench = new BenchDevice('pico');
    bench.applyAction('sys.arm', { timeoutMs: 5000 });
    bench.applyAction('gpio.write', { pin: 25, value: true });
    const result = checkBlinkLed(bench.snapshot(), 'pico');
    expect(result.success).toBe(false);
  });

  it('passes servo sweep to 90 then 0 on uno', () => {
    const bench = new BenchDevice('uno');
    bench.applyAction('sys.arm', { timeoutMs: 5000 });
    bench.applyAction('gpio.servo', { pin: 9, angle: 90 });
    bench.applyAction('gpio.servo', { pin: 9, angle: 0 });
    const result = checkServoSweep(bench.snapshot(), 'uno');
    expect(result.success).toBe(true);
  });

  it('passes sensor read when analogRead is journaled', () => {
    const bench = new BenchDevice('esp32');
    bench.applyAction('gpio.analogRead', { pin: 34 });
    const result = checkReadSensor(bench.snapshot(), 'esp32');
    expect(result.success).toBe(true);
    expect(result.observed.samples).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 2048 })]),
    );
  });

  it('does not treat model claims as success', () => {
    const bench = new BenchDevice('esp32');
    const result = checkBlinkLed(bench.snapshot(), 'esp32');
    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/journal/i);
  });
});
