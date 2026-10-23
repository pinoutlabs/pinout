/**
 * Declarative MQTT mapping for the local ESP32 Wi-Fi bridge.
 *
 * Host publishes commands under `pinout/esp32/{deviceId}/cmd/...`.
 * The board (or {@link Esp32MqttDeviceSimulator}) publishes armed/gpio state
 * and identity events under `state/` and `evt/`.
 */
import { esp32MqttTopicPrefix, type MqttMapping } from './mapping.js';

export const defaultEsp32MqttDeviceId = 'local';

export interface Esp32MqttMappingOptions {
  /** MQTT device id segment; default `local`. */
  deviceId?: string;
}

export function createEsp32MqttMapping(options: Esp32MqttMappingOptions = {}): MqttMapping {
  const deviceId = options.deviceId ?? defaultEsp32MqttDeviceId;
  const prefix = esp32MqttTopicPrefix(deviceId);
  return {
    publishes: [
      {
        capability: 'sys.arm',
        topic: `${prefix}/cmd/sys.arm`,
        payload: '',
        codec: 'json',
      },
      {
        capability: 'sys.disarm',
        topic: `${prefix}/cmd/sys.disarm`,
        payload: '',
        codec: 'json',
      },
      {
        capability: 'gpio.write',
        topic: `${prefix}/cmd/gpio.write`,
        payload: '',
        codec: 'json',
        qos: 0,
      },
      {
        capability: 'gpio.toggle',
        topic: `${prefix}/cmd/gpio.toggle`,
        payload: '',
        codec: 'json',
      },
      {
        capability: 'gpio.read',
        topic: `${prefix}/cmd/gpio.read`,
        payload: '',
        codec: 'json',
      },
    ],
    ingests: [
      {
        topic: `${prefix}/state/armed`,
        as: { kind: 'state', field: 'armed' },
        codec: 'text',
      },
      {
        topic: `${prefix}/state/gpio/+`,
        as: { kind: 'event', event: 'gpio.state' },
        codec: 'number',
      },
      {
        topic: `${prefix}/evt/hello`,
        as: { kind: 'event', event: 'sys.hello' },
        codec: 'json',
      },
      {
        topic: `${prefix}/evt/error`,
        as: { kind: 'event', event: 'mqtt.error' },
        codec: 'json',
      },
    ],
  };
}

export const defaultEsp32MqttMapping: MqttMapping = createEsp32MqttMapping();
