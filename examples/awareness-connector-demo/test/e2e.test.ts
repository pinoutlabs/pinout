/**
 * Headless e2e for awareness → connector (SIMULATED).
 *
 * - Real pinoutd /v1/awareness with --mock-devices (PR1)
 * - Real createDaemonMcpServer awareness/connector tools (PR2)
 * - Real generateConnector + fixtures/generator/* (PR3)
 * - Real /v1/connectors* pipeline (PR4)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { awarenessToolNames, createDaemonMcpServer } from '@pinout/mcp';
import { startDemoStack, type DemoStack } from '../src/startDemoStack.js';
import { evidenceExceeds, type SupportLevel } from '../src/types.js';

const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNKNOWN_BLE_ID = 'mock-ble-unknown-lamp';
const KNOWN_SERIAL_ID = 'mock-serial-esp32-known';
const READ_CAP = 'ble.gatt.00001800.00002a00.read';
const WRITE_CAP = 'ble.gatt.0000ff10.0000ff12.write';
const NOTIFY_CAP = 'ble.gatt.0000ff10.0000ff13.notify';

function notAutoArmed(connector: {
  safety: {
    autoActuateForbidden: boolean;
    autoFlashForbidden: boolean;
    autoInstallForbidden: boolean;
  };
}): boolean {
  return (
    connector.safety.autoActuateForbidden === true &&
    connector.safety.autoFlashForbidden === true &&
    connector.safety.autoInstallForbidden === true
  );
}

describe('awareness-connector demo e2e (SIMULATED)', () => {
  let stack: DemoStack;
  let connectorId: string;

  beforeAll(async () => {
    stack = await startDemoStack();
  }, 120_000);

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

  it('generate → reject before approve → ranges → never auto-arm (real /v1/connectors*)', async () => {
    const connector = await stack.connectors.generate(UNKNOWN_BLE_ID);
    connectorId = connector.id;

    expect(connector.status).toBe('QUARANTINED');
    expect(notAutoArmed(connector)).toBe(true);
    expect(evidenceExceeds(connector.evidenceLevel, 'COMPILE_TESTED')).toBe(false);
    expect(connector.evidenceLevel).not.toBe('HARDWARE_VERIFIED' satisfies SupportLevel);
    expect(connector.safety.physicalOutputsDisabled).toBe(true);
    expect(connector.report.passed).toBe(true);

    const writeCap = connector.capabilities.find((c) => c.name === WRITE_CAP);
    expect(writeCap?.physicalOutput).toBe(true);
    expect(writeCap?.enabled).toBe(false);

    const readOnly = await stack.connectors.invokeCapability(connector.id, READ_CAP, {});
    expect(readOnly.ok).toBe(true);

    const before = await stack.connectors.invokeCapability(connector.id, WRITE_CAP, {
      value: '28',
    });
    expect(before.ok).toBe(false);
    expect(before.code).toBe('SAFETY_APPROVAL_REQUIRED');

    const approved = await stack.connectors.approve(connector.id, {
      capabilities: [READ_CAP, NOTIFY_CAP],
      ranges: { [NOTIFY_CAP]: { value: { min: 0, max: 80 } } },
      approvedBy: 'e2e-operator',
    });
    expect(approved.status).toBe('APPROVED');
    expect(notAutoArmed(approved)).toBe(true);

    const installed = await stack.connectors.install(connector.id);
    expect(installed.status).toBe('INSTALLED');
    expect(notAutoArmed(installed)).toBe(true);

    const outOfRange = await stack.connectors.invokeCapability(connector.id, NOTIFY_CAP, {
      value: 95,
    });
    expect(outOfRange.ok).toBe(false);
    expect(outOfRange.code).toBe('POLICY_CONSTRAINT_VIOLATION');

    const inRange = await stack.connectors.invokeCapability(connector.id, NOTIFY_CAP, {
      value: 40,
    });
    expect(inRange.ok).toBe(true);
    expect(inRange.result?.armed).toBe(false);
    expect(inRange.result?.simulated).toBe(true);

    expect(evidenceExceeds(installed.evidenceLevel, 'COMPILE_TESTED')).toBe(false);
  }, 120_000);

  it('drives real PR2 MCP tools against the same pinoutd baseUrl', async () => {
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

  it('HTTP approve path for MQTT fixture connector stays disarmed', async () => {
    const mqttConnector = await stack.connectors.generate('mock-mqtt-room-sensor');
    expect(mqttConnector.status).toBe('QUARANTINED');
    expect(notAutoArmed(mqttConnector)).toBe(true);
    expect(evidenceExceeds(mqttConnector.evidenceLevel, 'COMPILE_TESTED')).toBe(false);

    const readCaps = mqttConnector.capabilities
      .filter((c) => !c.physicalOutput)
      .map((c) => c.name);
    expect(readCaps.length).toBeGreaterThan(0);

    const response = await fetch(
      `${stack.baseUrl}/v1/connectors/${encodeURIComponent(mqttConnector.id)}/approve`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${stack.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          capabilities: readCaps,
          ranges: {},
          approvedBy: 'e2e-operator',
        }),
      },
    );
    const body = (await response.json()) as {
      connector: {
        status: string;
        safety: { autoActuateForbidden: boolean };
      };
    };
    expect(response.ok).toBe(true);
    expect(body.connector.status).toBe('APPROVED');
    expect(body.connector.safety.autoActuateForbidden).toBe(true);
  }, 120_000);
});
