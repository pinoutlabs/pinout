import type {
  DoctorCheckResult,
  DoctorDependencies,
  DoctorOptions,
  DoctorReport,
  DoctorStage,
  DoctorSummary,
} from './types.js';
import type { CliOutput } from '../output.js';
import { checkEnvironmentVariables, checkNodeVersion, checkPinoutHome } from './environment.js';
import { checkDaemon } from './daemon.js';
import { checkDiscovery } from './discovery.js';
import { checkFirmware } from './firmware.js';
import { checkConfiguration } from './configuration.js';
import { checkSimulator } from './simulator.js';
import { renderDoctorReport } from './formatter.js';

const stageOrder: DoctorStage[] = [
  'environment',
  'daemon',
  'discovery',
  'firmware',
  'configuration',
  'simulator',
];

function orderedChecks(checks: DoctorCheckResult[]): DoctorCheckResult[] {
  return stageOrder.flatMap((stage) => checks.filter((check) => check.stage === stage));
}

export async function evaluateDoctor(
  options: DoctorOptions = {},
  deps: DoctorDependencies = {},
): Promise<DoctorReport> {
  const environmentChecks: DoctorCheckResult[] = [
    checkNodeVersion(deps),
    checkPinoutHome(deps),
    checkEnvironmentVariables(deps),
  ];

  const discoveryTask = checkDiscovery(options, deps);
  const daemonTask = checkDaemon(options, deps);
  const simulatorTask = checkSimulator(deps);
  const firmwareTask = discoveryTask.then(({ ports }) => checkFirmware(options, deps, ports));
  const configurationTask = discoveryTask.then(({ ports }) => checkConfiguration(deps, ports));

  const [daemonCheck, discoveryResult, firmwareCheck, configurationChecks, simulatorCheck] =
    await Promise.all([daemonTask, discoveryTask, firmwareTask, configurationTask, simulatorTask]);

  const checks = orderedChecks([
    ...environmentChecks,
    daemonCheck,
    ...discoveryResult.checks,
    firmwareCheck,
    ...configurationChecks,
    simulatorCheck,
  ]);

  // Calculate Summary
  const passed = checks.filter((check) => check.status === 'pass').length;
  const warned = checks.filter((check) => check.status === 'warn').length;
  const failed = checks.filter((check) => check.status === 'fail').length;
  const skipped = checks.filter((check) => check.status === 'skip').length;

  const summary: DoctorSummary = {
    total: checks.length,
    passed,
    warned,
    failed,
    skipped,
  };

  const status: 'pass' | 'warn' | 'fail' = failed > 0 ? 'fail' : warned > 0 ? 'warn' : 'pass';
  const ok = failed === 0;

  // Compile ordered next steps
  const nextSteps: string[] = [];
  for (const check of checks) {
    if (check.nextStep && check.status !== 'pass') {
      const stageTag = `[${check.stage.toUpperCase()}]`;
      const stepText = `${stageTag} ${check.nextStep}`;
      if (!nextSteps.includes(stepText)) {
        nextSteps.push(stepText);
      }
    }
  }

  return {
    ok,
    status,
    summary,
    checks,
    nextSteps,
  };
}

export async function runDoctor(
  output: CliOutput,
  options: DoctorOptions = {},
  deps: DoctorDependencies = {},
): Promise<number> {
  const report = await evaluateDoctor(options, deps);
  renderDoctorReport(report, output);
  return report.ok ? 0 : 1;
}
