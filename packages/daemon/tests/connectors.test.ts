import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PinoutRuntime,
  getModule,
  resetRuntimeModulesForTests,
  type SupportLevel,
} from '@pinout/core';
import type { AwarenessRecord } from '@pinout/awareness';
import { contentHash } from '@pinout/module-host';
import {
  generateConnectorFallback,
  type GenerateConnectorFn,
} from '../src/connectors/index.js';
import { startDaemon, type RunningDaemon } from '../src/start.js';

function makeAwarenessRecord(
  overrides: Partial<AwarenessRecord> & Pick<AwarenessRecord, 'id'>,
): AwarenessRecord {
  const now = Date.now();
  return {
    id: overrides.id,
    transport: overrides.transport ?? 'serial',
    identity: {
      vendor: 'Acme',
      model: 'TempProbe',
      deviceClass: 'sensor.temperature',
      ...overrides.identity,
    },
    state: overrides.state ?? 'PENDING_ENROLL',
    firstSeen: overrides.firstSeen ?? now,
    lastSeen: overrides.lastSeen ?? now,
    health: overrides.health ?? {
      status: 'UNKNOWN',
      lifecycle: 'disconnected',
      lastUpdated: now,
    },
    evidenceLevel: overrides.evidenceLevel ?? 'SIMULATED',
    capabilities: overrides.capabilities ?? ['sensor.read', 'heater.set'],
    confidence: overrides.confidence ?? 0.6,
    mock: overrides.mock ?? true,
  };
}

describe('connector pipeline', () => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let base: string;
  let awareness: Map<string, AwarenessRecord>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pinout-connectors-'));
    awareness = new Map<string, AwarenessRecord>([
      [
        'aware-sensor',
        makeAwarenessRecord({
          id: 'aware-sensor',
          capabilities: ['sensor.read', 'heater.set'],
        }),
      ],
    ]);
  });

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    resetRuntimeModulesForTests();
    rmSync(home, { recursive: true, force: true });
  });

  async function start(options: {
    token?: string;
    generateConnectorFn?: GenerateConnectorFn;
  } = {}): Promise<void> {
    const runtime = new PinoutRuntime();
    daemon = await startDaemon(runtime, {
      port: 0,
      pinoutHome: home,
      journalPath: join(home, 'journal', 'pinoutd.jsonl'),
      requireLeases: false,
      awarenessLookup: async (id) => awareness.get(id),
      // Fast path: JS fallback. Production uses @pinout/generator generateConnector.
      generateConnectorFn: options.generateConnectorFn ?? generateConnectorFallback,
      connectorConformance: { skipSandbox: true },
      ...(options.token ? { token: options.token } : {}),
    });
    base = `http://127.0.0.1:${daemon.port}`;
  }

  function authHeaders(token?: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  it('generates → quarantines → approves → installs with journal + hot register', async () => {
    await start();
    const generate = await fetch(`${base}/v1/connectors/generate`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ awarenessId: 'aware-sensor' }),
    });
    expect(generate.status).toBe(201);
    const generated = (await generate.json()) as {
      connector: {
        id: string;
        status: string;
        evidenceLevel: SupportLevel;
        awarenessId?: string;
        capabilities: Array<{
          name: string;
          physicalOutput: boolean;
          enabled: boolean;
          safety?: { physicalOutput: boolean; reversible: boolean };
        }>;
        safety: { physicalOutputsDisabled: boolean };
        safetyFlags: { physicalOutputBlockedUntilHumanApproval: boolean };
        report: Record<string, unknown>;
      };
    };
    expect(generated.connector.status).toBe('QUARANTINED');
    expect(generated.connector.evidenceLevel).not.toBe('HARDWARE_VERIFIED');
    expect(generated.connector.awarenessId).toBe('aware-sensor');
    expect(generated.connector.safety.physicalOutputsDisabled).toBe(true);
    expect(generated.connector.safetyFlags.physicalOutputBlockedUntilHumanApproval).toBe(true);
    expect(generated.connector.report).toEqual(expect.objectContaining({ passed: true }));
    const heater = generated.connector.capabilities.find(
      (capability) => capability.name === 'heater.set',
    );
    expect(heater?.physicalOutput).toBe(true);
    expect(heater?.enabled).toBe(false);
    expect(heater?.safety).toEqual({ physicalOutput: true, reversible: expect.any(Boolean) });

    const list = await fetch(`${base}/v1/connectors`);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      connectors: Array<{
        id: string;
        status: string;
        evidenceLevel: SupportLevel;
        safetyFlags?: { physicalOutputBlockedUntilHumanApproval: boolean };
        capabilities?: unknown[];
      }>;
    };
    expect(listed.connectors).toHaveLength(1);
    expect(listed.connectors[0]).toMatchObject({
      id: generated.connector.id,
      status: 'QUARANTINED',
      safetyFlags: { physicalOutputBlockedUntilHumanApproval: true },
    });
    expect(Array.isArray(listed.connectors[0]?.capabilities)).toBe(true);

    const approve = await fetch(`${base}/v1/connectors/${generated.connector.id}/approve`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        capabilities: ['heater.set', 'sensor.read'],
        ranges: { 'heater.set': { duty: { min: 0, max: 0.4 } } },
        approvedBy: 'test-operator',
      }),
    });
    expect(approve.status).toBe(200);
    const approved = (await approve.json()) as {
      connector: { status: string; approval: { approvedBy: string } };
    };
    expect(approved.connector.status).toBe('APPROVED');
    expect(approved.connector.approval.approvedBy).toBe('test-operator');

    const install = await fetch(`${base}/v1/connectors/${generated.connector.id}/install`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(install.status).toBe(200);
    const installed = (await install.json()) as {
      connector: { status: string; moduleId: string; contentHash: string };
    };
    expect(installed.connector.status).toBe('INSTALLED');
    expect(() => getModule(installed.connector.moduleId)).not.toThrow();

    const journalEntries = await daemon!.context.journal.query({
      kinds: [
        'connector.generated',
        'connector.quarantined',
        'connector.approved',
        'connector.installed',
      ],
    });
    const kinds = journalEntries.map((entry) => entry.kind);
    expect(kinds).toContain('connector.generated');
    expect(kinds).toContain('connector.quarantined');
    expect(kinds).toContain('connector.approved');
    expect(kinds).toContain('connector.installed');
    expect(JSON.stringify(journalEntries)).toContain('test-operator');
  });

  it('keeps garbage/malicious generated modules at CANDIDATE (contained)', async () => {
    const malicious: GenerateConnectorFn = async (input) => {
      const outDir = input.outDir!;
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, 'pinout.module.json'),
        JSON.stringify({
          schemaVersion: 1,
          id: 'evil/device',
          version: '0.0.1',
          deviceClass: 'sensor.custom',
          entrypoint: './index.js',
          runtime: 'node',
          capabilities: ['sensor.read'],
          simulation: { provided: true },
          status: 'CANDIDATE',
        }),
        'utf8',
      );
      writeFileSync(
        join(outDir, 'index.js'),
        [
          'import { writeFileSync } from "node:fs";',
          'writeFileSync("/tmp/pinout-pwned", "owned");',
          'throw new Error("malicious module");',
          'export default {};',
        ].join('\n'),
        'utf8',
      );
      return {
        files: ['pinout.module.json', 'index.js'],
        report: { generator: 'malicious-fixture' },
        capabilities: [{ name: 'sensor.read', physicalOutput: false }],
        safety: { physicalOutputsDisabled: true },
        evidenceLevel: 'UNKNOWN',
        moduleId: 'evil/device',
        version: '0.0.1',
        outputPath: outDir,
      };
    };

    await start({ generateConnectorFn: malicious });
    const response = await fetch(`${base}/v1/connectors/generate`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ awarenessId: 'aware-sensor' }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      connector: { id: string; status: string; report: { passed: boolean } };
    };
    expect(body.connector.status).toBe('CANDIDATE');
    expect(body.connector.report.passed).toBe(false);

    const approve = await fetch(`${base}/v1/connectors/${body.connector.id}/approve`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        capabilities: ['sensor.read'],
        ranges: {},
        approvedBy: 'should-fail',
      }),
    });
    expect(approve.status).toBe(400);
  });

  it('rejects install when the quarantine tree is tampered (integrity hash mismatch)', async () => {
    await start({ generateConnectorFn: generateConnectorFallback });
    const generate = await fetch(`${base}/v1/connectors/generate`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ awarenessId: 'aware-sensor' }),
    });
    const generated = (await generate.json()) as {
      connector: { id: string; status: string; moduleId: string; contentHash: string };
    };
    expect(generated.connector.status).toBe('QUARANTINED');

    await fetch(`${base}/v1/connectors/${generated.connector.id}/approve`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        capabilities: ['sensor.read'],
        ranges: {},
        approvedBy: 'operator',
      }),
    });

    const modulePath = join(home, 'connectors', generated.connector.id, 'module');
    const before = contentHash(modulePath);
    writeFileSync(join(modulePath, 'TAMPERED'), 'pwn\n', 'utf8');
    expect(contentHash(modulePath)).not.toBe(before);

    const install = await fetch(`${base}/v1/connectors/${generated.connector.id}/install`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(install.status).toBe(500);
    const err = (await install.json()) as { error: { message: string } };
    expect(err.error.message).toMatch(/integrity/i);
  });

  it('requires bearer auth for mutating connector routes when a token is configured', async () => {
    await start({ token: 'secret-token' });
    const unauthorized = await fetch(`${base}/v1/connectors/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ awarenessId: 'aware-sensor' }),
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${base}/v1/connectors/generate`, {
      method: 'POST',
      headers: authHeaders('secret-token'),
      body: JSON.stringify({ awarenessId: 'aware-sensor' }),
    });
    expect(authorized.status).toBe(201);

    const listed = await fetch(`${base}/v1/connectors`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(listed.status).toBe(200);
  });

  it('rejects a quarantined connector cleanly', async () => {
    await start();
    const generate = await fetch(`${base}/v1/connectors/generate`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ awarenessId: 'aware-sensor' }),
    });
    const id = ((await generate.json()) as { connector: { id: string } }).connector.id;
    const reject = await fetch(`${base}/v1/connectors/${id}/reject`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ reason: 'unsafe', rejectedBy: 'reviewer' }),
    });
    expect(reject.status).toBe(200);
    const body = (await reject.json()) as {
      connector: { status: string; rejection: { reason: string } };
    };
    expect(body.connector.status).toBe('REJECTED');
    expect(body.connector.rejection.reason).toBe('unsafe');
  });
});
