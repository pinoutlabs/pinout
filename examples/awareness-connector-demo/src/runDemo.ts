/**
 * End-to-end awareness → connector demo driver.
 *
 *   npm run demo:awareness
 *
 * Boots a SIMULATED control plane (stub until PR1/PR4 land on pinoutd with
 * --mock-devices), walks the scripted scenario, prints a HUMAN APPROVES
 * marker, then runs a scripted MCP agent loop and writes transcript.md.
 *
 * Honest labels only — Pinout has never run on real hardware here.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScriptedAgentLoop } from './agentLoop.js';
import {
  approveConnector,
  defaultMockDevicesPath,
  generateConnectorFromStore,
  installConnector,
  invokeConnectorCapability,
  startMockControlPlane,
  type RunningMockControlPlane,
} from './mockControlPlane.js';
import { probeAwarenessUpstream } from './probeUpstream.js';
import type { ConnectorRecord, SupportLevel } from './types.js';
import { evidenceExceeds } from './types.js';

const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface DemoRunResult {
  mode: 'stubbed-demo' | 'upstream-pinoutd';
  label: 'SIMULATED';
  baseUrl: string;
  connectorId: string;
  transcriptPath: string;
  assertions: Record<string, boolean>;
  stubbed: string[];
}

function log(section: string, message: string): void {
  process.stdout.write(`\n=== ${section} ===\n${message}\n`);
}

function assertEvidenceNotAboveCompile(level: SupportLevel): void {
  if (evidenceExceeds(level, 'COMPILE_TESTED')) {
    throw new Error(`Evidence level ${level} exceeds COMPILE_TESTED — honesty invariant broken`);
  }
}

async function callUpstream(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } }).error;
    const err = new Error(error?.message ?? `HTTP ${response.status}`);
    (err as Error & { code?: string }).code = error?.code ?? `HTTP_${response.status}`;
    throw err;
  }
  return payload;
}

async function runAgainstStub(): Promise<{
  plane: RunningMockControlPlane;
  connector: ConnectorRecord;
  assertions: Record<string, boolean>;
}> {
  const plane = await startMockControlPlane({
    mockDevicesPath: defaultMockDevicesPath(),
  });
  const assertions: Record<string, boolean> = {};

  log(
    'BOOT',
    `SIMULATED stub control plane on ${plane.baseUrl}\nmode=${plane.mode} label=${plane.label}\n(mock devices: ${defaultMockDevicesPath()})`,
  );

  const list = plane.store.listAwareness();
  const known = list.find((d) => d.id === 'mock-serial-esp32-known');
  const unknown = list.find((d) => d.id === 'mock-ble-unknown-lamp');
  assertions.knownAutoRecognized = Boolean(
    known && known.state === 'IDENTIFIED' && known.moduleId === 'pinout/esp32',
  );
  assertions.unknownAppeared = Boolean(
    unknown &&
    unknown.state === 'SEEN' &&
    (unknown.moduleId === null || unknown.moduleId === undefined),
  );
  log(
    'AWARENESS',
    list
      .map(
        (d) =>
          `- ${d.id} transport=${d.transport} state=${d.state} moduleId=${d.moduleId ?? 'null'} evidence=${d.evidenceLevel}`,
      )
      .join('\n'),
  );

  const connector = generateConnectorFromStore(plane.store, 'mock-ble-unknown-lamp');
  assertEvidenceNotAboveCompile(connector.evidenceLevel);
  assertions.generatedQuarantined = connector.status === 'QUARANTINED';
  assertions.evidenceCapped = !evidenceExceeds(connector.evidenceLevel, 'COMPILE_TESTED');
  assertions.notAutoArmed = connector.armed === false;
  log(
    'GENERATE CONNECTOR',
    `id=${connector.id} status=${connector.status} mode=${connector.mode} evidence=${connector.evidenceLevel}\n${connector.report.notes.join('\n')}`,
  );

  const statusOk = invokeConnectorCapability(plane.store, connector.id, 'lamp.status', {});
  assertions.readOnlyStatusOk = statusOk.ok === true;
  log('READ-ONLY USE', JSON.stringify(statusOk, null, 2));

  const beforeApprove = invokeConnectorCapability(plane.store, connector.id, 'lamp.setBrightness', {
    percent: 40,
  });
  assertions.physicalBeforeApproveRejected =
    beforeApprove.ok === false && beforeApprove.code === 'SAFETY_APPROVAL_REQUIRED';
  log('PHYSICAL BEFORE APPROVE (must reject)', JSON.stringify(beforeApprove, null, 2));

  log(
    'HUMAN APPROVES',
    [
      '>>> HUMAN APPROVES <<<',
      'Operator reviews quarantine report and unlocks physical-output ranges:',
      '  capability: lamp.setBrightness',
      '  percent: { min: 0, max: 80 }',
      'Nothing is auto-armed. Approval is explicit and scripted for this demo.',
    ].join('\n'),
  );
  approveConnector(plane.store, connector.id, {
    capabilities: ['lamp.setBrightness', 'lamp.status'],
    ranges: { 'lamp.setBrightness': { percent: { min: 0, max: 80 } } },
  });
  assertions.approved = connector.status === 'APPROVED';

  installConnector(plane.store, connector.id);
  assertions.installed = connector.status === 'INSTALLED';
  assertions.stillNotArmed = connector.armed === false;
  log('INSTALL', `status=${connector.status} armed=${connector.armed}`);

  const outOfRange = invokeConnectorCapability(plane.store, connector.id, 'lamp.setBrightness', {
    percent: 95,
  });
  assertions.outOfRangeRejected =
    outOfRange.ok === false && outOfRange.code === 'POLICY_CONSTRAINT_VIOLATION';
  log('OUT-OF-RANGE (must reject)', JSON.stringify(outOfRange, null, 2));

  const inRange = invokeConnectorCapability(plane.store, connector.id, 'lamp.setBrightness', {
    percent: 40,
  });
  assertions.inRangeOk = inRange.ok === true && inRange.result?.armed === false;
  log('IN-RANGE (SIMULATED ok)', JSON.stringify(inRange, null, 2));

  return { plane, connector, assertions };
}

async function tryUpstreamFromEnv(): Promise<{
  baseUrl: string;
  token: string;
} | null> {
  const baseUrl = process.env.PINOUT_DAEMON_URL;
  const token = process.env.PINOUT_TOKEN;
  if (!baseUrl || !token) return null;
  const probe = await probeAwarenessUpstream(baseUrl, token);
  if (!probe.available || !probe.connectors) {
    log('UPSTREAM PROBE', `Skipping real pinoutd: ${probe.reason}`);
    return null;
  }
  log('UPSTREAM PROBE', `Using real pinoutd: ${probe.reason} @ ${baseUrl}`);
  return { baseUrl, token };
}

export async function runAwarenessConnectorDemo(): Promise<DemoRunResult> {
  const scenario = JSON.parse(await readFile(join(demoRoot, 'scenario.json'), 'utf8')) as {
    honesty: string[];
  };
  log('SCENARIO', scenario.honesty.join('\n'));

  const upstream = await tryUpstreamFromEnv();
  const stubbed: string[] = [];

  // Prefer stub for deterministic CI assertions until orchestrator rebases onto
  // merged PR1–PR4. Upstream can be exercised by exporting PINOUT_DAEMON_URL +
  // PINOUT_TOKEN after those land.
  let plane: RunningMockControlPlane | undefined;
  let baseUrl: string;
  let token: string;
  let connectorId: string;
  let assertions: Record<string, boolean>;
  let mode: DemoRunResult['mode'] = 'stubbed-demo';

  if (upstream && process.env.PINOUT_AWARENESS_DEMO_USE_UPSTREAM === '1') {
    mode = 'upstream-pinoutd';
    baseUrl = upstream.baseUrl;
    token = upstream.token;
    assertions = {};
    const devices = (await callUpstream(baseUrl, token, 'GET', '/v1/awareness')) as {
      devices: Array<{ id: string }>;
    };
    log('AWARENESS (upstream)', JSON.stringify(devices, null, 2));
    const generated = (await callUpstream(baseUrl, token, 'POST', '/v1/connectors/generate', {
      awarenessId: 'mock-ble-unknown-lamp',
    })) as { connector: ConnectorRecord };
    connectorId = generated.connector.id;
    assertEvidenceNotAboveCompile(generated.connector.evidenceLevel);
    log(
      'HUMAN APPROVES',
      '>>> HUMAN APPROVES <<<\n(upstream) approving lamp.setBrightness percent [0,80]',
    );
    await callUpstream(baseUrl, token, 'POST', `/v1/connectors/${connectorId}/approve`, {
      capabilities: ['lamp.setBrightness', 'lamp.status'],
      ranges: { 'lamp.setBrightness': { percent: { min: 0, max: 80 } } },
    });
    await callUpstream(baseUrl, token, 'POST', `/v1/connectors/${connectorId}/install`, {});
    assertions.upstreamPath = true;
  } else {
    stubbed.push(
      'pinoutd --discover --mock-devices (PR1) — using local SIMULATED stub control plane',
    );
    stubbed.push('daemon /v1/awareness* and /v1/connectors* (PR1/PR4) — stubbed in demo');
    stubbed.push('MCP tools pinout__nearby_* / pinout__*connector* (PR2) — demo mcpBridge');
    stubbed.push(
      'generator generateConnector ingest (PR3) — fixture GATT/MQTT → quarantined connector',
    );
    const ran = await runAgainstStub();
    plane = ran.plane;
    baseUrl = plane.baseUrl;
    token = plane.token;
    connectorId = ran.connector.id;
    assertions = ran.assertions;
  }

  const transcriptPath = join(demoRoot, 'transcript.md');
  const agent = await runScriptedAgentLoop({
    baseUrl,
    token,
    unknownAwarenessId: 'mock-ble-unknown-lamp',
    transcriptPath,
    connectorId,
  });
  log(
    'MCP AGENT SESSION',
    `Wrote SIMULATED transcript → ${transcriptPath}\ntools: ${agent.toolNames.join(', ')}`,
  );

  const failed = Object.entries(assertions).filter(([, ok]) => !ok);
  if (failed.length) {
    await plane?.close();
    throw new Error(`Demo assertions failed: ${failed.map(([k]) => k).join(', ')}`);
  }

  log(
    'DONE',
    [
      'All scenario assertions passed (SIMULATED).',
      stubbed.length
        ? `Stubbed pending upstream merge:\n- ${stubbed.join('\n- ')}`
        : 'Used upstream pinoutd.',
      'Evidence never above COMPILE_TESTED. Nothing auto-armed.',
    ].join('\n'),
  );

  await plane?.close();

  return {
    mode,
    label: 'SIMULATED',
    baseUrl,
    connectorId,
    transcriptPath,
    assertions,
    stubbed,
  };
}

export async function main(): Promise<void> {
  const result = await runAwarenessConnectorDemo();
  process.stdout.write(
    `\n${JSON.stringify({ ok: true, ...result, baseUrl: undefined }, null, 2)}\n`,
  );
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : error}\n`);
    process.exitCode = 1;
  });
}
