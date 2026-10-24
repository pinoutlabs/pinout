/**
 * End-to-end awareness → connector demo driver.
 *
 *   npm run demo:awareness
 *
 * Real pinoutd awareness (--mock-devices) + PR3 generateConnector fixtures.
 * Connector approve/install HTTP remains a labeled stub until PR4.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScriptedAgentLoop } from './agentLoop.js';
import {
  approveStubConnector,
  generateStubConnector,
  installStubConnector,
  invokeStubConnector,
} from './connectorStub.js';
import { startDemoStack, type DemoStack } from './startDemoStack.js';
import type { StubConnectorRecord, SupportLevel } from './types.js';
import { evidenceExceeds } from './types.js';

const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const UNKNOWN_BLE_ID = 'mock-ble-unknown-lamp';
const KNOWN_SERIAL_ID = 'mock-serial-esp32-known';
const READ_CAP = 'ble.gatt.00001800.00002a00.read';
const WRITE_CAP = 'ble.gatt.0000ff10.0000ff12.write';
const NOTIFY_CAP = 'ble.gatt.0000ff10.0000ff13.notify';

export interface DemoRunResult {
  mode: DemoStack['mode'];
  label: 'SIMULATED';
  awarenessBaseUrl: string;
  connectorsBaseUrl: string;
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

export async function runAwarenessConnectorDemo(): Promise<DemoRunResult> {
  const scenario = JSON.parse(await readFile(join(demoRoot, 'scenario.json'), 'utf8')) as {
    honesty: string[];
  };
  log('SCENARIO', scenario.honesty.join('\n'));

  const stack = await startDemoStack();
  const assertions: Record<string, boolean> = {};
  const stubbed = [
    'daemon /v1/connectors* approve|install|reject (PR4) — lifecycle stub behind demo facade',
  ];

  try {
    log(
      'BOOT',
      [
        `Real pinoutd awareness @ ${stack.awarenessBaseUrl}`,
        `Connector stub (generateConnector + lifecycle) @ ${stack.connectorsBaseUrl}`,
        `Unified MCP facade @ ${stack.baseUrl}`,
        `mode=${stack.mode} label=${stack.label}`,
        `mock-devices=${join(demoRoot, 'fixtures', 'mock-devices.json')}`,
      ].join('\n'),
    );

    const devices = await stack.awareness.list();
    const known = devices.find((d) => d.id === KNOWN_SERIAL_ID);
    const unknown = devices.find((d) => d.id === UNKNOWN_BLE_ID);
    const unknownModule = unknown?.moduleId ?? unknown?.identity.guessedModuleId ?? '';

    // Known modules land in PENDING_ENROLL (never auto-enroll).
    assertions.knownAutoRecognized = Boolean(
      known &&
      known.moduleId === 'pinout/esp32' &&
      (known.state === 'PENDING_ENROLL' || known.state === 'IDENTIFIED') &&
      known.evidenceLevel === 'SIMULATED' &&
      known.mock === true,
    );
    assertions.unknownAppeared = Boolean(
      unknown &&
      unknown.mock === true &&
      unknownModule.startsWith('unknown/') &&
      (unknown.state === 'IDENTIFIED' || unknown.state === 'SEEN'),
    );

    log(
      'AWARENESS (real /v1/awareness)',
      devices
        .map(
          (d) =>
            `- ${d.id} transport=${d.transport} state=${d.state} moduleId=${d.moduleId ?? 'null'} evidence=${d.evidenceLevel} mock=${d.mock === true}`,
        )
        .join('\n'),
    );

    const connector = await generateStubConnector(stack.connectors.store, UNKNOWN_BLE_ID);
    assertEvidenceNotAboveCompile(connector.evidenceLevel);
    assertions.generatedQuarantined = connector.status === 'QUARANTINED';
    assertions.evidenceCapped = !evidenceExceeds(connector.evidenceLevel, 'COMPILE_TESTED');
    assertions.notAutoArmed = connector.armed === false;
    assertions.usedPr3Generator = connector.report.notes.some((n) =>
      n.includes('generateConnector'),
    );
    log(
      'GENERATE CONNECTOR (PR3 generateConnector)',
      `id=${connector.id} moduleId=${connector.moduleId} status=${connector.status} evidence=${connector.evidenceLevel}\npendingApprovals=${connector.pendingApprovals.join(', ')}\n${connector.report.notes.join('\n')}`,
    );

    const statusOk = invokeStubConnector(stack.connectors.store, connector.id, READ_CAP, {});
    assertions.readOnlyStatusOk = statusOk.ok === true;
    log('READ-ONLY USE', JSON.stringify(statusOk, null, 2));

    const beforeApprove = invokeStubConnector(stack.connectors.store, connector.id, WRITE_CAP, {
      value: '28',
    });
    assertions.physicalBeforeApproveRejected =
      beforeApprove.ok === false && beforeApprove.code === 'SAFETY_APPROVAL_REQUIRED';
    log('PHYSICAL BEFORE APPROVE (must reject)', JSON.stringify(beforeApprove, null, 2));

    log(
      'HUMAN APPROVES',
      [
        '>>> HUMAN APPROVES <<<',
        'Operator reviews quarantine report and unlocks physical-output ranges:',
        `  ${NOTIFY_CAP}.value: { min: 0, max: 80 }`,
        `  also unlock: ${WRITE_CAP}, ${READ_CAP}`,
        'Nothing is auto-armed. Approval is explicit and scripted for this demo.',
      ].join('\n'),
    );
    approveStubConnector(stack.connectors.store, connector.id, {
      capabilities: [READ_CAP, WRITE_CAP, NOTIFY_CAP],
      ranges: { [NOTIFY_CAP]: { value: { min: 0, max: 80 } } },
    });
    assertions.approved = connector.status === 'APPROVED';

    installStubConnector(stack.connectors.store, connector.id);
    assertions.installed = connector.status === 'INSTALLED';
    assertions.stillNotArmed = connector.armed === false;
    log('INSTALL (stub until PR4)', `status=${connector.status} armed=${connector.armed}`);

    const outOfRange = invokeStubConnector(stack.connectors.store, connector.id, NOTIFY_CAP, {
      value: 95,
    });
    assertions.outOfRangeRejected =
      outOfRange.ok === false && outOfRange.code === 'POLICY_CONSTRAINT_VIOLATION';
    log('OUT-OF-RANGE (must reject)', JSON.stringify(outOfRange, null, 2));

    const inRange = invokeStubConnector(stack.connectors.store, connector.id, NOTIFY_CAP, {
      value: 40,
    });
    assertions.inRangeOk = inRange.ok === true && inRange.result?.armed === false;
    log('IN-RANGE (SIMULATED ok)', JSON.stringify(inRange, null, 2));

    const transcriptPath = join(demoRoot, 'transcript.md');
    const agent = await runScriptedAgentLoop({
      baseUrl: stack.baseUrl,
      token: stack.token,
      unknownAwarenessId: UNKNOWN_BLE_ID,
      transcriptPath,
      connectorId: connector.id,
    });
    log(
      'MCP AGENT SESSION',
      `Wrote SIMULATED transcript → ${transcriptPath}\ntools: ${agent.toolNames.join(', ')}`,
    );

    const failed = Object.entries(assertions).filter(([, ok]) => !ok);
    if (failed.length) {
      throw new Error(`Demo assertions failed: ${failed.map(([k]) => k).join(', ')}`);
    }

    log(
      'DONE',
      [
        'All scenario assertions passed (SIMULATED).',
        `Stubbed pending upstream merge:\n- ${stubbed.join('\n- ')}`,
        'Evidence never above COMPILE_TESTED. Nothing auto-armed.',
      ].join('\n'),
    );

    return {
      mode: stack.mode,
      label: 'SIMULATED',
      awarenessBaseUrl: stack.awarenessBaseUrl,
      connectorsBaseUrl: stack.connectorsBaseUrl,
      connectorId: connector.id,
      transcriptPath,
      assertions,
      stubbed,
    };
  } finally {
    await stack.close();
  }
}

export async function main(): Promise<void> {
  const result = await runAwarenessConnectorDemo();
  process.stdout.write(
    `\n${JSON.stringify(
      {
        ok: true,
        mode: result.mode,
        label: result.label,
        connectorId: result.connectorId,
        transcriptPath: result.transcriptPath,
        assertions: result.assertions,
        stubbed: result.stubbed,
      },
      null,
      2,
    )}\n`,
  );
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : error}\n`);
    process.exitCode = 1;
  });
}

export type { StubConnectorRecord };
