import type { DoctorReport, DoctorStage } from './types.js';
import type { CliOutput } from '../output.js';

const STAGE_TITLES: Record<DoctorStage, string> = {
  environment: 'ENVIRONMENT',
  daemon: 'DAEMON',
  discovery: 'DEVICE DISCOVERY',
  firmware: 'FIRMWARE IDENTITY',
  configuration: 'CONFIGURATION & REGISTRY',
  simulator: 'SIMULATOR',
};

export function renderDoctorReport(report: DoctorReport, output: CliOutput): void {
  if (output.json) {
    output.log(report);
    return;
  }

  const lines: string[] = [];
  lines.push('=== PINOUT DOCTOR DIAGNOSTIC REPORT ===');
  lines.push('');

  const stageOrder: DoctorStage[] = [
    'environment',
    'daemon',
    'discovery',
    'firmware',
    'configuration',
    'simulator',
  ];

  for (const stage of stageOrder) {
    const stageChecks = report.checks.filter((check) => check.stage === stage);
    if (stageChecks.length === 0) continue;

    lines.push(`[${STAGE_TITLES[stage]}]`);
    for (const check of stageChecks) {
      const statusBadge = formatStatusBadge(check.status);
      const nameCol = check.name.padEnd(28);
      lines.push(`  ${statusBadge}  ${nameCol} ${check.detail}`);
    }
    lines.push('');
  }

  const summary = report.summary;
  lines.push('----------------------------------------');
  lines.push(
    `SUMMARY: ${summary.passed} passed, ${summary.warned} warning(s), ${summary.failed} failed, ${summary.skipped} skipped (total ${summary.total})`,
  );

  const statusLabel =
    report.status === 'pass'
      ? 'READY'
      : report.status === 'warn'
        ? 'READY (WITH WARNINGS)'
        : 'BLOCKED (ACTION REQUIRED)';
  lines.push(`OVERALL STATUS: ${statusLabel}`);
  lines.push('');

  if (report.nextSteps.length > 0) {
    lines.push('NEXT STEPS / REMEDIES:');
    report.nextSteps.forEach((step, index) => {
      lines.push(`  ${index + 1}. ${step}`);
    });
    lines.push('');
  }

  output.log(lines.join('\n'));
}

function formatStatusBadge(status: string): string {
  switch (status) {
    case 'pass':
      return 'PASS';
    case 'warn':
      return 'WARN';
    case 'fail':
      return 'FAIL';
    case 'skip':
      return 'SKIP';
    default:
      return status.toUpperCase().padEnd(4);
  }
}
