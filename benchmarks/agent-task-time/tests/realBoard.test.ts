import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeCommandRunner } from '../src/devices/commandRunner.js';
import { runRealBoardPreflight } from '../src/devices/preflight.js';
import { promptPhysicalConfirm } from '../src/devices/physicalConfirm.js';
import { RealBoardSession, resetBoardBetweenRuns } from '../src/devices/realBoardSession.js';
import { runHarness } from '../src/harness.js';
import type { BenchConfig } from '../src/types.js';
import type { PinoutDaemonClient } from '../src/arms/pinoutRealArm.js';

function realConfig(overrides: Partial<BenchConfig> = {}): BenchConfig {
  const resultsDir = mkdtempSync(join(tmpdir(), 'pinout-bench-real-'));
  return {
    provider: 'scripted',
    model: 'HARNESS_TEST_NOT_LLM',
    temperatureExplicitlySet: false,
    temperatureRecorded: 'model default',
    runs: 1,
    timeoutMs: 30_000,
    maxTurns: 20,
    deviceMode: 'real',
    profiles: ['esp32'],
    tasks: ['blinkLed'],
    arms: ['raw', 'pinout'],
    dryRun: true,
    scriptedAgent: true,
    resultsDir,
    seed: 3,
    promptUsdPerMillion: 0.15,
    completionUsdPerMillion: 0.6,
    confirmPhysical: true,
    baudRate: 115200,
    skipPreflight: true,
    serialPort: '/dev/ttyUSB0',
    daemonUrl: 'http://127.0.0.1:8787',
    ...overrides,
  };
}

function fakePinoutClient(): PinoutDaemonClient {
  return {
    async listDevices() {
      return [{ id: 'board-01', simulated: false }];
    },
    async describeDevice(deviceId) {
      return { id: deviceId, ok: true };
    },
    async readState(deviceId) {
      return { id: deviceId, state: 'armed' };
    },
    async invoke(_deviceId, action, payload) {
      return { action, payload, ok: true };
    },
  };
}

describe('real-board path (fakes)', () => {
  it('preflight fails clearly when toolchains and ports are missing', async () => {
    const result = await runRealBoardPreflight({
      profiles: ['esp32'],
      arms: ['raw', 'pinout'],
      deps: {
        commandRunner: createFakeCommandRunner({ binaries: {} }),
        listSerialPorts: async () => [],
        probeDaemon: async () => ({ ok: false, detail: 'connection refused' }),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /serial ports/i.test(error))).toBe(true);
    expect(result.errors.some((error) => /esptool|arduino-cli/i.test(error))).toBe(true);
    expect(result.errors.some((error) => /pinoutd/i.test(error))).toBe(true);
  });

  it('preflight passes with faked port, toolchain, and daemon', async () => {
    const result = await runRealBoardPreflight({
      profiles: ['esp32'],
      arms: ['raw', 'pinout'],
      serialPort: '/dev/ttyUSB0',
      daemonUrl: 'http://127.0.0.1:8787',
      deps: {
        commandRunner: createFakeCommandRunner({
          binaries: { 'esptool.py': '/usr/bin/esptool.py', 'arduino-cli': '/usr/bin/arduino-cli' },
        }),
        listSerialPorts: async () => [{ path: '/dev/ttyUSB0', manufacturer: 'Fake' }],
        probeDaemon: async () => ({ ok: true, detail: 'ok' }),
      },
    });
    expect(result.ok).toBe(true);
    expect(result.daemon.alreadyRunning).toBe(true);
    expect(result.selectedPort).toBe('/dev/ttyUSB0');
  });

  it('runs interleaved real-mode scripted arms with fakes and confirm-physical', async () => {
    const answers = ['yes', 'yes'];
    const { summary } = await runHarness(realConfig(), {
      commandRunner: createFakeCommandRunner({
        binaries: {
          'esptool.py': '/usr/bin/esptool.py',
          'arduino-cli': '/usr/bin/arduino-cli',
          echo: '/bin/echo',
        },
        handlers: {
          'esptool.py': () => ({
            stdout: 'stub',
            stderr: '',
            exitCode: 0,
            durationMs: 5,
          }),
          echo: () => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 }),
        },
      }),
      listSerialPorts: async () => [{ path: '/dev/ttyUSB0' }],
      pinoutDaemonClient: fakePinoutClient(),
      physicalConfirm: {
        ask: async () => answers.shift() ?? 'yes',
      },
    });

    expect(summary.evidence).toBe('HARNESS_TEST_NOT_LLM');
    expect(summary.deviceMode).toBe('real');
    expect(summary.hardwareStatus).toMatch(/UNTESTED/);
    expect(summary.runs.length).toBe(2);
    expect(summary.runs.every((run) => run.success)).toBe(true);
    expect(summary.runs.every((run) => run.physicalConfirm?.operatorAnswer === 'yes')).toBe(true);
    expect(summary.runs.every((run) => run.coldWarm !== undefined)).toBe(true);
  }, 60_000);

  it('records operator no without inventing physical success', async () => {
    const confirm = await promptPhysicalConfirm({
      taskId: 'blinkLed',
      profileLabel: 'ESP32',
      enabled: true,
      deps: { ask: async () => 'no' },
    });
    expect(confirm.prompted).toBe(true);
    expect(confirm.operatorAnswer).toBe('no');
  });

  it('resets board journal between runs via faked toolchain', async () => {
    const session = new RealBoardSession({
      profileId: 'esp32',
      port: '/dev/ttyUSB0',
      baudRate: 115200,
      pinoutdAlreadyRunning: true,
    });
    session.recordLevel(2, true);
    const runner = createFakeCommandRunner({
      binaries: { 'esptool.py': '/usr/bin/esptool.py' },
      handlers: {
        'esptool.py': () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 2 }),
      },
    });
    const result = await resetBoardBetweenRuns(session, { commandRunner: runner });
    expect(result.ok).toBe(true);
    expect(session.levels.size).toBe(0);
    expect(session.journal.some((entry) => entry.kind === 'device.state')).toBe(true);
  });
});
