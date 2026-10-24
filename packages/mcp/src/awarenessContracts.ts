/**
 * MCP-facing awareness + connector helpers.
 *
 * Awareness record/event/client types come from `@pinout/awareness` (PR1).
 * Generated-connector candidacy shapes (PR4) stay local until that API lands.
 */

import {
  type AwarenessRecord,
  type AwarenessState,
  type AwarenessTransport,
  type ConnectorStatus as AwarenessConnectorStatus,
} from '@pinout/awareness';
import { isSupportLevel, type SupportLevel } from '@pinout/core';

export type {
  AwarenessConnector,
  AwarenessEvent,
  AwarenessEventType,
  AwarenessHealth,
  AwarenessIdentity,
  AwarenessRecord,
  AwarenessState,
  AwarenessTransport,
  SupportLevel,
} from '@pinout/awareness';

/** @deprecated Prefer {@link SupportLevel} from `@pinout/core` / `@pinout/awareness`. */
export type EvidenceLevel = SupportLevel;

/**
 * PR4 generated-connector lifecycle (distinct from awareness `connector.status`).
 * Awareness uses none|available|pending|installed|failed; generation uses this ladder.
 */
export type GeneratedConnectorStatus =
  'CANDIDATE' | 'QUARANTINED' | 'APPROVED' | 'INSTALLED' | 'REJECTED';

/** @deprecated Use {@link GeneratedConnectorStatus}. */
export type ConnectorStatus = GeneratedConnectorStatus;

export interface GeneratedConnectorRecord {
  id: string;
  awarenessId?: string;
  status: GeneratedConnectorStatus;
  evidenceLevel: SupportLevel;
  capabilities?: Array<Record<string, unknown>>;
  safetyFlags?: Record<string, unknown>;
  report?: Record<string, unknown>;
  [key: string]: unknown;
}

/** @deprecated Use {@link GeneratedConnectorRecord}. */
export type ConnectorRecord = GeneratedConnectorRecord;

export interface NearbyDevicesFilter {
  state?: AwarenessState | AwarenessState[];
  transport?: AwarenessTransport | AwarenessTransport[];
  evidenceLevel?: SupportLevel | SupportLevel[];
  moduleId?: string;
  hasConnector?: boolean;
}

const generatedConnectorStatuses = new Set<GeneratedConnectorStatus>([
  'CANDIDATE',
  'QUARANTINED',
  'APPROVED',
  'INSTALLED',
  'REJECTED',
]);

/**
 * Never claim hardware: accept canonical SupportLevel values; missing/invalid
 * evidence collapses to SIMULATED so agents treat the device as simulation-grade
 * until the daemon says otherwise.
 */
export function normalizeEvidenceLevel(value: unknown): SupportLevel {
  if (isSupportLevel(value)) return value;
  return 'SIMULATED';
}

/** Ensure MCP annotations always see a canonical SupportLevel on the record. */
export function withNormalizedEvidence(record: AwarenessRecord): AwarenessRecord {
  return {
    ...record,
    evidenceLevel: normalizeEvidenceLevel(record.evidenceLevel),
  };
}

export function normalizeGeneratedConnector(raw: unknown): GeneratedConnectorRecord {
  const record = asObject(raw);
  const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : 'unknown';
  const status =
    typeof record.status === 'string' &&
    generatedConnectorStatuses.has(record.status as GeneratedConnectorStatus)
      ? (record.status as GeneratedConnectorStatus)
      : 'CANDIDATE';
  return {
    ...record,
    id,
    status,
    evidenceLevel: normalizeEvidenceLevel(record.evidenceLevel),
    ...(typeof record.awarenessId === 'string' ? { awarenessId: record.awarenessId } : {}),
    ...(Array.isArray(record.capabilities)
      ? { capabilities: record.capabilities as Array<Record<string, unknown>> }
      : {}),
  };
}

/** @deprecated Use {@link normalizeGeneratedConnector}. */
export const normalizeConnectorRecord = normalizeGeneratedConnector;

export function filterAwarenessRecords(
  devices: AwarenessRecord[],
  filter: NearbyDevicesFilter = {},
): AwarenessRecord[] {
  const states = toStringSet(filter.state);
  const transportSet = toStringSet(filter.transport);
  const evidenceSet = toStringSet(filter.evidenceLevel);
  return devices.filter((device) => {
    if (states && !states.has(device.state)) return false;
    if (transportSet && !transportSet.has(device.transport)) return false;
    if (evidenceSet && !evidenceSet.has(device.evidenceLevel)) return false;
    if (typeof filter.moduleId === 'string' && device.moduleId !== filter.moduleId) return false;
    if (typeof filter.hasConnector === 'boolean') {
      const present = Boolean(device.connector) && device.connector?.status !== 'none';
      if (present !== filter.hasConnector) return false;
    }
    return true;
  });
}

export function awarenessConnectorGuidance(status: AwarenessConnectorStatus | undefined): string {
  switch (status) {
    case 'installed':
      return 'Awareness connector status=installed — capabilities still follow lease/arm/safety; physical-output needs normal governance.';
    case 'available':
    case 'pending':
      return `Awareness connector status=${status} — not fully installed; do not assume physical-output is approved.`;
    case 'failed':
      return 'Awareness connector status=failed — do not use until rebuilt/approved.';
    case 'none':
    default:
      return 'No awareness connector yet — generate/approve via connector tools; physical-output stays human-gated.';
  }
}

export function generatedConnectorGuidance(status: GeneratedConnectorStatus): string {
  if (status === 'QUARANTINED' || status === 'CANDIDATE') {
    return 'QUARANTINED/CANDIDATE: read-only capabilities may be usable; physical-output capabilities must not be invoked until a human approves and installs the connector.';
  }
  if (status === 'APPROVED') {
    return 'APPROVED by a human but not yet INSTALLED — physical-output capabilities remain blocked until install completes.';
  }
  if (status === 'INSTALLED') {
    return 'INSTALLED: capabilities follow normal lease/arm/safety rules. Always surface evidenceLevel (SupportLevel) honestly; SIMULATED/UNKNOWN are not hardware.';
  }
  return 'REJECTED connectors must not be used.';
}

/** @deprecated Use {@link generatedConnectorGuidance}. */
export const connectorCapabilityGuidance = generatedConnectorGuidance;

export function honestyNote(evidenceLevel: SupportLevel): string {
  if (evidenceLevel === 'HARDWARE_VERIFIED') {
    return 'evidenceLevel=HARDWARE_VERIFIED (dated hardware record present). Still treat ACK as command receipt, not physical proof unless observed evidence exists.';
  }
  if (evidenceLevel === 'COMPILE_TESTED') {
    return 'evidenceLevel=COMPILE_TESTED — firmware/module compiled in CI; not a hardware claim.';
  }
  if (evidenceLevel === 'UNKNOWN') {
    return 'evidenceLevel=UNKNOWN — no evidence claimed; do not treat as physical hardware.';
  }
  return 'evidenceLevel=SIMULATED — do not claim physical hardware effect.';
}

export function isNewDeviceEventType(type: string): boolean {
  return type === 'seen' || type === 'identified' || type === 'online';
}

export function isConnectorInstallEvent(kind: string, payload: Record<string, unknown>): boolean {
  if (kind === 'connector_installed' || kind === 'connector.installed') return true;
  if (/connector/i.test(kind) && /install/i.test(kind)) return true;
  const status = payload.status ?? asObject(payload.connector).status;
  return status === 'INSTALLED' || status === 'installed';
}

function toStringSet(value: string | string[] | undefined): Set<string> | undefined {
  if (value === undefined) return undefined;
  return new Set(Array.isArray(value) ? value : [value]);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
