/**
 * Headless e2e for awareness → connector (SIMULATED).
 *
 * - Real pinoutd /v1/awareness with --mock-devices (PR1)
 * - Real createDaemonMcpServer awareness/connector tools (PR2)
 * - Real generateConnector + fixtures/generator/* (PR3)
 * - Lifecycle stub (+ facade) until PR4
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { awarenessToolNames, createDaemonMcpServer } from '@pinout/mcp';
import {
  approveStubConnector,
  generateStubConnector,
  installStubConnector,
  invokeStubConnector,
} from '../src/connectorStub.js';
import { startDemoStack, type DemoStack } from '../src/startDemoStack.js';
import { evidenceExceeds, type SupportLevel } from '../src/types.js';

const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNKNOWN_BLE_ID = 'mock-ble-unknown-lamp';
const KNOWN_SERIAL_ID = 'mock-serial-esp32-known';
const READ_CAP = 'ble.gatt.00001800.00002a00.read';
const WRITE_CAP = 'ble.gatt.0000ff10.0000ff12.write';
const NOTIFY_CAP = 'ble.gatt.0000ff10.0000ff13.notify';

describe('awareness-connector demo e2e (SIMULATED)', () => {
  let stack: DemoStack;
  let connectorId: string;

  beforeAll(async () => {
    stack = await startDemoStack();
  }, 60_000);

  afterAll(async () => {
    await stack.close();
  });

  it('loads scenario honesty + real awareness mock devices', async () => {
    const scenario = JSON.parse(await readFile(join(demoRoot, 'scenario.json'), 'utf8')) as {
      evidenceLabel: string;
      honesty: string[];
    };
    expect(scenario.evidenceLabel).toBe('SIMULATED');
    expect(scenario.honesty.join(' ')).toMatch(/never run on real hardware/i);

    const devices = await stack.awareness.list();
    expect(devices.length).toBeGreaterThanOrEqual(3);
    expect(devices.every((d) => d.evidenceLevel === 'SIMULATED')).toBe(true);
    expect(devices.every((d) => d.mock === true)).toBe(true);

    const known = devices.find((d) => d.id === KNOWN_SERIAL_ID);
    expect(known?.moduleId).toBe('pinout/esp32');
    expect(['PENDING_ENROLL', 'IDENTIFIED']).toContain(known?.state);

    const unknown = devices.find((d) => d.id === UNKNOWN_BLE_ID);
    const guessed = unknown?.moduleId ?? unknown?.identity.guessedModuleId;
    expect(guessed?.startsWith('unknown/')).toBe(true);
  });

  it('generateConnector → reject before approve → ranges → never auto-arm', async () => {
    const connector = await generateStubConnector(stack.connectors.store, UNKNOWN_BLE_ID);
    connectorId = connector.id;

    expect(connector.status).toBe('QUARANTINED');
    expect(connector.armed).toBe(false);
    expect(evidenceExceeds(connector.evidenceLevel, 'COMPILE_TESTED')).toBe(false);
    expect(connector.evidenceLevel).not.toBe('HARDWARE_VERIFIED' satisfies SupportLevel);
    expect(connector.report.neverInstalls).toBe(true);
    expect(connector.pendingApprovals.length).toBeGreaterThan(0);
    expect(connector.report.notes.some((n) => n.includes('generateConnector'))).toBe(true);

    const readOnly = invokeStubConnector(stack.connectors.store, connector.id, READ_CAP, {});
    expect(readOnly.ok).toBe(true);

    const before = invokeStubConnector(stack.connectors.store, connector.id, WRITE_CAP, {
      value: '28',
    });
    expect(before.ok).toBe(false);
    expect(before.code).toBe('SAFETY_APPROVAL_REQUIRED');

    approveStubConnector(stack.connectors.store, connector.id, {
      capabilities: [READ_CAP, WRITE_CAP, NOTIFY_CAP],
      ranges: { [NOTIFY_CAP]: { value: { min: 0, max: 80 } } },
    });
    expect(connector.status).toBe('APPROVED');
    expect(connector.armed).toBe(false);

    installStubConnector(stack.connectors.store, connector.id);
    expect(connector.status).toBe('INSTALLED');
    expect(connector.armed).toBe(false);

    const outOfRange = invokeStubConnector(stack.connectors.store, connector.id, NOTIFY_CAP, {
      value: 95,
    });
    expect(outOfRange.ok).toBe(false);
    expect(outOfRange.code).toBe('POLICY_CONSTRAINT_VIOLATION');

    const inRange = invokeStubConnector(stack.connectors.store, connector.id, NOTIFY_CAP, {
      value: 40,
    });
    expect(inRange.ok).toBe(true);
    expect(inRange.result?.armed).toBe(false);
    expect(inRange.result?.simulated).toBe(true);

    expect(evidenceExceeds(connector.evidenceLevel, 'COMPILE_TESTED')).toBe(false);
  });

  it('drives real PR2 MCP tools through the unified facade', async () => {
    const server = createDaemonMcpServer({
      baseUrl: stack.baseUrl,
      token: stack.token,
      owner: 'e2e',
      awarenessWatch: false,
      dynamicTools: false,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'awareness-e2e', version: '0.0.1-alpha.1' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      for (const required of awarenessToolNames) {
        expect(names).toContain(required);
      }

      const nearby = await client.callTool({ name: 'pinout__nearby_devices', arguments: {} });
      expect(nearby.isError).not.toBe(true);
      const devices = (nearby.structuredContent as { devices: unknown[] }).devices;
      expect(devices.length).toBeGreaterThanOrEqual(2);

      const described = await client.callTool({
        name: 'pinout__describe_nearby',
        arguments: { id: UNKNOWN_BLE_ID },
      });
      expect(described.isError).not.toBe(true);

      const generated = await client.callTool({
        name: 'pinout__generate_connector',
        arguments: { awarenessId: UNKNOWN_BLE_ID },
      });
      expect(generated.isError, JSON.stringify(generated)).not.toBe(true);
      const generatedId = (generated.structuredContent as { id?: string }).id;
      expect(generatedId).toBe(connectorId);

      const status = await client.callTool({
        name: 'pinout__connector_status',
        arguments: { id: connectorId },
      });
      expect(status.isError).not.toBe(true);
      const connector = status.structuredContent as {
        evidenceLevel: SupportLevel;
        status: string;
      };
      expect(evidenceExceeds(connector.evidenceLevel, 'COMPILE_TESTED')).toBe(false);
      expect(connector.status).toBe('INSTALLED');

      const listed = await client.callTool({ name: 'pinout__list_connectors', arguments: {} });
      expect(listed.isError).not.toBe(true);
      expect(
        (listed.structuredContent as { connectors: unknown[] }).connectors.length,
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('HTTP approve path emits HUMAN APPROVES marker for MQTT fixture connector', async () => {
    const mqttConnector = await generateStubConnector(
      stack.connectors.store,
      'mock-mqtt-room-sensor',
    );
    expect(mqttConnector.status).toBe('QUARANTINED');
    expect(mqttConnector.armed).toBe(false);
    expect(evidenceExceeds(mqttConnector.evidenceLevel, 'COMPILE_TESTED')).toBe(false);
    expect(mqttConnector.source).toBe('mqtt');

    const response = await fetch(
      `${stack.baseUrl}/v1/connectors/${encodeURIComponent(mqttConnector.id)}/approve`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${stack.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          capabilities: mqttConnector.capabilities.map((c) => c.id),
          ranges: {},
        }),
      },
    );
    const body = (await response.json()) as { marker?: string; connector: { armed: boolean } };
    expect(response.ok).toBe(true);
    expect(body.marker).toBe('HUMAN APPROVES');
    expect(body.connector.armed).toBe(false);
  });
});
