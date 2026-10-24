/**
 * AwarenessClient — typed HTTP + SSE client for the daemon awareness API.
 *
 * Contract (other agents depend on these shapes exactly):
 *   GET  /v1/awareness           → { devices: AwarenessRecord[] }
 *   GET  /v1/awareness/:id       → AwarenessRecord
 *   GET  /v1/awareness/events    → SSE { type, record }
 *   POST /v1/awareness/:id/enroll → { record, enrolled: true, device? }
 */
import type { AwarenessEvent, AwarenessEventType, AwarenessRecord } from './types.js';

export interface AwarenessClientOptions {
  baseUrl: string;
  token?: string;
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
}

export interface EnrollResult {
  enrolled: true;
  record: AwarenessRecord;
  device?: { id: string; module: string };
}

export type AwarenessSubscribeCallback = (event: AwarenessEvent) => void;

export class AwarenessClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AwarenessClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async list(): Promise<AwarenessRecord[]> {
    const body = await this.requestJson<{ devices: AwarenessRecord[] }>('GET', '/v1/awareness');
    return body.devices;
  }

  async get(id: string): Promise<AwarenessRecord> {
    return this.requestJson<AwarenessRecord>('GET', `/v1/awareness/${encodeURIComponent(id)}`);
  }

  async enroll(id: string, body: { moduleId?: string; deviceId?: string } = {}): Promise<EnrollResult> {
    return this.requestJson<EnrollResult>('POST', `/v1/awareness/${encodeURIComponent(id)}/enroll`, body);
  }

  /**
   * Subscribe to awareness SSE. Returns an unsubscribe function.
   * Uses the Fetch streaming body when available; falls back to polling list diffs in tests
   * if EventSource is unavailable and no stream reader exists.
   */
  subscribe(callback: AwarenessSubscribeCallback): () => void {
    const controller = new AbortController();
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    void (async () => {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/v1/awareness/events`, {
          headers,
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const dataLine = chunk
              .split('\n')
              .map((line) => line.trimEnd())
              .find((line) => line.startsWith('data:'));
            if (!dataLine) continue;
            const payload = dataLine.slice('data:'.length).trim();
            if (!payload) continue;
            try {
              const parsed = JSON.parse(payload) as {
                type?: AwarenessEventType | 'hello';
                record?: AwarenessRecord;
                at?: number;
                previousState?: AwarenessEvent['previousState'];
              };
              if (!parsed.type || parsed.type === 'hello' || !parsed.record) continue;
              callback({
                type: parsed.type,
                record: parsed.record,
                at: parsed.at ?? Date.now(),
                ...(parsed.previousState !== undefined
                  ? { previousState: parsed.previousState }
                  : {}),
              });
            } catch {
              // Ignore malformed SSE frames.
            }
          }
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
      }
    })();

    return () => controller.abort();
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await response.json()) as T & { error?: { message?: string } };
    if (!response.ok) {
      throw new Error(
        json.error?.message ?? `Awareness request failed: ${method} ${path} → ${response.status}`,
      );
    }
    return json;
  }
}
