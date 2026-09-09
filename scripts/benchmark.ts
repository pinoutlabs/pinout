/**
 * Reproducible micro-benchmarks (Wave-2 #18).
 *
 * Run: npm run bench
 *
 * These are local-machine numbers recorded for engineering visibility, NOT
 * marketing claims and not certified performance. Results are written to
 * benchmarks/results/benchmarks.json (gitignored) and printed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { arch, cpus, platform, release } from 'node:os';
import {
  BoundedIdempotencyStore,
  Journal,
  MemoryJournalStorage,
  OperationManager,
  PinoutRuntime,
  StreamBus,
  evaluatePolicies,
  redactPayload,
  registerModule,
  relayModule,
} from '@pinout/core';

interface BenchResult {
  name: string;
  iterations: number;
  totalMs: number;
  meanMicros: number;
  opsPerSecond: number;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  samplesMs?: number[];
}

const results: BenchResult[] = [];

function percentile(samples: number[], percentileValue: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (percentileValue / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (rank - lower);
}

function record(name: string, iterations: number, totalMs: number, samplesMs?: number[]): void {
  results.push({
    name,
    iterations,
    totalMs,
    meanMicros: (totalMs * 1000) / iterations,
    opsPerSecond: (iterations / totalMs) * 1000,
    ...(samplesMs && samplesMs.length > 0
      ? {
          p50Ms: percentile(samplesMs, 50),
          p95Ms: percentile(samplesMs, 95),
          p99Ms: percentile(samplesMs, 99),
          samplesMs,
        }
      : {}),
  });
}

function benchSync(name: string, iterations: number, fn: (index: number) => void): void {
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) fn(i);
  record(name, iterations, performance.now() - started);
}

async function benchAsync(
  name: string,
  iterations: number,
  fn: (index: number) => Promise<void>,
): Promise<void> {
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) await fn(i);
  record(name, iterations, performance.now() - started);
}

async function benchAsyncWithSamples(
  name: string,
  iterations: number,
  fn: (index: number) => Promise<void>,
): Promise<void> {
  const samplesMs: number[] = [];
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const sampleStarted = performance.now();
    await fn(i);
    samplesMs.push(performance.now() - sampleStarted);
  }
  record(name, iterations, performance.now() - started, samplesMs);
}

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  console.log('PINOUT MICRO-BENCHMARKS (local machine; not marketing claims)\n');

  // -- policy engine (pure CPU) ------------------------------------------
  const rules = [
    { kind: 'numericRange' as const, capability: 'voltage.set', field: 'voltage', min: 0, max: 30 },
    { kind: 'stateEquals' as const, capability: 'voltage.set', field: 'output', equals: 'off' },
  ];
  benchSync('policy.evaluate (2 rules)', 100_000, () => {
    evaluatePolicies(rules, {
      deviceId: 'd',
      capability: 'voltage.set',
      payload: { voltage: 12 },
      operationalState: { output: 'off' },
    });
  });

  // -- journal append + redaction -----------------------------------------
  const journal = new Journal({ storage: new MemoryJournalStorage() });
  benchSync('journal.append (redacted payload)', 50_000, (i) => {
    journal.append(
      'invocation.requested',
      { deviceId: 'd' },
      { capability: 'x', apiKey: 'secret', i },
    );
  });

  // -- payload redaction ------------------------------------------------------
  benchSync('journal.redactPayload (20 keys)', 50_000, () => {
    const payload: Record<string, unknown> = {};
    for (let k = 0; k < 20; k += 1) payload[`field${k}`] = k;
    payload.password = 'x';
    redactPayload(payload);
  });

  // -- idempotency store ---------------------------------------------------------
  const store = new BoundedIdempotencyStore({ maxEntries: 10_000 });
  benchSync('idempotency.record+lookup', 100_000, (i) => {
    const key = `k-${i}`;
    store.recordUnder(BoundedIdempotencyStore.keyFor('d', 'c', 'o', key), {
      operationId: `op_${i}`,
      deviceId: 'd',
      capability: 'c',
      owner: 'o',
      status: 'completed',
      createdAt: 0,
    });
    store.lookup('d', 'c', 'o', key);
  });

  // -- stream bus -------------------------------------------------------------------
  const bus = new StreamBus();
  bus.register({ id: 'bench:stream', deviceId: 'd', name: 'bench' });
  const consumer = bus.subscribe('bench:stream', { bufferSize: 64, policy: 'drop-oldest' });
  benchSync('stream.publish (64-byte frames, 1 subscriber)', 50_000, (i) => {
    bus.publish('bench:stream', new Uint8Array(64));
    if (i % 64 === 63) consumer.sample(64);
  });

  // -- runtime invoke round-trip (simulated device) -----------------------------------
  const runtime = new PinoutRuntime();
  registerModule(relayModule);
  await runtime.registerFromModule(relayModule.id, { id: 'relay-bench', simulated: true });
  await benchAsyncWithSamples('runtime.invoke round-trip (simulated relay)', 2_000, async () => {
    await runtime.invoke('relay-bench', 'relay.set', { on: true });
  });

  // -- operations lifecycle ----------------------------------------------------------------
  const operations = new OperationManager();
  await benchAsync('operation.begin→complete (await result)', 2_000, async () => {
    const { handle } = operations.begin({
      deviceId: 'd',
      capability: 'c',
      run: async () => ({ ok: true }),
    });
    await handle.waitForResult();
  });

  console.log('');
  for (const result of results) {
    console.log(
      `${result.name.padEnd(46)} ${String(result.iterations).padStart(7)} it  ` +
        `${result.meanMicros.toFixed(2).padStart(9)} µs/op  ${Math.round(result.opsPerSecond).toLocaleString('en-US').padStart(12)} ops/s`,
    );
    if (result.p50Ms !== undefined) {
      console.log(
        `${''.padEnd(46)} p50 ${result.p50Ms.toFixed(3)} ms  p95 ${result.p95Ms?.toFixed(3)} ms  p99 ${result.p99Ms?.toFixed(3)} ms`,
      );
    }
  }

  mkdirSync(join(process.cwd(), 'benchmarks', 'results'), { recursive: true });
  const recordedAt = new Date().toISOString();
  const report = {
    benchmark: 'host-simulator-command-overhead',
    evidence: 'SIMULATED',
    limits: {
      runtimeInvokeP99Ms: '< 50 ms (issue #27 contributor laptop limit)',
    },
    recordedAt,
    gitSha: gitSha(),
    machine: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length,
    },
    node: process.version,
    results,
  };
  writeFileSync(
    join(process.cwd(), 'benchmarks', `host-simulator-${recordedAt.slice(0, 10)}.json`),
    JSON.stringify(report, null, 2),
  );
  writeFileSync(
    join(process.cwd(), 'benchmarks', 'results', 'benchmarks.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(`\nRecorded to benchmarks/host-simulator-${recordedAt.slice(0, 10)}.json`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('bench failed:', error);
  process.exit(1);
});
