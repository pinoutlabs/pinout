import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PinoutRuntime, readDevicesFile } from '@pinout/core';
import { AwarenessClient } from '@pinout/awareness';
import { startDaemon, type RunningDaemon } from '../src/start.js';
import { AwarenessService } from '../src/awareness/service.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function startAwarenessDaemon(options: {
  token?: string;
  mockDevices?: string;
} = {}): Promise<{ daemon: RunningDaemon; base: string; home: string }> {
  const home = await mkdtemp(join(tmpdir(), 'pinoutd-awareness-'));
  const runtime = new PinoutRuntime();
  const awareness = new AwarenessService({
    home,
    mockDevices: options.mockDevices ?? 'demo',
    intervals: {
      serialMs: 60_000,
      usbMs: 60_000,
      bleMs: 60_000,
      mdnsMs: 60_000,
      networkMs: 60_000,
    },
  });
  const daemon = await startDaemon(runtime, {
    port: 0,
    journalPath: join(home, 'journal.jsonl'),
    requireLeases: false,
    ...(options.token ? { token: options.token } : {}),
    awareness,
  });
  cleanups.push(async () => {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  return { daemon, base: `http://127.0.0.1:${daemon.port}`, home };
}

describe('awareness HTTP API', () => {
  it('lists mock devices via GET /v1/awareness and GET /v1/awareness/:id', async () => {
    const { base } = await startAwarenessDaemon();
    const list = await fetch(`${base}/v1/awareness`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      devices: Array<{ id: string; state: string; evidenceLevel: string; mock?: boolean }>;
    };
    expect(body.devices.length).toBeGreaterThanOrEqual(5);
    expect(body.devices.every((d) => d.evidenceLevel === 'SIMULATED')).toBe(true);
    expect(body.devices.some((d) => d.state === 'PENDING_ENROLL')).toBe(true);
    expect(body.devices.some((d) => d.id && d.state === 'IDENTIFIED')).toBe(true);

    const unknown = body.devices.find((d) => d.state === 'IDENTIFIED');
    expect(unknown).toBeTruthy();
    const one = await fetch(`${base}/v1/awareness/${encodeURIComponent(unknown!.id)}`);
    expect(one.status).toBe(200);
    const record = (await one.json()) as { id: string; evidenceLevel: string };
    expect(record.id).toBe(unknown!.id);
    expect(record.evidenceLevel).toBe('SIMULATED');
  });

  it('streams awareness events over SSE', async () => {
    const { base, daemon } = await startAwarenessDaemon();
    const response = await fetch(`${base}/v1/awareness/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const seenTypes = new Set<string>();
    const deadline = Date.now() + 3_000;

    // Trigger a fresh observation so SSE emits after hello.
    daemon.awareness?.ingest(
      [
        {
          id: 'cand_sse_test',
          endpoint: { kind: 'serial', address: '/dev/cu.sse-test' },
          possibleIdentity: [
            {
              moduleId: 'pinout/esp32',
              vendor: 'Espressif',
              reason: 'sse test',
            },
          ],
          evidence: [{ source: 'test', detail: 'sse', weight: 0.4 }],
          confidence: 0.4,
          interfaces: ['serial'],
        },
      ],
      true,
    );

    while (Date.now() < deadline && !seenTypes.has('seen')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const chunk of buffer.split('\n\n')) {
        const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
        if (!dataLine) continue;
        const parsed = JSON.parse(dataLine.slice(5).trim()) as { type?: string };
        if (parsed.type) seenTypes.add(parsed.type);
      }
    }
    reader.cancel().catch(() => undefined);
    expect(seenTypes.has('hello') || seenTypes.has('seen')).toBe(true);
    expect(seenTypes.has('seen') || seenTypes.has('state_changed')).toBe(true);
  });

  it('enrolls PENDING_ENROLL via POST with auth token and devices.json path', async () => {
    const token = 'test-awareness-token';
    const { base, home } = await startAwarenessDaemon({ token });
    const listRes = await fetch(`${base}/v1/awareness`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const { devices } = (await listRes.json()) as {
      devices: Array<{ id: string; state: string; moduleId?: string }>;
    };
    const pending = devices.find((d) => d.state === 'PENDING_ENROLL' && d.moduleId === 'pinout/esp32');
    expect(pending).toBeTruthy();

    const denied = await fetch(`${base}/v1/awareness/${pending!.id}/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(denied.status).toBe(401);

    const enrolled = await fetch(`${base}/v1/awareness/${pending!.id}/enroll`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ deviceId: 'mock-esp-enrolled' }),
    });
    expect(enrolled.status).toBe(200);
    const body = (await enrolled.json()) as {
      enrolled: boolean;
      record: { state: string };
      device: { id: string; module: string };
    };
    expect(body.enrolled).toBe(true);
    expect(body.record.state).toBe('ONLINE');
    expect(body.device.id).toBe('mock-esp-enrolled');

    const file = readDevicesFile(undefined, home);
    expect(file.devices.some((d) => d.id === 'mock-esp-enrolled')).toBe(true);
  });

  it('refuses to enroll UNKNOWN devices without a module', async () => {
    const { base } = await startAwarenessDaemon();
    const list = (await (await fetch(`${base}/v1/awareness`)).json()) as {
      devices: Array<{
        id: string;
        state: string;
        moduleId?: string;
        identity: { guessedModuleId?: string };
      }>;
    };
    const unknown = list.devices.find(
      (d) =>
        d.state === 'IDENTIFIED' &&
        (d.identity.guessedModuleId?.startsWith('unknown/') === true ||
          d.moduleId?.startsWith('unknown/') === true),
    );
    expect(unknown).toBeTruthy();
    const response = await fetch(`${base}/v1/awareness/${unknown!.id}/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it('exposes AwarenessClient list/get/enroll/subscribe', async () => {
    const { base } = await startAwarenessDaemon();
    const client = new AwarenessClient({ baseUrl: base });
    const devices = await client.list();
    expect(devices.length).toBeGreaterThan(0);
    const first = await client.get(devices[0]!.id);
    expect(first.id).toBe(devices[0]!.id);

    const events: string[] = [];
    const stop = client.subscribe((event) => events.push(event.type));
    const pending = devices.find((d) => d.state === 'PENDING_ENROLL');
    if (pending) {
      await client.enroll(pending.id, { deviceId: `cli-${pending.id.slice(-6)}` });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    stop();
    expect(devices.some((d) => d.evidenceLevel === 'SIMULATED')).toBe(true);
  });

  it('reflects presence on DeviceGraph', async () => {
    const { daemon } = await startAwarenessDaemon();
    const graphIds = daemon.awareness!.graph.ids();
    expect(graphIds.length).toBeGreaterThan(0);
    const node = daemon.awareness!.graph.get(graphIds[0]!);
    expect(node?.support).toBe('SIMULATED');
    expect(node?.transport.kind).toBeTruthy();
    expect(node?.health.status === 'CONNECTED' || node?.health.status === 'DISCONNECTED').toBe(
      true,
    );
  });
});
