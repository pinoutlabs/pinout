import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PinoutRuntime, relayModule } from '@pinout/core';
import { describe, expect, it } from 'vitest';
import { startDaemon } from '../../daemon/src/start.js';
import { createDaemonMcpServer } from '../src/createDaemonServer.js';

describe('daemon-backed MCP governed flow', () => {
  it('reads, leases, previews, invokes, inspects, cancels, and observes halt denial', async () => {
    const runtime = new PinoutRuntime();
    await runtime.registerFromModule(relayModule.id, { id: 'relay-mcp', simulated: true });
    const daemon = await startDaemon(runtime, { port: 0, token: 'mcp-token' });
    const server = createDaemonMcpServer({
      baseUrl: `http://127.0.0.1:${daemon.port}`,
      token: 'mcp-token',
      owner: 'mcp-agent',
      awarenessWatch: false,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'pinout-mcp-e2e', version: '0.0.1-alpha.1' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const state = await client.callTool({
        name: 'pinout__read_state',
        arguments: { deviceId: 'relay-mcp' },
      });
      expect(state.isError).not.toBe(true);

      const lease = await client.callTool({
        name: 'pinout__acquire_lease',
        arguments: { deviceId: 'relay-mcp' },
      });
      expect(lease.isError).not.toBe(true);

      const preview = await client.callTool({
        name: 'pinout__dry_run',
        arguments: { deviceId: 'relay-mcp', capability: 'relay.set', args: { on: true } },
      });
      expect(preview.structuredContent).toMatchObject({ dryRun: true });

      const invoked = await client.callTool({
        name: 'relay_mcp__relay_set',
        arguments: {
          on: true,
          _pinout: { idempotencyKey: 'mcp-e2e-once', waitFor: 'accepted' },
        },
      });
      expect(invoked.isError, JSON.stringify(invoked)).not.toBe(true);
      const operationId = (invoked.structuredContent as { operation: { id: string } }).operation.id;

      const status = await client.callTool({
        name: 'pinout__operation_status',
        arguments: { operationId },
      });
      expect(status.structuredContent).toMatchObject({
        operation: { id: operationId, progress: { fraction: 1 } },
      });
      const cancelled = await client.callTool({
        name: 'pinout__cancel_operation',
        arguments: { operationId, reason: 'idempotent terminal cancellation check' },
      });
      expect(cancelled.isError).not.toBe(true);

      await fetch(`http://127.0.0.1:${daemon.port}/v1/halt`, {
        method: 'POST',
        headers: { authorization: 'Bearer mcp-token', 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'MCP denial proof' }),
      });
      const denied = await client.callTool({
        name: 'relay_mcp__relay_set',
        arguments: { on: false, _pinout: { idempotencyKey: 'blocked-after-halt' } },
      });
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringMatching(/SAFETY_HALTED/) }),
        ]),
      );
    } finally {
      await client.close();
      await server.close();
      await daemon.close();
    }
  });
});
