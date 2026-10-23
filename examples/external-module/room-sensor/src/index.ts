import { defineModule, action, sensorRead } from '@pinout/core';
import { RoomSensorBackend } from './backend.js';

/**
 * Local maker module for BME280 (I2C) and DHT11/DHT22 room climate sensors.
 *
 * Status: SIMULATED — simulator-backed only. Wiring notes for ESP32 / MicroPython
 * are documented; no physical or compile-tested firmware driver is claimed.
 */
export default defineModule({
  id: 'room-sensor/environment',
  version: '0.1.0',
  device: {
    class: 'sensor.environment',
    vendor: 'Pinout Labs (makers)',
    model: 'BME280/DHT',
    name: 'Room Environment Sensor',
    description:
      'BME280 and DHT-family room temperature, humidity, and pressure sensor module (SIMULATED).',
  },
  capabilities: [
    sensorRead('sensor.read', 'Read temperature, humidity, and pressure (when available).', {
      type: 'object',
      additionalProperties: false,
      properties: {
        temperatureC: { type: 'number', description: 'Temperature in °C.' },
        humidityPercent: { type: 'number', description: 'Relative humidity percentage.' },
        pressurePa: {
          description: 'Absolute pressure in Pascals, or null for DHT sensors.',
        },
        sensorFamily: { type: 'string', enum: ['bme280', 'dht11', 'dht22'] },
        observedAt: { type: 'string', description: 'ISO timestamp of the observation.' },
        source: { type: 'string', enum: ['sensor', 'simulated'] },
        provenance: { type: 'string', enum: ['simulated', 'hardware', 'unknown'] },
      },
      required: [
        'temperatureC',
        'humidityPercent',
        'pressurePa',
        'sensorFamily',
        'observedAt',
        'source',
        'provenance',
      ],
    }),
    sensorRead('temperature.read', 'Read current temperature in °C.', {
      type: 'object',
      additionalProperties: false,
      properties: {
        temperatureC: { type: 'number' },
        unit: { type: 'string', enum: ['C'] },
        observedAt: { type: 'string' },
        source: { type: 'string', enum: ['sensor', 'simulated'] },
        provenance: { type: 'string', enum: ['simulated', 'hardware', 'unknown'] },
      },
      required: ['temperatureC', 'unit', 'observedAt', 'source', 'provenance'],
    }),
    sensorRead('humidity.read', 'Read current relative humidity.', {
      type: 'object',
      additionalProperties: false,
      properties: {
        humidityPercent: { type: 'number' },
        unit: { type: 'string', enum: ['percent'] },
        observedAt: { type: 'string' },
        source: { type: 'string', enum: ['sensor', 'simulated'] },
        provenance: { type: 'string', enum: ['simulated', 'hardware', 'unknown'] },
      },
      required: ['humidityPercent', 'unit', 'observedAt', 'source', 'provenance'],
    }),
    sensorRead('pressure.read', 'Read absolute pressure in Pascals (BME280 only).', {
      type: 'object',
      additionalProperties: false,
      properties: {
        pressurePa: { type: 'number' },
        unit: { type: 'string', enum: ['Pa'] },
        observedAt: { type: 'string' },
        source: { type: 'string', enum: ['sensor', 'simulated'] },
        provenance: { type: 'string', enum: ['simulated', 'hardware', 'unknown'] },
      },
      required: ['pressurePa', 'unit', 'observedAt', 'source', 'provenance'],
    }),
    action({
      id: 'status.read',
      description:
        'Read connectivity, evidence (commanded/acknowledged/observed/freshness), and wiring config.',
      output: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ready', 'faulted'] },
          sensorFamily: { type: 'string', enum: ['bme280', 'dht11', 'dht22'] },
          simulated: { type: 'boolean' },
          commanded: { type: 'object' },
          acknowledged: { type: 'object' },
          observed: { type: 'object' },
          freshnessMs: { description: 'Age of last observation in ms, or null.' },
          stale: { type: 'boolean' },
          provenance: { type: 'string', enum: ['simulated', 'hardware', 'unknown'] },
          lastReading: { description: 'Last structured reading, or null before first read.' },
          wiring: { type: 'object' },
        },
        required: [
          'status',
          'sensorFamily',
          'simulated',
          'commanded',
          'acknowledged',
          'observed',
          'freshnessMs',
          'stale',
          'provenance',
        ],
      },
    }),
  ],
  supportedTransportKinds: ['simulated'],
  createBackend(config) {
    return new RoomSensorBackend(config);
  },
});
