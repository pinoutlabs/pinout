import { describe, expect, it } from 'vitest';
import moduleDefinition from '../src/index.js';
import { RoomSensorBackend } from '../src/backend.js';

describe('room-sensor module', () => {
  it('declares expected capabilities', () => {
    expect(moduleDefinition.capabilityNames).toEqual([
      'sensor.read',
      'temperature.read',
      'humidity.read',
      'pressure.read',
      'status.read',
    ]);
  });

  it('creates a simulated backend by default', () => {
    const backend = moduleDefinition.createSimulatedBackend!({});
    expect(backend.kind).toBe('simulated');
  });

  it('reads a structured environment sample from the simulator', async () => {
    const backend = moduleDefinition.createSimulatedBackend!({
      sensorFamily: 'bme280',
      seedTemperatureC: 21.0,
      seedHumidityPercent: 50,
      seedPressurePa: 101_300,
    });
    const result = await backend.invoke('sensor.read', {});
    expect(result.temperatureC).toBeTypeOf('number');
    expect(result.humidityPercent).toBeTypeOf('number');
    expect(result.pressurePa).toBeTypeOf('number');
    expect(result.sensorFamily).toBe('bme280');
    expect(result.source).toBe('simulated');
    expect(result.provenance).toBe('simulated');
    expect(typeof result.observedAt).toBe('string');
    await backend.close();
  });

  it('omits pressure for DHT family and rejects pressure.read', async () => {
    const backend = moduleDefinition.createSimulatedBackend!({
      sensorFamily: 'dht22',
    });
    const reading = await backend.invoke('sensor.read', {});
    expect(reading.pressurePa).toBeNull();
    await expect(backend.invoke('pressure.read', {})).rejects.toThrow(/Pressure is not available/);
    await backend.close();
  });

  it('follows the physical evidence contract on reads', async () => {
    const backend = new RoomSensorBackend({
      sensorFamily: 'bme280',
      observationMaxAgeMs: 10_000,
    });

    const before = await backend.invoke('status.read', {});
    expect(before.commanded).toMatchObject({ value: null, at: null, source: 'none' });
    expect(before.acknowledged).toMatchObject({ value: null, at: null, source: 'none' });
    expect(before.observed).toMatchObject({ value: null, at: null, source: 'none' });
    expect(before.freshnessMs).toBeNull();

    await backend.invoke('sensor.read', {});
    const after = await backend.invoke('status.read', {});

    // Reads update observed only — never invent commanded/acknowledged from a read.
    expect(after.commanded).toMatchObject({ value: null, at: null, source: 'none' });
    expect(after.acknowledged).toMatchObject({ value: null, at: null, source: 'none' });
    expect(after.observed.value).not.toBeNull();
    expect(after.observed.at).toBeTypeOf('string');
    expect(after.observed.source).toBe('simulated');
    expect(after.freshnessMs).toBeTypeOf('number');
    expect(after.stale).toBe(false);
    expect(after.provenance).toBe('simulated');
    expect(after.simulated).toBe(true);

    const evidence = backend.getOperationalStateEvidence!();
    expect(evidence.environment.observed.source).toBe('simulated');
    expect(evidence.environment.commanded.value).toBeNull();
    expect(evidence.environment.acknowledged.value).toBeNull();

    await backend.close();
  });

  it('refuses non-simulated reads (honest SIMULATED status)', async () => {
    const backend = new RoomSensorBackend({ simulated: false });
    expect(backend.kind).toBe('protocol');
    await expect(backend.invoke('sensor.read', {})).rejects.toThrow(/not implemented/i);
    await backend.close();
  });

  it('rejects unknown actions', async () => {
    const backend = moduleDefinition.createSimulatedBackend!({});
    await expect(backend.invoke('sensor.write', {})).rejects.toThrow(/Unsupported capability/);
    await backend.close();
  });
});
