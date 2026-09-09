/**
 * MCP stdio versus daemon HTTP round-trip benchmark for issue #28.
 *
 * This launches the actual @pinout/mcp stdio entrypoint as a child process,
 * backed by a real in-process pinoutd on an ephemeral loopback port. Results
 * are simulator-only and must not be read as USB or GPIO timing.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, arch } from 'node:os';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PinoutRuntime, relayModule } from '@pinout/core';
import { startDaemon, type RunningDaemon } from '@pinout/daemon';

const samples = 30;
const token = 'benchmark-token';
const owner = 'benchmark-mcp';
const repoRoot = resolve(import.meta.dirname, '..');
const mcpEntrypoint = resolve(repoRoot, 'packages/mcp/dist/index.js');

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lowIndex = Math.floor(rank);
  const highIndex = Math.ceil(rank);
  const low = sorted[lowIndex] ?? 0;
  const high = sorted[highIndex] ?? low;
  return low + (high - low) * (rank - lowIndex);
}

function summary(values: number[]): Record<string, unknown> {
  return {
    count: values.length,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    p99Ms: percentile(values, 99),
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

type Session = { client: Client; transport: StdioClientTransport };

function createSession(baseUrl: string): Session {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('PINOUT_')) environment[key] = value;
  }
  environment.PINOUT_DAEMON_URL = baseUrl;
  environment.PINOUT_TOKEN = token;
  environment.PINOUT_OWNER = owner;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntrypoint],
    env: environment,
  });
  return { client: new Client({ name: 'pinout-benchmark', version: '0.0.1' }), transport };
}

async function main(): Promise<void> {
  const runtime = new PinoutRuntime();
  await runtime.registerFromModule(relayModule.id, { id: 'relay-bench', simulated: true });
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon(runtime, {
      port: 0,
      token,
      requireLeases: false,
    });
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
  const runningDaemon = daemon;
  const baseUrl = `http://127.0.0.1:${runningDaemon.port}`;
  const initializeMs: number[] = [];
  const listToolsMs: number[] = [];
  const mcpInvokeMs: number[] = [];
  const mcpReadStateMs: number[] = [];
  const httpInvokeMs: number[] = [];
  const httpReadStateMs: number[] = [];

  try {
    // Each initialize sample starts and closes a real stdio subprocess.
    for (let index = 0; index < samples; index += 1) {
      const session = createSession(baseUrl);
      try {
        const started = performance.now();
        await session.client.connect(session.transport);
        initializeMs.push(performance.now() - started);
      } finally {
        await session.client.close().catch(() => undefined);
      }
    }

    const session = createSession(baseUrl);
    try {
      await session.client.connect(session.transport);
      const tools = await session.client.listTools();
      const relayTool = tools.tools.find((tool) => tool.name.endsWith('__relay_set'));
      if (!relayTool) throw new Error('MCP relay.set tool was not advertised.');
      // Warm the MCP tool cache and connection before timing steady-state calls.
      await session.client.listTools();
      await session.client.callTool({
        name: 'pinout__read_state',
        arguments: { deviceId: 'relay-bench' },
      });

      for (let index = 0; index < samples; index += 1) {
        let started = performance.now();
        const listed = await session.client.listTools();
        if (!listed.tools.some((tool) => tool.name === relayTool.name)) {
          throw new Error('MCP listTools result changed during benchmark.');
        }
        listToolsMs.push(performance.now() - started);

        started = performance.now();
        const invoke = await session.client.callTool({
          name: relayTool.name,
          arguments: { on: index % 2 === 0 },
        });
        if (invoke.isError) throw new Error('MCP invoke returned an error.');
        mcpInvokeMs.push(performance.now() - started);

        started = performance.now();
        const state = await session.client.callTool({
          name: 'pinout__read_state',
          arguments: { deviceId: 'relay-bench' },
        });
        if (state.isError) throw new Error('MCP read_state returned an error.');
        mcpReadStateMs.push(performance.now() - started);
      }
    } finally {
      await session.client.close().catch(() => undefined);
    }

    const request = async (path: string, init?: RequestInit): Promise<Record<string, unknown>> => {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
      return (await response.json()) as Record<string, unknown>;
    };
    await request('/v1/devices/relay-bench/state');
    for (let index = 0; index < samples; index += 1) {
      let started = performance.now();
      await request('/v1/devices/relay-bench/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          capability: 'relay.set',
          args: { on: index % 2 === 0 },
          owner,
          waitFor: 'result',
        }),
      });
      httpInvokeMs.push(performance.now() - started);

      started = performance.now();
      await request('/v1/devices/relay-bench/state');
      httpReadStateMs.push(performance.now() - started);
    }

    const recordedAt = new Date().toISOString();
    const mcpInvokeP99Ms = percentile(mcpInvokeMs, 99);
    const report = {
      benchmark: 'mcp-stdio-vs-daemon-http',
      issue: 28,
      evidence: 'SIMULATED',
      method: {
        samples,
        mcp: 'real packages/mcp/dist/index.js stdio subprocess, daemon-backed, persistent session after initialize warmup',
        http: 'real loopback pinoutd GET/POST endpoints, persistent fetch dispatcher after warmup',
        initialize: 'fresh stdio child process and MCP client connect for every sample',
      },
      limits: {
        minimumSamples: 'N >= 30',
        mcpInvokeP99Ms: { thresholdMs: 50, pass: mcpInvokeP99Ms < 50 },
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
      daemon: { host: '127.0.0.1', ephemeralPort: runningDaemon.port, deviceId: 'relay-bench' },
      results: {
        mcpInitialize: summary(initializeMs),
        mcpListTools: summary(listToolsMs),
        mcpInvoke: summary(mcpInvokeMs),
        mcpReadState: summary(mcpReadStateMs),
        httpInvoke: summary(httpInvokeMs),
        httpReadState: summary(httpReadStateMs),
      },
    };
    mkdirSync(join(repoRoot, 'benchmarks'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'benchmarks', `mcp-http-${recordedAt.slice(0, 10)}.json`),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await runningDaemon.close();
  }
}

main().catch((error: unknown) => {
  console.error('MCP benchmark failed:', error);
  process.exitCode = 1;
});
