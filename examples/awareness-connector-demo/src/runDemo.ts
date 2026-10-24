/**
 * End-to-end awareness → connector demo driver.
 *
 *   npm run demo:awareness
 *
 * Real pinoutd awareness (--mock-devices) + PR3 generateConnector fixtures +
 * PR4 /v1/connectors* pipeline on the same daemon.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScriptedAgentLoop } from './agentLoop.js';
import type { DaemonConnectorRecord } from './connectorApi.js';
import { startDemoStack, type DemoStack } from './startDemoStack.js';
import { evidenceExceeds, type SupportLevel } from './types.js';

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

function usedPr3Generator(connector: DaemonConnectorRecord): boolean {
  const generator = connector.report.generator;
  if (!generator || typeof generator !== 'object') return false;
  const blob = JSON.stringify(generator);
  return blob.includes('generateConnector') || blob.includes('moduleId');
}

function notAutoArmed(connector: DaemonConnectorRecord): boolean {
  return (
    connector.safety.autoActuateForbidden === true &&
    connector.safety.autoFlashForbidden === true &&
    connector.safety.autoInstallForbidden === true
  );
}

export async function runAwarenessConnectorDemo(): Promise<DemoRunResult> {
  const scenario = JSON.parse(await readFile(join(demoRoot, 'scenario.json'), 'utf8')) as {
    honesty: string[];
  };
  log('SCENARIO', scenario.honesty.join('\n'));

  const stack = await startDemoStack();
  const assertions: Record<string, boolean> = {};
  const stubbed: string[] = [];

  try {
    log(
      'BOOT',
      [
        `Real pinoutd @ ${stack.baseUrl}`,
        `mode=${stack.mode} label=${stack.label}`,
        `mock-devices=${join(demoRoot, 'fixtures', 'mock-devices.json')}`,
        'Routes: /v1/awareness* + /v1/connectors* (PR4) + /v1/devices*',
      ].join('\n'),
    );

    const devices = await stack.awareness.list();
    const known = devices.find((d) => d.id === KNOWN_SERIAL_ID);
    const unknown = devices.find((d) => d.id === UNKNOWN_BLE_ID);
    const unknownModule = unknown?.moduleId ?? unknown?.identity.guessedModuleId ?? '';

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

    const connector = await stack.connectors.generate(UNKNOWN_BLE_ID);
    assertEvidenceNotAboveCompile(connector.evidenceLevel);
    assertions.generatedQuarantined = connector.status === 'QUARANTINED';
    assertions.evidenceCapped = !evidenceExceeds(connector.evidenceLevel, 'COMPILE_TESTED');
    assertions.notAutoArmed = notAutoArmed(connector);
    assertions.usedPr3Generator = usedPr3Generator(connector);
    assertions.physicalOutputsBlocked =
      connector.safety.physicalOutputsDisabled === true &&
      connector.safetyFlags?.physicalOutputBlockedUntilHumanApproval === true;

    log(
      'GENERATE CONNECTOR (POST /v1/connectors/generate)',
      `id=${connector.id} moduleId=${connector.moduleId} status=${connector.status} evidence=${connector.evidenceLevel}\n${JSON.stringify(connector.report.generator ?? {}, null, 2)}`,
    );

    const statusOk = await stack.connectors.invokeCapability(connector.id, READ_CAP, {});
    assertions.readOnlyStatusOk = statusOk.ok === true;
    log('READ-ONLY USE', JSON.stringify(statusOk, null, 2));

    const beforeApprove = await stack.connectors.invokeCapability(connector.id, WRITE_CAP, {
      value: '28',
    });
    assertions.physicalBeforeApproveRejected =
      beforeApprove.ok === false && beforeApprove.code === 'SAFETY_APPROVAL_REQUIRED';
    log('PHYSICAL BEFORE APPROVE (must reject)', JSON.stringify(beforeApprove, null, 2));

    log(
      'HUMAN APPROVES',
      [
        '>>> HUMAN APPROVES <<<',
        'Operator reviews quarantine report and unlocks physical-output ranges via POST /v1/connectors/:id/approve:',
        `  ${NOTIFY_CAP}.value: { min: 0, max: 80 }`,
        `  also unlock read-only: ${READ_CAP}`,
        'Nothing is auto-armed. Approval is explicit and scripted for this demo.',
      ].join('\n'),
    );
    const approved = await stack.connectors.approve(connector.id, {
      capabilities: [READ_CAP, NOTIFY_CAP],
      ranges: { [NOTIFY_CAP]: { value: { min: 0, max: 80 } } },
      approvedBy: 'demo-operator',
    });
    assertions.approved = approved.status === 'APPROVED';
    assertions.stillNotArmedAfterApprove = notAutoArmed(approved);

    const installed = await stack.connectors.install(connector.id);
    assertions.installed = installed.status === 'INSTALLED';
    assertions.stillNotArmed = notAutoArmed(installed);
    log(
      'INSTALL (POST /v1/connectors/:id/install)',
      `status=${installed.status} moduleId=${installed.moduleId} autoActuateForbidden=${installed.safety.autoActuateForbidden}`,
    );

    const outOfRange = await stack.connectors.invokeCapability(connector.id, NOTIFY_CAP, {
      value: 95,
    });
    assertions.outOfRangeRejected =
      outOfRange.ok === false && outOfRange.code === 'POLICY_CONSTRAINT_VIOLATION';
    log('OUT-OF-RANGE (must reject)', JSON.stringify(outOfRange, null, 2));

    const inRange = await stack.connectors.invokeCapability(connector.id, NOTIFY_CAP, {
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
        'Evidence never above COMPILE_TESTED. Nothing auto-armed.',
        'Lifecycle via real pinoutd /v1/connectors* (no stub/facade).',
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
