import { describe, expect, it } from 'vitest';
import { PolicyConstraintViolation, evaluatePolicies } from '@pinout/core';
import {
  LibgpiodBackend,
  logicalToRaw,
  rawToLogical,
  validateLibgpiodConfig,
  type LibgpiodBackendOptions,
} from '../src/backend.js';
import { LibgpiodError } from '../src/errors.js';
import {
  createLibgpiodBackend,
  libgpiodCapabilities,
  libgpiodMaxPulseMs,
  libgpiodModule,
  libgpiodPolicies,
} from '../src/module.js';
import type { CommandRunner } from '../src/runner.js';
import { FakeCommandRunner } from './fakeRunner.js';

const statusLed = { offset: 17, name: 'status_led', direction: 'output' } as const;

type BackendState = {
  chip: string;
  platform: string;
  provenance: string;
  observedAt: number | null;
  lines: Record<string, Record<string, unknown>>;
};

function makeBackend(
  runner: FakeCommandRunner,
  overrides: Partial<LibgpiodBackendOptions> = {},
): LibgpiodBackend {
  return new LibgpiodBackend({
    runner,
    platform: 'linux',
    chip: 'gpiochip0',
    holdStartupGraceMs: 0,
    lines: [{ ...statusLed }],
    ...overrides,
  });
}

function stateOf(backend: LibgpiodBackend): BackendState {
  return backend.getOperationalState() as BackendState;
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition was not reached in time');
}

describe('LibgpiodBackend configuration validation', () => {
  it('normalizes defaults, including safe levels per direction and polarity', () => {
    const config = validateLibgpiodConfig({
      platform: 'linux',
      chip: '0',
      lines: [
        { offset: 17, direction: 'output' },
        { offset: 5, direction: 'output', polarity: 'active-low' },
        { offset: 3 },
      ],
    });
    expect(config.chip).toBe('gpiochip0');
    expect(config.provenance).toBe('hardware');
    expect(config.lines[0]).toMatchObject({
      name: 'line17',
      direction: 'output',
      polarity: 'active-high',
      safeLevel: 'low',
      bias: 'as-is',
    });
    expect(config.lines[1]).toMatchObject({ polarity: 'active-low', safeLevel: 'high' });
    expect(config.lines[2]).toMatchObject({ direction: 'input', safeLevel: 'high-z' });
  });

  it('rejects configurations whose safe state would energize the load', () => {
    const cases: Array<Record<string, unknown>> = [
      { offset: 17, direction: 'output', polarity: 'active-high', safeLevel: 'high' },
      { offset: 17, direction: 'output', polarity: 'active-low', safeLevel: 'low' },
    ];
    for (const line of cases) {
      try {
        validateLibgpiodConfig({ lines: [line] });
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect((error as LibgpiodError).code).toBe('UNSUPPORTED_CONFIGURATION');
        expect((error as LibgpiodError).message).toMatch(/energize/);
      }
    }
  });

  it('rejects impossible line combinations and malformed input', () => {
    const rejected: Array<Record<string, unknown>> = [
      { chip: '' },
      { lines: 'nope' },
      { lines: [null] },
      { lines: [{ offset: -1 }] },
      { lines: [{ offset: 1 }, { offset: 1 }] },
      {
        lines: [
          { offset: 1, name: 'a' },
          { offset: 2, name: 'a' },
        ],
      },
      { lines: [{ offset: 1, direction: 'sideways' }] },
      { lines: [{ offset: 1, polarity: 'flipped' }] },
      { lines: [{ offset: 1, safeLevel: 'floaty' }] },
      { lines: [{ offset: 1, bias: 'weak-up' }] },
      { lines: [{ offset: 1, direction: 'input', safeLevel: 'low' }] },
      { lines: [{ offset: 1, direction: 'output', bias: 'pull-up' }] },
      { toolTimeoutMs: 0 },
    ];
    for (const raw of rejected) {
      expect(() => validateLibgpiodConfig(raw)).toThrowError(LibgpiodError);
    }
  });

  it('translates polarity in both directions', () => {
    expect(logicalToRaw(true, 'active-high')).toBe(1);
    expect(logicalToRaw(false, 'active-high')).toBe(0);
    expect(logicalToRaw(true, 'active-low')).toBe(0);
    expect(logicalToRaw(false, 'active-low')).toBe(1);
    expect(rawToLogical(1, 'active-high')).toBe(true);
    expect(rawToLogical(0, 'active-low')).toBe(true);
    expect(rawToLogical(1, 'active-low')).toBe(false);
  });
});

describe('LibgpiodBackend writes and evidence', () => {
  it('holds an output line through a live gpioset child', async () => {
    const runner = new FakeCommandRunner();
    const backend = makeBackend(runner);
    const result = await backend.invoke('gpio.write', { line: 'status_led', value: true });

    expect(result).toMatchObject({
      line: 'status_led',
      offset: 17,
      value: true,
      raw: 1,
      mode: 'hold',
      held: true,
    });
    expect(runner.spawns[0]!.file).toBe('gpioset');
    expect(runner.spawns[0]!.args).toEqual(['--chip', 'gpiochip0', '--consumer', 'pinout', '17=1']);
    expect(stateOf(backend).lines.status_led).toMatchObject({
      value: true,
      raw: 1,
      held: true,
      source: 'acknowledged',
    });
    await backend.close();
  });

  it('replaces the previous holder when the line is written again', async () => {
    const runner = new FakeCommandRunner();
    const backend = makeBackend(runner);
    await backend.invoke('gpio.write', { line: 'status_led', value: true });
    await backend.invoke('gpio.write', { line: 'status_led', value: false });

    expect(runner.spawns).toHaveLength(2);
    expect(runner.spawns[0]!.process.signals).toEqual(['SIGTERM']);
    expect(runner.spawns[1]!.args).toContain('17=0');
    await backend.close();
  });

  it('drives the raw level implied by active-low polarity', async () => {
    const runner = new FakeCommandRunner();
    const backend = makeBackend(runner, {
      lines: [{ offset: 5, name: 'relay', direction: 'output', polarity: 'active-low' }],
    });
    await backend.invoke('gpio.write', { line: 'relay', value: true });
    expect(runner.spawns[0]!.args).toContain('5=0');
    await backend.close();
  });

  it('sets and releases a line once with hold: false', async () => {
    const runner = new FakeCommandRunner().enqueue({ code: 0, stdout: '', stderr: '' });
    const backend = makeBackend(runner);
    const result = await backend.invoke('gpio.write', {
      line: 'status_led',
      value: true,
      hold: false,
    });

    expect(result).toMatchObject({ mode: 'once', releasedOnExit: true, holdPeriodMs: 20 });
    expect(runner.runs[0]!.args).toEqual([
      '--chip',
      'gpiochip0',
      '--consumer',
      'pinout',
      '--hold-period',
      '20ms',
      '-t0',
      '17=1',
    ]);
    expect(stateOf(backend).lines.status_led).toMatchObject({ releasedOnExit: true, held: false });
    await backend.close();
  });

  it('pulses a line and returns it to the configured safe level', async () => {
    const runner = new FakeCommandRunner();
    const backend = makeBackend(runner);
    const result = await backend.invoke('gpio.write', {
      line: 'status_led',
      value: true,
      pulseMs: 15,
    });

    expect(result).toMatchObject({
      mode: 'pulse',
      raw: 1,
      returnedTo: { safeLevel: 'low', action: 'driven', raw: 0 },
    });
    expect(runner.spawns).toHaveLength(2);
    expect(runner.spawns[0]!.args).toContain('17=1');
    expect(runner.spawns[1]!.args).toContain('17=0');
    await backend.close();
  });

  it('cancels a pending pulse when safe state is applied', async () => {
    const runner = new FakeCommandRunner();
    const backend = makeBackend(runner);
    const pending = backend.invoke('gpio.write', {
      line: 'status_led',
      value: true,
      pulseMs: 30_000,
    });
    // Wait until the pulse is armed (holder up + cancel callback registered),
    // not merely until gpioset is spawned — otherwise safeState can race ahead
    // of waitForPulse and miss the cancel.
    await flushUntil(() => stateOf(backend).lines.status_led?.held === true);

    const safe = await backend.safeState();
    const result = await pending;

    expect(safe).toMatchObject({ applied: true });
    expect(result).toMatchObject({ mode: 'pulse', cancelled: true });
    expect(runner.spawns).toHaveLength(2);
    await backend.close();
  });

  it('rejects writes to input lines, bad values, and undeclared lines', async () => {
    const runner = new FakeCommandRunner();
    const backend = makeBackend(runner, {
      lines: [
        { offset: 3, name: 'button', direction: 'input' },
        { offset: 17, name: 'led', direction: 'output' },
      ],
    });

    await expect(
      backend.invoke('gpio.write', { line: 'button', value: true }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(backend.invoke('gpio.write', { line: 'led', value: 'yes' })).rejects.toMatchObject(
      {
        code: 'VALIDATION_ERROR',
      },
    );
    await expect(
      backend.invoke('gpio.write', { line: 'led', offset: 17, value: true }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(backend.invoke('gpio.write', { line: 'nope', value: true })).rejects.toMatchObject(
      { code: 'GPIO_LINE_NOT_FOUND' },
    );
    await expect(backend.invoke('gpio.write', { offset: 99, value: true })).rejects.toMatchObject({
      code: 'GPIO_LINE_NOT_FOUND',
    });
    expect(runner.usedTools()).toEqual([]);
    await backend.close();
  });

  it('emits gpio.holdLost and clears acknowledged state when a holder dies', async () => {
    const runner = new FakeCommandRunner();
    const backend = makeBackend(runner);
    const events: string[] = [];
    backend.subscribe((event) => events.push(event));

    await backend.invoke('gpio.write', { line: 'status_led', value: true });
    runner.spawns[0]!.process.exit({ code: 1, signal: null });
    await flushUntil(() => events.includes('gpio.holdLost'));

    expect(stateOf(backend).lines.status_led).toMatchObject({ held: false, value: null });
    await backend.close();
  });
});

describe('LibgpiodBackend reads, watches, and safe state', () => {
  it('reads raw and logical values and records gpio-readback evidence', async () => {
    const runner = new FakeCommandRunner().enqueue({ stdout: '0\n' });
    const backend = makeBackend(runner, {
      lines: [{ offset: 5, name: 'relay', direction: 'output', polarity: 'active-low' }],
    });

    const result = await backend.invoke('gpio.read', { line: 'relay' });
    expect(result).toMatchObject({
      line: 'relay',
      offset: 5,
      raw: 0,
      value: true,
      polarity: 'active-low',
      source: 'gpio-readback',
    });
    expect(runner.runs[0]!.args).toContain('--as-is');
    expect(stateOf(backend).lines.relay).toMatchObject({
      value: true,
      raw: 0,
      source: 'gpio-readback',
      stale: false,
    });
    await backend.close();
  });

  it('applies the configured bias to input reads', async () => {
    const runner = new FakeCommandRunner().enqueue({ stdout: '1\n' });
    const backend = makeBackend(runner, {
      lines: [{ offset: 3, name: 'button', direction: 'input', bias: 'pull-up' }],
    });
    await backend.invoke('gpio.read', { line: 'button' });
    expect(runner.runs[0]!.args).toEqual(expect.arrayContaining(['--bias', 'pull-up']));
    await backend.close();
  });
  it('translates watch edges through polarity and stops the monitor', async () => {
    const runner = new FakeCommandRunner();
    const backend = makeBackend(runner, {
      lines: [{ offset: 5, name: 'relay', direction: 'output', polarity: 'active-low' }],
    });
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    backend.subscribe((event, payload) => events.push({ event, payload }));

    const watch = await backend.invoke('gpio.watch', { lines: ['relay'] });
    expect(watch).toMatchObject({
      watching: true,
      chip: 'gpiochip0',
      lines: [{ line: 'relay', offset: 5 }],
      debounceMs: 0,
    });

    runner.spawns[0]!.process.pushStdout('5 2 1.5\n');
    await flushUntil(() => events.some((entry) => entry.event === 'gpio.changed'));

    const changed = events.find((entry) => entry.event === 'gpio.changed');
    expect(changed?.payload).toMatchObject({
      line: 'relay',
      raw: 0,
      value: true,
      edge: 'falling',
      source: 'gpio-readback',
    });
    expect(stateOf(backend).lines.relay).toMatchObject({ value: true, source: 'gpio-readback' });

    const stopped = await backend.invoke('gpio.unwatch', {});
    expect(stopped).toMatchObject({ watching: false, stopped: true });
    expect(runner.spawns[0]!.process.signals).toEqual(['SIGTERM']);
    await backend.close();
  });

  it('emits gpio.watchStopped when gpiomon dies unexpectedly', async () => {
    const runner = new FakeCommandRunner();
    const backend = makeBackend(runner);
    const events: string[] = [];
    backend.subscribe((event) => events.push(event));

    await backend.invoke('gpio.watch', { line: 'status_led' });
    runner.spawns[0]!.process.exit({ code: 3, signal: null });
    await flushUntil(() => events.includes('gpio.watchStopped'));

    expect(stateOf(backend).lines.status_led?.watching).toBe(false);
    await backend.close();
  });

  it('applies safe levels in the documented order and reports every action', async () => {
    const runner = new FakeCommandRunner();
    const backend = makeBackend(runner, {
      lines: [
        { offset: 10, name: 'hold_line', direction: 'output', safeLevel: 'hold' },
        { offset: 11, name: 'z_line', direction: 'output', safeLevel: 'high-z' },
        { offset: 12, name: 'drive_b', direction: 'output' },
        { offset: 13, name: 'drive_a', direction: 'output' },
        { offset: 14, name: 'sense', direction: 'input' },
      ],
    });
    const events: string[] = [];
    backend.subscribe((event) => events.push(event));

    await backend.invoke('gpio.write', { line: 'hold_line', value: true });
    await backend.invoke('gpio.write', { line: 'z_line', value: true });

    const result = (await backend.safeState()) as {
      lines: Array<{ line: string; action: string; raw: number | null; reason?: string }>;
    };
    expect(result.lines).toEqual([
      {
        line: 'drive_b',
        offset: 12,
        safeLevel: 'low',
        action: 'driven',
        raw: 0,
        reason: 'safe-state',
      },
      {
        line: 'drive_a',
        offset: 13,
        safeLevel: 'low',
        action: 'driven',
        raw: 0,
        reason: 'safe-state',
      },
      { line: 'z_line', offset: 11, safeLevel: 'high-z', action: 'released', raw: null },
      { line: 'hold_line', offset: 10, safeLevel: 'hold', action: 'kept', raw: 1 },
      {
        line: 'sense',
        offset: 14,
        safeLevel: 'high-z',
        action: 'skipped',
        raw: null,
        reason: 'input-line',
      },
    ]);
    expect(runner.spawns).toHaveLength(4);
    expect(runner.spawns[1]!.process.signals).toEqual(['SIGTERM']);
    expect(events).toContain('safe_state.applied');
    await backend.close();
  });

  it('reports chip lists and fails loudly for absent chips', async () => {
    const runner = new FakeCommandRunner()
      .enqueue({ stdout: 'gpiochip0 [pinctrl-rp1] (54 lines)\n' })
      .enqueue({ stdout: 'gpiochip0 - 54 lines:\n\tline 0: unnamed input\n' });
    const backend = makeBackend(runner);

    const info = await backend.invoke('gpio.info', {});
    expect(info).toMatchObject({ chip: 'gpiochip0' });
    expect(runner.usedTools()).toEqual(['gpiodetect', 'gpioinfo']);

    runner.enqueue({ stdout: 'gpiochip0 [pinctrl-rp1] (54 lines)\n' });
    await expect(backend.invoke('gpio.info', { chip: 'gpiochip4' })).rejects.toMatchObject({
      code: 'GPIOCHIP_NOT_FOUND',
    });
    await backend.close();
  });

  it('reports evidence per line and a safe-state note', async () => {
    const runner = new FakeCommandRunner().enqueue({ stdout: '1\n' });
    const backend = makeBackend(runner);
    await backend.invoke('gpio.read', { line: 'status_led' });

    const evidence = backend.getOperationalStateEvidence();
    expect(evidence['line:status_led']).toMatchObject({
      observed: expect.objectContaining({ value: true, source: 'gpio-readback' }),
      provenance: 'hardware',
    });
    expect(stateOf(backend).observedAt).toBeTypeOf('number');
    await backend.close();
  });
});

describe('LibgpiodBackend lifecycle and platform gating', () => {
  it('refuses every operation on non-Linux hosts while allowing construction', async () => {
    const runner = new FakeCommandRunner();
    const backend = new LibgpiodBackend({
      runner,
      platform: 'darwin',
      chip: 'gpiochip0',
      holdStartupGraceMs: 0,
      lines: [{ ...statusLed }],
    });

    expect(stateOf(backend)).toMatchObject({ platform: 'darwin', provenance: 'unknown' });
    await expect(backend.invoke('gpio.read', { line: 'status_led' })).rejects.toMatchObject({
      code: 'PLATFORM_UNSUPPORTED',
    });
    await expect(
      backend.invoke('gpio.write', { line: 'status_led', value: true }),
    ).rejects.toMatchObject({ code: 'PLATFORM_UNSUPPORTED' });
    expect(runner.usedTools()).toEqual([]);
    await backend.close();
  });

  it('closes idempotently, releasing holders and stopping the watch', async () => {
    const runner = new FakeCommandRunner();
    const backend = makeBackend(runner);
    await backend.invoke('gpio.write', { line: 'status_led', value: true });
    await backend.invoke('gpio.watch', { line: 'status_led' });

    await backend.close();
    await backend.close();

    expect(runner.spawns).toHaveLength(2);
    expect(runner.spawns.every((spawn) => spawn.process.exited)).toBe(true);
    await expect(backend.invoke('gpio.read', { line: 'status_led' })).rejects.toMatchObject({
      code: 'DISCONNECTED',
    });
  });

  it('rejects unknown actions', async () => {
    const runner = new FakeCommandRunner();
    const backend = makeBackend(runner);
    await expect(backend.invoke('gpio.spin', {})).rejects.toMatchObject({
      code: 'UNKNOWN_ACTION',
    });
    await backend.close();
  });
});

describe('CommandRunner seam typing', () => {
  it('accepts a plain runner object (no Node child processes required)', () => {
    const runner: CommandRunner = {
      async run() {
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      },
      spawn() {
        throw new Error('not used');
      },
    };
    const backend = new LibgpiodBackend({ runner, platform: 'linux' });
    expect(stateOf(backend).chip).toBe('gpiochip0');
  });
});

describe('libgpiod module definition', () => {
  it('declares capabilities with schemas and safety metadata', () => {
    expect(libgpiodModule.id).toBe('pinout/linux-gpio');
    expect(libgpiodModule.deviceClass).toBe('controller.linux-sbc-gpio');
    expect(libgpiodModule.supportedTransportKinds).toEqual(['host']);
    expect(libgpiodModule.capabilityNames).toEqual([
      'gpio.info',
      'gpio.read',
      'gpio.write',
      'gpio.watch',
      'gpio.unwatch',
      'gpio.safeState',
    ]);
    for (const capability of libgpiodCapabilities) {
      expect(capability.inputSchema.type).toBe('object');
      expect(capability.outputSchema.type).toBe('object');
      expect(capability.safety.physicalOutput).toBeTypeOf('boolean');
    }
    const write = libgpiodCapabilities.find((capability) => capability.name === 'gpio.write');
    expect(write?.safety).toMatchObject({ physicalOutput: true, reversible: true });
    const safeState = libgpiodCapabilities.find(
      (capability) => capability.name === 'gpio.safeState',
    );
    expect(safeState?.safety).toMatchObject({ physicalOutput: true, reversible: false });
  });

  it('bounds pulseMs and debounceMs through policy rules', () => {
    const context = (capability: string, payload: Record<string, unknown>) => ({
      deviceId: 'bench-pi',
      capability,
      payload,
      operationalState: {},
    });
    expect(() =>
      evaluatePolicies(
        libgpiodPolicies,
        context('gpio.write', { value: true, pulseMs: libgpiodMaxPulseMs + 1 }),
      ),
    ).toThrowError(PolicyConstraintViolation);
    expect(() =>
      evaluatePolicies(libgpiodPolicies, context('gpio.write', { value: true, pulseMs: 250 })),
    ).not.toThrow();
    expect(() =>
      evaluatePolicies(libgpiodPolicies, context('gpio.watch', { debounceMs: -1 })),
    ).toThrowError(PolicyConstraintViolation);
    expect(() =>
      evaluatePolicies(libgpiodPolicies, context('gpio.read', { line: 'a', offset: 1 })),
    ).toThrowError(PolicyConstraintViolation);
  });

  it('refuses to fabricate a simulated backend', () => {
    expect(() => createLibgpiodBackend({ simulated: true })).toThrowError(/simulated/);
    expect(() => libgpiodModule.createSimulatedBackend?.({})).toThrowError(/simulated/);
  });

  it('creates a protocol backend through the module contract', async () => {
    const runner = new FakeCommandRunner();
    const backend = await libgpiodModule.createProtocolBackend?.({
      runner,
      platform: 'linux',
      holdStartupGraceMs: 0,
      lines: [{ ...statusLed }],
    });
    expect(backend).toBeInstanceOf(LibgpiodBackend);
    expect(stateOf(backend as LibgpiodBackend).chip).toBe('gpiochip0');
    await backend?.close();
  });
});
