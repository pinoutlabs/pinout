/**
 * ProtocolDeviceBackend heartbeat jitter benchmark for issue #29.
 *
 * The wrapper observes actual protocol writes from ProtocolDeviceBackend to
 * simulatedEsp32 while concurrent protocol reads create serial-style load.
 * It does not emulate the backend heartbeat in a separate scheduler.
 */
import { execFileSync } from 'node:child_process';
import { cpus, platform, release, arch } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  connect,
  ProtocolDeviceBackend,
  simulatedEsp32,
  type Transport,
} from '@pinout/core';

const repoRoot = resolve(import.meta.dirname, '..');
const timeoutMs = 200;
const heartbeatIntervalMs = 25;
const loadDurationMs = 5000;

class ObservedTransport implements Transport {
  readonly kind = 'simulated-esp32-observed';
  readonly kickTimesMs: number[] = [];
  requestCount = 0;
  private readonly decoder = new TextDecoder();

  constructor(private readonly inner: Transport) {}

  get readable(): AsyncIterable<Uint8Array> {
    return this.inner.readable;
  }

  async open(): Promise<void> {
    await this.inner.open();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  async write(data: Uint8Array): Promise<void> {
    const text = this.decoder.decode(data);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as { action?: unknown };
        if (typeof message.action === 'string') {
          this.requestCount += 1;
          if (message.action === 'watchdog.kick') this.kickTimesMs.push(performance.now());
        }
      } catch {
        // The underlying transport remains authoritative; observation is best effort.
      }
    }
    await this.inner.write(data);
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lowIndex = Math.floor(rank);
  const highIndex = Math.ceil(rank);
  const low = sorted[lowIndex] ?? 0;
  const high = sorted[highIndex] ?? low;
  return low + (high - low) * (rank - lowIndex);
}

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const observed = new ObservedTransport(simulatedEsp32());
  const device = await connect({ transport: observed });
  const backend = new ProtocolDeviceBackend(device, {
    watchdogTimeoutMs: timeoutMs,
    heartbeatIntervalMs,
  });
  let loadRequests = 0;
  try {
    await backend.arm({ timeoutMs, heartbeatIntervalMs, requireWatchdog: true });
    const stopAt = Date.now() + loadDurationMs;
    const workers = Array.from({ length: 8 }, async () => {
      let requestsSinceYield = 0;
      while (Date.now() < stopAt) {
        await backend.invoke('gpio.read', { pin: 2 });
        loadRequests += 1;
        requestsSinceYield += 1;
        if (requestsSinceYield >= 64) {
          requestsSinceYield = 0;
          await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
        }
      }
    });
    await Promise.all(workers);
    // Allow an in-flight heartbeat callback to finish before disarming.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, heartbeatIntervalMs * 2));
  } finally {
    await backend.disarm().catch(() => undefined);
    await backend.close();
  }

  const allIntervalsMs = observed.kickTimesMs
    .slice(1)
    .map((at, index) => at - (observed.kickTimesMs[index] ?? at));
  // The production backend currently issues two kicks in each timer callback.
  // Keep one cadence observation per callback by excluding the near-zero pair gap.
  const cadenceIntervalsMs = allIntervalsMs.filter((gap) => gap >= heartbeatIntervalMs * 0.5);
  const intervalErrorMs = cadenceIntervalsMs.map((gap) => Math.abs(gap - heartbeatIntervalMs));
  const maxIntervalMs = allIntervalsMs.length > 0 ? Math.max(...allIntervalsMs) : 0;
  const recordedAt = new Date().toISOString();
  const report = {
    benchmark: 'protocol-backend-watchdog-kick-jitter',
    issue: 29,
    evidence: 'SIMULATED',
    method: {
      load: 'ProtocolDeviceBackend with eight concurrent gpio.read protocol requests against simulatedEsp32',
      heartbeat: 'ProtocolDeviceBackend.arm({ timeoutMs, heartbeatIntervalMs }) actual host heartbeat',
      cadence: 'inter-kick gaps >= interval/2; duplicate same-callback kick gap excluded from cadence error',
      durationMs: loadDurationMs,
    },
    limits: {
      timeoutMs,
      heartbeatIntervalMs,
      expectedCadenceErrorP99Ms: '< 175 ms (timeout minus configured interval)',
      hostHeartbeatMustStayInsideTimeout: true,
    },
    recordedAt,
    gitSha: gitSha(),
    node: process.version,
    machine: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length,
    },
    observations: {
      protocolRequests: observed.requestCount,
      loadRequests,
      kickCount: observed.kickTimesMs.length,
      allIntervalsMs,
      cadenceIntervalsMs,
      intervalErrorMs,
      maxIntervalMs,
      timeoutMarginMs: timeoutMs - maxIntervalMs,
      withinTimeout: maxIntervalMs < timeoutMs,
      p50IntervalErrorMs: percentile(intervalErrorMs, 50),
      p95IntervalErrorMs: percentile(intervalErrorMs, 95),
      p99IntervalErrorMs: percentile(intervalErrorMs, 99),
    },
  };
  mkdirSync(join(repoRoot, 'benchmarks'), { recursive: true });
  writeFileSync(join(repoRoot, 'benchmarks', `watchdog-${recordedAt.slice(0, 10)}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  console.error('Watchdog benchmark failed:', error);
  process.exitCode = 1;
});
