import type { CapabilityDescriptor, DeviceBackend, PinoutModuleDefinition } from '@pinout/core';
import { defaultMqttBridgeMapping, MqttBackend } from './mqttBackend.js';
import type { MqttMapping } from './mapping.js';
import type { MqttClient } from './mqttClient.js';

export const mqttBridgeModuleId = 'pinout/mqtt-bridge';

function publishCapabilities(mapping: MqttMapping): CapabilityDescriptor[] {
  return mapping.publishes.map((rule) => ({
    name: rule.capability,
    description: `Publish MQTT mapping '${rule.capability}' to topic '${rule.topic}'.`,
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {},
    },
    outputSchema: {
      type: 'object',
      required: ['topic', 'payload'],
      properties: {
        topic: { type: 'string' },
        payload: { type: 'string' },
      },
    },
    safety: {
      physicalOutput: true,
      reversible: true,
      notes: 'MQTT publish. Physical effect depends on the remote subscriber, not this adapter.',
    },
  }));
}

export function createMqttBridgeModule(
  mapping: MqttMapping = defaultMqttBridgeMapping,
): PinoutModuleDefinition {
  const capabilities: CapabilityDescriptor[] = [
    {
      name: 'mqtt.status',
      description: 'Read last ingested and commanded MQTT bridge state.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      safety: { physicalOutput: false, reversible: true },
    },
    ...publishCapabilities(mapping),
  ];
  return {
    id: mqttBridgeModuleId,
    version: '0.1.0',
    deviceClass: 'bridge.mqtt',
    vendor: 'Pinout',
    model: 'MQTT Bridge',
    capabilities,
    capabilityNames: capabilities.map((capability) => capability.name),
    policies: [],
    supportedTransportKinds: ['simulated', 'tcp'],
    createSimulatedBackend(options: Record<string, unknown> = {}): DeviceBackend {
      const resolvedMapping =
        options.mapping && typeof options.mapping === 'object'
          ? (options.mapping as MqttMapping)
          : mapping;
      return MqttBackend.createSimulated({
        mapping: resolvedMapping,
        ...(typeof options.clientId === 'string' ? { clientId: options.clientId } : {}),
        ...(options.client ? { client: options.client as MqttClient } : {}),
      });
    },
    async createProtocolBackend(options: Record<string, unknown>): Promise<DeviceBackend> {
      const resolvedMapping =
        options.mapping && typeof options.mapping === 'object'
          ? (options.mapping as MqttMapping)
          : mapping;
      return MqttBackend.create({
        mapping: resolvedMapping,
        simulated: false,
        ...(options.client ? { client: options.client as MqttClient } : {}),
        ...(typeof options.clientId === 'string' ? { clientId: options.clientId } : {}),
      });
    },
  };
}

export const mqttBridgeModule: PinoutModuleDefinition = createMqttBridgeModule();
