import type { CapabilityDescriptor, DeviceBackend, PinoutModuleDefinition } from '@pinout/core';
import { Esp32MqttBackend } from './esp32MqttBackend.js';
import { createEsp32MqttMapping, defaultEsp32MqttDeviceId } from './esp32MqttMapping.js';
import type { MqttMapping } from './mapping.js';
import type { MqttClient } from './mqttClient.js';

export const esp32MqttModuleId = 'pinout/esp32-mqtt';

const statusCapability: CapabilityDescriptor = {
  name: 'mqtt.status',
  description:
    'Read ESP32 MQTT bridge operational state (armed, gpio table, topic prefix). Status: SIMULATED in CI.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: { type: 'object', additionalProperties: true, properties: {} },
  safety: { physicalOutput: false, reversible: true },
};

function capabilityDescriptors(mapping: MqttMapping): CapabilityDescriptor[] {
  const fromPublishes: CapabilityDescriptor[] = mapping.publishes.map((rule) => {
    const physical = rule.capability.startsWith('gpio.');
    return {
      name: rule.capability,
      description: `ESP32 MQTT mapping '${rule.capability}' → topic '${rule.topic}'.`,
      inputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {},
      },
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          topic: { type: 'string' },
          payload: { type: 'string' },
        },
      },
      safety: {
        physicalOutput: physical,
        reversible: true,
        notes:
          'LAN MQTT publish. Physical effect depends on firmware/subscribers; simulator path is SIMULATED only.',
      },
    };
  });
  return [statusCapability, ...fromPublishes];
}

export function createEsp32MqttModule(
  mapping: MqttMapping = createEsp32MqttMapping(),
): PinoutModuleDefinition {
  const capabilities = capabilityDescriptors(mapping);
  return {
    id: esp32MqttModuleId,
    version: '0.1.0',
    deviceClass: 'bridge.mqtt',
    vendor: 'Pinout',
    model: 'ESP32 Wi-Fi MQTT Bridge',
    capabilities,
    capabilityNames: capabilities.map((capability) => capability.name),
    policies: [],
    supportedTransportKinds: ['simulated', 'tcp'],
    createSimulatedBackend(options: Record<string, unknown> = {}): DeviceBackend {
      // Async setup is deferred via Esp32MqttBackend.create; sync module API
      // returns a thin wrapper that awaits create on first invoke.
      return new LazyEsp32MqttBackend(options, mapping, true);
    },
    async createProtocolBackend(options: Record<string, unknown>): Promise<DeviceBackend> {
      const deviceId =
        typeof options.deviceId === 'string' ? options.deviceId : defaultEsp32MqttDeviceId;
      const resolvedMapping =
        options.mapping && typeof options.mapping === 'object'
          ? (options.mapping as MqttMapping)
          : createEsp32MqttMapping({ deviceId });
      return Esp32MqttBackend.create({
        mapping: resolvedMapping,
        deviceId,
        simulated: false,
        ...(options.client ? { client: options.client as MqttClient } : {}),
        ...(typeof options.clientId === 'string' ? { clientId: options.clientId } : {}),
      });
    },
  };
}

/**
 * PinoutModuleDefinition.createSimulatedBackend is synchronous; this wrapper
 * starts the broker + device simulator on first use.
 */
class LazyEsp32MqttBackend implements DeviceBackend {
  readonly kind = 'simulated' as const;
  private backend: Esp32MqttBackend | undefined;
  private readonly ready: Promise<Esp32MqttBackend>;

  constructor(options: Record<string, unknown>, fallbackMapping: MqttMapping, simulated: boolean) {
    const deviceId =
      typeof options.deviceId === 'string' ? options.deviceId : defaultEsp32MqttDeviceId;
    const resolvedMapping =
      options.mapping && typeof options.mapping === 'object'
        ? (options.mapping as MqttMapping)
        : options.deviceId
          ? createEsp32MqttMapping({ deviceId })
          : fallbackMapping;
    this.ready = Esp32MqttBackend.create({
      mapping: resolvedMapping,
      deviceId,
      simulated,
      ...(typeof options.clientId === 'string' ? { clientId: options.clientId } : {}),
      ...(options.client ? { client: options.client as MqttClient } : {}),
      ...(options.autoArm === true ? { autoArm: true } : {}),
    }).then((backend) => {
      this.backend = backend;
      return backend;
    });
  }

  async invoke(
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const backend = await this.ready;
    return backend.invoke(action, payload);
  }

  async close(): Promise<void> {
    const backend = await this.ready.catch(() => undefined);
    await backend?.close();
  }

  subscribe(handler: (event: string, payload: Record<string, unknown>) => void): () => void {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    void this.ready.then((backend) => {
      if (cancelled) return;
      unsubscribe = backend.subscribe(handler);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }

  getOperationalState(): Record<string, unknown> {
    return this.backend?.getOperationalState() ?? { evidenceStatus: 'SIMULATED', pending: true };
  }

  getOperationalStateEvidence() {
    return this.backend?.getOperationalStateEvidence() ?? {};
  }
}

export const esp32MqttModule: PinoutModuleDefinition = createEsp32MqttModule();
