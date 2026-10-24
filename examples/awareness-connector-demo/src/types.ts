/**
 * Contract types for the awareness + connector demo (PR5).
 *
 * Aligns with PR0 SupportLevel and the PR1–PR4 HTTP/MCP surface described in
 * docs/awareness-and-connectors.md. Until those PRs merge, the demo stub
 * implements the same shapes locally (honestly labeled SIMULATED / STUBBED).
 */

export type SupportLevel = 'UNKNOWN' | 'SIMULATED' | 'COMPILE_TESTED' | 'HARDWARE_VERIFIED';

export type AwarenessTransport = 'serial' | 'usb' | 'ble' | 'mdns' | 'mqtt';

export type AwarenessState =
  'SEEN' | 'IDENTIFIED' | 'PENDING_ENROLL' | 'ONLINE' | 'STALE' | 'OFFLINE';

export type ConnectorStatus = 'CANDIDATE' | 'QUARANTINED' | 'APPROVED' | 'INSTALLED' | 'REJECTED';

export interface AwarenessIdentity {
  advertisedName?: string;
  vid?: string;
  pid?: string;
  firmware?: string;
  version?: string;
  protocol?: number;
  macHash?: string;
  uuids?: string[];
  rssi?: number;
  topics?: string[];
  broker?: string;
}

export interface AwarenessRecord {
  id: string;
  transport: AwarenessTransport;
  identity: AwarenessIdentity;
  state: AwarenessState;
  firstSeen: number;
  lastSeen: number;
  moduleId?: string | null;
  capabilities?: string[];
  evidenceLevel: SupportLevel;
  label?: string;
  connector?: { id: string; status: ConnectorStatus };
}

export interface ParamRange {
  min: number;
  max: number;
}

export interface ConnectorApproveRequest {
  capabilities: string[];
  ranges: Record<string, Record<string, ParamRange>>;
}

export interface ConnectorCapability {
  id: string;
  physicalOutput: boolean;
  params: Record<string, { type: string; suggestedMin?: number; suggestedMax?: number }>;
  confidence: number;
  requiresHumanReview: boolean;
}

export interface ConnectorRecord {
  id: string;
  awarenessId: string;
  status: ConnectorStatus;
  evidenceLevel: SupportLevel;
  mode: 'read-only' | 'approved' | 'installed';
  capabilities: ConnectorCapability[];
  approvedCapabilities: string[];
  ranges: Record<string, Record<string, ParamRange>>;
  armed: boolean;
  generated: true;
  report: {
    quarantine: boolean;
    conformanceGate: 'passed' | 'failed' | 'stubbed';
    notes: string[];
  };
}

export interface InvokeResult {
  ok: boolean;
  code?: string;
  message?: string;
  result?: Record<string, unknown>;
}

export interface MockDeviceFixture {
  id: string;
  transport: AwarenessTransport;
  identity: AwarenessIdentity;
  moduleId: string | null;
  stateHint: AwarenessState;
  capabilitiesHint: string[];
  evidenceLevel: SupportLevel;
  label?: string;
  gattDumpPath?: string;
  mqttSamplesPath?: string;
}

export interface MockDevicesFile {
  preset?: string;
  label?: string;
  devices: MockDeviceFixture[];
}

export const EVIDENCE_RANK: Record<SupportLevel, number> = {
  UNKNOWN: 0,
  SIMULATED: 1,
  COMPILE_TESTED: 2,
  HARDWARE_VERIFIED: 3,
};

export function capEvidenceLevel(
  level: SupportLevel,
  max: SupportLevel = 'COMPILE_TESTED',
): SupportLevel {
  return EVIDENCE_RANK[level] > EVIDENCE_RANK[max] ? max : level;
}
