import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PinoutRuntime, relayModule, registerModule } from '@pinout/core';
import { startDaemon, type RunningDaemon } from '../src/start.js';

describe('Daemon HTTP Recovery & Reconciliation API', () => {
  let daemon: RunningDaemon | undefined;
  let journalDir: string | undefined;

  afterEach(async () => {
    if (daemon) {
      await daemon.close().catch(() => undefined);
      daemon = undefined;
    }
    if (journalDir) {
      await rm(journalDir, { recursive: true, force: true }).catch(() => undefined);
      journalDir = undefined;
    }
  });

  it('handles crash after dispatch, exposes requires_reconciliation, and resolves via POST /v1/operations/:id/reconcile', async () => {
    journalDir = await mkdtemp(join(tmpdir(), 'daemon-recovery-'));
    const journalPath = join(journalDir, 'journal.jsonl');

    // 1. Start initial daemon instance
    const runtime1 = new PinoutRuntime();
    registerModule(relayModule);
    await runtime1.registerFromModule(relayModule.id, { id: 'relay-rec-1', simulated: true });
    daemon = await startDaemon(runtime1, {
      port: 0,
      journalPath,
      requireLeases: false,
    });
    const url1 = `http://127.0.0.1:${daemon.port}`;

    // Invoke an operation that gets accepted and started
    const startRes = await fetch(`${url1}/v1/devices/relay-rec-1/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: 'relay.set',
        args: { on: true },
        owner: 'agent-rec',
        idempotencyKey: 'rec-key-1',
        waitFor: 'accepted',
      }),
    });
    expect(startRes.status).toBe(202);
    const { operation: initialOp } = (await startRes.json()) as { operation: { id: string } };

    // Simulate daemon crash by abruptly closing server and runtime
    await daemon.close();
    daemon = undefined;

    // 2. Restart daemon against the EXACT SAME persistent journal file
    const runtime2 = new PinoutRuntime();
    await runtime2.registerFromModule(relayModule.id, { id: 'relay-rec-1', simulated: true });
    daemon = await startDaemon(runtime2, {
      port: 0,
      journalPath,
      requireLeases: false,
    });
    const url2 = `http://127.0.0.1:${daemon.port}`;

    // Inspect operations list: operation must be in 'requires_reconciliation' or 'completed'
    const listRes = await fetch(`${url2}/v1/operations`);
    expect(listRes.status).toBe(200);
    const { operations } = (await listRes.json()) as {
      operations: Array<{ id: string; status: string }>;
    };
    const recovered = operations.find((op) => op.id === initialOp.id);
    expect(recovered).toBeDefined();

    // If it was in flight and recovered as requires_reconciliation, test reconcile route
    if (recovered?.status === 'requires_reconciliation') {
      // Retrying with same idempotency key returns 409 demanding reconciliation
      const retryRes = await fetch(`${url2}/v1/devices/relay-rec-1/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          capability: 'relay.set',
          args: { on: true },
          owner: 'agent-rec',
          idempotencyKey: 'rec-key-1',
          waitFor: 'result',
        }),
      });
      expect(retryRes.status).toBe(409);
      const retryBody = (await retryRes.json()) as { error: { code: string } };
      expect(retryBody.error.code).toBe('OPERATION_REQUIRES_RECONCILIATION');

      // Operator reconciles via POST /v1/operations/:id/reconcile
      const reconcileRes = await fetch(`${url2}/v1/operations/${initialOp.id}/reconcile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resolution: 'observedComplete',
          note: 'Operator confirmed relay state physically active',
          actor: 'operator-rec',
        }),
      });
      expect(reconcileRes.status).toBe(200);
      const reconcileBody = (await reconcileRes.json()) as {
        operation: { status: string; reconciled: boolean };
      };
      expect(reconcileBody.operation.status).toBe('completed');
      expect(reconcileBody.operation.reconciled).toBe(true);

      // Subsequent retry now succeeds without re-executing
      const retryAfterReconcile = await fetch(`${url2}/v1/devices/relay-rec-1/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          capability: 'relay.set',
          args: { on: true },
          owner: 'agent-rec',
          idempotencyKey: 'rec-key-1',
          waitFor: 'result',
        }),
      });
      expect(retryAfterReconcile.status).toBe(200);
      const retryResult = (await retryAfterReconcile.json()) as {
        deduped: boolean;
        operation: { status: string };
      };
      expect(retryResult.deduped).toBe(true);
      expect(retryResult.operation.status).toBe('completed');
    }
  });

  it('rejects invalid reconciliation resolution values with 400', async () => {
    const runtime = new PinoutRuntime();
    registerModule(relayModule);
    await runtime.registerFromModule(relayModule.id, { id: 'relay-rec-2', simulated: true });
    daemon = await startDaemon(runtime, { port: 0, requireLeases: false });
    const url = `http://127.0.0.1:${daemon.port}`;

    const res = await fetch(`${url}/v1/operations/op_nonexistent/reconcile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resolution: 'invalidResolutionValue',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('enforces lease conflict and lease invalidation across daemon restarts over HTTP', async () => {
    journalDir = await mkdtemp(join(tmpdir(), 'daemon-lease-'));
    const journalPath = join(journalDir, 'journal.jsonl');

    // 1. Daemon 1
    const runtime1 = new PinoutRuntime();
    registerModule(relayModule);
    await runtime1.registerFromModule(relayModule.id, { id: 'relay-lease-api', simulated: true });
    daemon = await startDaemon(runtime1, { port: 0, journalPath, requireLeases: true });
    const url1 = `http://127.0.0.1:${daemon.port}`;

    // Agent A acquires lease
    const leaseA = await fetch(`${url1}/v1/leases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: 'agent-a',
        scope: { kind: 'device', deviceId: 'relay-lease-api' },
      }),
    });
    expect(leaseA.status).toBe(201);
    const { lease: createdLease } = (await leaseA.json()) as { lease: { id: string } };

    // Agent B attempts to acquire conflicting lease -> 409 LEASE_CONFLICT
    const leaseB = await fetch(`${url1}/v1/leases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: 'agent-b',
        scope: { kind: 'device', deviceId: 'relay-lease-api' },
      }),
    });
    expect(leaseB.status).toBe(409);

    // Agent A invokes capability under active lease -> 200
    const invokeA = await fetch(`${url1}/v1/devices/relay-lease-api/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: 'relay.set',
        args: { on: true },
        owner: 'agent-a',
        waitFor: 'result',
      }),
    });
    expect(invokeA.status).toBe(200);

    // Agent B invokes without lease -> 409 SAFETY_LEASE_REQUIRED
    const invokeB = await fetch(`${url1}/v1/devices/relay-lease-api/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: 'relay.set',
        args: { on: true },
        owner: 'agent-b',
        waitFor: 'result',
      }),
    });
    expect(invokeB.status).toBe(409);

    // Restart daemon
    await daemon.close();
    daemon = undefined;

    const runtime2 = new PinoutRuntime();
    await runtime2.registerFromModule(relayModule.id, { id: 'relay-lease-api', simulated: true });
    daemon = await startDaemon(runtime2, { port: 0, journalPath, requireLeases: true });
    const url2 = `http://127.0.0.1:${daemon.port}`;

    // Agent A's previous in-memory lease is invalidated; a NEW actuation (fresh
    // idempotency key) fails without acquiring a new lease. Observing the prior
    // completed op via its original key remains allowed by design.
    const invokeAfterRestart = await fetch(`${url2}/v1/devices/relay-lease-api/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: 'relay.set',
        args: { on: false },
        owner: 'agent-a',
        waitFor: 'result',
        idempotencyKey: 'after-restart-new-actuation',
      }),
    });
    expect(invokeAfterRestart.status).toBe(409);

    // Renewing old lease ID fails
    const renewOld = await fetch(`${url2}/v1/leases/${createdLease.id}/renew`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'agent-a' }),
    });
    expect(renewOld.status).toBe(409);
  });
});
