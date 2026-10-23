import {
  computeFreshness,
  recordObserved,
  unknownEvidence,
  type DeviceBackend,
  type EvidenceState,
} from '@pinout/core';
import {
  validateRoomSensorConfig,
  type RoomSensorReading,
  type RoomSensorStatus,
  type SensorFamily,
  type ValidatedRoomSensorConfig,
} from './types.js';

/**
 * Simulated (and future protocol) backend for BME280 / DHT room sensors.
 *
 * Honesty rule: sensor reads only update `observed`. There is no write path, so
 * `commanded` / `acknowledged` stay null — a successful invoke never pretends a
 * prior command implied a physical reading.
 */
export class RoomSensorBackend implements DeviceBackend {
  readonly kind: 'simulated' | 'protocol';
  private readonly config: ValidatedRoomSensorConfig;
  private closed = false;
  private readonly handlers = new Set<(event: string, payload: Record<string, unknown>) => void>();
  private evidence: EvidenceState<RoomSensorReading>;
  private lastReading: RoomSensorReading | null = null;
  private sampleIndex = 0;

  constructor(rawConfig: Record<string, unknown> = {}) {
    this.config = validateRoomSensorConfig(rawConfig);
    this.kind = this.config.simulated ? 'simulated' : 'protocol';
    this.evidence = unknownEvidence<RoomSensorReading>(this.config.provenance);
  }

  async invoke(
    action: string,
    _payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new Error('Room sensor backend is closed.');
    }

    // Protocol path exists for conformance flag parity only — no silent fake hardware reads.
    if (!this.config.simulated) {
      throw new Error(
        'Room sensor hardware backend is not implemented (status: SIMULATED). Use simulated: true. See docs/room-sensor.md for ESP32/MicroPython wiring notes.',
      );
    }

    switch (action) {
      case 'sensor.read':
        return { ...this.readEnvironment() };
      case 'temperature.read': {
        const reading = this.readEnvironment();
        return {
          temperatureC: reading.temperatureC,
          unit: 'C',
          observedAt: reading.observedAt,
          source: reading.source,
          provenance: reading.provenance,
        };
      }
      case 'humidity.read': {
        const reading = this.readEnvironment();
        return {
          humidityPercent: reading.humidityPercent,
          unit: 'percent',
          observedAt: reading.observedAt,
          source: reading.source,
          provenance: reading.provenance,
        };
      }
      case 'pressure.read': {
        const reading = this.readEnvironment();
        if (reading.pressurePa === null) {
          throw new Error(
            `Pressure is not available for sensor family '${this.config.sensorFamily}' (DHT reports temp/humidity only).`,
          );
        }
        return {
          pressurePa: reading.pressurePa,
          unit: 'Pa',
          observedAt: reading.observedAt,
          source: reading.source,
          provenance: reading.provenance,
        };
      }
      case 'status.read':
        return { ...this.buildStatus() };
      default:
        throw new Error(`Unsupported capability '${action}'.`);
    }
  }

  subscribe(handler: (event: string, payload: Record<string, unknown>) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  getOperationalState(): Record<string, unknown> {
    return this.buildStatus() as unknown as Record<string, unknown>;
  }

  getOperationalStateEvidence(): Record<string, EvidenceState<unknown>> {
    const fresh = computeFreshness(
      this.evidence,
      Date.now(),
      this.config.observationMaxAgeMs,
    );
    return {
      environment: fresh as EvidenceState<unknown>,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
  }

  private readEnvironment(): RoomSensorReading {
    const reading = this.sampleReading();
    this.lastReading = reading;
    this.evidence = recordObserved(
      this.evidence,
      reading,
      reading.source,
      reading.observedAt,
      this.config.provenance,
      this.config.observationMaxAgeMs,
    );
    // commanded / acknowledged intentionally untouched (remain null / none).
    this.emit('sensor.reading', {
      temperatureC: reading.temperatureC,
      humidityPercent: reading.humidityPercent,
      pressurePa: reading.pressurePa,
      observedAt: reading.observedAt,
    });
    return reading;
  }

  private sampleReading(): RoomSensorReading {
    const family = this.config.sensorFamily;
    const jitter = Math.sin(this.sampleIndex / 3) * 0.15;
    this.sampleIndex += 1;

    const temperatureC = round1(this.config.seedTemperatureC + jitter);
    const humidityPercent = clamp(
      round1(this.config.seedHumidityPercent + jitter * 2),
      0,
      100,
    );
    const pressurePa = supportsPressure(family)
      ? Math.round(this.config.seedPressurePa + jitter * 20)
      : null;

    return {
      temperatureC,
      humidityPercent,
      pressurePa,
      sensorFamily: family,
      observedAt: new Date().toISOString(),
      source: 'simulated',
      provenance: this.config.provenance,
    };
  }

  private buildStatus(): RoomSensorStatus {
    const now = Date.now();
    const fresh = computeFreshness(this.evidence, now, this.config.observationMaxAgeMs);
    return {
      status: 'ready',
      sensorFamily: this.config.sensorFamily,
      simulated: this.config.simulated,
      commanded: fresh.commanded,
      acknowledged: fresh.acknowledged,
      observed: fresh.observed,
      freshnessMs: fresh.freshnessMs,
      stale: fresh.stale,
      provenance: fresh.provenance,
      lastReading: this.lastReading,
      wiring: {
        i2cAddress: this.config.i2cAddress,
        sdaPin: this.config.sdaPin,
        sclPin: this.config.sclPin,
        dhtPin: this.config.dhtPin,
      },
    };
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    for (const handler of this.handlers) {
      handler(event, payload);
    }
  }
}

function supportsPressure(family: SensorFamily): boolean {
  return family === 'bme280';
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
