import { afterEach, describe, expect, it } from 'vitest';
import type { Transport } from '@pinout/core';
import {
  createUrDashboardClient,
  createUrSimulator,
  isDashboardFailure,
  parseModeReply,
  parsePolyscopeVersionReply,
  parseProgramStateReply,
  parseRobotModeReply,
  parseRunningReply,
  parseSafetyModeReply,
  type UrDashboardDiagnostic,
  UrDashboardError,
} from '../src/index.js';
import { expectErrorCode } from './errorAssertions.js';

/**
 * Minimal scripted dashboard transport for the client tests: replies are
 * produced by a callback so tests can control success, failure, silence, and
 * the presence or absence of a welcome line.
 */
class ScriptedTransport implements Transport {
  readonly kind = 'scripted-dashboard';
  readonly written: string[] = [];
  private readonly listeners = new Set<(chunk: Uint8Array) => void>();
  private readonly queue: Uint8Array[] = [];
  private closedState = false;
  private readonly welcome: string | undefined;

  constructor(
    private readonly respond: (line: string) => string | undefined,
    options: { welcome?: string; noWelcome?: boolean } = {},
  ) {
    this.welcome =
      options.noWelcome === true
        ? undefined
        : (options.welcome ?? 'Universal Robots Dashboard Server');
  }

  get closed(): boolean {
    return this.closedState;
  }

  get readable(): AsyncIterable<Uint8Array> {
    const listeners = this.listeners;
    const queue = this.queue;
    const isClosed = (): boolean => this.closedState;
    return {
      async *[Symbol.asyncIterator]() {
        let notify: (() => void) | undefined;
        const listener = (chunk: Uint8Array): void => {
          queue.push(chunk);
          notify?.();
        };
        listeners.add(listener);
        try {
          while (!isClosed()) {
            if (queue.length === 0) {
              await new Promise<void>((resolve) => {
                notify = resolve;
              });
              continue;
            }
            yield queue.shift()!;
          }
        } finally {
          listeners.delete(listener);
        }
      },
    };
  }

  async open(): Promise<void> {
    this.closedState = false;
    if (this.welcome !== undefined) this.emit(this.welcome);
  }

  async close(): Promise<void> {
    this.closedState = true;
    this.emitRaw(new Uint8Array(0));
  }

  async write(data: Uint8Array): Promise<void> {
    const line = new TextDecoder().decode(data).trim();
    this.written.push(line);
    const reply = this.respond(line);
    if (reply !== undefined) this.emit(reply);
  }

  private emit(text: string): void {
    this.emitRaw(new TextEncoder().encode(`${text}\n`));
  }

  private emitRaw(chunk: Uint8Array): void {
    if (this.listeners.size === 0) {
      this.queue.push(chunk);
      return;
    }
    for (const listener of this.listeners) listener(chunk);
  }
}

describe('UR dashboard reply parsers', () => {
  it('parses robot-mode replies by name and by RTDE number', () => {
    expect(parseRobotModeReply('Robotmode: 7')).toMatchObject({ mode: 'RUNNING', numeric: 7 });
    expect(parseRobotModeReply('Robotmode: POWER_OFF')).toMatchObject({
      mode: 'POWER_OFF',
      numeric: undefined,
    });
    expect(parseRobotModeReply('Robotmode: SomeFutureMode').mode).toBe('UNKNOWN');
    expect(parseRobotModeReply('Robotmode: 42')).toMatchObject({ mode: 'UNKNOWN', numeric: 42 });
  });

  it('parses safety-mode replies by name and by RTDE number', () => {
    expect(parseSafetyModeReply('Safetymode: NORMAL').mode).toBe('NORMAL');
    expect(parseSafetyModeReply('Safetymode: 3')).toMatchObject({
      mode: 'PROTECTIVE_STOP',
      numeric: 3,
    });
    expect(parseSafetyModeReply('Safetymode: 11').mode).toBe('UNDEFINED_SAFETY_MODE');
  });

  it('parses program state, running, and Polyscope version replies', () => {
    const playing = parseProgramStateReply('PLAYING demo.urp');
    expect(playing.state).toBe('PLAYING');
    expect(playing.programName).toBe('demo.urp');
    expect(parseProgramStateReply('STOPPED').state).toBe('STOPPED');
    expect(parseProgramStateReply('SOMETHING ELSE').state).toBe('UNKNOWN');
    expect(parseRunningReply('Program running: true')).toBe(true);
    expect(parseRunningReply('Program running: false')).toBe(false);
    expect(parsePolyscopeVersionReply('URSoftware 5.11.0 (108057)')).toMatchObject({
      version: '5.11.0',
      build: '108057',
    });
  });

  it('rejects unparseable running and Polyscope replies', () => {
    expect(() => parseRunningReply('Running: maybe')).toThrowError(UrDashboardError);
    expectErrorCode(() => parseRunningReply('Running: maybe'), 'UR_DASHBOARD_UNEXPECTED_REPLY');
    expectErrorCode(() => parsePolyscopeVersionReply('UR 5.11'), 'UR_DASHBOARD_UNEXPECTED_REPLY');
  });

  it('classifies dashboard failure replies without flagging successes', () => {
    expect(isDashboardFailure('Could not play program: no program loaded.')).toBe(true);
    expect(isDashboardFailure('Error while loading program')).toBe(true);
    expect(isDashboardFailure('Unknown command: frobnicate')).toBe(true);
    expect(isDashboardFailure('Failed to power on')).toBe(true);
    expect(isDashboardFailure('The command is not allowed')).toBe(true);
    expect(isDashboardFailure('Starting program')).toBe(false);
    expect(isDashboardFailure('Stopped')).toBe(false);
    expect(parseModeReply('Robotmode: 5')).toMatchObject({ numeric: 5, name: undefined });
  });
});

describe('UrDashboardClient against the simulator', () => {
  const closers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      await closers
        .pop()!
        .close()
        .catch(() => undefined);
    }
  });

  it('consumes the welcome line and drives power, programs, and reads', async () => {
    const sim = createUrSimulator();
    const dashboard = createUrDashboardClient({ transport: sim.dashboard, timeoutMs: 2000 });
    closers.push(dashboard);
    await dashboard.start();
    expect(dashboard.welcomeMessage).toBe('Universal Robots Dashboard Server');

    await expect(dashboard.play()).rejects.toMatchObject({
      code: 'UR_DASHBOARD_COMMAND_FAILED',
    });
    await expect(dashboard.play()).rejects.toThrowError(/could not play program/i);

    expect(await dashboard.powerOn()).toBe('Powering on');
    expect(await dashboard.powerOn()).toBe('Robot is already powered on');
    expect(await dashboard.brakeRelease()).toBe('Brake releasing');
    expect((await dashboard.robotMode()).mode).toBe('IDLE');

    expect(await dashboard.loadProgram('/programs/demo.urp')).toBe(
      'Loading program: /programs/demo.urp',
    );
    expect(await dashboard.play()).toBe('Starting program');
    expect(await dashboard.running()).toBe(true);
    expect((await dashboard.programState()).state).toBe('PLAYING');
    expect(await dashboard.pause()).toBe('Pausing program');
    expect((await dashboard.programState()).state).toBe('PAUSED');
    expect(await dashboard.stop()).toBe('Stopped');
    expect((await dashboard.robotMode()).mode).toBe('IDLE');

    expect(await dashboard.robotModel()).toBe('UR5e');
    expect(await dashboard.serialNumber()).toBe('2020550000');
    expect((await dashboard.polyscopeVersion()).version).toBe('5.11.0');
    expect(await dashboard.safetyStatus()).toMatchObject({ status: 'NORMAL' });
  });

  it('returns raw replies for arbitrary commands and classifies failures', async () => {
    const sim = createUrSimulator();
    const dashboard = createUrDashboardClient({ transport: sim.dashboard, timeoutMs: 2000 });
    closers.push(dashboard);
    await dashboard.start();
    const reply = await dashboard.command('frobnicate');
    expect(reply).toMatch(/^Unknown command/);
    expect(isDashboardFailure(reply)).toBe(true);
  });

  it('does not send commands before start()', async () => {
    const sim = createUrSimulator();
    const dashboard = createUrDashboardClient({ transport: sim.dashboard, timeoutMs: 2000 });
    closers.push(dashboard);
    await expect(dashboard.command('robotmode')).rejects.toMatchObject({
      code: 'UR_DASHBOARD_NOT_STARTED',
    });
  });

  it('requires verified success wordings unless lenientReplies is set', async () => {
    const transport = new ScriptedTransport(() => 'Accepted.', { noWelcome: true });
    const strict = createUrDashboardClient({ transport, expectWelcome: false, timeoutMs: 500 });
    closers.push(strict);
    await strict.start();
    await expect(strict.powerOn()).rejects.toMatchObject({
      code: 'UR_DASHBOARD_UNEXPECTED_REPLY',
    });

    const lenientTransport = new ScriptedTransport(() => 'Accepted.', { noWelcome: true });
    const lenient = createUrDashboardClient({
      transport: lenientTransport,
      expectWelcome: false,
      lenientReplies: true,
      timeoutMs: 500,
    });
    closers.push(lenient);
    await lenient.start();
    expect(await lenient.powerOn()).toBe('Accepted.');
  });

  it('accepts custom success wordings via acceptedReplies', async () => {
    const transport = new ScriptedTransport(() => 'OK, powering.', { noWelcome: true });
    const dashboard = createUrDashboardClient({
      transport,
      expectWelcome: false,
      timeoutMs: 500,
      acceptedReplies: { 'power on': ['OK, powering.'] },
    });
    closers.push(dashboard);
    await dashboard.start();
    expect(await dashboard.powerOn()).toBe('OK, powering.');
  });

  it('continues with a diagnostic when no welcome line arrives', async () => {
    const diagnostics: UrDashboardDiagnostic[] = [];
    const transport = new ScriptedTransport(
      (line) => (line === 'robotmode' ? 'Robotmode: 5' : undefined),
      {
        noWelcome: true,
      },
    );
    const dashboard = createUrDashboardClient({
      transport,
      welcomeTimeoutMs: 20,
      timeoutMs: 500,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    closers.push(dashboard);
    await dashboard.start();
    expect(dashboard.welcomeMessage).toBeUndefined();
    expect(diagnostics.map((entry) => entry.code)).toContain('UR_DASHBOARD_NO_WELCOME');
    expect((await dashboard.robotMode()).mode).toBe('IDLE');
  });

  it('closes the session after a reply timeout and refuses later commands', async () => {
    const transport = new ScriptedTransport(() => undefined, { noWelcome: true });
    const dashboard = createUrDashboardClient({ transport, expectWelcome: false, timeoutMs: 40 });
    closers.push(dashboard);
    await dashboard.start();
    await expect(dashboard.command('robotmode')).rejects.toMatchObject({
      code: 'UR_DASHBOARD_TIMEOUT',
    });
    await expect(dashboard.command('robotmode')).rejects.toMatchObject({
      code: 'UR_DASHBOARD_CLOSED',
    });
    expect(transport.closed).toBe(true);
  });
});
