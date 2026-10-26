import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PinoutRuntime, relayModule, registerModule } from '@pinout/core';
import { startDaemon, type RunningDaemon } from '../src/start.js';

let daemon: RunningDaemon;
let base: string;
let journalDir: string;

beforeAll(async () => {
  const runtime = new PinoutRuntime();
  registerModule(relayModule);
  await runtime.registerFromModule(relayModule.id, { id: 'relay-01', simulated: true });
  journalDir = await mkdtemp(join(tmpdir(), 'pinoutd-test-'));
  daemon = await startDaemon(runtime, {
    port: 0,
    journalPath: join(journalDir, 'journal.jsonl'),
    requireLeases: false,
  });
  base = `http://127.0.0.1:${daemon.port}`;
});

afterAll(async () => {
  await daemon?.close();
  await rm(journalDir, { recursive: true, force: true });
});

describe('pinoutd HTTP API', () => {
  it('scopes idempotency keys by the caller supplied to HTTP', async () => {
    const invoke = async (owner: string) => {
      const response = await fetch(`${base}/v1/devices/relay-01/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          capability: 'relay.set',
          args: { on: false },
          owner,
          idempotencyKey: 'owner-test',
          waitFor: 'result',
        }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { operation: { id: string } }).operation.id;
    };
    const first = await invoke('first');
    expect(await invoke('second')).not.toBe(first);
    expect(await invoke('first')).toBe(first);
  });

  it.each(['null', '[]', '{oops'])(
    'returns validation errors for malformed bodies: %s',
    async (body) => {
      const response = await fetch(`${base}/v1/devices/relay-01/invoke`, { method: 'POST', body });
      expect(response.status).toBe(400);
    },
  );

  it('dry runs preserve rate slots and retries reuse an operation after its approval is consumed', async () => {
    const runtime = new PinoutRuntime();
    await runtime.registerFromModule(relayModule.id, { id: 'r', simulated: true });
    const isolated = await startDaemon(runtime, {
      port: 0,
      requireLeases: false,
      safetyRules: [
        { kind: 'rate', capability: 'relay.set', maxPerWindow: 1, windowMs: 60000 },
        { kind: 'approval', capability: 'relay.set' },
      ],
    });
    isolated.context.safety.recordApproval({
      id: 'a',
      deviceId: 'r',
      capability: 'relay.set',
      grantedBy: 'operator',
    });
    const invoke = (dryRun: boolean) =>
      fetch(`http://127.0.0.1:${isolated.port}/v1/devices/r/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          capability: 'relay.set',
          args: { on: true },
          dryRun,
          owner: 'agent',
          idempotencyKey: 'once',
          waitFor: 'result',
        }),
      });
    try {
      expect((await invoke(true)).status).toBe(200);
      expect((await invoke(true)).status).toBe(200);
      const first = await invoke(false);
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { operation: { id: string } };
      isolated.context.halt.halt('retry must not execute');
      const retry = await invoke(false);
      expect(retry.status).toBe(200);
      expect(((await retry.json()) as { operation: { id: string } }).operation.id).toBe(
        firstBody.operation.id,
      );
    } finally {
      await isolated.close();
    }
  });

  it('reports health', async () => {
    const res = await fetch(`${base}/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; devices: number; safety: string };
    expect(body.ok).toBe(true);
    expect(body.devices).toBe(1);
    expect(body.safety).toBe('NORMAL');
  });

  it('requires an exclusive owner lease for physical outputs by default', async () => {
    const runtime = new PinoutRuntime();
    await runtime.registerFromModule(relayModule.id, { id: 'lease-default', simulated: true });
    const guarded = await startDaemon(runtime, { port: 0 });
    const url = `http://127.0.0.1:${guarded.port}`;
    const invoke = () =>
      fetch(`${url}/v1/devices/lease-default/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          capability: 'relay.set',
          args: { on: true },
          owner: 'agent-a',
          waitFor: 'result',
        }),
      });
    try {
      expect((await invoke()).status).toBe(409);
      const lease = await fetch(`${url}/v1/leases`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          owner: 'agent-a',
          mode: 'exclusive',
          scope: { kind: 'device', deviceId: 'lease-default' },
        }),
      });
      expect(lease.status).toBe(201);
      expect((await invoke()).status).toBe(200);
    } finally {
      await guarded.close();
    }
  });

  it('lists devices and their state', async () => {
    const res = await fetch(`${base}/v1/devices`);
    const { devices } = (await res.json()) as { devices: Array<{ id: string }> };
    expect(devices.map((d) => d.id)).toContain('relay-01');

    const state = await fetch(`${base}/v1/devices/relay-01/state`);
    const body = (await state.json()) as { state: Record<string, unknown> };
    expect(body.state).toBeDefined();
  });

  it('404s for unknown devices with a structured error', async () => {
    const res = await fetch(`${base}/v1/devices/ghost`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DEVICE_NOT_FOUND');
  });

  it('invokes a capability with waitFor=result', async () => {
    const res = await fetch(`${base}/v1/devices/relay-01/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'relay.set', args: { on: true }, waitFor: 'result' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: Record<string, unknown>;
      operation: { status: string };
    };
    expect(body.operation.status).toBe('completed');
    expect(body.result).toBeDefined();
  });

  it('supports dry-run without executing', async () => {
    const res = await fetch(`${base}/v1/devices/relay-01/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'relay.set', args: { on: false }, dryRun: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dryRun: boolean;
      capability: string;
      resolvedArgs: Record<string, unknown>;
    };
    expect(body.dryRun).toBe(true);
    expect(body.resolvedArgs).toEqual({ on: false });
    // Nothing executed: state remains as set by the previous test.
    const state = (await (await fetch(`${base}/v1/devices/relay-01/state`)).json()) as {
      state: Record<string, unknown>;
    };
    expect(JSON.stringify(state.state)).not.toContain('"on":false');
  });

  it('returns 202 with an operation handle for accepted invocations', async () => {
    const res = await fetch(`${base}/v1/devices/relay-01/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'relay.set', args: { on: true } }),
    });
    expect(res.status).toBe(202);
    const { operation } = (await res.json()) as { operation: { id: string; status: string } };
    expect(operation.id).toMatch(/^op_/);

    const polled = await fetch(`${base}/v1/operations/${operation.id}`);
    const body = (await polled.json()) as { operation: { id: string } };
    expect(body.operation.id).toBe(operation.id);
  });

  it('dedupes retries via idempotency key', async () => {
    const makeCall = (): Promise<Response> =>
      fetch(`${base}/v1/devices/relay-01/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          capability: 'relay.set',
          args: { on: true },
          idempotencyKey: 'retry-42',
          waitFor: 'result',
        }),
      });

    const first = await makeCall();
    const second = await makeCall();
    const firstOp = ((await first.json()) as { operation: { id: string } }).operation;
    const secondOp = ((await second.json()) as { operation: { id: string } }).operation;
    expect(secondOp.id).toBe(firstOp.id);
  });

  it('rejects unsupported capabilities', async () => {
    const res = await fetch(`${base}/v1/devices/relay-01/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'motion.move_to', args: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('manages leases', async () => {
    const acquired = await fetch(`${base}/v1/leases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'agent-a', scope: { kind: 'device', deviceId: 'relay-01' } }),
    });
    expect(acquired.status).toBe(201);
    const { lease } = (await acquired.json()) as { lease: { id: string } };

    const listed = (await (await fetch(`${base}/v1/leases`)).json()) as {
      leases: Array<{ id: string }>;
    };
    expect(listed.leases.map((l) => l.id)).toContain(lease.id);

    const renewed = await fetch(`${base}/v1/leases/${lease.id}/renew`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'agent-a' }),
    });
    expect(renewed.status).toBe(200);

    const released = await fetch(`${base}/v1/leases/${lease.id}?owner=agent-a`, {
      method: 'DELETE',
    });
    expect(released.status).toBe(200);
  });

  it('halts and resumes, rejecting physical invocations while halted', async () => {
    const halt = await fetch(`${base}/v1/halt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'test halt' }),
    });
    expect(halt.status).toBe(200);

    const safety = (await (await fetch(`${base}/v1/safety`)).json()) as { state: string };
    expect(safety.state).toBe('HALTED');

    const rejected = await fetch(`${base}/v1/devices/relay-01/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: 'relay.set',
        args: { on: true },
        // Distinct key so this is a new actuation, not an idempotent observe of
        // an earlier successful invoke on the shared daemon.
        idempotencyKey: 'halt-rejection-check',
      }),
    });
    expect(rejected.status).toBe(409);
    const err = (await rejected.json()) as { error: { code: string } };
    expect(err.error.code).toBe('SAFETY_HALTED');

    const resumed = await fetch(`${base}/v1/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'all clear' }),
    });
    expect(resumed.status).toBe(200);
    const after = (await (await fetch(`${base}/v1/safety`)).json()) as { state: string };
    expect(after.state).toBe('NORMAL');
  });

  it('treats estop as sticky over the API', async () => {
    await fetch(`${base}/v1/estop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'emergency drill' }),
    });
    let safety = (await (await fetch(`${base}/v1/safety`)).json()) as {
      state: string;
      estopRequested: boolean;
    };
    expect(safety.state).toBe('ESTOP_REQUESTED');
    expect(safety.estopRequested).toBe(true);

    // resume is refused while estop is active
    const refused = await fetch(`${base}/v1/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(refused.status).toBe(409);

    await fetch(`${base}/v1/estop/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    safety = (await (await fetch(`${base}/v1/safety`)).json()) as {
      state: string;
      estopRequested: boolean;
    };
    expect(safety.state).toBe('HALTED');
    await fetch(`${base}/v1/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  });

  it('streams events over SSE', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/events`, { signal: controller.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Fire an invocation while subscribed; expect its operation event.
    void fetch(`${base}/v1/devices/relay-01/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: 'relay.set',
        args: { on: true },
        waitFor: 'result',
        idempotencyKey: `sse-event-${Date.now()}`,
      }),
    });

    let collected = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !collected.includes('operation')) {
      const timeout = new Promise<{ value?: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ done: true }), 150),
      );
      const result = await Promise.race([reader.read(), timeout]);
      if (result.done) break;
      collected += decoder.decode(result.value!);
    }
    controller.abort();
    expect(collected).toContain('hello');
    expect(collected).toContain('operation');
  });

  it('serves the journal', async () => {
    const res = await fetch(`${base}/v1/journal?deviceId=relay-01&limit=5`);
    const { entries } = (await res.json()) as { entries: Array<{ kind: string }> };
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.kind.startsWith('operation.'))).toBe(true);
  });
});

describe('remote binding protection', () => {
  it('refuses non-loopback binding without allowRemote+token', async () => {
    const runtime = new PinoutRuntime();
    await expect(startDaemon(runtime, { host: '0.0.0.0', port: 0 })).rejects.toThrowError(
      /Refusing to bind non-loopback/,
    );
    await expect(
      startDaemon(runtime, { host: '0.0.0.0', port: 0, allowRemote: true }),
    ).rejects.toThrowError(/auth token/);
    await expect(
      startDaemon(runtime, { host: '0.0.0.0', port: 0, token: 'secret' }),
    ).rejects.toThrowError(/Refusing to bind non-loopback/);
  });

  it('enforces bearer auth when a token is configured', async () => {
    const runtime = new PinoutRuntime();
    registerModule(relayModule);
    await runtime.registerFromModule(relayModule.id, { id: 'relay-auth', simulated: true });
    const secured = await startDaemon(runtime, { port: 0, token: 'test-token' });
    const url = `http://127.0.0.1:${secured.port}`;

    const unauthenticated = await fetch(`${url}/v1/devices`);
    expect(unauthenticated.status).toBe(401);

    const health = await fetch(`${url}/v1/health`);
    expect(health.status).toBe(200);

    const authorized = await fetch(`${url}/v1/devices`, {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(authorized.status).toBe(200);

    await secured.close();
    await runtime.close();
  });

  it('rejects browser cross-origin and non-JSON mutating requests', async () => {
    const runtime = new PinoutRuntime();
    const secured = await startDaemon(runtime, { port: 0, token: 'timing-token' });
    const url = `http://127.0.0.1:${secured.port}`;
    const foreignOrigin = await fetch(`${url}/v1/halt`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer timing-token',
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ reason: 'test' }),
    });
    expect(foreignOrigin.status).toBe(403);
    const nonJson = await fetch(`${url}/v1/halt`, {
      method: 'POST',
      headers: { authorization: 'Bearer timing-token', 'content-type': 'text/plain' },
      body: JSON.stringify({ reason: 'test' }),
    });
    expect(nonJson.status).toBe(400);
    await secured.close();
    await runtime.close();
  });

  it('exposes approval and deadman heartbeat feeds', async () => {
    const runtime = new PinoutRuntime();
    await runtime.registerFromModule(relayModule.id, { id: 'relay-policy', simulated: true });
    const secured = await startDaemon(runtime, {
      port: 0,
      token: 'policy-token',
      requireLeases: false,
      safetyRules: [{ kind: 'approval', capability: 'relay.set' }],
    });
    const url = `http://127.0.0.1:${secured.port}`;
    const headers = { authorization: 'Bearer policy-token', 'content-type': 'application/json' };
    const approval = await fetch(`${url}/v1/approvals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'approval-1',
        deviceId: 'relay-policy',
        capability: 'relay.set',
        grantedBy: 'operator',
      }),
    });
    expect(approval.status).toBe(201);
    expect(((await approval.json()) as { approval: { id: string } }).approval.id).toBe(
      'approval-1',
    );
    const heartbeat = await fetch(`${url}/v1/devices/relay-policy/heartbeat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ actor: 'operator' }),
    });
    expect(heartbeat.status).toBe(200);
    expect(((await heartbeat.json()) as { alive: boolean }).alive).toBe(true);
    await secured.close();
    await runtime.close();
  });
});
