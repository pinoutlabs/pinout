import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { AwarenessRecord } from '@pinout/awareness';
import { afterEach, describe, expect, it } from 'vitest';
import {
  filterAwarenessRecords,
  normalizeEvidenceLevel,
  withNormalizedEvidence,
} from '../src/awarenessContracts.js';
import { createDaemonMcpServer } from '../src/createDaemonServer.js';

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

function createSseHub() {
  const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();

  function openStream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.add(controller);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`),
        );
      },
      cancel() {
        // reader cancelled
      },
    });
  }

  function publish(event: Record<string, unknown>): void {
    const chunk = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const controller of [...controllers]) {
      try {
        controller.enqueue(chunk);
      } catch {
        controllers.delete(controller);
      }
    }
  }

  function closeAll(): void {
    for (const controller of [...controllers]) {
      try {
        controller.close();
      } catch {
        // ignore
      }
      controllers.delete(controller);
    }
  }

  return { openStream, publish, closeAll };
}

function sampleRecord(overrides: Partial<AwarenessRecord> = {}): AwarenessRecord {
  return {
    id: 'usb-probe-1',
    transport: 'usb',
    identity: { vid: '2341', pid: '0043', endpoint: '/dev/cu.test' },
    state: 'IDENTIFIED',
    firstSeen: Date.parse('2026-10-24T00:00:00.000Z'),
    lastSeen: Date.parse('2026-10-24T00:01:00.000Z'),
    health: {
      status: 'UNKNOWN',
      lifecycle: 'disconnected',
      lastUpdated: Date.parse('2026-10-24T00:01:00.000Z'),
    },
    capabilities: ['gpio.read'],
    evidenceLevel: 'SIMULATED',
    mock: true,
    ...overrides,
  };
}

const sampleDevices: AwarenessRecord[] = [
  sampleRecord(),
  sampleRecord({
    id: 'ble-lamp',
    transport: 'ble',
    identity: { advertisedName: 'desk-lamp', macHash: 'abc123' },
    state: 'ONLINE',
    lastSeen: Date.parse('2026-10-24T00:02:00.000Z'),
    health: {
      status: 'CONNECTED',
      lifecycle: 'ready',
      lastUpdated: Date.parse('2026-10-24T00:02:00.000Z'),
    },
    moduleId: 'pinout/mqtt-lamp',
    evidenceLevel: 'COMPILE_TESTED',
    connector: { status: 'pending', moduleId: 'pinout/mqtt-lamp' },
    mock: true,
  }),
];

function createMockAwarenessDaemon(options?: {
  devices?: AwarenessRecord[];
  connectors?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
}) {
  const devices = new Map((options?.devices ?? sampleDevices).map((device) => [device.id, device]));
  const connectors = new Map(
    (options?.connectors ?? []).map((connector) => [String(connector.id), { ...connector }]),
  );
  let tools = [...(options?.tools ?? [])];
  const awarenessHub = createSseHub();
  const eventsHub = createSseHub();
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];

  const fetchStub: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, ...(body ? { body } : {}) });
    const pathname = new URL(url).pathname;

    if (pathname === '/v1/awareness/events' && method === 'GET') {
      return new Response(awarenessHub.openStream(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (pathname === '/v1/events' && method === 'GET') {
      return new Response(eventsHub.openStream(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (pathname === '/v1/awareness' && method === 'GET') {
      return jsonResponse({ devices: [...devices.values()] });
    }
    if (
      pathname.startsWith('/v1/awareness/') &&
      pathname.endsWith('/enroll') &&
      method === 'POST'
    ) {
      const id = decodeURIComponent(pathname.split('/')[3] ?? '');
      const device = devices.get(id);
      if (!device) {
        return jsonResponse({ error: { message: `Unknown ${id}` } }, 404);
      }
      const enrolled: AwarenessRecord = {
        ...device,
        state: 'ONLINE',
        moduleId:
          typeof body?.moduleId === 'string' ? body.moduleId : (device.moduleId ?? 'pinout/esp32'),
      };
      devices.set(id, enrolled);
      return jsonResponse({
        enrolled: true,
        record: enrolled,
        device: {
          id: typeof body?.deviceId === 'string' ? body.deviceId : id,
          module: enrolled.moduleId,
        },
      });
    }
    if (pathname.startsWith('/v1/awareness/') && method === 'GET') {
      const id = decodeURIComponent(pathname.slice('/v1/awareness/'.length));
      const device = devices.get(id);
      if (!device) {
        return jsonResponse({ error: { message: `Unknown ${id}` } }, 404);
      }
      return jsonResponse(device);
    }
    if (pathname === '/v1/connectors/generate' && method === 'POST') {
      const awarenessId = typeof body?.awarenessId === 'string' ? body.awarenessId : '';
      const connector = {
        id: `conn-${awarenessId}`,
        awarenessId,
        status: 'QUARANTINED',
        evidenceLevel: 'SIMULATED',
        capabilities: [
          { name: 'sensor.read', safety: { physicalOutput: false, reversible: true } },
          { name: 'actuator.set', safety: { physicalOutput: true, reversible: true } },
        ],
        safetyFlags: { physicalOutputBlockedUntilHumanApproval: true },
        report: { generator: 'mock' },
      };
      connectors.set(connector.id, connector);
      return jsonResponse({ connector });
    }
    if (pathname === '/v1/connectors' && method === 'GET') {
      return jsonResponse({ connectors: [...connectors.values()] });
    }
    if (pathname.startsWith('/v1/connectors/') && method === 'GET') {
      const id = decodeURIComponent(pathname.slice('/v1/connectors/'.length));
      const connector = connectors.get(id);
      if (!connector) {
        return jsonResponse({ error: { message: `Unknown ${id}` } }, 404);
      }
      return jsonResponse({ connector });
    }
    if (pathname === '/v1/tools' && method === 'GET') {
      return jsonResponse({ tools });
    }
    return missingRouteResponse(pathname);
  };

  return {
    fetchStub,
    requests,
    devices,
    connectors,
    awarenessHub,
    eventsHub,
    installConnector(id: string) {
      const connector = connectors.get(id);
      if (!connector) throw new Error(`missing connector ${id}`);
      connector.status = 'INSTALLED';
      const awarenessId = String(connector.awarenessId ?? '');
      tools = [
        ...tools.filter((tool) => tool.deviceId !== awarenessId),
        {
          deviceId: awarenessId,
          capability: 'sensor.read',
          mcpName: `${awarenessId.replace(/-/g, '_')}__sensor_read`,
          name: 'sensor.read',
          description: 'Read sensor (quarantine-safe read-only).',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: { type: 'object', properties: {} },
          annotations: { physicalOutput: false, reversible: true },
        },
      ];
      eventsHub.publish({
        kind: 'connector_installed',
        connectorId: id,
        awarenessId,
        status: 'INSTALLED',
        at: Date.now(),
      });
    },
    close() {
      awarenessHub.closeAll();
      eventsHub.closeAll();
    },
  };
}

describe('awareness contracts honesty', () => {
  it('defaults missing evidence to SIMULATED and accepts SupportLevel including UNKNOWN', () => {
    expect(normalizeEvidenceLevel(undefined)).toBe('SIMULATED');
    expect(normalizeEvidenceLevel('HARDWARE_VERIFIED')).toBe('HARDWARE_VERIFIED');
    expect(normalizeEvidenceLevel('UNKNOWN')).toBe('UNKNOWN');
    expect(normalizeEvidenceLevel('not-a-level')).toBe('SIMULATED');
    expect(withNormalizedEvidence(sampleRecord({ evidenceLevel: 'UNKNOWN' })).evidenceLevel).toBe(
      'UNKNOWN',
    );
  });

  it('filters nearby devices by state/transport/evidence using AwarenessRecord shapes', () => {
    expect(filterAwarenessRecords(sampleDevices, { transport: 'ble' }).map((d) => d.id)).toEqual([
      'ble-lamp',
    ]);
    expect(filterAwarenessRecords(sampleDevices, { hasConnector: true }).map((d) => d.id)).toEqual([
      'ble-lamp',
    ]);
    expect(
      filterAwarenessRecords(sampleDevices, { evidenceLevel: 'SIMULATED' }).map((d) => d.id),
    ).toEqual(['usb-probe-1']);
  });
});

describe('@pinout/mcp awareness + connector surface (AwarenessClient)', () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()?.();
    }
  });

  it('exposes awareness/connector tools with quarantine honesty in descriptions', async () => {
    const mock = createMockAwarenessDaemon();
    cleanups.push(() => mock.close());
    const server = createDaemonMcpServer({
      dynamicTools: true,
      awarenessWatch: false,
      baseUrl: 'http://awareness.test',
      fetch: mock.fetchStub,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'awareness-tools', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'pinout__nearby_devices',
        'pinout__awareness_events',
        'pinout__describe_nearby',
        'pinout__request_enroll',
        'pinout__generate_connector',
        'pinout__connector_status',
        'pinout__list_connectors',
      ]),
    );
    for (const toolName of [
      'pinout__nearby_devices',
      'pinout__generate_connector',
      'pinout__connector_status',
    ]) {
      const tool = tools.find((entry) => entry.name === toolName);
      expect(tool?.description).toMatch(/QUARANTINED/i);
      expect(tool?.description).toMatch(/physical-output/i);
      expect(tool?.description).toMatch(/evidenceLevel/i);
    }
    expect(tools.find((tool) => tool.name === 'pinout__nearby_devices')?.description).toMatch(
      /AwarenessClient/,
    );
  });

  it('lists, filters, and describes nearby devices via AwarenessClient routes', async () => {
    const mock = createMockAwarenessDaemon();
    cleanups.push(() => mock.close());
    const server = createDaemonMcpServer({
      awarenessWatch: false,
      baseUrl: 'http://awareness.test',
      fetch: mock.fetchStub,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'awareness-list', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const listed = await client.callTool({
      name: 'pinout__nearby_devices',
      arguments: { transport: 'usb' },
    });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      count: 1,
      devices: [
        expect.objectContaining({
          id: 'usb-probe-1',
          evidenceLevel: 'SIMULATED',
          honesty: expect.stringMatching(/SIMULATED/),
          firstSeen: expect.any(Number),
          lastSeen: expect.any(Number),
        }),
      ],
    });

    const described = await client.callTool({
      name: 'pinout__describe_nearby',
      arguments: { id: 'ble-lamp' },
    });
    expect(described.structuredContent).toMatchObject({
      id: 'ble-lamp',
      evidenceLevel: 'COMPILE_TESTED',
      connector: expect.objectContaining({
        status: 'pending',
        guidance: expect.stringMatching(/physical-output/i),
      }),
    });
    expect(mock.requests.some((request) => request.url.endsWith('/v1/awareness'))).toBe(true);
    expect(mock.requests.some((request) => request.url.endsWith('/v1/awareness/ble-lamp'))).toBe(
      true,
    );
  });

  it('request_enroll uses AwarenessClient.enroll and keeps physical-output human-gated', async () => {
    const mock = createMockAwarenessDaemon();
    cleanups.push(() => mock.close());
    const server = createDaemonMcpServer({
      awarenessWatch: false,
      baseUrl: 'http://awareness.test',
      fetch: mock.fetchStub,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'awareness-enroll', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const enrolled = await client.callTool({
      name: 'pinout__request_enroll',
      arguments: { id: 'usb-probe-1', moduleId: 'pinout/esp32' },
    });
    expect(enrolled.isError).not.toBe(true);
    expect(enrolled.structuredContent).toMatchObject({
      enrolled: true,
      pendingPhysicalOutputApproval: true,
      humanStepRequired: true,
      record: expect.objectContaining({ state: 'ONLINE', moduleId: 'pinout/esp32' }),
      instructions: expect.arrayContaining([
        expect.stringMatching(/AwarenessClient\.enroll/),
        expect.stringMatching(/NOT approved/i),
      ]),
    });
    expect(
      mock.requests.some(
        (request) =>
          request.method === 'POST' && request.url.endsWith('/v1/awareness/usb-probe-1/enroll'),
      ),
    ).toBe(true);
  });

  it('generates and lists quarantined connectors with capability guidance', async () => {
    const mock = createMockAwarenessDaemon();
    cleanups.push(() => mock.close());
    const server = createDaemonMcpServer({
      awarenessWatch: false,
      baseUrl: 'http://awareness.test',
      fetch: mock.fetchStub,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'awareness-connector', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const generated = await client.callTool({
      name: 'pinout__generate_connector',
      arguments: { awarenessId: 'usb-probe-1' },
    });
    expect(generated.structuredContent).toMatchObject({
      status: 'QUARANTINED',
      evidenceLevel: 'SIMULATED',
      humanApprovalRequiredForPhysicalOutput: true,
      guidance: expect.stringMatching(/read-only capabilities may be usable/i),
    });

    const listed = await client.callTool({ name: 'pinout__list_connectors', arguments: {} });
    expect(listed.structuredContent).toMatchObject({
      count: 1,
      connectors: [expect.objectContaining({ id: 'conn-usb-probe-1', status: 'QUARANTINED' })],
    });
  });

  it('buffers AwarenessClient SSE events and invalidates /v1/tools on connector install', async () => {
    const mock = createMockAwarenessDaemon({
      tools: [
        {
          deviceId: 'relay-01',
          capability: 'relay.set',
          mcpName: 'relay_01__relay_set',
          name: 'relay.set',
          description: 'Set relay',
          inputSchema: { type: 'object', properties: { on: { type: 'boolean' } } },
          outputSchema: { type: 'object' },
          annotations: { physicalOutput: true, reversible: true },
        },
      ],
    });
    cleanups.push(() => mock.close());

    const toolListChanged: unknown[] = [];
    const resourceListChanged: unknown[] = [];

    const server = createDaemonMcpServer({
      dynamicTools: true,
      awarenessWatch: true,
      baseUrl: 'http://awareness.test',
      fetch: mock.fetchStub,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'awareness-sse', version: '0.0.0' });
    client.setNotificationHandler(ToolListChangedNotificationSchema, (notification) => {
      toolListChanged.push(notification);
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, (notification) => {
      resourceListChanged.push(notification);
    });
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => undefined);

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    await waitFor(() =>
      mock.requests.some((request) => request.url.includes('/v1/awareness/events')),
    );

    const before = await client.listTools();
    expect(before.tools.map((tool) => tool.name)).toContain('relay_01__relay_set');
    expect(before.tools.map((tool) => tool.name)).not.toContain('usb_probe_1__sensor_read');

    await client.callTool({
      name: 'pinout__generate_connector',
      arguments: { awarenessId: 'usb-probe-1' },
    });
    mock.installConnector('conn-usb-probe-1');

    await waitFor(() => toolListChanged.length > 0);

    const after = await client.listTools();
    expect(after.tools.map((tool) => tool.name)).toContain('usb_probe_1__sensor_read');

    mock.awarenessHub.publish({
      type: 'seen',
      at: Date.now(),
      record: sampleRecord({ id: 'new-serial', transport: 'serial', state: 'SEEN' }),
    });
    await waitFor(() => resourceListChanged.length > 0);

    const events = await client.callTool({
      name: 'pinout__awareness_events',
      arguments: { limit: 20 },
    });
    expect(events.structuredContent).toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ type: 'seen' })]),
    });
  });

  it('exposes awareness resources for list/read', async () => {
    const mock = createMockAwarenessDaemon();
    cleanups.push(() => mock.close());
    const server = createDaemonMcpServer({
      awarenessWatch: false,
      baseUrl: 'http://awareness.test',
      fetch: mock.fetchStub,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'awareness-resources', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const listed = await client.listResources();
    expect(listed.resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining([
        'pinout://awareness/devices',
        'pinout://awareness/events',
        'pinout://awareness/device/usb-probe-1',
      ]),
    );

    const read = await client.readResource({ uri: 'pinout://awareness/device/ble-lamp' });
    const text = read.contents[0] && 'text' in read.contents[0] ? read.contents[0].text : '';
    expect(JSON.parse(text ?? '{}')).toMatchObject({
      id: 'ble-lamp',
      evidenceLevel: 'COMPILE_TESTED',
    });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
