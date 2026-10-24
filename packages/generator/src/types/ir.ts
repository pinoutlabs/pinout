export type ConfidenceBand = 'high' | 'medium' | 'low';

export interface EvidenceReference {
  sourceId: string;
  path: string;
  lines?: { start: number; end: number };
  excerpt?: string;
}

export interface Uncertainty {
  id: string;
  message: string;
  confidence?: number;
  evidence?: EvidenceReference[];
  severity: 'info' | 'warning' | 'critical';
}

export interface CandidateArgument {
  name: string;
  type: 'number' | 'integer' | 'string' | 'boolean' | 'object';
  unit?: string;
  description?: string;
  required?: boolean;
  minimum?: number;
  maximum?: number;
  enumValues?: Array<string | number | boolean>;
}

/**
 * Interface transport kinds. Legacy kinds (tcp|serial|http|sdk|unknown) remain
 * for back-compat; connector builders also emit ble-gatt, mqtt, mdns, serial-bridge.
 */
export type HardwareInterfaceKind =
  'tcp' | 'serial' | 'http' | 'sdk' | 'unknown' | 'ble-gatt' | 'mqtt' | 'mdns' | 'serial-bridge';

export type CapabilitySafetyClass = 'readOnly' | 'physicalOutput' | 'unknown';

export interface CandidateArgumentSchema {
  type: 'object';
  additionalProperties: false;
  properties: Record<string, CandidateArgument>;
  required?: string[];
}

export interface CandidateCapability {
  id: string;
  description?: string;
  vendorNames?: string[];
  arguments?: Record<string, CandidateArgument>;
  output?: Record<string, CandidateArgument>;
  /** Strict input schema for physical outputs (no additionalProperties). */
  inputSchema?: CandidateArgumentSchema;
  /** Strict output schema when inferred from samples. */
  outputSchema?: CandidateArgumentSchema;
  confidence: number;
  evidence: EvidenceReference[];
  implementationStatus: 'implemented' | 'skeleton' | 'unknown';
  /** Inferred actuation class — never invent; unknowns stay explicit. */
  safetyClass?: CapabilitySafetyClass;
  reversible?: boolean;
  reversibilityNotes?: string;
  /** True when human must supply ranges / approve before hard policies. */
  requiresApproval?: boolean;
}

export interface CandidateStateField {
  name: string;
  type: string;
  description?: string;
  evidence?: EvidenceReference[];
}

export interface CandidateEvent {
  id: string;
  description?: string;
  confidence: number;
  evidence: EvidenceReference[];
}

export interface CandidateSafetyConstraint {
  type: 'range' | 'precondition' | 'candidate';
  capability: string;
  argument?: string;
  field?: string;
  minimum?: number;
  maximum?: number;
  /** Unit declared alongside the numeric bound, when the source provides one. */
  unit?: string;
  equals?: string | number | boolean;
  message?: string;
  confidence: number;
  evidence: EvidenceReference[];
  requiresHumanReview: boolean;
  documented: boolean;
  /** Policy stub: default-deny until a human supplies bounds. */
  requiresApproval?: boolean;
}

export interface HardwareInterface {
  kind: HardwareInterfaceKind;
  description?: string;
  host?: string;
  port?: number;
  baud?: number;
  /** Topic prefix / service type / GATT service UUID when known. */
  endpoint?: string;
  commands?: string[];
  evidence: EvidenceReference[];
  confidence: number;
}

export interface HardwareDeviceInference {
  vendor?: string;
  model?: string;
  deviceClass?: string;
  description?: string;
  confidence: number;
  evidence: EvidenceReference[];
}

export interface HardwareInterfaceIR {
  device: HardwareDeviceInference;
  interfaces: HardwareInterface[];
  capabilities: CandidateCapability[];
  state?: CandidateStateField[];
  events?: CandidateEvent[];
  safety: CandidateSafetyConstraint[];
  evidence: EvidenceReference[];
  uncertainties: Uncertainty[];
  /**
   * Literal claims found in sources: example calls, usage snippets. Used by
   * the contradiction engine to compare examples against documented limits.
   * Claims from examples are DATA, never hard rules.
   */
  claims?: DocumentedNumericClaim[];
}

export interface DocumentedNumericClaim {
  claim: string;
  capability: string;
  value: number;
  unit?: string;
  evidence: EvidenceReference[];
}

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.9) {
    return 'high';
  }
  if (confidence >= 0.7) {
    return 'medium';
  }
  return 'low';
}

export const HARDWARE_INTERFACE_KINDS: readonly HardwareInterfaceKind[] = [
  'tcp',
  'serial',
  'http',
  'sdk',
  'unknown',
  'ble-gatt',
  'mqtt',
  'mdns',
  'serial-bridge',
] as const;
