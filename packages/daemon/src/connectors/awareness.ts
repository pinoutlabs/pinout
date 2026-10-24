import { ValidationError } from '@pinout/core';
import type { AwarenessRecord } from '@pinout/awareness';
import type { HardwareInterfaceIR } from '@pinout/generator';

export type { AwarenessRecord };

/** Lookup used by the connector pipeline (daemon awareness service or test double). */
export type AwarenessLookup = (awarenessId: string) => Promise<AwarenessRecord | undefined>;

/** Bind a daemon AwarenessService (or anything with `.get`) into the pipeline lookup. */
export function createAwarenessServiceLookup(service: {
  get(id: string): AwarenessRecord | undefined;
}): AwarenessLookup {
  return async (awarenessId: string) => service.get(awarenessId);
}

export async function resolveAwarenessRecord(
  awarenessId: string,
  lookup?: AwarenessLookup,
): Promise<AwarenessRecord> {
  if (lookup) {
    const found = await lookup(awarenessId);
    if (found) return found;
  }
  throw new ValidationError(
    `Awareness record '${awarenessId}' was not found. Observe/enroll it via /v1/awareness before generating a connector.`,
  );
}

/**
 * Build a HardwareInterfaceIR from a PR1 awareness record for generateConnector.
 * Uses identity + advertised capabilities; never invents physical limits.
 */
export function buildIrFromAwareness(record: AwarenessRecord): HardwareInterfaceIR {
  const capabilities = (record.capabilities ?? []).map((capabilityId) => ({
    id: capabilityId,
    description: capabilityId,
    confidence: record.confidence ?? 0.5,
    evidence: [],
    implementationStatus: 'skeleton' as const,
    safetyClass: inferSafetyClass(capabilityId),
    requiresApproval: inferSafetyClass(capabilityId) === 'physicalOutput',
  }));

  const ifaceKind = mapTransportToInterface(record.transport);

  return {
    device: {
      vendor: record.identity.vendor,
      model: record.identity.model ?? record.identity.advertisedName ?? record.identity.firmware,
      deviceClass: record.identity.deviceClass ?? 'device.custom',
      description: record.identity.endpoint,
      confidence: record.confidence ?? 0.5,
      evidence: [],
    },
    interfaces: [
      {
        kind: ifaceKind,
        description: `${record.transport} observation`,
        evidence: [],
        confidence: record.confidence ?? 0.5,
        ...(record.identity.endpoint ? { host: record.identity.endpoint } : {}),
      },
    ],
    capabilities:
      capabilities.length > 0
        ? capabilities
        : [
            {
              id: 'status.read',
              description: 'Read device status (placeholder from awareness).',
              confidence: 0.4,
              evidence: [],
              implementationStatus: 'skeleton',
              safetyClass: 'readOnly',
              requiresApproval: false,
            },
          ],
    safety: [],
    evidence: [],
    uncertainties: [
      {
        id: 'awareness-derived',
        message:
          'IR derived from an awareness record without full documentation. Treat as unverified.',
        severity: 'warning',
      },
    ],
  };
}

function mapTransportToInterface(
  transport: AwarenessRecord['transport'],
): HardwareInterfaceIR['interfaces'][number]['kind'] {
  switch (transport) {
    case 'serial':
    case 'usb':
      return 'serial';
    case 'ble':
      return 'ble-gatt';
    case 'mqtt':
      return 'mqtt';
    case 'mdns':
      return 'mdns';
    default:
      return 'unknown';
  }
}

function inferSafetyClass(capabilityId: string): 'readOnly' | 'physicalOutput' | 'unknown' {
  const lower = capabilityId.toLowerCase();
  if (/(^|\.)(read|status|get|list|info|sense|sensor|hello|ping)(\.|$)/.test(lower)) {
    return 'readOnly';
  }
  if (/(set|write|move|actuate|on|off|drive|pwm|gpio|heat|pump|valve|relay|arm)/.test(lower)) {
    return 'physicalOutput';
  }
  return 'unknown';
}
