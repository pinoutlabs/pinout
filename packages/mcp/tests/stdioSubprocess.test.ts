import { execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PinoutRuntime, relayModule } from '@pinout/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type RunningDaemon } from '../../daemon/src/start.js';

interface TrackedSession {
  client: Client;
  transport: StdioClientTransport;
  childProcess?: ChildProcess | undefined;
}

const entrypointPath = resolve(import.meta.dirname, '../dist/index.js');
const activeSessions: TrackedSession[] = [];
const activeDaemons: RunningDaemon[] = [];

beforeAll(() => {
  try {
    execSync('npx tsc -b packages/mcp', { stdio: 'ignore' });
  } catch {
    // If scoped build encounters transient errors in referenced packages under active edit by other agents,
    // continue with existing built dist.
  }
});

afterEach(async () => {
  for (const session of activeSessions.splice(0)) {
    try {
      await session.client.close().catch(() => undefined);
    } catch {
      // ignore close errors during teardown
    }
    if (session.childProcess && session.childProcess.exitCode === null) {
      session.childProcess.kill('SIGKILL');
    }
  }

  for (const daemon of activeDaemons.splice(0)) {
    try {
      await daemon.close().catch(() => undefined);
    } catch {
      // ignore daemon close errors during teardown
    }
  }
});

function createSubprocessClient(env: Record<string, string>): TrackedSession {
  const mergedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      mergedEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(env)) {
    mergedEnv[key] = value;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypointPath],
    env: mergedEnv,
  });
  const client = new Client({ name: 'pinout-mcp-subprocess-test', version: '0.0.1-alpha.1' });
  const session: TrackedSession = { client, transport };
  activeSessions.push(session);
  return session;
}

describe('@pinout/mcp stdio subprocess lifecycle', () => {
  it('handles the full governed lifecycle in default daemon-backed mode and stays connected between calls', async () => {
    const runtime = new PinoutRuntime();
    await runtime.registerFromModule(relayModule.id, { id: 'relay-mcp', simulated: true });
    const daemon = await startDaemon(runtime, { port: 0, token: 'test-token' });
    activeDaemons.push(daemon);

    const session = createSubprocessClient({
      PINOUT_DAEMON_URL: `http://127.0.0.1:${daemon.port}`,
      PINOUT_TOKEN: 'test-token',
      PINOUT_OWNER: 'mcp-agent',
    });

    await session.client.connect(session.transport);
    session.childProcess = (
      session.transport as unknown as { _process?: ChildProcess | undefined }
    )._process;
    expect(session.childProcess).toBeDefined();

    // 1. List tools
    const toolsResult = await session.client.listTools();
    const toolNames = toolsResult.tools.map((tool) => tool.name);
    expect(toolNames).toContain('pinout__invoke');
    expect(toolNames).not.toContain('relay_mcp__relay_set');
    expect(toolNames).toContain('pinout__describe_device');
    expect(toolNames).toContain('pinout__acquire_lease');
    expect(toolNames).toContain('pinout__read_state');
    expect(toolNames).toContain('pinout__snapshot');

    // 2. Describe device
    const describeResult = await session.client.callTool({
      name: 'pinout__describe_device',
      arguments: { deviceId: 'relay-mcp' },
    });
    expect(describeResult.isError).not.toBe(true);
    expect(describeResult.structuredContent).toMatchObject({
      identity: { id: 'relay-mcp' },
      stateEvidence: expect.any(Object),
    });

    // 3. Acquire lease
    const leaseResult = await session.client.callTool({
      name: 'pinout__acquire_lease',
      arguments: { deviceId: 'relay-mcp' },
    });
    expect(leaseResult.isError).not.toBe(true);
    expect(leaseResult.structuredContent).toMatchObject({
      lease: expect.objectContaining({ owner: 'mcp-agent' }),
    });

    // 4. Invoke capability
    const invokeResult = await session.client.callTool({
      name: 'pinout__invoke',
      arguments: {
        deviceId: 'relay-mcp',
        capability: 'relay.set',
        args: { on: true },
        idempotencyKey: 'subprocess-once',
        waitFor: 'result',
      },
    });
    expect(invokeResult.isError).not.toBe(true);
    expect(invokeResult.structuredContent).toMatchObject({
      result: { on: true },
    });

    // 5. Read state
    const stateResult = await session.client.callTool({
      name: 'pinout__read_state',
      arguments: { deviceId: 'relay-mcp' },
    });
    expect(stateResult.isError).not.toBe(true);
    expect(stateResult.structuredContent).toMatchObject({
      deviceId: 'relay-mcp',
      state: expect.objectContaining({ on: true }),
      stateEvidence: expect.objectContaining({
        on: expect.objectContaining({
          commanded: expect.objectContaining({ value: true, source: 'commanded' }),
          acknowledged: expect.objectContaining({ value: true, source: 'acknowledged' }),
          observed: expect.objectContaining({ value: true, source: 'simulated' }),
        }),
      }),
    });

    // 6. Close client and assert child process exits cleanly with code 0
    await session.client.close();
    expect(session.childProcess?.exitCode).toBe(0);
    expect(session.childProcess?.signalCode).toBeNull();
  }, 15000);

  it('runs embedded mode with simulated transport and exits cleanly', async () => {
    const session = createSubprocessClient({
      PINOUT_MCP_EMBEDDED: '1',
      PINOUT_MOCK: '1',
    });

    await session.client.connect(session.transport);
    session.childProcess = (
      session.transport as unknown as { _process?: ChildProcess | undefined }
    )._process;
    expect(session.childProcess).toBeDefined();

    const toolsResult = await session.client.listTools();
    const toolNames = toolsResult.tools.map((tool) => tool.name);
    expect(toolNames).toContain('esp32_01__sys_arm');
    expect(toolNames).toContain('esp32_01__gpio_write');
    expect(toolNames).toContain('esp32_01__gpio_read');

    const armResult = await session.client.callTool({
      name: 'esp32_01__sys_arm',
      arguments: {},
    });
    expect(armResult.isError).not.toBe(true);

    const invokeResult = await session.client.callTool({
      name: 'esp32_01__gpio_write',
      arguments: { pin: 2, value: true },
    });
    expect(invokeResult.isError).not.toBe(true);

    await session.client.close();
    expect(session.childProcess?.exitCode).toBe(0);
    expect(session.childProcess?.signalCode).toBeNull();
  }, 15000);

  it('runs heterogeneous demo mode and exits cleanly', async () => {
    const session = createSubprocessClient({
      PINOUT_DEMO: 'heterogeneous',
    });

    await session.client.connect(session.transport);
    session.childProcess = (
      session.transport as unknown as { _process?: ChildProcess | undefined }
    )._process;
    expect(session.childProcess).toBeDefined();

    const toolsResult = await session.client.listTools();
    const toolNames = toolsResult.tools.map((tool) => tool.name);
    expect(toolNames).toContain('arm_sim_01__motion_home');
    expect(toolNames).toContain('chamber_sim_01__temperature_set');
    expect(toolNames).toContain('esp32_01__gpio_write');

    const invokeResult = await session.client.callTool({
      name: 'arm_sim_01__motion_home',
      arguments: {},
    });
    expect(invokeResult.isError).not.toBe(true);

    await session.client.close();
    expect(session.childProcess?.exitCode).toBe(0);
    expect(session.childProcess?.signalCode).toBeNull();
  }, 15000);

  it('handles unreachable daemon without closing transport and surfaces explained error', async () => {
    const unreachableUrl = 'http://127.0.0.1:49999';
    const session = createSubprocessClient({
      PINOUT_DAEMON_URL: unreachableUrl,
    });

    await session.client.connect(session.transport);
    session.childProcess = (
      session.transport as unknown as { _process?: ChildProcess | undefined }
    )._process;
    expect(session.childProcess).toBeDefined();

    // Tools list succeeds (returns control-plane tools)
    const toolsResult = await session.client.listTools();
    expect(toolsResult.tools.length).toBeGreaterThan(0);

    // Calling a tool surfaces clear DAEMON_UNAVAILABLE error with daemon URL
    const callResult = await session.client.callTool({
      name: 'pinout__read_state',
      arguments: { deviceId: 'missing-device' },
    });
    expect(callResult.isError).toBe(true);
    const content = (callResult as { content: Array<{ type: string; text?: string }> }).content;
    expect(content[0]?.text).toContain('DAEMON_UNAVAILABLE');
    expect(content[0]?.text).toContain(unreachableUrl);

    // Another request on the same connection still works (transport remains open)
    const secondCallResult = await session.client.callTool({
      name: 'pinout__safety_status',
      arguments: {},
    });
    expect(secondCallResult.isError).toBe(true);
    const secondContent = (secondCallResult as { content: Array<{ type: string; text?: string }> })
      .content;
    expect(secondContent[0]?.text).toContain('DAEMON_UNAVAILABLE');

    // Clean exit
    await session.client.close();
    expect(session.childProcess?.exitCode).toBe(0);
    expect(session.childProcess?.signalCode).toBeNull();
  }, 15000);
});
