import type { DeviceBackend, PinoutModuleDefinition } from '@pinout/core';
import { lampCapabilities } from '@pinout/core';
import { MqttLampBackend } from './lampBackend.js';
import type { MqttClient } from './mqttClient.js';
import type { MqttMapping } from './mapping.js';

export const mqttLampModuleId = 'pinout/mqtt-lamp';

const lampCapabilityNames = lampCapabilities.map((capability) => capability.name);

/**
 * Commissioned lamp / smart-plug module over MQTT (Tasmota/Shelly topic mapping).
 * Audience: local Wi-Fi homes — not industrial Modbus cells.
 *
 * Prefer {@link createMqttLampBackend} for tests. Runtime registration uses
 * `createSimulatedBackend` (in-process broker) or `createProtocolBackend`
 * (TCP to a LAN broker when `simulated: false` and host/port are set).
 */
export const mqttLampModule: PinoutModuleDefinition = {
  id: mqttLampModuleId,
  version: '0.1.0',
  deviceClass: 'actuator.lamp',
  vendor: 'Pinout',
  model: 'MQTT Home Lamp / Plug',
  capabilities: [...lampCapabilities],
  capabilityNames: [...lampCapabilityNames],
  policies: [],
  supportedTransportKinds: ['simulated', 'tcp'],
  createSimulatedBackend(options: Record<string, unknown> = {}): DeviceBackend {
    return MqttLampBackend.createSimulated({
      polarity: 'active-high',
      safeLevel: 'low',
      requireWatchdog: false,
      ...options,
      ...(options.client ? { client: options.client as MqttClient } : {}),
      ...(options.mapping ? { mapping: options.mapping as MqttMapping } : {}),
    });
  },
  async createProtocolBackend(options: Record<string, unknown> = {}): Promise<DeviceBackend> {
    return MqttLampBackend.create({
      polarity: 'active-high',
      safeLevel: 'low',
      requireWatchdog: false,
      ...options,
      ...(options.client ? { client: options.client as MqttClient } : {}),
      ...(options.mapping ? { mapping: options.mapping as MqttMapping } : {}),
    });
  },
};

export function createMqttLampModule(): PinoutModuleDefinition {
  return mqttLampModule;
}
