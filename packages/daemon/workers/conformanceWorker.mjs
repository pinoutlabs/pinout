#!/usr/bin/env node
/**
 * Out-of-process connector conformance worker.
 * Invoked as: node conformanceWorker.mjs <modulePath>
 * Restricts cwd to the module directory (caller sets cwd) and prints JSON.
 */
import { runModuleConformance } from '@pinout/core';

const modulePath = process.argv[2];
if (!modulePath) {
  process.stdout.write(
    JSON.stringify({
      builds: false,
      conformancePassed: false,
      checks: [{ name: 'argv', passed: false, detail: 'modulePath required' }],
      buildError: 'modulePath required',
    }),
  );
  process.exit(1);
}

try {
  const result = await runModuleConformance(modulePath);
  const builds = result.checks.some((check) => check.name === 'entrypoint' && check.passed);
  process.stdout.write(
    JSON.stringify({
      builds,
      conformancePassed: result.passed,
      checks: result.checks,
    }),
  );
  process.exit(result.passed ? 0 : 2);
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      builds: false,
      conformancePassed: false,
      checks: [
        {
          name: 'worker',
          passed: false,
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
      buildError: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}
