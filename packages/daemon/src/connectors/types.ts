import type { SupportLevel } from '@pinout/core';

/** Lifecycle of a generated connector through the human-gated pipeline. */
export type ConnectorStatus =
  | 'CANDIDATE'
  | 'QUARANTINED'
  | 'APPROVED'
  | 'INSTALLED'
  | 'REJECTED';

/** Per-parameter numeric bounds granted at approval time. */
export type ConnectorRangeMap = Record<string, Record<string, { min: number; max: number }>>;

export interface ConnectorCapabilitySummary {
  name: string;
  description?: string;
  physicalOutput: boolean;
  /** False while quarantined for physicalOutput capabilities (until approve). */
  enabled: boolean;
  reversible?: boolean;
}

export interface ConnectorSafetyFlags {
  physicalOutputsDisabled: boolean;
  requiresHumanApproval: boolean;
  autoInstallForbidden: true;
  autoFlashForbidden: true;
  autoActuateForbidden: true;
}

export interface ConnectorApproval {
  approvedAt: string;
  approvedBy: string;
  capabilities: string[];
  ranges: ConnectorRangeMap;
}

export interface ConnectorConformanceReport {
  passed: boolean;
  level?: string;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  buildError?: string;
  integrityStatus?: string;
  reasons: string[];
  generator?: Record<string, unknown>;
}

export interface ConnectorRecord {
  id: string;
  awarenessId?: string;
  moduleId: string;
  version: string;
  status: ConnectorStatus;
  evidenceLevel: SupportLevel;
  capabilities: ConnectorCapabilitySummary[];
  safety: ConnectorSafetyFlags;
  report: ConnectorConformanceReport;
  approval?: ConnectorApproval;
  contentHash?: string;
  manifestHash?: string;
  modulePath: string;
  createdAt: string;
  updatedAt: string;
  rejection?: { rejectedAt: string; rejectedBy: string; reason?: string };
  installPath?: string;
}

export interface ConnectorListItem {
  id: string;
  moduleId: string;
  status: ConnectorStatus;
  evidenceLevel: SupportLevel;
  awarenessId?: string;
  updatedAt: string;
}

export interface ApproveConnectorBody {
  capabilities: string[];
  ranges: ConnectorRangeMap;
  approvedBy?: string;
}

export interface RejectConnectorBody {
  reason?: string;
  rejectedBy?: string;
}

export interface GenerateConnectorBody {
  awarenessId: string;
}
