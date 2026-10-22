export const OAHL_PROTOCOL_VERSION = '1.0.0';

export interface OahlDeviceCapability {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | undefined;
  safety: {
    physicalOutput: boolean;
    reversible: boolean;
    notes?: string | undefined;
  };
}

export interface OahlReservationInfo {
  reservationId: string;
  owner: string;
  expiresAt: string;
  scope?: 'exclusive' | 'shared' | undefined;
}

export interface OahlDevice {
  id: string;
  label: string;
  deviceClass: string;
  vendor?: string | undefined;
  model?: string | undefined;
  status: 'ready' | 'busy' | 'faulted' | 'offline';
  available: boolean;
  capabilities: OahlDeviceCapability[];
  currentReservation?: OahlReservationInfo | undefined;
}

export interface OahlDiscoverFilter {
  deviceClass?: string | undefined;
  capability?: string | undefined;
  availableOnly?: boolean | undefined;
}

export interface OahlDiscoverResponse {
  protocolVersion: string;
  timestamp: string;
  devices: OahlDevice[];
}

export interface OahlReserveRequest {
  deviceId: string;
  owner: string;
  ttlMs?: number | undefined;
  scope?: 'exclusive' | 'shared' | undefined;
  capabilities?: string[] | undefined;
}

export interface OahlReserveResponse {
  reservationId: string;
  deviceId: string;
  owner: string;
  grantedTtlMs: number;
  expiresAt: string;
  status: 'acquired';
}

export interface OahlRenewRequest {
  reservationId: string;
  ttlMs?: number | undefined;
}

export interface OahlRenewResponse {
  reservationId: string;
  grantedTtlMs: number;
  expiresAt: string;
}

export interface OahlExecuteRequest {
  reservationId: string;
  deviceId: string;
  action: string;
  params?: Record<string, unknown> | undefined;
  idempotencyKey?: string | undefined;
}

export interface OahlExecuteError {
  code: string;
  message: string;
  details?: unknown;
}

export interface OahlExecuteResponse {
  executionId: string;
  deviceId: string;
  action: string;
  status: 'completed' | 'failed';
  result?: Record<string, unknown> | undefined;
  error?: OahlExecuteError | undefined;
  executedAt: string;
}

export interface OahlReleaseRequest {
  reservationId: string;
  deviceId?: string | undefined;
  safePark?: boolean | undefined;
}

export interface OahlReleaseResponse {
  released: boolean;
  reservationId: string;
  releasedAt: string;
}

export interface OahlBridgeOptions {
  defaultTtlMs?: number | undefined;
  maxTtlMs?: number | undefined;
}

export interface OahlServerOptions extends OahlBridgeOptions {
  port?: number | undefined;
  host?: string | undefined;
}
