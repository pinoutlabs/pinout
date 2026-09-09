/**
 * FileJournalStorage restart/hydrate benchmark for issue #30.
 *
 * Each fixture is generated through the real daemon invoke endpoint, then the
 * daemon is closed and restarted against the same JSONL journal. Hydration is
 * timed through DaemonContext.ready and list latency through GET /v1/operations.
 */
import { execFileSync } from 'node:child_process';
import { cpus, hostname, platform, release, arch, tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DaemonContext, DaemonHttpServer, startDaemon } from '@pinout/daemon';
import { PinoutRuntime, relayModule } from '@pinout/core';

const operationCounts = [100, 1000, 5000];
const restartSamples = 10;
const repoRoot = resolve(import.meta.dirname, '..');

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lowIndex = Math.floor(rank);
  const highIndex = Math.ceil(rank);
  const low = sorted[lowIndex] ?? 0;
  const high = sorted[highIndex] ?? low;
  return low + (high - low) * (rank - lowIndex);
}

function distribution(values: number[]): Record<string, unknown> {
  return {
    count: values.length,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    rawSamplesMs: values,
  };
}

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function fixture(count: number, journalPath: string): Promise<void> {
  const runtime = new PinoutRuntime();
  await runtime.registerFromModule(relayModule.id, { id: 'relay-journal', simulated: true });
  const daemon = await startDaemon(runtime, {
    port: 0,
    journalPath,
    requireLeases: false,
  });
  const base = `http://127.0.0.1:${daemon.port}`;
  try {
    for (let index = 0; index < count; index += 1) {
      const response = await fetch(`${base}/v1/devices/relay-journal/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          capability: 'relay.set',
          args: { on: index % 2 === 0 },
          owner: 'journal-benchmark',
          waitFor: 'result',
        }),
      });
      if (!response.ok) throw new Error(`fixture invoke failed with HTTP ${response.status}`);
      await response.json();
    }
  } finally {
    await daemon.close();
  }
}

async function measureRestart(journalPath: string, expectedCount: number): Promise<{ hydrateMs: number; listMs: number }> {
  const runtime = new PinoutRuntime();
  await runtime.registerFromModule(relayModule.id, { id: 'relay-journal', simulated: true });
  const started = performance.now();
  const context = new DaemonContext(runtime, { journalPath, requireLeases: false });
  await context.ready;
  const hydrateMs = performance.now() - started;
  const server = new DaemonHttpServer(context);
  const address = await server.listen({ port: 0, requireLeases: false });
  try {
    const listStarted = performance.now();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/operations`);
    if (!response.ok) throw new Error(`operations list failed with HTTP ${response.status}`);
    const payload = (await response.json()) as { operations?: unknown[] };
    const listMs = performance.now() - listStarted;
    if (!Array.isArray(payload.operations) || payload.operations.length !== expectedCount) {
      throw new Error(`expected ${expectedCount} hydrated operations, got ${String(payload.operations?.length)}`);
    }
    return { hydrateMs, listMs };
  } finally {
    await server.close();
    await runtime.close();
  }
}

async function main(): Promise<void> {
  console.log(`Journal benchmark limits: FileJournalStorage; counts ${operationCounts.join(', ')}; ${restartSamples} restart/list samples per count; simulator only.`);
  const reports: Record<string, unknown>[] = [];
  const tempRoot = await mkdtemp(join(tmpdir(), 'pinout-journal-benchmark-'));
  try {
    for (const count of operationCounts) {
      const journalPath = join(tempRoot, `operations-${count}.jsonl`);
      console.log(`Generating ${count} completed operations in ${journalPath}...`);
      await fixture(count, journalPath);
      const hydrateMs: number[] = [];
      const listMs: number[] = [];
      for (let sample = 0; sample < restartSamples; sample += 1) {
        const result = await measureRestart(journalPath, count);
        hydrateMs.push(result.hydrateMs);
        listMs.push(result.listMs);
      }
      reports.push({
        operationCount: count,
        storageBackend: 'FileJournalStorage',
        journalPath: 'temporary JSONL (removed after run)',
        hydrate: distribution(hydrateMs),
        listOperations: distribution(listMs),
      });
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  const recordedAt = new Date().toISOString();
  const report = {
    benchmark: 'file-journal-restart-hydrate-and-list',
    issue: 30,
    evidence: 'SIMULATED',
    method: {
      operationCounts,
      restartSamples,
      fixture: 'completed relay.set operations through POST /v1/devices/:id/invoke on pinoutd',
      restart: 'fresh DaemonContext and DaemonHttpServer against the same FileJournalStorage JSONL file',
      list: 'GET /v1/operations response fully parsed and operation count asserted',
    },
    limits: {
      noPhysicalClaim: true,
      noExactlyOnceClaim: true,
      temporaryFilesRemoved: true,
    },
    recordedAt,
    gitSha: gitSha(),
    node: process.version,
    machine: {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length,
    },
    results: reports,
  };
  mkdirSync(join(repoRoot, 'benchmarks'), { recursive: true });
  writeFileSync(join(repoRoot, 'benchmarks', `journal-${recordedAt.slice(0, 10)}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  console.error('Journal benchmark failed:', error);
  process.exitCode = 1;
});
