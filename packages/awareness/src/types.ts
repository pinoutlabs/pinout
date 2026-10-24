/**
 * Device awareness contracts (PR1).
 *
 * Awareness tracks every device ever observed. It never actuates, never
 * auto-flashes, and never enrolls without explicit operator approval.
 *
 * `evidenceLevel` is core `SupportLevel` (PR0): UNKNOWN | SIMULATED |
 * COMPILE_TESTED | HARDWARE_VERIFIED.
 */
import type { SupportLevel } from '@pinout/core';

export type { SupportLevel };

/** @deprecated Use SupportLevel from @pinout/core. Alias kept for callers mid-rebase. */
export type EvidenceLevel = SupportLevel;

export type AwarenessTransport = 'serial' | 'usb' | 'ble' | 'mdns' | 'mqtt';

export type AwarenessState =
  | 'SEEN'
  | 'IDENTIFIED'
  | 'PENDING_ENROLL'
  | 'ONLINE'
  | 'STALE'
  | 'OFFLINE';

export interface AwarenessIdentity {
  vid?: string;
  pid?: string;
  firmware?: string;
  version?: string;
  advertisedName?: string;
  uuids?: string[];
  /** SHA-256 prefix of the BLE/MAC address — never store raw MAC. */
  macHash?: string;
  vendor?: string;
  model?: string;
  /** Path / host:port / topic key for the observation endpoint. */
  endpoint?: string;
  /** Best-guess module id from discovery (may be unknown/*). */
  guessedModuleId?: string;
  deviceClass?: string;
}

export type ConnectorStatus = 'none' | 'available' | 'pending' | 'installed' | 'failed';

export interface AwarenessConnector {
  status: ConnectorStatus;
  moduleId?: string;
  note?: string;
}

export interface AwarenessHealth {
  status: 'CONNECTED' | 'DEGRADED' | 'FAULTED' | 'DISCONNECTED' | 'UNKNOWN';
  lifecycle: 'connecting' | 'ready' | 'busy' | 'faulted' | 'stopped' | 'disconnected';
  message?: string;
  lastUpdated: number;
}

export interface AwarenessRecord {
  id: string;
  transport: AwarenessTransport;
  identity: AwarenessIdentity;
  state: AwarenessState;
  firstSeen: number;
  lastSeen: number;
  health: AwarenessHealth;
  capabilities?: string[];
  moduleId?: string;
  /** Canonical PR0 evidence ladder. Defaults to SIMULATED. */
  evidenceLevel: SupportLevel;
  connector?: AwarenessConnector;
  /** Confidence from the last discovery observation (0..1). */
  confidence?: number;
  /** True when this record came from --mock-devices (always SIMULATED). */
  mock?: boolean;
}

export type AwarenessEventType =
  | 'seen'
  | 'identified'
  | 'state_changed'
  | 'online'
  | 'offline';

export interface AwarenessEvent {
  type: AwarenessEventType;
  record: AwarenessRecord;
  at: number;
  previousState?: AwarenessState;
}

export interface AwarenessStalenessConfig {
  /** Ms without observation before ONLINE/PENDING_ENROLL/IDENTIFIED/SEEN → STALE. */
  staleAfterMs: number;
  /** Ms without observation before STALE → OFFLINE. */
  offlineAfterMs: number;
}

export const DEFAULT_STALENESS: AwarenessStalenessConfig = {
  staleAfterMs: 30_000,
  offlineAfterMs: 120_000,
};

export interface AwarenessFile {
  schemaVersion: 1;
  devices: AwarenessRecord[];
}

/** Allowed state-machine transitions (explicit; anything else is rejected). */
export const AWARENESS_TRANSITIONS: Readonly<Record<AwarenessState, readonly AwarenessState[]>> = {
  SEEN: ['IDENTIFIED', 'PENDING_ENROLL', 'STALE', 'OFFLINE'],
  IDENTIFIED: ['PENDING_ENROLL', 'ONLINE', 'STALE', 'OFFLINE', 'SEEN'],
  PENDING_ENROLL: ['ONLINE', 'IDENTIFIED', 'STALE', 'OFFLINE'],
  ONLINE: ['STALE', 'OFFLINE', 'PENDING_ENROLL'],
  STALE: ['ONLINE', 'PENDING_ENROLL', 'IDENTIFIED', 'SEEN', 'OFFLINE'],
  OFFLINE: ['SEEN', 'IDENTIFIED', 'PENDING_ENROLL', 'ONLINE', 'STALE'],
};
