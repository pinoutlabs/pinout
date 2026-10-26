import { describe, expect, it } from 'vitest';
import {
  modelOmitsTemperature,
  resolveTemperaturePolicy,
} from '../src/llm/temperature.js';

describe('temperature policy', () => {
  it('detects reasoning-family models that omit temperature', () => {
    expect(modelOmitsTemperature('gpt-6.1-sol')).toBe(true);
    expect(modelOmitsTemperature('gpt-5.4')).toBe(true);
    expect(modelOmitsTemperature('o3-mini')).toBe(true);
    expect(modelOmitsTemperature('gpt-4o-mini')).toBe(false);
  });

  it('records model default and does not send temperature for gpt-6', () => {
    const policy = resolveTemperaturePolicy({
      modelId: 'gpt-6.1-sol',
      requested: 0,
      temperatureExplicitlySet: true,
    });
    expect(policy.send).toBeUndefined();
    expect(policy.record).toBe('model default');
    expect(policy.note).toMatch(/rejects temperature/i);
  });

  it('sends and records numeric temperature for chat models', () => {
    const policy = resolveTemperaturePolicy({
      modelId: 'gpt-4o-mini',
      requested: 0.2,
      temperatureExplicitlySet: true,
    });
    expect(policy.send).toBe(0.2);
    expect(policy.record).toBe(0.2);
  });

  it('defaults chat models to 0 when not explicitly set', () => {
    const policy = resolveTemperaturePolicy({
      modelId: 'gpt-4o-mini',
      requested: undefined,
      temperatureExplicitlySet: false,
    });
    expect(policy.send).toBe(0);
    expect(policy.record).toBe(0);
  });
});
