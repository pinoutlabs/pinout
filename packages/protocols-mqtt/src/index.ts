export {
  encodeConnect,
  encodeSubscribe,
  encodePublish,
  encodePingReq,
  encodeDisconnect,
  encodeRemainingLength,
  tryDecodePacket,
} from './wire.js';
export type { MqttPacket, MqttPacketType, ConnectOptions } from './wire.js';
export { MqttClient } from './mqttClient.js';
export type { MqttClientOptions, MessageHandler } from './mqttClient.js';
export { MqttError } from './errors.js';
export {
  decodeIngestion,
  encodePublishPayload,
  topicMatches,
  esp32MqttTopicPrefix,
} from './mapping.js';
export type { MqttMapping, TopicIngestRule, PublishRule, MappedIngestion } from './mapping.js';
export { MqttBrokerSimulator } from './brokerSimulator.js';
export {
  MqttBackend,
  createMqttBackend,
  defaultMqttBridgeMapping,
  type MqttBackendOptions,
} from './mqttBackend.js';
export { mqttBridgeModule, mqttBridgeModuleId, createMqttBridgeModule } from './mqttModule.js';
export {
  resolveMqttLampTopics,
  buildMqttLampMapping,
  parseMqttLampPayload,
  type MqttLampPreset,
  type MqttLampTopicTemplates,
  type ResolvedMqttLampTopics,
} from './lampTopics.js';
export {
  MqttLampBackend,
  createMqttLampBackend,
  validateMqttLampConfig,
  type MqttLampConfig,
  type ValidatedMqttLampConfig,
} from './lampBackend.js';
export { mqttLampModule, mqttLampModuleId, createMqttLampModule } from './lampModule.js';
export {
  createEsp32MqttMapping,
  defaultEsp32MqttMapping,
  defaultEsp32MqttDeviceId,
} from './esp32MqttMapping.js';
export type { Esp32MqttMappingOptions } from './esp32MqttMapping.js';
export { Esp32MqttDeviceSimulator } from './esp32MqttDeviceSimulator.js';
export type { Esp32MqttDeviceSimulatorOptions } from './esp32MqttDeviceSimulator.js';
export {
  Esp32MqttBackend,
  createEsp32MqttBackend,
  type Esp32MqttBackendOptions,
} from './esp32MqttBackend.js';
export { esp32MqttModule, esp32MqttModuleId, createEsp32MqttModule } from './esp32MqttModule.js';
