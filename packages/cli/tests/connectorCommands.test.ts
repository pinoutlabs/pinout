import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PinoutRuntime, resetRuntimeModulesForTests } from '@pinout/core';
import type { AwarenessRecord } from '@pinout/awareness';
import { generateConnectorFallback, startDaemon } from '@pinout/daemon';
import { runCli } from '../src/runCli.js';

describe('CLI connector commands', () => {
  let home: string;
  let closeDaemon: (() => Promise<void>) | undefined;
  let lines: string[];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'pinout-cli-connector-'));
    process.env.PINOUT_HOME = home;
    const runtime = new PinoutRuntime();
    const now = Date.now();
    const record: AwarenessRecord = {
      id: 'cli-aware',
      transport: 'serial',
      identity: { vendor: 'CliCo', model: 'SenseOne', deviceClass: 'sensor.custom' },
      state: 'PENDING_ENROLL',
      firstSeen: now,
      lastSeen: now,
      health: { status: 'UNKNOWN', lifecycle: 'disconnected', lastUpdated: now },
      evidenceLevel: 'SIMULATED',
      capabilities: ['sensor.read'],
      mock: true,
    };
    const daemon = await startDaemon(runtime, {
      port: 0,
      pinoutHome: home,
      journalPath: join(home, 'journal.jsonl'),
      requireLeases: false,
      connectorConformance: { skipSandbox: true },
      generateConnectorFn: generateConnectorFallback,
      awarenessLookup: async (id) => (id === record.id ? record : undefined),
    });
    process.env.PINOUT_URL = `http://127.0.0.1:${daemon.port}`;
    closeDaemon = async () => {
      await daemon.close();
      await runtime.close();
    };
    lines = [];
  });

  afterAll(async () => {
    await closeDaemon?.();
    delete process.env.PINOUT_URL;
    delete process.env.PINOUT_HOME;
    resetRuntimeModulesForTests();
    rmSync(home, { recursive: true, force: true });
  });

  async function run(argv: string[]): Promise<number> {
    lines = [];
    return runCli(['node', 'pinout', ...argv], {
      log: (value: unknown) =>
        lines.push(typeof value === 'string' ? value : JSON.stringify(value)),
      error: (message: string) => lines.push(message),
    });
  }

  it('lists, generates, shows, approves, installs, and rejects via CLI', async () => {
    expect(await run(['connector', 'list', '--json'])).toBe(0);
    expect(lines.join('\n')).toContain('connectors');

    expect(await run(['connector', 'generate', '--awareness', 'cli-aware', '--json'])).toBe(0);
    const generated = JSON.parse(lines.join('\n')) as { connector: { id: string; status: string } };
    expect(generated.connector.status).toBe('QUARANTINED');
    const id = generated.connector.id;

    expect(await run(['connector', 'show', id, '--json'])).toBe(0);
    expect(lines.join('\n')).toContain(id);

    expect(
      await run([
        'connector',
        'approve',
        id,
        '--capabilities',
        'sensor.read',
        '--ranges',
        '{}',
        '--by',
        'cli-test',
        '--json',
      ]),
    ).toBe(0);
    expect(lines.join('\n')).toContain('APPROVED');

    expect(await run(['connector', 'install', id, '--json'])).toBe(0);
    expect(lines.join('\n')).toContain('INSTALLED');

    expect(await run(['connector', 'reject', id, '--reason', 'done', '--json'])).toBe(0);
    expect(lines.join('\n')).toContain('REJECTED');
  });
});
