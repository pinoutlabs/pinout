import { OahlError } from './errors.js';
import type {
  OahlDiscoverFilter,
  OahlDiscoverResponse,
  OahlExecuteRequest,
  OahlExecuteResponse,
  OahlReleaseRequest,
  OahlReleaseResponse,
  OahlRenewRequest,
  OahlRenewResponse,
  OahlReserveRequest,
  OahlReserveResponse,
} from './types.js';

export interface OahlClientOptions {
  baseUrl: string;
}

export class OahlClient {
  readonly baseUrl: string;

  constructor(options: OahlClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  async discover(filter: OahlDiscoverFilter = {}): Promise<OahlDiscoverResponse> {
    const params = new URLSearchParams();
    if (filter.deviceClass) params.set('deviceClass', filter.deviceClass);
    if (filter.capability) params.set('capability', filter.capability);
    if (filter.availableOnly) params.set('availableOnly', 'true');

    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request<OahlDiscoverResponse>('GET', `/oahl/v1/discover${qs}`);
  }

  async reserve(req: OahlReserveRequest): Promise<OahlReserveResponse> {
    return this.request<OahlReserveResponse>('POST', '/oahl/v1/reserve', req);
  }

  async renew(req: OahlRenewRequest): Promise<OahlRenewResponse> {
    return this.request<OahlRenewResponse>('POST', '/oahl/v1/renew', req);
  }

  async execute(req: OahlExecuteRequest): Promise<OahlExecuteResponse> {
    return this.request<OahlExecuteResponse>('POST', '/oahl/v1/execute', req);
  }

  async release(req: OahlReleaseRequest): Promise<OahlReleaseResponse> {
    return this.request<OahlReleaseResponse>('POST', '/oahl/v1/release', req);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    const init: RequestInit = {
      method,
      headers,
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);

    const json = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      const errObj = json.error as
        { code?: string; message?: string; details?: unknown } | undefined;
      const code = errObj?.code ?? 'REQUEST_FAILED';
      const msg = errObj?.message ?? `OAHL request failed with status ${res.status}`;
      throw new OahlError(code, msg, res.status, errObj?.details);
    }

    return json as T;
  }
}
