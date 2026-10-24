import type {
  CandidateArgument,
  CandidateCapability,
  EvidenceReference,
  HardwareInterfaceIR,
  Uncertainty,
} from '../types/ir.js';
import { applyCapabilitySafetyInference } from '../safety/capabilitySafety.js';

/**
 * GATT dump → IR capabilities.
 * read ⇒ read-only; write / notify ⇒ physicalOutput candidate.
 */
export interface GattCharacteristicDump {
  uuid: string;
  properties?: string[] | string;
  description?: string;
  handle?: number;
}

export interface GattServiceDump {
  uuid: string;
  description?: string;
  characteristics?: GattCharacteristicDump[];
}

export interface GattDump {
  name?: string;
  address?: string;
  vendor?: string;
  model?: string;
  services?: GattServiceDump[];
}

export function ingestGattDump(
  raw: unknown,
  options: { sourceId?: string; path?: string } = {},
): HardwareInterfaceIR {
  const sourceId = options.sourceId ?? 'gatt';
  const path = options.path ?? 'gatt-dump.json';
  const evidence: EvidenceReference[] = [{ sourceId, path, excerpt: 'BLE GATT dump' }];
  const uncertainties: Uncertainty[] = [];

  if (!isRecord(raw)) {
    return applyCapabilitySafetyInference({
      device: { confidence: 0.1, evidence, description: 'Invalid GATT dump' },
      interfaces: [{ kind: 'ble-gatt', confidence: 0.3, evidence }],
      capabilities: [],
      safety: [],
      evidence,
      uncertainties: [
        {
          id: 'gatt-invalid',
          message: 'GATT dump is not a JSON object; no characteristics inferred.',
          severity: 'critical',
          confidence: 1,
          evidence,
        },
      ],
    });
  }

  const dump = raw as GattDump;
  const services = Array.isArray(dump.services) ? dump.services : [];
  if (services.length === 0) {
    uncertainties.push({
      id: 'gatt-empty',
      message: 'GATT dump has no services; unknowns stay explicit.',
      severity: 'warning',
      confidence: 0.9,
      evidence,
    });
  }

  const capabilities: CandidateCapability[] = [];
  for (const service of services) {
    if (!service || typeof service.uuid !== 'string') {
      uncertainties.push({
        id: `gatt-service-unknown-${capabilities.length}`,
        message: 'Skipping service without uuid.',
        severity: 'info',
        evidence,
      });
      continue;
    }
    const chars = Array.isArray(service.characteristics) ? service.characteristics : [];
    for (const characteristic of chars) {
      if (!characteristic || typeof characteristic.uuid !== 'string') {
        continue;
      }
      const props = normalizeProperties(characteristic.properties);
      const id = gattCapabilityId(service.uuid, characteristic.uuid, props);
      const hasWrite = props.some((p) => p === 'write' || p === 'write-without-response');
      const hasNotify = props.some((p) => p === 'notify' || p === 'indicate');
      const hasRead = props.includes('read');

      const args: Record<string, CandidateArgument> = {};
      if (hasWrite) {
        args['value'] = {
          name: 'value',
          type: 'string',
          description: 'Hex or UTF-8 payload written to characteristic (UNVERIFIED bounds).',
          required: true,
        };
      }

      const capability: CandidateCapability = {
        id,
        description:
          characteristic.description ??
          `GATT ${shortUuid(characteristic.uuid)} on service ${shortUuid(service.uuid)} [${props.join(',')}]`,
        confidence: 0.8,
        evidence: [
          {
            ...evidence[0]!,
            excerpt: `${service.uuid}/${characteristic.uuid} props=${props.join(',')}`,
          },
        ],
        implementationStatus: 'skeleton',
        vendorNames: [characteristic.uuid, service.uuid],
        safetyClass: hasWrite || hasNotify ? 'physicalOutput' : hasRead ? 'readOnly' : 'unknown',
        requiresApproval: hasWrite || hasNotify,
      };
      if (Object.keys(args).length > 0) {
        capability.arguments = args;
      }
      if (hasWrite) {
        capability.reversible = true;
        capability.reversibilityNotes =
          'Write may actuate hardware; reversibility unconfirmed without device docs.';
      } else if (hasNotify) {
        capability.reversibilityNotes =
          'Notify/indicate subscriptions are treated as physicalOutput candidates until classified.';
      }
      capabilities.push(capability);
    }
  }

  if (capabilities.length === 0) {
    uncertainties.push({
      id: 'gatt-no-characteristics',
      message: 'No GATT characteristics found; refusing to invent capabilities.',
      severity: 'warning',
      confidence: 1,
      evidence,
    });
  }

  const ir: HardwareInterfaceIR = {
    device: {
      vendor: dump.vendor ?? 'Unknown BLE',
      model: dump.model ?? dump.name ?? dump.address ?? 'ble-gatt-device',
      deviceClass: inferGattDeviceClass(capabilities),
      description: 'BLE GATT device inferred from service/characteristic dump.',
      confidence: capabilities.length > 0 ? 0.75 : 0.3,
      evidence,
    },
    interfaces: [
      {
        kind: 'ble-gatt',
        description: 'Bluetooth LE GATT',
        confidence: 0.9,
        evidence,
        ...(dump.address ? { endpoint: dump.address } : {}),
      },
    ],
    capabilities,
    safety: [],
    evidence,
    uncertainties,
  };

  return applyCapabilitySafetyInference(ir);
}

function normalizeProperties(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.toLowerCase().trim());
  }
  if (typeof value === 'string') {
    return value
      .split(/[|,\s]+/)
      .map((item) => item.toLowerCase().trim())
      .filter(Boolean);
  }
  return [];
}

function shortUuid(uuid: string): string {
  const clean = uuid.toLowerCase().replace(/-/g, '');
  if (clean.length === 4) {
    return clean;
  }
  if (clean.length >= 8) {
    return clean.slice(0, 8);
  }
  return clean;
}

function gattCapabilityId(serviceUuid: string, charUuid: string, props: string[]): string {
  const verb = props.some((p) => p.startsWith('write'))
    ? 'write'
    : props.includes('notify') || props.includes('indicate')
      ? 'notify'
      : props.includes('read')
        ? 'read'
        : 'access';
  return `ble.gatt.${shortUuid(serviceUuid)}.${shortUuid(charUuid)}.${verb}`;
}

function inferGattDeviceClass(capabilities: CandidateCapability[]): string {
  const ids = capabilities.map((c) => c.id).join(' ');
  if (/lamp|light|on|off|brightness/i.test(ids)) {
    return 'actuator.lamp';
  }
  if (capabilities.some((c) => c.safetyClass === 'physicalOutput')) {
    return 'actuator.custom';
  }
  return 'sensor.custom';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
