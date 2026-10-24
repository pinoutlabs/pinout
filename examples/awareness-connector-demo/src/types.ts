/**
 * Contract types for the awareness + connector demo (PR5).
 *
 * Evidence levels use canonical SupportLevel from @pinout/core (PR0).
 * HTTP/MCP shapes align with PR1–PR4; until those merge, the demo stub
 * implements them locally (honestly labeled SIMULATED / STUBBED).
 */
import { capSupportLevel, compareSupportLevels, type SupportLevel } from '@pinout/core';

export type { SupportLevel };

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

/** Cap generated-connector evidence (never above COMPILE_TESTED without HIL record). */
export function capEvidenceLevel(
  level: SupportLevel,
  max: SupportLevel = 'COMPILE_TESTED',
): SupportLevel {
  return capSupportLevel(level, max);
}

/** True when `level` is strictly stronger than `max`. */
export function evidenceExceeds(level: SupportLevel, max: SupportLevel): boolean {
  return compareSupportLevels(level, max) > 0;
}
