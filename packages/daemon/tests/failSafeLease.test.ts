/**
 * SIMULATED only — no hardware. Verifies lease-expiry and deadman fail-safe
 * disarm / safeState behavior used when an agent runtime pauses mid-call.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PinoutRuntime, relayModule, registerModule } from '@pinout/core';
import { startDaemon, type RunningDaemon } from '../src/start.js';

describe('daemon fail-safe on lease expiry (SIMULATED)', () => {
  let daemon: RunningDaemon | undefined;

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  it('reaps expired leases on a timer, applies safeState, and journals lease.expired', async () => {
    registerModule(relayModule);
    const runtime = new PinoutRuntime();
    await runtime.registerFromModule(relayModule.id, { id: 'relay-fs', simulated: true });
    daemon = await startDaemon(runtime, {
      port: 0,
      requireLeases: true,
      maxLeaseTtlMs: 5_000,
      leaseReapIntervalMs: 50,
      failSafeOnAuthorityLoss: true,
    });
    const base = `http://127.0.0.1:${daemon.port}`;

    const leaseRes = await fetch(`${base}/v1/leases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: 'agent-pause',
        mode: 'exclusive',
        ttlMs: 120,
        scope: { kind: 'device', deviceId: 'relay-fs' },
      }),
    });
    expect(leaseRes.status).toBe(201);
    const { lease } = (await leaseRes.json()) as { lease: { id: string } };

    const onRes = await fetch(`${base}/v1/devices/relay-fs/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: 'relay.set',
        args: { on: true },
        owner: 'agent-pause',
        waitFor: 'result',
        idempotencyKey: 'fs-on-1',
      }),
    });
    expect(onRes.status).toBe(200);
    const onBody = (await onRes.json()) as {
      result: { on: boolean };
      idempotencyKey: string;
    };
    expect(onBody.result.on).toBe(true);
    expect(onBody.idempotencyKey).toBe('fs-on-1');

    // Wait past lease TTL; timer should reap and apply safeState (relay off).
    await new Promise((resolve) => setTimeout(resolve, 250));
    await daemon.context.failSafe.tick();

    expect(daemon.context.leases.get(lease.id)).toBeUndefined();
    const state = await fetch(`${base}/v1/devices/relay-fs/state`);
    const stateBody = (await state.json()) as { state: { on?: boolean } };
    expect(stateBody.state.on).toBe(false);

    const journal = await fetch(`${base}/v1/journal?deviceId=relay-fs&limit=50`);
    const journalBody = (await journal.json()) as {
      entries: Array<{ kind: string; payload?: Record<string, unknown> }>;
    };
    expect(journalBody.entries.some((entry) => entry.kind === 'lease.expired')).toBe(true);
    expect(
      journalBody.entries.some(
        (entry) =>
          entry.kind === 'safety.state_changed' &&
          entry.payload?.event === 'fail_safe.applied',
      ),
    ).toBe(true);
  });

  it('dedupes physical invokes by auto-generated idempotency key', async () => {
    registerModule(relayModule);
    const runtime = new PinoutRuntime();
    await runtime.registerFromModule(relayModule.id, { id: 'relay-idemp', simulated: true });
    daemon = await startDaemon(runtime, {
      port: 0,
      requireLeases: false,
      failSafeOnAuthorityLoss: false,
    });
    const base = `http://127.0.0.1:${daemon.port}`;

    const invoke = () =>
      fetch(`${base}/v1/devices/relay-idemp/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          capability: 'relay.set',
          args: { on: true },
          owner: 'same-owner',
          waitFor: 'result',
        }),
      });

    const first = await invoke();
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      operation: { id: string };
      idempotencyKey: string;
      idempotencyKeyGenerated?: boolean;
    };
    expect(firstBody.idempotencyKeyGenerated).toBe(true);
    expect(firstBody.idempotencyKey.startsWith('auto-')).toBe(true);

    const second = await invoke();
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      operation: { id: string };
      idempotencyKey: string;
      deduped?: boolean;
    };
    expect(secondBody.operation.id).toBe(firstBody.operation.id);
    expect(secondBody.idempotencyKey).toBe(firstBody.idempotencyKey);
    expect(secondBody.deduped).toBe(true);
  });

  it('clamps lease TTL to maxLeaseTtlMs', async () => {
    registerModule(relayModule);
    const runtime = new PinoutRuntime();
    await runtime.registerFromModule(relayModule.id, { id: 'relay-ttl', simulated: true });
    daemon = await startDaemon(runtime, {
      port: 0,
      requireLeases: false,
      maxLeaseTtlMs: 1_500,
      failSafeOnAuthorityLoss: false,
    });
    const base = `http://127.0.0.1:${daemon.port}`;
    const before = Date.now();
    const res = await fetch(`${base}/v1/leases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: 'ttl-agent',
        ttlMs: 60_000,
        scope: { kind: 'device', deviceId: 'relay-ttl' },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { lease: { expiresAt: number } };
    expect(body.lease.expiresAt).toBeLessThanOrEqual(before + 1_500 + 50);
  });
});
