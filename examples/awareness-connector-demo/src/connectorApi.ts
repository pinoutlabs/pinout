/**
 * HTTP client for real pinoutd /v1/connectors* (PR4) plus SIMULATED capability
 * exercise that honors quarantine enablement and post-install device invoke.
 */
import { getModule, type PinoutRuntime } from '@pinout/core';
import type { InvokeResult, SupportLevel } from './types.js';

export interface DaemonConnectorCapability {
  name: string;
  physicalOutput: boolean;
  enabled: boolean;
  description?: string;
  reversible?: boolean;
  safety?: { physicalOutput: boolean; reversible: boolean };
}

export interface DaemonConnectorRecord {
  id: string;
  awarenessId?: string;
  moduleId: string;
  version: string;
  status: 'CANDIDATE' | 'QUARANTINED' | 'APPROVED' | 'INSTALLED' | 'REJECTED';
  evidenceLevel: SupportLevel;
  capabilities: DaemonConnectorCapability[];
  safety: {
    physicalOutputsDisabled: boolean;
    requiresHumanApproval: boolean;
    autoInstallForbidden: boolean;
    autoFlashForbidden: boolean;
    autoActuateForbidden: boolean;
  };
  safetyFlags?: {
    physicalOutputBlockedUntilHumanApproval: boolean;
  };
  report: {
    passed: boolean;
    neverInstalls?: boolean;
    generator?: Record<string, unknown>;
    reasons?: string[];
    checks?: unknown[];
  };
  approval?: {
    approvedAt: string;
    approvedBy: string;
    capabilities: string[];
    ranges: Record<string, Record<string, { min: number; max: number }>>;
  };
  contentHash?: string;
  modulePath?: string;
  installPath?: string;
}

export interface ConnectorApiOptions {
  baseUrl: string;
  token: string;
  runtime: PinoutRuntime;
}

export class ConnectorApi {
  readonly baseUrl: string;
  readonly token: string;
  private readonly runtime: PinoutRuntime;
  private readonly deviceByConnector = new Map<string, string>();

  constructor(options: ConnectorApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.runtime = options.runtime;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: T }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = { raw: text };
      }
    }
    return { status: response.status, body: parsed as T };
  }

  async generate(awarenessId: string): Promise<DaemonConnectorRecord> {
    const { status, body } = await this.request<{
      connector?: DaemonConnectorRecord;
      error?: { message?: string };
    }>('POST', '/v1/connectors/generate', { awarenessId });
    if (status !== 201 || !body.connector) {
      throw new Error(
        `generate failed HTTP ${status}: ${body.error?.message ?? JSON.stringify(body)}`,
      );
    }
    return body.connector;
  }

  async get(connectorId: string): Promise<DaemonConnectorRecord> {
    const { status, body } = await this.request<{
      connector?: DaemonConnectorRecord;
      error?: { message?: string };
    }>('GET', `/v1/connectors/${encodeURIComponent(connectorId)}`);
    if (status !== 200 || !body.connector) {
      throw new Error(`get connector failed HTTP ${status}: ${JSON.stringify(body)}`);
    }
    return body.connector;
  }

  async list(): Promise<DaemonConnectorRecord[]> {
    const { status, body } = await this.request<{
      connectors?: DaemonConnectorRecord[];
    }>('GET', '/v1/connectors');
    if (status !== 200 || !Array.isArray(body.connectors)) {
      throw new Error(`list connectors failed HTTP ${status}`);
    }
    return body.connectors;
  }

  async approve(
    connectorId: string,
    payload: {
      capabilities: string[];
      ranges: Record<string, Record<string, { min: number; max: number }>>;
      approvedBy?: string;
    },
  ): Promise<DaemonConnectorRecord> {
    const { status, body } = await this.request<{
      connector?: DaemonConnectorRecord;
      error?: { message?: string };
    }>('POST', `/v1/connectors/${encodeURIComponent(connectorId)}/approve`, payload);
    if (status !== 200 || !body.connector) {
      throw new Error(
        `approve failed HTTP ${status}: ${body.error?.message ?? JSON.stringify(body)}`,
      );
    }
    return body.connector;
  }

  async install(connectorId: string): Promise<DaemonConnectorRecord> {
    const { status, body } = await this.request<{
      connector?: DaemonConnectorRecord;
      error?: { message?: string };
    }>('POST', `/v1/connectors/${encodeURIComponent(connectorId)}/install`, {});
    if (status !== 200 || !body.connector) {
      throw new Error(
        `install failed HTTP ${status}: ${body.error?.message ?? JSON.stringify(body)}`,
      );
    }
    return body.connector;
  }

  async reject(connectorId: string, reason?: string): Promise<DaemonConnectorRecord> {
    const { status, body } = await this.request<{
      connector?: DaemonConnectorRecord;
      error?: { message?: string };
    }>('POST', `/v1/connectors/${encodeURIComponent(connectorId)}/reject`, {
      ...(reason !== undefined ? { reason } : {}),
      rejectedBy: 'demo-operator',
    });
    if (status !== 200 || !body.connector) {
      throw new Error(
        `reject failed HTTP ${status}: ${body.error?.message ?? JSON.stringify(body)}`,
      );
    }
    return body.connector;
  }

  /** Ensure a SIMULATED runtime device exists for an INSTALLED connector module. */
  async ensureSimulatedDevice(connector: DaemonConnectorRecord): Promise<string> {
    const existing = this.deviceByConnector.get(connector.id);
    if (existing) return existing;

    const deviceId = `sim-connector-${connector.id.slice(0, 8)}`;
    const module = getModule(connector.moduleId);
    await this.runtime.registerModuleDevice(module, {
      id: deviceId,
      simulated: true,
    });
    this.deviceByConnector.set(connector.id, deviceId);
    return deviceId;
  }

  /**
   * Exercise a capability against the real connector record / device path.
   * Quarantine physical-output blocks before approval; after install, ranges
   * are enforced by /v1/devices/:id/invoke policy rules.
   */
  async invokeCapability(
    connectorId: string,
    capability: string,
    args: Record<string, unknown>,
  ): Promise<InvokeResult> {
    const connector = await this.get(connectorId);
    const descriptor = connector.capabilities.find((entry) => entry.name === capability);
    if (!descriptor) {
      return {
        ok: false,
        code: 'UNSUPPORTED_CAPABILITY',
        message: `Unknown capability ${capability}`,
      };
    }

    if (connector.status === 'REJECTED') {
      return { ok: false, code: 'CONNECTOR_REJECTED', message: 'Connector was rejected' };
    }

    if (!descriptor.enabled) {
      return {
        ok: false,
        code: 'SAFETY_APPROVAL_REQUIRED',
        message:
          'Physical-output capability is quarantined until a human approves ranges (HUMAN APPROVES).',
      };
    }

    if (connector.status !== 'INSTALLED') {
      // Read-only quarantine use before install — SIMULATED, no transport.
      return {
        ok: true,
        result: {
          capability,
          args,
          evidenceLevel: connector.evidenceLevel,
          simulated: true,
          armed: false,
          note: 'SIMULATED read-only connector use before install — no physical transport opened',
        },
      };
    }

    const deviceId = await this.ensureSimulatedDevice(connector);
    const { status, body } = await this.request<{
      result?: Record<string, unknown>;
      operation?: { status?: string };
      error?: { code?: string; message?: string };
    }>('POST', `/v1/devices/${encodeURIComponent(deviceId)}/invoke`, {
      capability,
      args,
      owner: 'awareness-demo',
      waitFor: 'result',
    });

    if (status >= 400) {
      return {
        ok: false,
        code: body.error?.code ?? `HTTP_${status}`,
        message: body.error?.message ?? `invoke failed HTTP ${status}`,
        result: body as unknown as Record<string, unknown>,
      };
    }

    const result = (body.result ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      result: {
        ...result,
        simulated: true,
        armed: result.armed === true || result.armed === 'armed' ? true : false,
        evidenceLevel: connector.evidenceLevel,
      },
    };
  }
}
