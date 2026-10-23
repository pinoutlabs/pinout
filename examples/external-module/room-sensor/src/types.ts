import type { EvidenceProvenance, EvidenceState } from '@pinout/core';

export type SensorFamily = 'bme280' | 'dht11' | 'dht22';

export type RoomSensorOperationalStatus = 'ready' | 'faulted';

export interface RoomSensorReading {
  temperatureC: number;
  humidityPercent: number;
  /** Absolute pressure in Pascals. Present for BME280; null for DHT family. */
  pressurePa: number | null;
  sensorFamily: SensorFamily;
  observedAt: string;
  source: 'sensor' | 'simulated';
  provenance: EvidenceProvenance;
}

export interface RoomSensorConfig {
  sensorFamily?: SensorFamily;
  /** BME280 I2C address (typically 0x76 or 0x77). */
  i2cAddress?: number;
  /** DHT data pin (ESP32 GPIO number). Ignored for BME280. */
  dhtPin?: number;
  /** I2C SDA pin. Default ESP32 classic: 21. */
  sdaPin?: number;
  /** I2C SCL pin. Default ESP32 classic: 22. */
  sclPin?: number;
  observationMaxAgeMs?: number;
  provenance?: EvidenceProvenance;
  simulated?: boolean;
  /** Seed temperature °C for the simulator. */
  seedTemperatureC?: number;
  /** Seed relative humidity % for the simulator. */
  seedHumidityPercent?: number;
  /** Seed pressure Pa for the simulator (BME280). */
  seedPressurePa?: number;
}

export interface ValidatedRoomSensorConfig {
  sensorFamily: SensorFamily;
  i2cAddress: number;
  dhtPin: number;
  sdaPin: number;
  sclPin: number;
  observationMaxAgeMs: number;
  provenance: EvidenceProvenance;
  simulated: boolean;
  seedTemperatureC: number;
  seedHumidityPercent: number;
  seedPressurePa: number;
}

export interface RoomSensorStatus {
  status: RoomSensorOperationalStatus;
  sensorFamily: SensorFamily;
  simulated: boolean;
  commanded: EvidenceState<RoomSensorReading>['commanded'];
  acknowledged: EvidenceState<RoomSensorReading>['acknowledged'];
  observed: EvidenceState<RoomSensorReading>['observed'];
  freshnessMs: number | null;
  stale: boolean;
  provenance: EvidenceProvenance;
  lastReading: RoomSensorReading | null;
  wiring: {
    i2cAddress: number;
    sdaPin: number;
    sclPin: number;
    dhtPin: number;
  };
}

export function validateRoomSensorConfig(
  rawConfig: Record<string, unknown> = {},
): ValidatedRoomSensorConfig {
  const sensorFamily = normalizeSensorFamily(rawConfig.sensorFamily);
  const i2cAddress =
    typeof rawConfig.i2cAddress === 'number' && Number.isInteger(rawConfig.i2cAddress)
      ? rawConfig.i2cAddress
      : 0x76;
  const dhtPin =
    typeof rawConfig.dhtPin === 'number' && Number.isInteger(rawConfig.dhtPin)
      ? rawConfig.dhtPin
      : 4;
  const sdaPin =
    typeof rawConfig.sdaPin === 'number' && Number.isInteger(rawConfig.sdaPin)
      ? rawConfig.sdaPin
      : 21;
  const sclPin =
    typeof rawConfig.sclPin === 'number' && Number.isInteger(rawConfig.sclPin)
      ? rawConfig.sclPin
      : 22;

  let observationMaxAgeMs = 5000;
  if (rawConfig.observationMaxAgeMs !== undefined) {
    if (
      typeof rawConfig.observationMaxAgeMs !== 'number' ||
      !Number.isFinite(rawConfig.observationMaxAgeMs) ||
      rawConfig.observationMaxAgeMs <= 0
    ) {
      throw new Error('observationMaxAgeMs must be a positive finite number.');
    }
    observationMaxAgeMs = rawConfig.observationMaxAgeMs;
  }

  const simulated = rawConfig.simulated !== false;
  const provenance: EvidenceProvenance =
    rawConfig.provenance === 'hardware'
      ? 'hardware'
      : ((rawConfig.provenance as EvidenceProvenance | undefined) ??
        (simulated ? 'simulated' : 'unknown'));

  return {
    sensorFamily,
    i2cAddress,
    dhtPin,
    sdaPin,
    sclPin,
    observationMaxAgeMs,
    provenance,
    simulated,
    seedTemperatureC:
      typeof rawConfig.seedTemperatureC === 'number' ? rawConfig.seedTemperatureC : 22.4,
    seedHumidityPercent:
      typeof rawConfig.seedHumidityPercent === 'number' ? rawConfig.seedHumidityPercent : 47.5,
    seedPressurePa:
      typeof rawConfig.seedPressurePa === 'number' ? rawConfig.seedPressurePa : 101_325,
  };
}

function normalizeSensorFamily(value: unknown): SensorFamily {
  if (value === 'bme280' || value === 'dht11' || value === 'dht22') {
    return value;
  }
  return 'bme280';
}
