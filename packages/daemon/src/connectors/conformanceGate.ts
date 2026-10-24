import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runModuleConformance } from '@pinout/core';
import {
  contentHash,
  evaluateConformanceLevel,
  manifestHash,
  verifyModule,
  type ConformanceEvidence,
} from '@pinout/module-host';
import type { ConnectorConformanceReport } from './types.js';

export interface ConformanceGateOptions {
  /** Run conformance in-process (still no install). Prefer false in production. */
  skipSandbox?: boolean;
}

export interface ConformanceGateResult extends ConnectorConformanceReport {
  contentHash?: string;
  manifestHash?: string;
}

/**
 * Typecheck/load + conformance in an out-of-process Node worker with cwd
 * restricted to the module directory and a minimal env. Failure keeps the
 * connector at CANDIDATE; success allows QUARANTINED.
 */
export async function runConformanceGate(
  modulePath: string,
  options: ConformanceGateOptions = {},
): Promise<ConformanceGateResult> {
  const reasons: string[] = [];
  let buildError: string | undefined;
  let builds = false;
  let conformancePassed = false;
  const checks: ConnectorConformanceReport['checks'] = [];

  if (!existsSync(join(modulePath, 'pinout.module.json'))) {
    return {
      passed: false,
      checks: [{ name: 'manifest', passed: false, detail: 'pinout.module.json missing' }],
      reasons: ['manifest missing'],
    };
  }

  let manifestValid = false;
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(readFileSync(join(modulePath, 'pinout.module.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    manifestValid = typeof manifest.id === 'string' && typeof manifest.version === 'string';
    checks.push({ name: 'manifest', passed: manifestValid });
  } catch (error) {
    checks.push({
      name: 'manifest',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    reasons.push('manifest parse failed');
  }

  if (!manifestValid) {
    return { passed: false, checks, reasons };
  }

  try {
    if (options.skipSandbox) {
      const result = await runModuleConformance(modulePath);
      builds = result.checks.some((check) => check.name === 'entrypoint' && check.passed);
      conformancePassed = result.passed;
      checks.push(...result.checks);
    } else {
      const sandbox = await runSandboxedConformance(modulePath);
      builds = sandbox.builds;
      conformancePassed = sandbox.conformancePassed;
      checks.push(...sandbox.checks);
      if (sandbox.buildError) {
        buildError = sandbox.buildError;
        reasons.push(sandbox.buildError);
      }
    }
  } catch (error) {
    buildError = error instanceof Error ? error.message : String(error);
    builds = false;
    conformancePassed = false;
    checks.push({ name: 'sandbox', passed: false, detail: buildError });
    reasons.push(buildError);
  }

  const integrity = verifyModule(modulePath);
  checks.push({
    name: 'integrity',
    passed: integrity.status !== 'INVALID_SIGNATURE',
    detail: integrity.status,
  });
  if (integrity.status === 'INVALID_SIGNATURE') {
    reasons.push(...integrity.reasons);
  }

  const evidence: ConformanceEvidence = {
    manifestValid,
    builds,
    conformancePassed,
    simulationVerified: false,
    integrationVerified: false,
  };
  let level: string | undefined;
  try {
    level = evaluateConformanceLevel(evidence);
  } catch {
    level = undefined;
  }

  const passed =
    manifestValid && builds && conformancePassed && integrity.status !== 'INVALID_SIGNATURE';

  if (!passed && reasons.length === 0) {
    reasons.push('conformance gate failed');
  }

  const report: ConformanceGateResult = {
    passed,
    checks,
    integrityStatus: integrity.status,
    reasons,
  };
  if (level !== undefined) report.level = level;
  if (buildError !== undefined) report.buildError = buildError;

  if (passed) {
    report.contentHash = contentHash(modulePath);
    report.manifestHash = manifestHash(manifest);
  }

  return report;
}

interface SandboxResult {
  builds: boolean;
  conformancePassed: boolean;
  checks: ConnectorConformanceReport['checks'];
  buildError?: string;
}

function resolveWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/connectors or dist/connectors → package workers/
  return join(here, '..', '..', 'workers', 'conformanceWorker.mjs');
}

async function runSandboxedConformance(modulePath: string): Promise<SandboxResult> {
  const workerPath = resolveWorkerPath();
  if (!existsSync(workerPath)) {
    // Fall back in-process when the packaged worker is missing, but mark it.
    const result = await runModuleConformance(modulePath);
    return {
      builds: result.checks.some((check) => check.name === 'entrypoint' && check.passed),
      conformancePassed: result.passed,
      checks: [
        {
          name: 'sandbox-worker',
          passed: false,
          detail: 'worker missing; ran in-process fallback',
        },
        ...result.checks,
      ],
    };
  }

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [workerPath, modulePath], {
      cwd: modulePath,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PINOUT_HOME: process.env.PINOUT_HOME,
        NODE_PATH: process.env.NODE_PATH,
        npm_config_cache: process.env.npm_config_cache,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise({
        builds: false,
        conformancePassed: false,
        checks: [{ name: 'sandbox-timeout', passed: false, detail: 'conformance worker timed out' }],
        buildError: 'conformance worker timed out',
      });
    }, 60_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout.trim() || '{}') as SandboxResult;
        if (code !== 0 && !parsed.buildError) {
          parsed.buildError = stderr.trim() || `worker exited with code ${code}`;
        }
        const sandboxResult: SandboxResult = {
          builds: parsed.builds === true,
          conformancePassed: parsed.conformancePassed === true,
          checks: Array.isArray(parsed.checks) ? parsed.checks : [],
        };
        if (parsed.buildError !== undefined) {
          sandboxResult.buildError = parsed.buildError;
        }
        resolvePromise(sandboxResult);
      } catch {
        resolvePromise({
          builds: false,
          conformancePassed: false,
          checks: [
            {
              name: 'sandbox-parse',
              passed: false,
              detail: stderr.trim() || 'failed to parse worker output',
            },
          ],
          buildError: stderr.trim() || 'failed to parse worker output',
        });
      }
    });
  });
}

export function computeModuleHashes(modulePath: string): {
  contentHash: string;
  manifestHash: string;
} {
  const manifest = JSON.parse(readFileSync(join(modulePath, 'pinout.module.json'), 'utf8'));
  return {
    contentHash: contentHash(modulePath),
    manifestHash: manifestHash(manifest),
  };
}

export function assertIntegrityMatches(
  modulePath: string,
  expectedContentHash: string,
): { ok: true } | { ok: false; actual: string; expected: string } {
  const actual = contentHash(modulePath);
  if (actual !== expectedContentHash) {
    return { ok: false, actual, expected: expectedContentHash };
  }
  return { ok: true };
}
