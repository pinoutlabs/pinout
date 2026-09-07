import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  connect,
  createHeterogeneousRuntime,
  simulatedEsp32,
  PINOUT_HOME_ENV,
  addDeviceDefinition,
  createRuntimeFromConfig,
  installModuleFromPath,
  resetRuntimeModulesForTests,
} from '@pinout/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinoutMcpServer } from '../src/createServer.js';
import { createRuntimeMcpServer } from '../src/createRuntimeServer.js';
import { createDaemonMcpServer } from '../src/createDaemonServer.js';

const relaySetCapability = {
  name: 'relay.set',
  description: 'Set relay state.',
  inputSchema: {
    type: 'object',
    required: ['on'],
    properties: { on: { type: 'boolean' } },
  },
  outputSchema: { type: 'object', properties: { on: { type: 'boolean' } } },
  safety: { physicalOutput: true, reversible: true },
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function missingRouteResponse(pathname: string): Response {
  return jsonResponse(
    {
      error: {
        code: 'NOT_FOUND',
        message: `No route for GET ${pathname}`,
        retryable: false,
      },
    },
    404,
  );
}

describe('@pinout/mcp daemon client', () => {
  it('uses pinoutd for leases and governed capability operations', async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ url, method, ...(body ? { body } : {}) });
      const pathname = new URL(url).pathname;
      let payload: Record<string, unknown>;
      if (pathname === '/v1/devices') {
        payload = { devices: [{ id: 'relay-01', simulated: true }] };
      } else if (pathname === '/v1/devices/relay-01' && method === 'GET') {
        payload = {
          identity: { id: 'relay-01' },
          capabilityDescriptors: [relaySetCapability],
        };
      } else if (pathname === '/v1/leases') {
        payload = { lease: { id: 'lease-1', owner: 'agent-fixed' } };
      } else if (pathname === '/v1/devices/relay-01/invoke') {
        payload = { operation: { id: 'op-1', status: 'completed' }, result: { on: true } };
      } else {
        payload = { ok: true };
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const server = createDaemonMcpServer({
      baseUrl: 'http://pinoutd.test',
      owner: 'agent-fixed',
      fetch: fetchStub,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'daemon-mcp-test', version: '0.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('relay_01__relay_set');

      const lease = await client.callTool({
        name: 'pinout__acquire_lease',
        arguments: { deviceId: 'relay-01' },
      });
      expect(lease.isError).not.toBe(true);
      const invoked = await client.callTool({
        name: 'relay_01__relay_set',
        arguments: {
          on: true,
          _pinout: { idempotencyKey: 'brew-once', waitFor: 'result' },
        },
      });
      expect(invoked.isError).not.toBe(true);
      expect(requests.find((request) => request.url.endsWith('/v1/leases'))?.body).toMatchObject({
        owner: 'agent-fixed',
      });
      expect(
        requests.find((request) => request.url.endsWith('/v1/devices/relay-01/invoke'))?.body,
      ).toMatchObject({
        owner: 'agent-fixed',
        idempotencyKey: 'brew-once',
        args: { on: true },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('passes stateEvidence through in pinout__describe_device and pinout__read_state', async () => {
    const fetchStub: typeof fetch = async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/v1/devices') {
        return new Response(JSON.stringify({ devices: [{ id: 'relay-01', simulated: true }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (pathname === '/v1/devices/relay-01') {
        return new Response(
          JSON.stringify({
            identity: { id: 'relay-01', deviceClass: 'actuator.relay' },
            capabilityDescriptors: [],
            operationalState: { on: true },
            stateEvidence: {
              on: {
                commanded: { value: true, source: 'commanded', at: '2026-09-05T00:00:00.000Z' },
                acknowledged: {
                  value: true,
                  source: 'acknowledged',
                  at: '2026-09-05T00:00:00.000Z',
                },
                observed: { value: null, source: 'none', at: null },
                freshnessMs: null,
                stale: false,
                provenance: 'simulated',
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (pathname === '/v1/devices/relay-01/state') {
        return new Response(
          JSON.stringify({
            deviceId: 'relay-01',
            state: { on: true },
            stateEvidence: {
              on: {
                commanded: { value: true, source: 'commanded', at: '2026-09-05T00:00:00.000Z' },
                acknowledged: {
                  value: true,
                  source: 'acknowledged',
                  at: '2026-09-05T00:00:00.000Z',
                },
                observed: { value: null, source: 'none', at: null },
                freshnessMs: null,
                stale: false,
                provenance: 'simulated',
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const server = createDaemonMcpServer({
      baseUrl: 'http://pinoutd.test',
      fetch: fetchStub,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'daemon-evidence-test', version: '0.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const described = await client.callTool({
        name: 'pinout__describe_device',
        arguments: { deviceId: 'relay-01' },
      });
      expect(described.isError).not.toBe(true);
      expect(described.structuredContent).toMatchObject({
        identity: { id: 'relay-01' },
        operationalState: { on: true },
        stateEvidence: {
          on: expect.objectContaining({
            commanded: expect.objectContaining({ value: true }),
            observed: expect.objectContaining({ source: 'none' }),
          }),
        },
      });

      const readState = await client.callTool({
        name: 'pinout__read_state',
        arguments: { deviceId: 'relay-01' },
      });
      expect(readState.isError).not.toBe(true);
      expect(readState.structuredContent).toMatchObject({
        deviceId: 'relay-01',
        state: { on: true },
        stateEvidence: {
          on: expect.objectContaining({
            commanded: expect.objectContaining({ value: true }),
            observed: expect.objectContaining({ source: 'none' }),
          }),
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('invokes capabilities by parsing the MCP name without per-device GET', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method });
      const pathname = new URL(url).pathname;
      if (pathname === '/v1/devices/relay-01/invoke' && method === 'POST') {
        return jsonResponse({
          operation: { id: 'op-1', status: 'completed' },
          result: { on: true },
        });
      }
      if (pathname === '/v1/devices/relay-01' && method === 'GET') {
        throw new Error('per-device GET must not run on capability invoke');
      }
      return missingRouteResponse(pathname);
    };
    const server = createDaemonMcpServer({
      baseUrl: 'http://pinoutd.test',
      owner: 'agent-fixed',
      fetch: fetchStub,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'daemon-mcp-invoke-parse', version: '0.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const invoked = await client.callTool({
        name: 'relay_01__relay_set',
        arguments: { on: true },
      });
      expect(invoked.isError).not.toBe(true);
      expect(invoked.structuredContent).toMatchObject({ result: { on: true } });
      expect(requests.some((request) => request.url.endsWith('/v1/devices'))).toBe(false);
      expect(
        requests.filter(
          (request) => request.url.endsWith('/v1/devices/relay-01') && request.method === 'GET',
        ),
      ).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('prefers GET /v1/tools over N+1 device describes', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method });
      const pathname = new URL(url).pathname;
      if (pathname === '/v1/tools') {
        return jsonResponse({
          tools: [
            {
              deviceId: 'relay-01',
              capability: 'relay.set',
              mcpName: 'relay_01__relay_set',
              name: 'relay.set',
              description: 'Set relay state.',
              inputSchema: relaySetCapability.inputSchema,
              outputSchema: relaySetCapability.outputSchema,
              annotations: relaySetCapability.safety,
            },
          ],
        });
      }
      if (pathname === '/v1/devices/relay-01' && method === 'GET') {
        throw new Error('must not N+1 describe when /v1/tools is available');
      }
      return missingRouteResponse(pathname);
    };
    const server = createDaemonMcpServer({
      baseUrl: 'http://pinoutd.test',
      fetch: fetchStub,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'daemon-mcp-tools-endpoint', version: '0.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('relay_01__relay_set');
      expect(requests.some((request) => request.url.endsWith('/v1/tools'))).toBe(true);
      expect(requests.some((request) => request.url.endsWith('/v1/devices'))).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('falls back to N+1 device describes when GET /v1/tools is missing', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method });
      const pathname = new URL(url).pathname;
      if (pathname === '/v1/tools') {
        return missingRouteResponse(pathname);
      }
      if (pathname === '/v1/devices') {
        return jsonResponse({ devices: [{ id: 'relay-01', simulated: true }] });
      }
      if (pathname === '/v1/devices/relay-01' && method === 'GET') {
        return jsonResponse({
          identity: { id: 'relay-01' },
          capabilityDescriptors: [relaySetCapability],
        });
      }
      return missingRouteResponse(pathname);
    };
    const server = createDaemonMcpServer({
      baseUrl: 'http://pinoutd.test',
      fetch: fetchStub,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'daemon-mcp-tools-fallback', version: '0.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('relay_01__relay_set');
      expect(requests.some((request) => request.url.endsWith('/v1/tools'))).toBe(true);
      expect(requests.some((request) => request.url.endsWith('/v1/devices'))).toBe(true);
      expect(
        requests.some(
          (request) => request.url.endsWith('/v1/devices/relay-01') && request.method === 'GET',
        ),
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('still invokes after listTools even if later per-device GET is removed', async () => {
    let listToolsFinished = false;
    const fetchStub: typeof fetch = async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      if (pathname === '/v1/tools') {
        return missingRouteResponse(pathname);
      }
      if (pathname === '/v1/devices') {
        return jsonResponse({ devices: [{ id: 'relay-01', simulated: true }] });
      }
      if (pathname === '/v1/devices/relay-01' && method === 'GET') {
        if (listToolsFinished) {
          throw new Error('per-device GET must not run after listTools');
        }
        return jsonResponse({
          identity: { id: 'relay-01' },
          capabilityDescriptors: [relaySetCapability],
        });
      }
      if (pathname === '/v1/devices/relay-01/invoke' && method === 'POST') {
        return jsonResponse({ result: { on: true } });
      }
      return missingRouteResponse(pathname);
    };
    const server = createDaemonMcpServer({
      baseUrl: 'http://pinoutd.test',
      fetch: fetchStub,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'daemon-mcp-invoke-after-list', version: '0.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('relay_01__relay_set');
      listToolsFinished = true;
      const invoked = await client.callTool({
        name: 'relay_01__relay_set',
        arguments: { on: true },
      });
      expect(invoked.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns pinout__snapshot from GET /v1/snapshot when present', async () => {
    const fetchStub: typeof fetch = async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/v1/snapshot') {
        return jsonResponse({
          ok: true,
          safety: 'NORMAL',
          devices: [
            {
              id: 'relay-01',
              identity: { id: 'relay-01' },
              health: { lifecycle: 'ready' },
              operationalState: { on: false },
              stateEvidence: {
                on: { observed: { value: null, source: 'none', at: null } },
              },
              capabilities: ['relay.set'],
            },
          ],
        });
      }
      if (pathname === '/v1/devices' || pathname.startsWith('/v1/devices/')) {
        throw new Error('snapshot must not N+1 when /v1/snapshot is available');
      }
      return missingRouteResponse(pathname);
    };
    const server = createDaemonMcpServer({
      baseUrl: 'http://pinoutd.test',
      fetch: fetchStub,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'daemon-mcp-snapshot', version: '0.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const snapshot = await client.callTool({ name: 'pinout__snapshot', arguments: {} });
      expect(snapshot.isError).not.toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        safety: 'NORMAL',
        devices: [expect.objectContaining({ identity: { id: 'relay-01' } })],
      });
      const content = (snapshot as { content: Array<{ type: string; text?: string }> }).content;
      expect(content[0]?.text).toBe(JSON.stringify(snapshot.structuredContent));
      expect(content[0]?.text).not.toContain('\n');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('assembles pinout__snapshot from devices and state when GET /v1/snapshot is missing', async () => {
    const fetchStub: typeof fetch = async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/v1/snapshot' || pathname === '/v1/tools') {
        return missingRouteResponse(pathname);
      }
      if (pathname === '/v1/devices') {
        return jsonResponse({ devices: [{ id: 'relay-01', simulated: true }] });
      }
      if (pathname === '/v1/safety') {
        return jsonResponse({ state: 'NORMAL', reason: '', estopRequested: false });
      }
      if (pathname === '/v1/devices/relay-01') {
        return jsonResponse({
          identity: { id: 'relay-01', deviceClass: 'actuator.relay' },
          capabilityDescriptors: [relaySetCapability],
          operationalState: { on: false },
          stateEvidence: {
            on: { observed: { value: null, source: 'none', at: null } },
          },
        });
      }
      return missingRouteResponse(pathname);
    };
    const server = createDaemonMcpServer({
      baseUrl: 'http://pinoutd.test',
      fetch: fetchStub,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'daemon-mcp-snapshot-fallback', version: '0.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const snapshot = await client.callTool({ name: 'pinout__snapshot', arguments: {} });
      expect(snapshot.isError).not.toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        safety: 'NORMAL',
        devices: expect.arrayContaining([
          expect.objectContaining({
            identity: expect.objectContaining({ id: 'relay-01' }),
            operationalState: { on: false },
            stateEvidence: expect.any(Object),
          }),
        ]),
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('@pinout/mcp server', () => {
  it('lists device capabilities as MCP tools', async () => {
    const device = await connect({ transport: simulatedEsp32() });
    const server = createPinoutMcpServer(device);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'pinout-mcp-test', version: '0.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('gpio.write');
      expect(names).toContain('gpio.read');
      expect(names).toContain('sys.hello');

      const writeTool = tools.find((tool) => tool.name === 'gpio.write');
      expect(writeTool?.inputSchema).toMatchObject({
        required: ['pin', 'value'],
      });
      expect(writeTool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      expect(writeTool?.annotations?.idempotentHint).toBeUndefined();

      const readTool = tools.find((tool) => tool.name === 'gpio.read');
      expect(readTool?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    } finally {
      await client.close();
      await server.close();
      await device.close();
    }
  });

  it('invokes gpio.write through tools/call', async () => {
    const device = await connect({ transport: simulatedEsp32() });
    await device.arm();
    const server = createPinoutMcpServer(device);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'pinout-mcp-test', version: '0.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const writeResult = await client.callTool({
        name: 'gpio.write',
        arguments: { pin: 2, value: true },
      });
      expect(writeResult.isError).not.toBe(true);
      expect(writeResult.structuredContent).toEqual({ pin: 2, value: true });
      const writeContent = (writeResult as { content: Array<{ type: string; text?: string }> })
        .content;
      expect(writeContent[0]?.text).toBe(JSON.stringify({ pin: 2, value: true }));

      const readResult = await client.callTool({
        name: 'gpio.read',
        arguments: { pin: 2 },
      });
      expect(readResult.isError).not.toBe(true);
      expect(readResult.structuredContent).toEqual({ pin: 2, value: true });
    } finally {
      await client.close();
      await server.close();
      await device.close();
    }
  });

  it('returns tool errors for invalid pins without crashing', async () => {
    const device = await connect({ transport: simulatedEsp32() });
    const server = createPinoutMcpServer(device);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'pinout-mcp-test', version: '0.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: 'gpio.write',
        arguments: { pin: 34, value: true },
      });
      expect(result.isError).toBe(true);
      const content = (result as { content: Array<{ type: string; text?: string }> }).content;
      expect(content[0]?.type).toBe('text');
      if (content[0]?.type === 'text') {
        expect(content[0].text).toMatch(/input-only|cannot be driven/i);
      }
    } finally {
      await client.close();
      await server.close();
      await device.close();
    }
  });
});

describe('@pinout/mcp heterogeneous runtime', () => {
  it('lists tools from all registered devices with unique names', async () => {
    const runtime = await createHeterogeneousRuntime({ motionDelayMs: 0 });
    const server = createRuntimeMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'pinout-mcp-runtime-test', version: '0.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('pinout__list_devices');
      expect(names).toContain('pinout__describe_device');
      expect(names).toContain('pinout__snapshot');
      expect(names).toContain('esp32_01__gpio_write');
      expect(names).toContain('arm_sim_01__motion_home');
      expect(names).toContain('chamber_sim_01__temperature_set');
      expect(new Set(names).size).toBe(names.length);
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });

  it('exposes runtime discovery before an agent acts', async () => {
    const runtime = await createHeterogeneousRuntime({ motionDelayMs: 0 });
    const server = createRuntimeMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'pinout-mcp-runtime-test', version: '0.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.callTool({ name: 'pinout__list_devices', arguments: {} });
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toMatchObject({
        devices: expect.arrayContaining([
          expect.objectContaining({ id: 'esp32-01', simulated: true }),
        ]),
      });

      const described = await client.callTool({
        name: 'pinout__describe_device',
        arguments: { deviceId: 'chamber-sim-01' },
      });
      expect(described.isError).not.toBe(true);
      expect(described.structuredContent).toMatchObject({
        identity: { id: 'chamber-sim-01' },
        simulated: true,
        activeTransportKind: 'simulated',
        supportedTransportKinds: ['simulated'],
        capabilities: expect.arrayContaining([
          expect.objectContaining({ name: 'temperature.read' }),
        ]),
        stateEvidence: expect.any(Object),
      });

      const { tools } = await client.listTools();
      const readStateTool = tools.find((t) => t.name === 'pinout__read_state');
      expect(readStateTool?.description).toContain(
        '`observed` is the only field that reflects independent physical evidence; `commanded`/`acknowledged` do not prove physical effect.',
      );
      const describeDeviceTool = tools.find((t) => t.name === 'pinout__describe_device');
      expect(describeDeviceTool?.description).toContain(
        '`observed` is the only field that reflects independent physical evidence; `commanded`/`acknowledged` do not prove physical effect.',
      );
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });

  it('surfaces evidence-qualified state across write and read actions honestly to agents', async () => {
    const runtime = await createHeterogeneousRuntime({ motionDelayMs: 0 });
    const server = createRuntimeMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'pinout-mcp-evidence-test', version: '0.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      // 0. Explicitly arm device via MCP tool
      const armResult = await client.callTool({
        name: 'esp32_01__sys_arm',
        arguments: {},
      });
      expect(armResult.isError).not.toBe(true);

      // 1. Actuation write via MCP tool
      const writeResult = await client.callTool({
        name: 'esp32_01__gpio_write',
        arguments: { pin: 2, value: true },
      });
      expect(writeResult.isError).not.toBe(true);

      // 2. Read state via MCP tool: shows commanded/acknowledged set, observed remains none
      const stateAfterWrite = await client.callTool({
        name: 'pinout__read_state',
        arguments: { deviceId: 'esp32-01' },
      });
      expect(stateAfterWrite.isError).not.toBe(true);
      const evidenceAfterWrite = (
        stateAfterWrite.structuredContent as {
          stateEvidence: Record<
            string,
            {
              commanded: { value: unknown; source: string; at: string | null };
              acknowledged: { value: unknown; source: string; at: string | null };
              observed: { value: unknown; source: string; at: string | null };
              freshnessMs: number | null;
              stale: boolean;
            }
          >;
        }
      ).stateEvidence;

      expect(evidenceAfterWrite['gpio.2']).toBeDefined();
      expect(evidenceAfterWrite['gpio.2']?.commanded.value).toBe(true);
      expect(evidenceAfterWrite['gpio.2']?.commanded.source).toBe('commanded');
      expect(evidenceAfterWrite['gpio.2']?.acknowledged.value).toBe(true);
      expect(evidenceAfterWrite['gpio.2']?.acknowledged.source).toBe('acknowledged');
      // Honest reporting: observed is none
      expect(evidenceAfterWrite['gpio.2']?.observed.value).toBeNull();
      expect(evidenceAfterWrite['gpio.2']?.observed.source).toBe('none');
      expect(evidenceAfterWrite['gpio.2']?.freshnessMs).toBeNull();

      // 3. Independent sensor read via MCP tool
      const readResult = await client.callTool({
        name: 'esp32_01__gpio_read',
        arguments: { pin: 2 },
      });
      expect(readResult.isError).not.toBe(true);

      // 4. Read state again: observed is now populated with evidence and freshness
      const stateAfterRead = await client.callTool({
        name: 'pinout__read_state',
        arguments: { deviceId: 'esp32-01' },
      });
      expect(stateAfterRead.isError).not.toBe(true);
      const evidenceAfterRead = (
        stateAfterRead.structuredContent as {
          stateEvidence: Record<
            string,
            {
              commanded: { value: unknown };
              acknowledged: { value: unknown };
              observed: { value: unknown; source: string; at: string | null };
              freshnessMs: number | null;
              stale: boolean;
            }
          >;
        }
      ).stateEvidence;

      expect(evidenceAfterRead['gpio.2']?.observed.value).toBe(true);
      expect(evidenceAfterRead['gpio.2']?.observed.source).toBe('simulated');
      expect(evidenceAfterRead['gpio.2']?.observed.at).toBeTruthy();
      expect(typeof evidenceAfterRead['gpio.2']?.freshnessMs).toBe('number');
      expect(evidenceAfterRead['gpio.2']?.stale).toBe(false);
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });

  it('routes tool calls to the correct device and propagates policy failures', async () => {
    const runtime = await createHeterogeneousRuntime({ motionDelayMs: 0 });
    const server = createRuntimeMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'pinout-mcp-runtime-test', version: '0.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const home = await client.callTool({
        name: 'arm_sim_01__motion_home',
        arguments: {},
      });
      expect(home.isError).not.toBe(true);

      const denied = await client.callTool({
        name: 'chamber_sim_01__temperature_set',
        arguments: { value: 200 },
      });
      expect(denied.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });

  it('returns an in-process pinout__snapshot with safety, devices, and stateEvidence', async () => {
    const runtime = await createHeterogeneousRuntime({ motionDelayMs: 0 });
    const server = createRuntimeMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'pinout-mcp-snapshot-embedded', version: '0.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const snapshot = await client.callTool({ name: 'pinout__snapshot', arguments: {} });
      expect(snapshot.isError).not.toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        safety: 'NORMAL',
        devices: expect.arrayContaining([
          expect.objectContaining({
            identity: expect.objectContaining({ id: 'esp32-01' }),
            health: expect.objectContaining({ lifecycle: expect.any(String) }),
            operationalState: expect.any(Object),
            stateEvidence: expect.any(Object),
            capabilities: expect.arrayContaining([expect.objectContaining({ name: 'gpio.write' })]),
          }),
        ]),
      });
      const content = (snapshot as { content: Array<{ type: string; text?: string }> }).content;
      expect(content[0]?.text).toBe(JSON.stringify(snapshot.structuredContent));
      expect(content[0]?.text).not.toContain('\n');

      const lease = await client.callTool({
        name: 'pinout__acquire_lease',
        arguments: { deviceId: 'esp32-01' },
      });
      expect(lease.isError).toBe(true);
      const leaseContent = (lease as { content: Array<{ type: string; text?: string }> }).content;
      expect(leaseContent[0]?.text).toContain('CONTROL_PLANE_UNAVAILABLE');
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });
});

describe('@pinout/mcp external module via runtime config', () => {
  const weirdSensorPath = resolve(
    import.meta.dirname,
    '../../../examples/external-module/weird-sensor',
  );
  let pinoutHome: string;
  const previousHome = process.env[PINOUT_HOME_ENV];

  beforeEach(async () => {
    pinoutHome = mkdtempSync(join(tmpdir(), 'pinout-mcp-home-'));
    process.env[PINOUT_HOME_ENV] = pinoutHome;
    resetRuntimeModulesForTests();
    await installModuleFromPath(weirdSensorPath, { home: pinoutHome });
    addDeviceDefinition(
      {
        id: 'sensor-01',
        module: 'weird-sensor/thermometer',
        backend: { type: 'simulated' },
      },
      { home: pinoutHome },
    );
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env[PINOUT_HOME_ENV];
    } else {
      process.env[PINOUT_HOME_ENV] = previousHome;
    }
    rmSync(pinoutHome, { recursive: true, force: true });
    resetRuntimeModulesForTests();
  });

  it('exposes external module tools without MCP package changes', async () => {
    const { runtime } = await createRuntimeFromConfig({
      home: pinoutHome,
      includeDemoDefaults: true,
    });
    const server = createRuntimeMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'pinout-mcp-external-test', version: '0.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('sensor_01__temperature_read');
      expect(names).toContain('sensor_01__humidity_read');

      const reading = await client.callTool({
        name: 'sensor_01__temperature_read',
        arguments: {},
      });
      expect(reading.isError).not.toBe(true);
      expect(reading.structuredContent).toMatchObject({
        temperature: expect.any(Number),
      });
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });
});
