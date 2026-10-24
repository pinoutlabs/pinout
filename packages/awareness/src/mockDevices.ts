/**
 * Simulated discovery sources for tests and `pinoutd --mock-devices`.
 *
 * Everything injected here is SIMULATED. Never claims HARDWARE_VERIFIED.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  candidateId,
  type DiscoveredCandidate,
  type DiscoveryPlugin,
  validateCandidate,
} from '@pinout/discovery';
import type { AwarenessTransport } from './types.js';

export interface MockDeviceSpec {
  /** Stable id override; otherwise derived from transport+endpoint. */
  id?: string;
  transport: AwarenessTransport;
  endpoint: string;
  vid?: string;
  pid?: string;
  firmware?: string;
  version?: string;
  advertisedName?: string;
  uuids?: string[];
  mac?: string;
  vendor?: string;
  moduleId?: string;
  deviceClass?: string;
  confidence?: number;
  interfaces?: string[];
  capabilities?: string[];
  /** When true, force unknown/* module (no matching connector). */
  unknown?: boolean;
}

export interface MockDevicesFile {
  schemaVersion: 1;
  devices: MockDeviceSpec[];
}

/** Built-in presets usable as `--mock-devices <preset>`. */
export const MOCK_DEVICE_PRESETS: Record<string, MockDeviceSpec[]> = {
  demo: [
    {
      transport: 'serial',
      endpoint: '/dev/cu.mock-esp32',
      vid: '303a',
      pid: '1001',
      vendor: 'Espressif',
      moduleId: 'pinout/esp32',
      deviceClass: 'microcontroller',
      firmware: 'esp32-bridge',
      version: '0.1.0-mock',
      confidence: 0.5,
      interfaces: ['serial'],
    },
    {
      transport: 'ble',
      endpoint: 'aa:bb:cc:dd:ee:01',
      mac: 'aa:bb:cc:dd:ee:01',
      advertisedName: 'ESP32-Mock-BLE',
      uuids: ['6e700001-b5a3-f393-e0a9-e50e24dcca9e'],
      vendor: 'Espressif',
      moduleId: 'pinout/esp32',
      deviceClass: 'microcontroller',
      confidence: 0.5,
      interfaces: ['ble'],
    },
    {
      transport: 'mdns',
      endpoint: 'pinout-bridge.local',
      vendor: 'Pinout',
      moduleId: 'pinout/bridge',
      deviceClass: 'microcontroller',
      confidence: 0.45,
      interfaces: ['mdns', 'http'],
    },
    {
      transport: 'mqtt',
      endpoint: 'mqtt://127.0.0.1/pinout/esp32/mock-lamp',
      vendor: 'Tasmota',
      moduleId: 'pinout/mqtt-lamp',
      deviceClass: 'actuator.lamp',
      confidence: 0.45,
      interfaces: ['mqtt'],
    },
    {
      transport: 'usb',
      endpoint: 'usb:1234:5678',
      vid: '1234',
      pid: '5678',
      vendor: 'Unknown Vendor',
      moduleId: 'unknown/usb',
      unknown: true,
      confidence: 0.25,
      interfaces: ['usb'],
      advertisedName: 'UNKNOWN-Desk-Gadget',
    },
  ],
};

function endpointKind(
  transport: AwarenessTransport,
): 'serial' | 'usb' | 'ble' | 'mdns' | 'network' | 'simulated' {
  if (transport === 'mqtt') return 'network';
  return transport;
}

export function mockSpecToCandidate(spec: MockDeviceSpec): DiscoveredCandidate {
  const kind = endpointKind(spec.transport);
  const address =
    spec.transport === 'ble' && spec.mac ? spec.mac.toLowerCase() : spec.endpoint;
  const details: Record<string, unknown> = {};
  if (spec.vid) details.vendorId = spec.vid;
  if (spec.pid) details.productId = spec.pid;
  if (spec.advertisedName) {
    details.localName = spec.advertisedName;
    details.advertisedName = spec.advertisedName;
  }
  if (spec.uuids) details.serviceUuids = spec.uuids;
  if (spec.firmware) details.firmware = spec.firmware;
  if (spec.version) details.version = spec.version;
  if (spec.vendor) details.manufacturer = spec.vendor;

  const moduleId = spec.unknown
    ? (spec.moduleId ?? 'unknown/device')
    : (spec.moduleId ?? 'unknown/device');

  const candidate: DiscoveredCandidate = {
    id:
      spec.id ??
      candidateId({
        kind,
        address,
      }),
    endpoint: {
      kind,
      address,
      details,
    },
    possibleIdentity: [
      {
        moduleId,
        ...(spec.vendor ? { vendor: spec.vendor } : {}),
        ...(spec.deviceClass ? { deviceClass: spec.deviceClass } : {}),
        reason: spec.unknown
          ? 'mock UNKNOWN device with no matching module'
          : 'mock-devices simulated observation',
      },
    ],
    evidence: [
      {
        source: 'mock-devices',
        detail: `simulated ${spec.transport} device at ${address}`,
        weight: 0.4,
      },
    ],
    confidence: Math.min(spec.confidence ?? 0.4, 0.5),
    interfaces: spec.interfaces ?? [spec.transport],
  };
  return validateCandidate(candidate);
}

export function loadMockDevices(source: string): MockDeviceSpec[] {
  if (MOCK_DEVICE_PRESETS[source]) {
    return MOCK_DEVICE_PRESETS[source]!;
  }
  const raw = JSON.parse(readFileSync(source, 'utf8')) as MockDevicesFile;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.devices)) {
    throw new Error(`Invalid mock-devices file '${source}': expected schemaVersion 1 + devices[].`);
  }
  return raw.devices;
}

/** Discovery plugin that yields mock candidates once per discover() call. */
export function mockDiscoveryPlugin(specs: MockDeviceSpec[]): DiscoveryPlugin {
  return {
    name: 'mock-devices',
    async discover(): Promise<DiscoveredCandidate[]> {
      return specs.map(mockSpecToCandidate);
    },
  };
}

export function macHash(address: string): string {
  return createHash('sha256').update(address.toLowerCase()).digest('hex').slice(0, 16);
}
