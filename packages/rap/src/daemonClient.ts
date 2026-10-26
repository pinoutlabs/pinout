export interface DaemonClientOptions {
  baseUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export class DaemonClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: DaemonClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
    this.token = options.token;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  get url(): string {
    return this.baseUrl;
  }

  async call(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    if (text) {
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        payload = { raw: text };
      }
    }
    if (!response.ok) {
      const error = (payload.error as Record<string, unknown> | undefined) ?? {};
      const code = typeof error.code === 'string' ? error.code : `HTTP_${response.status}`;
      const message =
        typeof error.message === 'string'
          ? error.message
          : typeof payload.message === 'string'
            ? payload.message
            : `Daemon request failed (${response.status})`;
      throw Object.assign(new Error(message), {
        code,
        status: response.status,
        details: payload,
        retryable: response.status >= 500,
      });
    }
    return payload;
  }

  listDevices(): Promise<unknown> {
    return this.call('GET', '/v1/devices?include=capabilities');
  }

  describeDevice(deviceId: string): Promise<Record<string, unknown>> {
    return this.call('GET', `/v1/devices/${encodeURIComponent(deviceId)}`);
  }

  readState(deviceId: string): Promise<Record<string, unknown>> {
    return this.call('GET', `/v1/devices/${encodeURIComponent(deviceId)}/state`);
  }

  snapshot(): Promise<Record<string, unknown>> {
    return this.call('GET', '/v1/snapshot');
  }

  safety(): Promise<Record<string, unknown>> {
    return this.call('GET', '/v1/safety');
  }

  invokeAccepted(input: {
    deviceId: string;
    capability: string;
    args: Record<string, unknown>;
    owner: string;
    idempotencyKey: string;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    return this.call('POST', `/v1/devices/${encodeURIComponent(input.deviceId)}/invoke`, {
      capability: input.capability,
      args: input.args,
      owner: input.owner,
      waitFor: 'accepted',
      idempotencyKey: input.idempotencyKey,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
  }

  dryRun(input: {
    deviceId: string;
    capability: string;
    args: Record<string, unknown>;
    owner: string;
  }): Promise<Record<string, unknown>> {
    return this.call('POST', `/v1/devices/${encodeURIComponent(input.deviceId)}/invoke`, {
      capability: input.capability,
      args: input.args,
      owner: input.owner,
      dryRun: true,
    });
  }

  operationStatus(operationId: string): Promise<Record<string, unknown>> {
    return this.call('GET', `/v1/operations/${encodeURIComponent(operationId)}`);
  }

  cancelOperation(operationId: string, reason?: string): Promise<Record<string, unknown>> {
    return this.call('POST', `/v1/operations/${encodeURIComponent(operationId)}/cancel`, {
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  acquireLease(input: {
    deviceId: string;
    owner: string;
    mode?: string;
    ttlMs?: number;
  }): Promise<Record<string, unknown>> {
    return this.call('POST', '/v1/leases', {
      owner: input.owner,
      mode: input.mode ?? 'exclusive',
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
      scope: { kind: 'device', deviceId: input.deviceId },
    });
  }

  renewLease(input: {
    leaseId: string;
    owner: string;
    ttlMs?: number;
  }): Promise<Record<string, unknown>> {
    return this.call('POST', `/v1/leases/${encodeURIComponent(input.leaseId)}/renew`, {
      owner: input.owner,
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    });
  }

  releaseLease(leaseId: string, owner: string): Promise<Record<string, unknown>> {
    return this.call(
      'DELETE',
      `/v1/leases/${encodeURIComponent(leaseId)}?owner=${encodeURIComponent(owner)}`,
      { owner },
    );
  }

  listLeases(): Promise<Record<string, unknown>> {
    return this.call('GET', '/v1/leases');
  }

  /** Best-effort disarm / safe-state for a device the thread may have armed. */
  async disarmOrSafeState(deviceId: string, owner: string): Promise<void> {
    try {
      await this.call('POST', `/v1/devices/${encodeURIComponent(deviceId)}/invoke`, {
        capability: 'sys.disarm',
        args: {},
        owner,
        waitFor: 'accepted',
        idempotencyKey: `rap-disarm:${owner}:${deviceId}:${Date.now()}`,
      });
      return;
    } catch {
      // Fall through to other safe capabilities.
    }
    for (const capability of ['gpio.safeState', 'sys.safeState', 'lamp.disarm']) {
      try {
        await this.call('POST', `/v1/devices/${encodeURIComponent(deviceId)}/invoke`, {
          capability,
          args: {},
          owner,
          waitFor: 'accepted',
          idempotencyKey: `rap-safe:${owner}:${deviceId}:${capability}:${Date.now()}`,
        });
        return;
      } catch {
        // try next
      }
    }
  }
}
