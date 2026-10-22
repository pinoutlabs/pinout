import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModuleHost, ModuleCrashedError, ModuleDeadError, auditPermissions } from '../src/index.js';

const fixture = (name: string): string =>
  join(process.cwd(), 'packages', 'module-host', 'tests', 'fixtures', name);

let host: ModuleHost;

beforeAll(() => {
  host = new ModuleHost();
});

afterAll(async () => {
  await host.shutdownAll();
});

describe('ModuleHost: happy path', () => {
  it('spawns a node worker, correlates invokes, and forwards events', async () => {
    const processHandle = host.spawn({
      id: 'echo',
      runtime: 'node',
      modulePath: fixture('echo-module.mjs'),
      heartbeatIntervalMs: 200,
    });
    await processHandle.start();
    expect(processHandle.state()).toBe('ready');
    expect(processHandle.capabilities()).toContain('echo');

    const first = await processHandle.invoke('echo', { message: 'hello' });
    expect(first).toEqual({ echoed: 'hello', echoes: 1 });
    const second = await processHandle.invoke('echo', { message: 'world' });
    expect(second).toEqual({ echoed: 'world', echoes: 2 });

    const events: Array<[string, Record<string, unknown>]> = [];
    const unsubscribe = processHandle.onEvent((event, data) => events.push([event, data]));
    await processHandle.invoke('emit', {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    unsubscribe();
    expect(events.some(([event]) => event === 'fixture.event')).toBe(true);
  });

  it('surfaces structured module errors', async () => {
    const processHandle = host.spawn({
      id: 'echo-errors',
      runtime: 'node',
      modulePath: fixture('echo-module.mjs'),
      heartbeatIntervalMs: 200,
    });
    await processHandle.start();
    await expect(processHandle.invoke('nonexistent', {})).rejects.toMatchObject({
      code: 'MODULE_INVOKE_FAILED',
    });
  });

  it('times out a stalled invoke without killing the worker', async () => {
    const processHandle = host.spawn({
      id: 'echo-stall',
      runtime: 'node',
      modulePath: fixture('echo-module.mjs'),
      heartbeatIntervalMs: 200,
    });
    await processHandle.start();
    await expect(processHandle.invoke('stall', {}, { timeoutMs: 150 })).rejects.toThrowError(
      /MODULE_INVOKE_TIMEOUT/,
    );
    // The worker is still alive and answering.
    const after = await processHandle.invoke('echo', { message: 'still here' });
    expect(after.echoed).toBe('still here');
  });
});

describe('ModuleHost: crash isolation', () => {
  it('worker crashes exhaust the bounded restart budget and the host survives', async () => {
    const processHandle = host.spawn({
      id: 'crashy',
      runtime: 'node',
      modulePath: fixture('crashy-module.mjs'),
      heartbeatIntervalMs: 200,
      restart: { maxRestarts: 1, backoffMs: 50 },
    });
    await processHandle.start();
    const pong = await processHandle.invoke('ping');
    expect(pong.pong).toBe(true);

    // Observe the terminal state rather than sample a restart during process startup.
    await expect.poll(() => processHandle.state(), { timeout: 4000 }).toBe('dead');
    await processHandle.shutdown();
  });

  it('exhausted restarts transition the process to dead and invokes fail with MODULE_DEAD', async () => {
    const processHandle = host.spawn({
      id: 'doomed',
      runtime: 'node',
      modulePath: fixture('crashy-module.mjs'),
      heartbeatIntervalMs: 200,
      restart: { maxRestarts: 0, backoffMs: 10 },
    });
    await processHandle.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(processHandle.state()).toBe('dead');
    await expect(processHandle.invoke('ping')).rejects.toBeInstanceOf(ModuleDeadError);
  }, 10_000);

  it('a silent (heartbeat-stalled) worker is detected and killed', async () => {
    const processHandle = host.spawn({
      id: 'silent',
      runtime: 'node',
      modulePath: fixture('silent-module.mjs'),
      workerScript: fixture('silent-module.mjs'),
      heartbeatIntervalMs: 200,
      restart: { maxRestarts: 0, backoffMs: 10 },
    });
    await processHandle.start();
    // No heartbeats → host watchdog fires at 3*200+500ms.
    await new Promise((resolve) => setTimeout(resolve, 1400));
    expect(processHandle.state()).toBe('dead');
  }, 10_000);

  it('a ModuleCrashedError is retryable and structured', () => {
    const error = new ModuleCrashedError('m', 'exited (code 1)');
    expect(error.code).toBe('MODULE_CRASHED');
    expect(error.retryable).toBe(true);
  });
});

describe('permissions audit', () => {
  it('flags subprocess declarations as critical and documents non-enforcement', () => {
    const findings = auditPermissions({
      id: 'scary',
      permissions: { subprocess: true, environment: { keys: ['AWS_SECRET'] } },
    });
    expect(
      findings.some(
        (finding) => finding.severity === 'critical' && finding.permission === 'subprocess',
      ),
    ).toBe(true);
    expect(findings.some((finding) => finding.permission === 'environment')).toBe(true);
  });

  it('advises declaring permissions when the manifest is empty', () => {
    const findings = auditPermissions({ id: 'quiet' });
    expect(findings.some((finding) => finding.permission === 'none')).toBe(true);
  });
});
