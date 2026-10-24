/**
 * Boots real pinoutd awareness (--mock-devices), PR3 generateConnector lifecycle
 * stub, and a unified HTTP facade so createDaemonMcpServer (PR2) can use one baseUrl.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { PinoutRuntime } from '@pinout/core';
import { AwarenessClient } from '@pinout/awareness';
import { AwarenessService, startDaemon, type RunningDaemon } from '@pinout/daemon';
import { startConnectorStub, type RunningConnectorStub } from './connectorStub.js';
import { startDemoFacade, type RunningDemoFacade } from './demoFacade.js';

const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function defaultMockDevicesPath(): string {
  return join(demoRoot, 'fixtures', 'mock-devices.json');
}

export function defaultConnectorEvidencePath(): string {
  return join(demoRoot, 'fixtures', 'connector-evidence.json');
}

export interface DemoStack {
  label: 'SIMULATED';
  mode: 'real-awareness+generator+real-mcp+stub-lifecycle';
  home: string;
  token: string;
  daemon: RunningDaemon;
  /** Unified base URL for createDaemonMcpServer (awareness + connectors). */
  baseUrl: string;
  awarenessBaseUrl: string;
  connectorsBaseUrl: string;
  awareness: AwarenessClient;
  connectors: RunningConnectorStub;
  facade: RunningDemoFacade;
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
    journalPath: join(home, 'journal.jsonl'),
    requireLeases: false,
    awareness: awarenessService,
  });

  const connectors = await startConnectorStub({
    evidencePath: connectorEvidencePath,
    token,
  });

  const awarenessBaseUrl = `http://127.0.0.1:${daemon.port}`;
  const facade = await startDemoFacade({
    awarenessBaseUrl,
    connectorsBaseUrl: connectors.baseUrl,
    token,
  });

  return {
    label: 'SIMULATED',
    mode: 'real-awareness+generator+real-mcp+stub-lifecycle',
    home,
    token,
    daemon,
    baseUrl: facade.baseUrl,
    awarenessBaseUrl,
    connectorsBaseUrl: connectors.baseUrl,
    awareness: new AwarenessClient({ baseUrl: awarenessBaseUrl, token }),
    connectors,
    facade,
    close: async () => {
      await facade.close();
      await connectors.close();
      await daemon.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
