/**
 * Demo-local types for the connector lifecycle stub (PR4 surface).
 * Awareness records come from `@pinout/awareness`. Evidence uses core SupportLevel.
 */
import { capSupportLevel, compareSupportLevels, type SupportLevel } from '@pinout/core';
import type { ConnectorSourceKind } from '@pinout/generator';

export type { SupportLevel };

/** PR4 connector lifecycle (PR2/MCP contracts). Distinct from awareness ConnectorStatus. */
export type ConnectorLifecycleStatus =
  'CANDIDATE' | 'QUARANTINED' | 'APPROVED' | 'INSTALLED' | 'REJECTED';

export interface ParamRange {
  min: number;
  max: number;
}

export interface ConnectorApproveRequest {
  capabilities: string[];
  ranges: Record<string, Record<string, ParamRange>>;
}

export interface StubConnectorCapability {
  id: string;
  physicalOutput: boolean;
  requiresApproval: boolean;
  args?: Record<string, { type?: string; required?: boolean }>;
}

export interface StubConnectorRecord {
  id: string;
  awarenessId: string;
  status: ConnectorLifecycleStatus;
  evidenceLevel: SupportLevel;
  mode: 'read-only' | 'approved' | 'installed';
  capabilities: StubConnectorCapability[];
  approvedCapabilities: string[];
  ranges: Record<string, Record<string, ParamRange>>;
  armed: boolean;
  generated: true;
  source: ConnectorSourceKind | string;
  moduleId: string;
  pendingApprovals: string[];
  report: {
    quarantine: boolean;
    conformanceGate: 'passed' | 'failed' | 'stubbed';
    notes: string[];
    neverInstalls: true;
    neverRegisters: true;
  };
}

export interface InvokeResult {
  ok: boolean;
  code?: string;
  message?: string;
  result?: Record<string, unknown>;
}

export interface ConnectorEvidenceEntry {
  source: ConnectorSourceKind | 'auto' | 'gatt' | 'mqtt' | 'sys.hello' | 'mdns' | 'openapi';
  fixturePath: string;
}

export interface ConnectorEvidenceFile {
  byAwarenessId: Record<string, ConnectorEvidenceEntry>;
}

export function capEvidenceLevel(
  level: SupportLevel,
  max: SupportLevel = 'COMPILE_TESTED',
): SupportLevel {
  return capSupportLevel(level, max);
}

export function evidenceExceeds(level: SupportLevel, max: SupportLevel): boolean {
  return compareSupportLevels(level, max) > 0;
}
