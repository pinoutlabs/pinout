/**
 * Boots real pinoutd with --mock-devices awareness + PR4 ConnectorPipeline on
 * the same baseUrl (generate → quarantine → approve → install).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { PinoutRuntime } from '@pinout/core';
import { AwarenessClient } from '@pinout/awareness';
import { AwarenessService, startDaemon, type RunningDaemon } from '@pinout/daemon';
import { ConnectorApi } from './connectorApi.js';
import {
  createFixtureGenerateConnectorFn,
  loadConnectorEvidence,
} from './fixtureGenerate.js';

const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function defaultMockDevicesPath(): string {
  return join(demoRoot, 'fixtures', 'mock-devices.json');
}

export function defaultConnectorEvidencePath(): string {
  return join(demoRoot, 'fixtures', 'connector-evidence.json');
}

export interface DemoStack {
  label: 'SIMULATED';
  mode: 'real-awareness+generator+real-mcp+real-connectors';
  home: string;
  token: string;
  daemon: RunningDaemon;
  /** Single pinoutd base URL for awareness, connectors, devices, and MCP. */
  baseUrl: string;
  awarenessBaseUrl: string;
  connectorsBaseUrl: string;
  awareness: AwarenessClient;
  connectors: ConnectorApi;
  runtime: PinoutRuntime;
  close(): Promise<void>;
}

export interface StartDemoStackOptions {
  mockDevicesPath?: string;
  connectorEvidencePath?: string;
  token?: string;
}

export async function startDemoStack(options: StartDemoStackOptions = {}): Promise<DemoStack> {
  const home = await mkdtemp(join(tmpdir(), 'pinout-awareness-demo-'));
  const token = options.token ?? `demo-${randomBytes(8).toString('hex')}`;
  const mockDevicesPath = options.mockDevicesPath ?? defaultMockDevicesPath();
  const connectorEvidencePath = options.connectorEvidencePath ?? defaultConnectorEvidencePath();

  const evidence = await loadConnectorEvidence(connectorEvidencePath);
  const generateConnectorFn = createFixtureGenerateConnectorFn(evidence);

  const runtime = new PinoutRuntime();
  const awarenessService = new AwarenessService({
    home,
    mockDevices: mockDevicesPath,
    intervals: {
      serialMs: 60_000,
      usbMs: 60_000,
      bleMs: 60_000,
      mdnsMs: 60_000,
      networkMs: 60_000,
    },
    log: (message) => process.stdout.write(`[awareness] ${message}\n`),
  });

  const daemon = await startDaemon(runtime, {
    port: 0,
    token,
    pinoutHome: home,
    journalPath: join(home, 'journal', 'pinoutd.jsonl'),
    requireLeases: false,
    awareness: awarenessService,
    generateConnectorFn,
    // Demo/CI: in-process conformance (sandbox worker still exists for production).
    connectorConformance: { skipSandbox: true },
  });

  const baseUrl = `http://127.0.0.1:${daemon.port}`;
  const connectors = new ConnectorApi({ baseUrl, token, runtime });

  return {
    label: 'SIMULATED',
    mode: 'real-awareness+generator+real-mcp+real-connectors',
    home,
    token,
    daemon,
    baseUrl,
    awarenessBaseUrl: baseUrl,
    connectorsBaseUrl: baseUrl,
    awareness: new AwarenessClient({ baseUrl, token }),
    connectors,
    runtime,
    close: async () => {
      await daemon.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
