import type {
  CandidateCapability,
  EvidenceReference,
  HardwareInterfaceIR,
  Uncertainty,
} from '../types/ir.js';
import { applyCapabilitySafetyInference } from '../safety/capabilitySafety.js';

/**
 * Live / simulated `sys.hello` capability list from an enrolled / awareness identity.
 * Never invents capabilities beyond the advertised list.
 */
export interface SysHelloPayload {
  firmware?: string;
  version?: string;
  protocol?: number;
  boardId?: string;
  deviceId?: string;
  vendor?: string;
  model?: string;
  capabilities?: string[];
  features?: string[];
  [key: string]: unknown;
}

export function ingestSysHello(
  raw: unknown,
  options: { sourceId?: string; path?: string } = {},
): HardwareInterfaceIR {
  const sourceId = options.sourceId ?? 'sys.hello';
  const path = options.path ?? 'sys.hello';
  const evidence: EvidenceReference[] = [{ sourceId, path, excerpt: 'sys.hello payload' }];
  const uncertainties: Uncertainty[] = [];

  if (!isRecord(raw)) {
    return emptyUnknownIr(evidence, [
      {
        id: 'hello-invalid',
        message: 'sys.hello payload is not a JSON object; no capabilities inferred.',
        severity: 'critical',
        confidence: 1,
        evidence,
      },
    ]);
  }

  const payload = raw as SysHelloPayload;
  const advertised = normalizeCapabilityList(payload.capabilities ?? payload.features ?? []);
  if (advertised.length === 0) {
    uncertainties.push({
      id: 'hello-empty-capabilities',
      message: 'sys.hello did not advertise capabilities; unknowns stay explicit.',
      severity: 'warning',
      confidence: 0.95,
      evidence,
    });
  }

  const capabilities: CandidateCapability[] = advertised.map((id) => ({
    id,
    description: `Advertised by sys.hello (${payload.boardId ?? payload.firmware ?? 'device'})`,
    confidence: 0.92,
    evidence,
    implementationStatus: 'skeleton' as const,
    vendorNames: [id],
  }));

  const ir: HardwareInterfaceIR = {
    device: {
      vendor: typeof payload.vendor === 'string' ? payload.vendor : 'Pinout',
      model:
        typeof payload.model === 'string'
          ? payload.model
          : typeof payload.boardId === 'string'
            ? payload.boardId
            : typeof payload.firmware === 'string'
              ? payload.firmware
              : 'serial-bridge-device',
      deviceClass: inferHelloDeviceClass(advertised),
      description: 'Device inferred from sys.hello capability list (serial-bridge).',
      confidence: advertised.length > 0 ? 0.85 : 0.4,
      evidence,
    },
    interfaces: [
      {
        kind: 'serial-bridge',
        description: 'Pinout NDJSON serial bridge via sys.hello',
        baud: 115200,
        confidence: 0.9,
        evidence,
      },
    ],
    capabilities,
    safety: [],
    evidence,
    uncertainties,
  };

  return applyCapabilitySafetyInference(ir);
}

function normalizeCapabilityList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) {
      out.push(item.trim());
    }
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

function inferHelloDeviceClass(capabilities: string[]): string {
  if (capabilities.some((c) => c.startsWith('gpio.') || c.startsWith('sys.arm'))) {
    return 'mcu.bridge';
  }
  if (capabilities.some((c) => c.includes('temperature') || c.includes('sensor'))) {
    return 'sensor.custom';
  }
  return 'device.custom';
}

function emptyUnknownIr(
  evidence: EvidenceReference[],
  uncertainties: Uncertainty[],
): HardwareInterfaceIR {
  return applyCapabilitySafetyInference({
    device: {
      confidence: 0.1,
      evidence,
      description: 'Unknown device — invalid sys.hello',
    },
    interfaces: [{ kind: 'unknown', confidence: 0.2, evidence }],
    capabilities: [],
    safety: [],
    evidence,
    uncertainties,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
