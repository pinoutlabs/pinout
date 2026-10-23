import { serialPort } from '../serial.js';
import { loopbackTransport } from '../transports/loopbackTransport.js';
import { tcpTransport } from '../transports/tcpTransport.js';
import { createSimulatedBleGattBridge } from '../transports/simulatedBleGatt.js';
import { simulatedEsp32 } from '../drivers/esp32/simulatedTransport.js';
import type { Transport } from '../types.js';
import type { DeviceBackendConfig, DeviceTransportConfig } from './deviceStore.js';
import { DeviceConfigInvalidError } from '../module/errors.js';

export async function createTransportFromConfig(
  transportConfig: DeviceTransportConfig,
): Promise<Transport> {
  switch (transportConfig.type) {
    case 'serial': {
      if (!transportConfig.path) {
        throw new DeviceConfigInvalidError('Serial transport requires path.');
      }
      return serialPort({
        path: transportConfig.path,
        baudRate: transportConfig.baud ?? 115200,
      });
    }
    case 'tcp': {
      if (!transportConfig.host || transportConfig.port === undefined) {
        throw new DeviceConfigInvalidError('TCP transport requires host and port.');
      }
      return tcpTransport({ host: transportConfig.host, port: transportConfig.port });
    }
    case 'simulated-esp32':
      return simulatedEsp32();
    case 'simulated-ble-gatt':
      return createSimulatedBleGattBridge().transport;
    case 'loopback':
      return loopbackTransport({ onOpen: () => [] });
    default:
      throw new DeviceConfigInvalidError(`Unsupported transport type '${transportConfig.type}'.`);
  }
}

export function isSimulatedBackend(
  backend: DeviceBackendConfig | undefined,
  moduleId: string,
): boolean {
  if (backend?.type === 'simulated') {
    return true;
  }
  if (backend?.type === 'protocol') {
    return (
      backend.transport?.type === 'simulated-esp32' ||
      backend.transport?.type === 'loopback' ||
      backend.transport?.type === 'simulated-ble-gatt'
    );
  }
  return moduleId !== 'pinout/esp32';
}

export async function resolveRegistrationOptions(
  definition: {
    id: string;
    label?: string;
    backend?: DeviceBackendConfig;
    config?: Record<string, unknown>;
  },
  moduleId: string,
): Promise<{
  id: string;
  label?: string;
  simulated: boolean;
  transport?: Transport;
  backendOptions: Record<string, unknown>;
}> {
  const simulated = isSimulatedBackend(definition.backend, moduleId);
  const backendOptions: Record<string, unknown> = { ...(definition.config ?? {}) };
  let transport: Transport | undefined;

  if (definition.backend?.type === 'protocol' && definition.backend.transport) {
    transport = await createTransportFromConfig(definition.backend.transport);
  }

  const options: {
    id: string;
    label?: string;
    simulated: boolean;
    transport?: Transport;
    backendOptions: Record<string, unknown>;
  } = {
    id: definition.id,
    simulated,
    backendOptions,
  };
  if (definition.label !== undefined) {
    options.label = definition.label;
  }
  if (transport !== undefined) {
    options.transport = transport;
  }
  return options;
}
