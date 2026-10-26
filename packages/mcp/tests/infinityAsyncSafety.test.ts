/**
 * SIMULATED Infinity pause / async-safety coverage for pinout-mcp.
 * Never claims hardware — uses pinoutd with simulated relay / slow backends only.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  DeviceInstance,
  PinoutRuntime,
  createBackendEventBus,
  relayModule,
  type DeviceBackend,
} from '@pinout/core';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon, type RunningDaemon } from '../../daemon/src/start.js';
import { createDaemonMcpServer } from '../src/createDaemonServer.js';

function createSlowRelayBackend(delayMs: number): DeviceBackend {
  const eventBus = createBackendEventBus();
  let on = false;
  return {
    kind: 'simulated',
    subscribe: (handler) => eventBus.subscribe(handler),
    async close() {
      eventBus.clear();
    },
    getOperationalState: () => ({ on, status: 'ready' }),
    async safeState() {
      on = false;
      return { applied: true, on: false };
    },
    async invoke(action, payload) {
      if (action === 'relay.set') {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        on = payload.on === true;
        return { on };
      }
      if (action === 'relay.read' || action === 'status.read') {
        return { on, status: 'ready' };
      }
      throw new Error(`unknown ${action}`);
    },
  };
}

describe('Infinity async safety (SIMULATED)', () => {
  let daemon: RunningDaemon | undefined;

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  async function startPair(options: {
    invokeWaitMs?: number;
    leaseReapIntervalMs?: number;
    maxLeaseTtlMs?: number;
    owner?: string;
    slowDelayMs?: number;
  }) {
    const runtime = new PinoutRuntime();
    if (options.slowDelayMs !== undefined) {
      const backend = createSlowRelayBackend(options.slowDelayMs);
      await runtime.register(
        new DeviceInstance({
          identity: {
            id: 'relay-inf',
            moduleId: relayModule.id,
            deviceClass: 'actuator.relay',
            label: 'Slow simulated relay',
          },
          backend,
          capabilities: relayModule.capabilities,
          policies: [],
          simulated: true,
          activeTransportKind: 'simulated',
          transportKinds: ['simulated'],
          getOperationalState: () => backend.getOperationalState?.() ?? {},
        }),
      );
    } else {
      await runtime.registerFromModule(relayModule.id, { id: 'relay-inf', simulated: true });
    }
    daemon = await startDaemon(runtime, {
      port: 0,
      token: 'inf-token',
      requireLeases: true,
      failSafeOnAuthorityLoss: true,
      leaseReapIntervalMs: options.leaseReapIntervalMs ?? 50,
      maxLeaseTtlMs: options.maxLeaseTtlMs ?? 5_000,
    });
    const server = createDaemonMcpServer({
      baseUrl: `http://127.0.0.1:${daemon.port}`,
      token: 'inf-token',
      owner: options.owner ?? 'mcp-infinity',
      awarenessWatch: false,
      invokeWaitMs: options.invokeWaitMs ?? 10_000,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'infinity-sim', version: '0.0.1-alpha.1' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, server, daemon: daemon! };
  }

  it('returns OPERATION_PENDING when wait budget elapses; exposes renew/heartbeat/status/cancel', async () => {
    const { client, server } = await startPair({ invokeWaitMs: 80, slowDelayMs: 400 });
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain('pinout__invoke');
      expect(names).toContain('pinout__operation_status');
      expect(names).toContain('pinout__cancel_operation');
      expect(names).toContain('pinout__renew_lease');
      expect(names).toContain('pinout__heartbeat');

      const invokeTool = listed.tools.find((tool) => tool.name === 'pinout__invoke');
      expect(invokeTool?.annotations).toMatchObject({
        destructiveHint: true,
        idempotentHint: false,
      });

      const lease = await client.callTool({
        name: 'pinout__acquire_lease',
        arguments: { deviceId: 'relay-inf', ttlMs: 5_000, threadId: 't-1' },
      });
      expect(lease.isError).not.toBe(true);
      const leaseBody = lease.structuredContent as { lease: { id: string; owner: string } };
      expect(leaseBody.lease.owner).toBe('mcp-infinity:t-1');

      const renewed = await client.callTool({
        name: 'pinout__renew_lease',
        arguments: { leaseId: leaseBody.lease.id, threadId: 't-1', ttlMs: 5_000 },
      });
      expect(renewed.isError).not.toBe(true);

      const heartbeat = await client.callTool({
        name: 'pinout__heartbeat',
        arguments: { deviceId: 'relay-inf', threadId: 't-1' },
      });
      expect(heartbeat.isError).not.toBe(true);

      const pending = await client.callTool({
        name: 'pinout__invoke',
        arguments: {
          deviceId: 'relay-inf',
          capability: 'relay.set',
          args: { on: true },
          threadId: 't-1',
          waitFor: 'result',
          idempotencyKey: 'slow-op-1',
        },
      });
      expect(pending.isError).not.toBe(true);
      const pendingBody = pending.structuredContent as {
        code?: string;
        operationId?: string;
        idempotencyKey?: string;
        poll?: { tool: string };
        cancel?: { tool: string };
      };
      expect(pendingBody.code).toBe('OPERATION_PENDING');
      expect(pendingBody.operationId).toBeTruthy();
      expect(pendingBody.idempotencyKey).toBe('slow-op-1');
      expect(pendingBody.poll?.tool).toBe('pinout__operation_status');
      expect(pendingBody.cancel?.tool).toBe('pinout__cancel_operation');

      // Wait for the slow op to finish, then status should be terminal.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const status = await client.callTool({
        name: 'pinout__operation_status',
        arguments: { operationId: pendingBody.operationId },
      });
      expect(status.structuredContent).toMatchObject({
        operation: { id: pendingBody.operationId, status: 'completed' },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('after simulated pause longer than lease TTL: device is fail-safe off; same key does not double-actuate', async () => {
    const { client, server, daemon: running } = await startPair({
      invokeWaitMs: 200,
      leaseReapIntervalMs: 40,
      maxLeaseTtlMs: 5_000,
    });
    try {
      const lease = await client.callTool({
        name: 'pinout__acquire_lease',
        arguments: { deviceId: 'relay-inf', ttlMs: 100, owner: 'paused-agent' },
      });
      expect(lease.isError).not.toBe(true);

      const first = await client.callTool({
        name: 'pinout__invoke',
        arguments: {
          deviceId: 'relay-inf',
          capability: 'relay.set',
          args: { on: true },
          owner: 'paused-agent',
          idempotencyKey: 'pause-key-1',
          waitFor: 'result',
        },
      });
      expect(first.isError, JSON.stringify(first)).not.toBe(true);
      const firstBody = first.structuredContent as {
        operation: { id: string };
        result?: { on?: boolean };
        idempotencyKey?: string;
      };
      expect(firstBody.result?.on).toBe(true);
      expect(firstBody.idempotencyKey).toBe('pause-key-1');

      // Simulate Infinity pause longer than lease TTL.
      await new Promise((resolve) => setTimeout(resolve, 220));
      await running.context.failSafe.tick();

      const state = await client.callTool({
        name: 'pinout__read_state',
        arguments: { deviceId: 'relay-inf' },
      });
      expect((state.structuredContent as { state: { on?: boolean } }).state.on).toBe(false);

      // Re-acquire and retry with the SAME idempotency key — must observe original op, not re-actuate.
      const lease2 = await client.callTool({
        name: 'pinout__acquire_lease',
        arguments: { deviceId: 'relay-inf', ttlMs: 2_000, owner: 'paused-agent' },
      });
      expect(lease2.isError).not.toBe(true);

      const retry = await client.callTool({
        name: 'pinout__invoke',
        arguments: {
          deviceId: 'relay-inf',
          capability: 'relay.set',
          args: { on: true },
          owner: 'paused-agent',
          idempotencyKey: 'pause-key-1',
          waitFor: 'result',
        },
      });
      expect(retry.isError).not.toBe(true);
      const retryBody = retry.structuredContent as {
        operation: { id: string };
        deduped?: boolean;
      };
      expect(retryBody.operation.id).toBe(firstBody.operation.id);
      // Device remains in fail-safe off because deduped op does not re-run.
      const stateAfter = await client.callTool({
        name: 'pinout__read_state',
        arguments: { deviceId: 'relay-inf' },
      });
      expect((stateAfter.structuredContent as { state: { on?: boolean } }).state.on).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
