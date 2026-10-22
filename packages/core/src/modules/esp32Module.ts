import { describeCapabilities, firstPartyCapabilities } from '../capabilities.js';
import { connect } from '../connect.js';
import { simulatedEsp32 } from '../drivers/esp32/simulatedTransport.js';
import { createLogger } from '../logger.js';
import {
  assertGpioPin,
  assertPolarity,
  assertSafeLevel,
  type GpioPolarity,
  type GpioSafeLevel,
} from '../drivers/esp32/pins.js';
import { ValidationError } from '../errors.js';
import type { ConnectOptions, Transport } from '../types.js';
import type { DeviceBackend, PinoutModuleDefinition } from '../runtime/types.js';
import { ProtocolDeviceBackend, type OutputSafeConfig } from '../runtime/protocolBackend.js';

export const esp32ModuleId = 'pinout/esp32';

export const esp32Module: PinoutModuleDefinition = {
  id: esp32ModuleId,
  version: '0.1.0',
  deviceClass: 'microcontroller',
  vendor: 'Espressif',
  model: 'ESP32',
  capabilities: describeCapabilities([...firstPartyCapabilities]),
  capabilityNames: [...firstPartyCapabilities],
  policies: [],
  supportedTransportKinds: ['serial', 'simulated-esp32', 'tcp', 'loopback'],
  createSimulatedBackend(): DeviceBackend {
    throw new Error('Use createProtocolBackend with simulatedEsp32() transport for ESP32.');
  },
  async createProtocolBackend(options: Record<string, unknown>): Promise<DeviceBackend> {
    const transport = options.transport as Transport | undefined;
    if (!transport) {
      throw new Error('ESP32 protocol backend requires a transport.');
    }
    const connectOptions: ConnectOptions = { transport };
    if (typeof options.timeoutMs === 'number') {
      connectOptions.timeoutMs = options.timeoutMs;
    }
    if (options.signal instanceof AbortSignal) {
      connectOptions.signal = options.signal;
    }

    const validatedOutputs: OutputSafeConfig[] = [];
    if (options.outputs !== undefined) {
      if (!Array.isArray(options.outputs)) {
        throw new ValidationError('outputs configuration must be an array.');
      }
      for (const [index, entry] of options.outputs.entries()) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new ValidationError(`outputs[${index}] must be an object.`);
        }
        const item = entry as Record<string, unknown>;
        const pin = assertGpioPin(item.pin);

        const safeLevel: GpioSafeLevel =
          item.safeLevel === undefined ? 'low' : assertSafeLevel(item.safeLevel);
        const polarity: GpioPolarity =
          item.polarity === undefined ? 'active-high' : assertPolarity(item.polarity);
        validatedOutputs.push({ pin, safeLevel, polarity });
      }
    }

    const device = await connect(connectOptions);
    const autoArm = options.autoArm === true;
    if (autoArm) {
      createLogger('warn').warn(
        'autoArm is enabled on ESP32 protocol backend; this is for demo/testing only and bypasses explicit arming safety.',
      );
    }
    try {
      const backend = new ProtocolDeviceBackend(device, {
        outputs: validatedOutputs.length > 0 ? validatedOutputs : undefined,
        requireWatchdog:
          typeof options.requireWatchdog === 'boolean' ? options.requireWatchdog : undefined,
        autoHeartbeat:
          typeof options.autoHeartbeat === 'boolean' ? options.autoHeartbeat : undefined,
        heartbeatIntervalMs:
          typeof options.heartbeatIntervalMs === 'number' ? options.heartbeatIntervalMs : undefined,
        watchdogTimeoutMs:
          typeof options.watchdogTimeoutMs === 'number' ? options.watchdogTimeoutMs : undefined,
        autoArm,
      });

      await backend.initializeOutputs();
      if (autoArm) {
        await backend.arm();
      }

      return backend;
    } catch (error) {
      await device.close().catch(() => undefined);
      throw error;
    }
  },
};

export function createEsp32SimulatedTransport(options: { autoArm?: boolean } = {}): Transport {
  return simulatedEsp32(options);
}

/** Shared bridge module; actual board and capabilities come from the handshake. */
export const boardModule: PinoutModuleDefinition = {
  ...esp32Module,
  id: 'pinout/board',
  vendor: 'Pinout',
  model: 'USB microcontroller bridge',
};
