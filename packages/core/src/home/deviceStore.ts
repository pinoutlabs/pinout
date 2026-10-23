import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { DeclarativePolicyMap } from '../module/policies.js';
import { DeviceAlreadyExistsError, DeviceConfigInvalidError } from '../module/errors.js';
import { resolveDevicesConfigPath, resolvePinoutHome } from './paths.js';

export interface DeviceTransportConfig {
  type: 'serial' | 'tcp' | 'simulated-esp32' | 'loopback' | 'simulated-ble-gatt';  path?: string;
  host?: string;
  port?: number;
  baud?: number;
}

export interface DeviceBackendConfig {
  type: 'simulated' | 'protocol';
  transport?: DeviceTransportConfig;
}

/** Identity captured during explicit hardware enrollment. */
export interface DeviceIdentity {
  firmware: string;
  version: string;
  protocol: number;
  capabilities: string[];
  usbSerial?: string;
  vid?: string;
  pid?: string;
}

export interface DeviceDefinition {
  id: string;
  module: string;
  label?: string;
  backend?: DeviceBackendConfig;
  config?: Record<string, unknown>;
  policies?: DeclarativePolicyMap;
  enabled?: boolean;
  identity?: DeviceIdentity;
  enrolledAt?: string;
}

export interface DevicesFile {
  schemaVersion: 1;
  devices: DeviceDefinition[];
}

export function readDevicesFile(path?: string, home?: string): DevicesFile {
  const resolvedHome = resolvePinoutHome(home);
  const configPath = resolveDevicesConfigPath(resolvedHome, path);
  if (!existsSync(configPath)) {
    return { schemaVersion: 1, devices: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new DeviceConfigInvalidError(
      `Failed to parse devices config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseDevicesFile(parsed);
}

export function writeDevicesFile(devicesFile: DevicesFile, path?: string, home?: string): void {
  const resolvedHome = resolvePinoutHome(home);
  const configPath = resolveDevicesConfigPath(resolvedHome, path);
  mkdirSync(resolvePinoutHome(resolvedHome), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(devicesFile, null, 2)}\n`, 'utf8');
  // Device identities and transport paths are local sensitive state.
  chmodSync(configPath, 0o600);
}

export function addDeviceDefinition(
  definition: DeviceDefinition,
  options: { path?: string; home?: string } = {},
): DeviceDefinition {
  assertValidDeviceDefinition(definition);
  const file = readDevicesFile(options.path, options.home);
  if (file.devices.some((entry) => entry.id === definition.id)) {
    throw new DeviceAlreadyExistsError(definition.id);
  }
  if (definition.identity?.usbSerial) {
    const duplicate = file.devices.find(
      (entry) => entry.identity?.usbSerial === definition.identity?.usbSerial,
    );
    if (duplicate) {
      throw new DeviceAlreadyExistsError(
        `USB serial '${definition.identity.usbSerial}' is already enrolled as '${duplicate.id}'.`,
      );
    }
  }
  const path = definition.backend?.transport?.path;
  if (path) {
    const samePath = file.devices.find((entry) => entry.backend?.transport?.path === path);
    if (samePath && JSON.stringify(samePath.identity) !== JSON.stringify(definition.identity)) {
      throw new DeviceConfigInvalidError(
        `Transport path '${path}' is already enrolled with a different identity ('${samePath.id}'). Re-enroll explicitly before changing identity.`,
      );
    }
  }
  file.devices.push(definition);
  writeDevicesFile(file, options.path, options.home);
  return definition;
}

export function removeDeviceDefinition(
  deviceId: string,
  options: { path?: string; home?: string } = {},
): void {
  const file = readDevicesFile(options.path, options.home);
  const next = file.devices.filter((entry) => entry.id !== deviceId);
  if (next.length === file.devices.length) {
    throw new DeviceConfigInvalidError(`Device '${deviceId}' is not configured.`);
  }
  writeDevicesFile({ schemaVersion: 1, devices: next }, options.path, options.home);
}

export function inspectDeviceDefinition(
  deviceId: string,
  options: { path?: string; home?: string } = {},
): DeviceDefinition {
  const file = readDevicesFile(options.path, options.home);
  const device = file.devices.find((entry) => entry.id === deviceId);
  if (!device) {
    throw new DeviceConfigInvalidError(`Device '${deviceId}' is not configured.`);
  }
  return device;
}

function parseDevicesFile(raw: unknown): DevicesFile {
  if (!raw || typeof raw !== 'object') {
    throw new DeviceConfigInvalidError('Devices config must be a JSON object.');
  }
  const object = raw as Record<string, unknown>;
  if (object.schemaVersion !== 1) {
    throw new DeviceConfigInvalidError('Unsupported devices schemaVersion.');
  }
  if (!Array.isArray(object.devices)) {
    throw new DeviceConfigInvalidError('Devices config must include a devices array.');
  }
  const devices = object.devices.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new DeviceConfigInvalidError('Each device entry must be an object.');
    }
    const device = entry as Record<string, unknown>;
    const id = device.id;
    const moduleId = device.module;
    if (typeof id !== 'string' || typeof moduleId !== 'string') {
      throw new DeviceConfigInvalidError('Each device requires string id and module fields.');
    }
    const parsed: DeviceDefinition = { id, module: moduleId };
    if (typeof device.label === 'string') {
      parsed.label = device.label;
    }
    if (device.backend && typeof device.backend === 'object') {
      parsed.backend = device.backend as DeviceBackendConfig;
    }
    if (device.config && typeof device.config === 'object') {
      parsed.config = device.config as Record<string, unknown>;
    }
    if (device.policies && typeof device.policies === 'object') {
      parsed.policies = device.policies as DeclarativePolicyMap;
    }
    if (device.enabled === false) {
      parsed.enabled = false;
    }
    if (device.identity && typeof device.identity === 'object') {
      const identity = device.identity as Record<string, unknown>;
      if (
        typeof identity.firmware !== 'string' ||
        typeof identity.version !== 'string' ||
        typeof identity.protocol !== 'number' ||
        !Array.isArray(identity.capabilities) ||
        !identity.capabilities.every((capability) => typeof capability === 'string')
      ) {
        throw new DeviceConfigInvalidError('Device identity is invalid.');
      }
      parsed.identity = {
        firmware: identity.firmware,
        version: identity.version,
        protocol: identity.protocol,
        capabilities: identity.capabilities,
        ...(typeof identity.usbSerial === 'string' ? { usbSerial: identity.usbSerial } : {}),
        ...(typeof identity.vid === 'string' ? { vid: identity.vid } : {}),
        ...(typeof identity.pid === 'string' ? { pid: identity.pid } : {}),
      };
    }
    if (typeof device.enrolledAt === 'string') parsed.enrolledAt = device.enrolledAt;
    return parsed;
  });
  return { schemaVersion: 1, devices };
}

function assertValidDeviceDefinition(definition: DeviceDefinition): void {
  if (!definition.id || !definition.module) {
    throw new DeviceConfigInvalidError('Device id and module are required.');
  }
}
