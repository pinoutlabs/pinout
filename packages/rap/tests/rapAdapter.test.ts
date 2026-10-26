import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PinoutRuntime, relayModule } from '@pinout/core';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon } from '../../daemon/src/start.js';
import { startRapServer, type StartedRapServer } from '../src/server.js';
import { PendingStore } from '../src/pendingStore.js';
import { RapAdapter } from '../src/adapter.js';
import {
  getJson,
  postJson,
  startMockRapRuntime,
  type MockRapRuntime,
} from './mockRapRuntime.js';

interface Harness {
  daemon: Awaited<ReturnType<typeof startDaemon>>;
  rap: StartedRapServer;
  mock: MockRapRuntime;
  home: string;
  journalDir: string;
}

const harnesses: Harness[] = [];

async function startHarness(options: {
  token?: string;
  host?: string;
  allowRemote?: boolean;
} = {}): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), 'pinout-rap-'));
  const journalDir = join(home, 'rap');
  const runtime = new PinoutRuntime();
  await runtime.registerFromModule(relayModule.id, { id: 'relay-rap', simulated: true });
  const daemon = await startDaemon(runtime, {
    port: 0,
    ...(options.token ? { token: options.token } : { token: 'rap-daemon-token' }),
    pinoutHome: home,
  });
  const mock = await startMockRapRuntime();
  const rap = await startRapServer({
    host: options.host ?? '127.0.0.1',
    port: 0,
    daemonUrl: `http://127.0.0.1:${daemon.port}`,
    daemonToken: options.token ?? 'rap-daemon-token',
    ...(options.token ? { token: options.token } : {}),
    ...(options.allowRemote ? { allowRemote: true } : {}),
    pinoutHome: home,
    journalDir,
    maxCallbackAttempts: 3,
    pollIntervalMs: 15,
    operationTimeoutMs: 10_000,
  });
  const harness = { daemon, rap, mock, home, journalDir };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (harnesses.length) {
    const harness = harnesses.pop()!;
    await harness.rap.close().catch(() => undefined);
    await harness.mock.close().catch(() => undefined);
    await harness.daemon.close().catch(() => undefined);
    rmSync(harness.home, { recursive: true, force: true });
  }
});

describe('pinout RAP adapter', () => {
  it('acks invoke immediately then POSTs tool_result to callback_url', async () => {
    const { rap, mock } = await startHarness();
    const toolset = await getJson(`${rap.baseUrl}/.well-known/rap-toolset`);
    expect(toolset.status).toBe(200);
    const manifest = toolset.json as {
      name: string;
      endpoint: string;
      tools: Array<{ name: string; annotations?: Record<string, unknown> }>;
    };
    expect(manifest.name).toBe('pinout');
    expect(manifest.endpoint).toBe(`${rap.baseUrl}/invoke`);
    expect(manifest.tools.some((tool) => tool.name === 'pinout__list_devices')).toBe(true);
    const invokeTool = manifest.tools.find((tool) => tool.name === 'pinout__invoke');
    expect(invokeTool?.annotations?.['x-pinout-side-effect']).toBe('physical-output');
    const listTool = manifest.tools.find((tool) => tool.name === 'pinout__list_devices');
    expect(listTool?.annotations?.['x-pinout-side-effect']).toBe('read-only');

    const started = Date.now();
    const ack = await postJson(`${rap.baseUrl}/invoke`, {
      operation: 'pinout__list_devices',
      arguments: {},
      id: 'call_list_1',
      call_id: null,
      callback_url: mock.callbackUrl,
      group_id: 'thread_list',
    });
    const ackMs = Date.now() - started;
    expect(ack.status).toBe(200);
    expect(ackMs).toBeLessThan(500);

    const result = await mock.waitForToolResult('call_list_1');
    expect(result.type).toBe('tool_result');
    expect(result.group_id).toBe('thread_list');
    expect(String(result.text)).toContain('relay-rap');
  });

  it('runs physical invoke with waitFor accepted and group_id:id idempotency', async () => {
    const { rap, mock } = await startHarness();
    const groupId = 'thread_actuate';

    await postJson(`${rap.baseUrl}/invoke`, {
      operation: 'pinout__acquire_lease',
      arguments: { deviceId: 'relay-rap', mode: 'exclusive' },
      id: 'call_lease',
      callback_url: mock.callbackUrl,
      group_id: groupId,
    });
    await mock.waitForToolResult('call_lease');

    await postJson(`${rap.baseUrl}/invoke`, {
      operation: 'pinout__invoke',
      arguments: {
        deviceId: 'relay-rap',
        capability: 'relay.set',
        args: { on: true },
      },
      id: 'call_invoke',
      callback_url: mock.callbackUrl,
      group_id: groupId,
    });
    const first = await mock.waitForToolResult('call_invoke');
    expect(first.type).toBe('tool_result');
    expect(String(first.text)).toMatch(/completed|operation/i);

    // Duplicate invocation with same group_id:id must redeliver (idempotent key).
    const before = mock.callbacks.filter(
      (entry) => entry.body.type === 'tool_result' && entry.body.id === 'call_invoke',
    ).length;
    await postJson(`${rap.baseUrl}/invoke`, {
      operation: 'pinout__invoke',
      arguments: {
        deviceId: 'relay-rap',
        capability: 'relay.set',
        args: { on: true },
      },
      id: 'call_invoke',
      callback_url: mock.callbackUrl,
      group_id: groupId,
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const results = mock.callbacks.filter(
        (entry) => entry.body.type === 'tool_result' && entry.body.id === 'call_invoke',
      );
      if (results.length >= before + 1) {
        expect(results.length).toBeGreaterThanOrEqual(2);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for idempotent redelivery of call_invoke');
  });

  it('handles duplicate and late cancel_tool_call without failing', async () => {
    const { rap, mock } = await startHarness();
    const groupId = 'thread_cancel';

    await postJson(`${rap.baseUrl}/invoke`, {
      operation: 'pinout__acquire_lease',
      arguments: { deviceId: 'relay-rap' },
      id: 'call_lease_c',
      callback_url: mock.callbackUrl,
      group_id: groupId,
    });
    await mock.waitForToolResult('call_lease_c');

    await postJson(`${rap.baseUrl}/invoke`, {
      operation: 'pinout__invoke',
      arguments: {
        deviceId: 'relay-rap',
        capability: 'relay.set',
        args: { on: false },
      },
      id: 'call_slow',
      callback_url: mock.callbackUrl,
      group_id: groupId,
    });

    const cancelBody = { thread_id: groupId, tool_call_id: 'call_slow' };
    const c1 = await postJson(`${rap.baseUrl}/cancel_tool_call`, cancelBody);
    const c2 = await postJson(`${rap.baseUrl}/cancel_tool_call`, cancelBody);
    expect(c1.status).toBe(200);
    expect(c2.status).toBe(200);

    // Late cancel after completion must still be 200.
    const result = await mock.waitForToolResult('call_slow');
    expect(result.type).toBe('tool_result');
    const late = await postJson(`${rap.baseUrl}/cancel_tool_call`, cancelBody);
    expect(late.status).toBe(200);

    // Unknown tool call id is also 200 (best effort).
    const unknown = await postJson(`${rap.baseUrl}/cancel_tool_call`, {
      thread_id: groupId,
      tool_call_id: 'never_seen',
    });
    expect(unknown.status).toBe(200);
  });

  it('recovers pending callback delivery after adapter restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pinout-rap-restart-'));
    const journalDir = join(home, 'rap');
    const runtime = new PinoutRuntime();
    await runtime.registerFromModule(relayModule.id, { id: 'relay-rap', simulated: true });
    const daemon = await startDaemon(runtime, {
      port: 0,
      token: 'rap-daemon-token',
      pinoutHome: home,
    });
    const mock = await startMockRapRuntime();

    // Seed a delivered-pending journal entry as if the process crashed mid-delivery.
    const store = new PendingStore({ pinoutHome: home, journalDir });
    store.upsertCall({
      key: 'thread_restart:call_restart',
      groupId: 'thread_restart',
      id: 'call_restart',
      callbackUrl: mock.callbackUrl,
      operation: 'pinout__list_devices',
      arguments: {},
      status: 'delivering',
      resultText: JSON.stringify({ recovered: true, devices: [{ id: 'relay-rap' }] }),
      deliveryAttempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deviceIds: [],
      leaseIds: [],
      cancelled: false,
    });
    store.compact();

    const rap = await startRapServer({
      host: '127.0.0.1',
      port: 0,
      daemonUrl: `http://127.0.0.1:${daemon.port}`,
      daemonToken: 'rap-daemon-token',
      pinoutHome: home,
      journalDir,
      maxCallbackAttempts: 3,
    });
    harnesses.push({
      daemon,
      rap,
      mock,
      home,
      journalDir,
    });

    const result = await mock.waitForToolResult('call_restart');
    expect(result.type).toBe('tool_result');
    expect(String(result.text)).toContain('recovered');
  });

  it('close_thread releases leases owned by the thread', async () => {
    const { rap, mock, daemon } = await startHarness();
    const groupId = 'thread_close';

    await postJson(`${rap.baseUrl}/invoke`, {
      operation: 'pinout__acquire_lease',
      arguments: { deviceId: 'relay-rap', mode: 'exclusive' },
      id: 'call_lease_close',
      callback_url: mock.callbackUrl,
      group_id: groupId,
    });
    const leaseResult = await mock.waitForToolResult('call_lease_close');
    expect(String(leaseResult.text)).toMatch(/lease/i);

    const before = await fetch(`http://127.0.0.1:${daemon.port}/v1/leases`, {
      headers: { authorization: 'Bearer rap-daemon-token' },
    }).then((response) => response.json() as Promise<{ leases: Array<{ owner: string }> }>);
    expect(before.leases.some((lease) => lease.owner === groupId)).toBe(true);

    const closed = await postJson(`${rap.baseUrl}/close_thread`, { thread_id: groupId });
    expect(closed.status).toBe(200);

    // Allow async cleanup to finish.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = await fetch(`http://127.0.0.1:${daemon.port}/v1/leases`, {
      headers: { authorization: 'Bearer rap-daemon-token' },
    }).then((response) => response.json() as Promise<{ leases: Array<{ owner: string }> }>);
    expect(after.leases.some((lease) => lease.owner === groupId)).toBe(false);

    // Duplicate close_thread remains 200.
    const again = await postJson(`${rap.baseUrl}/close_thread`, { thread_id: groupId });
    expect(again.status).toBe(200);
  });

  it('requires bearer auth when a token is configured', async () => {
    const { rap } = await startHarness({ token: 'rap-secret' });

    const deniedToolset = await getJson(`${rap.baseUrl}/.well-known/rap-toolset`);
    expect(deniedToolset.status).toBe(401);

    const deniedInvoke = await postJson(`${rap.baseUrl}/invoke`, {
      operation: 'pinout__list_devices',
      arguments: {},
      id: 'x',
      callback_url: 'http://127.0.0.1:9/callback',
      group_id: 't',
    });
    expect(deniedInvoke.status).toBe(401);

    const okToolset = await getJson(`${rap.baseUrl}/.well-known/rap-toolset`, {
      authorization: 'Bearer rap-secret',
    });
    expect(okToolset.status).toBe(200);

    const badToken = await getJson(`${rap.baseUrl}/.well-known/rap-toolset`, {
      authorization: 'Bearer wrong',
    });
    expect(badToken.status).toBe(401);
  });

  it('refuses non-loopback bind without token even with allowRemote', async () => {
    await expect(
      startRapServer({
        host: '0.0.0.0',
        port: 0,
        allowRemote: true,
      }),
    ).rejects.toThrow(/Bearer token is required/i);
  });

  it('aborts safety after callback delivery exhaustion', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pinout-rap-failcb-'));
    const journalDir = join(home, 'rap');
    const runtime = new PinoutRuntime();
    await runtime.registerFromModule(relayModule.id, { id: 'relay-rap', simulated: true });
    const daemon = await startDaemon(runtime, {
      port: 0,
      token: 'rap-daemon-token',
      pinoutHome: home,
    });

    const adapter = new RapAdapter({
      publicBaseUrl: 'http://127.0.0.1:9',
      daemonUrl: `http://127.0.0.1:${daemon.port}`,
      daemonToken: 'rap-daemon-token',
      pinoutHome: home,
      journalDir,
      maxCallbackAttempts: 2,
      callbackBaseDelayMs: 1,
    });

    // Acquire a lease through the daemon so abort has something to release.
    const lease = await adapter.daemon.acquireLease({
      deviceId: 'relay-rap',
      owner: 'thread_failcb',
    });
    const leaseId = (lease.lease as { id: string }).id;
    adapter.store.noteLease('thread_failcb', leaseId);
    adapter.store.noteDevice('thread_failcb', 'relay-rap');

    adapter.acceptInvocation({
      operation: 'pinout__list_devices',
      arguments: {},
      id: 'call_failcb',
      callback_url: 'http://127.0.0.1:1/no-listener',
      group_id: 'thread_failcb',
    });

    // Wait for delivery attempts to exhaust.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const call = adapter.store.getCall('thread_failcb:call_failcb');
      if (call && call.status === 'failed' && call.deliveryAttempts >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    const listed = await adapter.daemon.listLeases();
    const leases = Array.isArray(listed.leases) ? listed.leases : [];
    expect(leases.some((entry) => (entry as { id?: string }).id === leaseId)).toBe(false);

    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  });
});
